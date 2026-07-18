import { describe, expect, it, vi } from "vitest";
import {
  CorpusCache,
  assembleSession,
  buildSessionDigest,
  type CorpusSessionMeta,
} from "../src/corpus.js";
import { buildCandidates } from "../src/candidates.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  bundle,
  completedToolPart,
  globalSessionFrom,
  makeContext,
  makeFakeHarness,
  reasoningPart,
  runTool,
  session,
  textPart,
  userMessage,
} from "./helpers.js";
import { search } from "../src/search.js";
import type { SearchOutput } from "../src/types.js";

function target(id: string, updated: number, title = `Session ${id}`): CorpusSessionMeta {
  return { id, title, directory: PROJECT_DIR, updated };
}

describe("CorpusCache", () => {
  it("serves unchanged sessions from cache and re-fetches on updated bump", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS);

    const first = await cache.sync([target("s-current", 1_000)]);
    first.release();
    expect(h.calls.messages).toHaveLength(1);
    expect(first.sessions[0]!.candidates.length).toBeGreaterThan(0);

    // Same version: served from cache, no new fetch.
    const second = await cache.sync([target("s-current", 1_000)]);
    second.release();
    expect(h.calls.messages).toHaveLength(1);

    // Session content changed: fixture gains a message, updated bumps.
    h.messagesBySession["s-current"]!.push(
      bundle(userMessage("m-new", "s-current", Date.now()), [
        textPart("p-new", "s-current", "m-new", "freshly added zanzibar content"),
      ]),
    );
    const third = await cache.sync([target("s-current", 2_000)]);
    third.release();
    expect(h.calls.messages).toHaveLength(2);
    expect(third.sessions[0]!.candidates.some((c) => c.rawText.includes("zanzibar"))).toBe(true);
  });

  it("treats unknown updated (<= 0) as uncacheable: always fetch, never store", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS);

    const first = await cache.sync([target("s-current", 0)]);
    first.release();
    const second = await cache.sync([target("s-current", 0)]);
    second.release();
    expect(h.calls.messages).toHaveLength(2);
    expect(cache.stats().sessions).toBe(0);
    expect(second.sessions[0]!.candidates.length).toBeGreaterThan(0);
  });

  it("reports per-session load failures without caching them", async () => {
    const h = makeFakeHarness({ messageErrors: { "s-current": "boom" } });
    const cache = new CorpusCache(h.client, TEST_LIMITS);

    const result = await cache.sync([target("s-current", 1_000), target("s-project-2", 1_000)]);
    result.release();
    expect(result.loadErrorCount).toBe(1);
    expect(result.loadErrors[0]).toContain("s-current");
    expect(result.sessions[0]!.candidates).toEqual([]);
    expect(result.sessions[1]!.candidates.length).toBeGreaterThan(0);
    // The failure is not cached: a later sync retries the fetch.
    const retry = await cache.sync([target("s-current", 1_000)]);
    retry.release();
    expect(h.calls.messages.filter((c) => c.sessionID === "s-current")).toHaveLength(2);
  });

  it("deduplicates concurrent fetches of the same session", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS);

    const [a, b] = await Promise.all([
      cache.sync([target("s-current", 1_000)]),
      cache.sync([target("s-current", 1_000)]),
    ]);
    a.release();
    b.release();
    expect(h.calls.messages).toHaveLength(1);
    expect(a.sessions[0]!.candidates.length).toBeGreaterThan(0);
    expect(b.sessions[0]!.candidates.length).toBeGreaterThan(0);
  });

  it("does not share an in-flight fetch across different session versions", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const [older, newer] = await Promise.all([
      cache.sync([target("s-current", 1_000)]),
      cache.sync([target("s-current", 2_000)]),
    ]);
    older.release();
    newer.release();
    // Different versions must fetch independently so the stored entry is
    // never labeled with a version its caller did not request.
    expect(h.calls.messages).toHaveLength(2);
    // A follow-up sync at the newer version is served from cache.
    const again = await cache.sync([target("s-current", 2_000)]);
    again.release();
    expect(h.calls.messages).toHaveLength(2);
  });

  it("evicts least-recently-used sessions over cacheMaxChars but never pinned ones", async () => {
    const h = makeFakeHarness();
    const big = "x".repeat(500);
    for (const id of ["s-big-1", "s-big-2"]) {
      const s = session(id, `Big ${id}`, PROJECT_DIR, 1_000);
      h.messagesBySession[id] = [
        bundle(userMessage(`m-${id}`, id, 1_000), [textPart(`p-${id}`, id, `m-${id}`, big)]),
      ];
      void s;
    }
    // charCount now counts rawText + field texts, so a 500-char part session
    // is ~1000 chars retained. Budget fits roughly one big session at a time.
    const cache = new CorpusCache(h.client, { ...TEST_LIMITS, cacheMaxChars: 1_200 });

    const first = await cache.sync([target("s-big-1", 1_000)]);
    // Still pinned: syncing a second session over budget must not evict the
    // first while its query is in flight.
    const second = await cache.sync([target("s-big-2", 1_000)]);
    expect(cache.stats().sessions).toBe(2);

    first.release();
    second.release();
    // After release, LRU eviction brings the cache back under budget.
    expect(cache.stats().chars).toBeLessThanOrEqual(1_200);
    expect(cache.stats().sessions).toBe(1);

    // The evicted session is simply re-fetched next time: same results.
    const again = await cache.sync([target("s-big-1", 1_000)]);
    again.release();
    expect(again.sessions[0]!.candidates.length).toBe(1);
  });

  it("keeps a session pinned until every overlapping sync releases it", async () => {
    const h = makeFakeHarness();
    const big = "x".repeat(500);
    for (const id of ["s-big-1", "s-big-2"]) {
      h.messagesBySession[id] = [
        bundle(userMessage(`m-${id}`, id, 1_000), [textPart(`p-${id}`, id, `m-${id}`, big)]),
      ];
    }
    const cache = new CorpusCache(h.client, { ...TEST_LIMITS, cacheMaxChars: 600 });
    const fetchesOf = (id: string) => h.calls.messages.filter((c) => c.sessionID === id).length;

    // Two overlapping queries pin s-big-1; only one of them releases.
    const a = await cache.sync([target("s-big-1", 1_000)]);
    const b = await cache.sync([target("s-big-1", 1_000)]);
    a.release();

    // Eviction pressure from another session must evict the unpinned one, not
    // the session still pinned by the in-flight query.
    const other = await cache.sync([target("s-big-2", 1_000)]);
    other.release();
    const stillCached = await cache.sync([target("s-big-1", 1_000)]);
    stillCached.release();
    expect(fetchesOf("s-big-1")).toBe(1);

    // Once the last overlapping sync releases, the session becomes evictable.
    b.release();
    const evictor = await cache.sync([target("s-big-2", 1_000)]);
    evictor.release();
    const refetched = await cache.sync([target("s-big-1", 1_000)]);
    refetched.release();
    expect(fetchesOf("s-big-1")).toBe(2);
  });

  it("returns placeholder entries without load errors when aborted before fetching", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const controller = new AbortController();
    controller.abort();

    const result = await cache.sync([target("s-current", 1_000)], controller.signal);
    result.release();
    // An abort is not a load failure: no fetch happened and no error is
    // fabricated for the sessions the abort skipped.
    expect(h.calls.messages).toHaveLength(0);
    expect(result.loadErrorCount).toBe(0);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.candidates).toEqual([]);
    expect(result.sessions[0]!.loadError).toBeUndefined();
  });

  it("release() is idempotent and unpin survives double release", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const result = await cache.sync([target("s-current", 1_000)]);
    result.release();
    result.release();
    // A later sync still works and still deduplicates correctly.
    const again = await cache.sync([target("s-current", 1_000)]);
    again.release();
    expect(again.sessions[0]!.candidates.length).toBeGreaterThan(0);
  });

  it("concurrent callers deduping onto one failed fetch each see the failure", async () => {
    const h = makeFakeHarness({ messageThrows: new Set(["s-current"]) });
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const [a, b] = await Promise.all([
      cache.sync([target("s-current", 1_000)]),
      cache.sync([target("s-current", 1_000)]),
    ]);
    a.release();
    b.release();
    expect(h.calls.messages).toHaveLength(1);
    expect(a.loadErrorCount).toBe(1);
    expect(b.loadErrorCount).toBe(1);
    expect(a.sessions[0]!.loadError).toBeDefined();
    expect(b.sessions[0]!.loadError).toBeDefined();
  });
});

describe("persistent index (smart search)", () => {
  function bumpUpdated(h: ReturnType<typeof makeFakeHarness>, id: string, updated: number): void {
    for (const list of [h.sessions, h.globalSessions]) {
      const found = list.find((s) => s.id === id);
      if (found) (found.time as { updated: number }).updated = updated;
    }
  }

  it("reflects a version replace: old content leaves the index, new content is found", async () => {
    const h = makeFakeHarness();
    const s = session("s-rep", "Replace Session", PROJECT_DIR, 1_000);
    h.sessions.push(s);
    h.globalSessions.push(globalSessionFrom(s));
    h.messagesBySession["s-rep"] = [
      bundle(userMessage("m1", "s-rep", 1_000), [
        textPart("p1", "s-rep", "m1", "zanzibar alpha content"),
      ]),
    ];
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache);
    const q = (query: string) =>
      runTool<SearchOutput>(tool, { query, match: "smart", scope: "global", group: "part" });

    expect((await q("zanzibar")).results.some((r) => r.sessionID === "s-rep")).toBe(true);

    // New version: content changes, updated bumps. The persistent index must
    // discard the old partIDs, not accumulate stale hits.
    h.messagesBySession["s-rep"] = [
      bundle(userMessage("m2", "s-rep", 2_000), [
        textPart("p2", "s-rep", "m2", "wombat beta content"),
      ]),
    ];
    bumpUpdated(h, "s-rep", 2_000);

    expect((await q("zanzibar")).results.some((r) => r.sessionID === "s-rep")).toBe(false);
    expect((await q("wombat")).results.some((r) => r.sessionID === "s-rep")).toBe(true);
  });

  it("re-adds an evicted session to the index on the next search (no duplicate-id crash)", async () => {
    const h = makeFakeHarness();
    const s = session("s-evict", "Evict Session", PROJECT_DIR, 1_000);
    h.sessions.push(s);
    h.globalSessions.push(globalSessionFrom(s));
    h.messagesBySession["s-evict"] = [
      bundle(userMessage("m1", "s-evict", 1_000), [
        textPart("p1", "s-evict", "m1", "quokka ".repeat(200)),
      ]),
    ];
    // A tiny budget evicts every unpinned session as soon as each query
    // releases, so the second search must re-fetch and re-add from scratch.
    const cache = new CorpusCache(h.client, { ...TEST_LIMITS, cacheMaxChars: 100 });
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache);
    const q = () =>
      runTool<SearchOutput>(tool, {
        query: "quokka",
        match: "smart",
        scope: "global",
        group: "part",
      });

    expect((await q()).results.some((r) => r.sessionID === "s-evict")).toBe(true);
    // Everything is unpinned and over budget once the query released.
    expect(cache.stats().sessions).toBe(0);
    // Re-adding an evicted session must not throw on a duplicate partID.
    expect((await q()).results.some((r) => r.sessionID === "s-evict")).toBe(true);
  });

  it("routes narrow/unknown-version searches to the side index, broad ones to the persistent index", async () => {
    // s-current's metadata get() throws, so a session-scope sync sees updated<=0
    // (unknown): its candidates are never stored in the persistent index, so
    // only the side path can search it.
    const h = makeFakeHarness({ getThrows: new Set(["s-current"]) });
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const spy = vi.spyOn(cache, "searchPersistent");
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache);

    const scoped = await runTool<SearchOutput>(
      tool,
      { query: "unauthorized", match: "smart", scope: "session", excludeCurrentSession: false },
      makeContext({ sessionID: "s-current" }).ctx,
    );
    expect(scoped.results.some((r) => r.sessionID === "s-current")).toBe(true);
    expect(spy).not.toHaveBeenCalled();

    // A broad global search over known versions uses the persistent index.
    spy.mockClear();
    await runTool<SearchOutput>(tool, { query: "walkthrough", match: "smart", scope: "global" });
    expect(spy).toHaveBeenCalled();
  });

  it("shares one cold sync across two racing searches (Fix 5.5)", async () => {
    const h = makeFakeHarness();
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache);

    const [a, b] = await Promise.all([
      runTool<SearchOutput>(tool, { query: "walkthrough", match: "smart", scope: "global" }),
      runTool<SearchOutput>(tool, { query: "walkthrough", match: "smart", scope: "global" }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // The per-session-version in-flight map single-flights the fetch: each
    // session is loaded exactly once despite two concurrent cold searches.
    const perSession = new Map<string, number>();
    for (const call of h.calls.messages) {
      perSession.set(call.sessionID, (perSession.get(call.sessionID) ?? 0) + 1);
    }
    for (const [, count] of perSession) expect(count).toBe(1);
    expect(a.results.some((r) => r.sessionID === "s-other")).toBe(true);
    expect(b.results.some((r) => r.sessionID === "s-other")).toBe(true);
  });
});

describe("buildSessionDigest", () => {
  function digestOf(messages: Parameters<typeof buildCandidates>[0]): string {
    const { candidates } = buildCandidates(messages, {
      id: "s",
      title: "T",
      directory: PROJECT_DIR,
    });
    return buildSessionDigest(candidates);
  }

  it("combines the first user message head with statement/command vocabulary", () => {
    const digest = digestOf([
      {
        info: { id: "m1", role: "user", time: { created: 100 } },
        parts: [textPart("p1", "s", "m1", "Investigate the flaky websocket reconnect logic")],
      },
      {
        info: { id: "m2", role: "assistant", time: { created: 200 } },
        parts: [
          completedToolPart(
            "p2",
            "s",
            "m2",
            "bash",
            { command: "wscat --connect ws://host" },
            "ok",
          ),
        ],
      },
    ] as never);
    expect(digest).toContain("Investigate the flaky websocket reconnect logic");
    expect(digest).toContain("wscat");
  });

  it("gives no digest credit to read/skill tools or JSON pseudo-commands", () => {
    const digest = digestOf([
      {
        info: { id: "m1", role: "assistant", time: { created: 100 } },
        parts: [
          completedToolPart(
            "p1",
            "s",
            "m1",
            "read",
            { filePath: "/docs/zeppelin-handbook.md" },
            "zeppelin zeppelin zeppelin airship manual",
          ),
          completedToolPart(
            "p2",
            "s",
            "m1",
            "mcp__host__skill",
            { skill: "zeppelin" },
            "zeppelin skill payload",
          ),
        ],
      },
    ] as never);
    expect(digest).not.toContain("zeppelin");
    expect(digest).toBe("");
  });

  it("uses the earliest user message as the head and ignores reasoning vocabulary", () => {
    const digest = digestOf([
      {
        info: { id: "m1", role: "user", time: { created: 100 } },
        parts: [textPart("p1", "s", "m1", "Fix the broken telemetry exporter")],
      },
      {
        info: { id: "m2", role: "user", time: { created: 200 } },
        parts: [textPart("p2", "s", "m2", "Also polish dashboard rendering")],
      },
      {
        info: { id: "m3", role: "assistant", time: { created: 300 } },
        parts: [reasoningPart("p3", "s", "m3", "quixotic quixotic quixotic pondering")],
      },
    ] as never);
    // Candidates arrive newest-first; the head must still be the EARLIEST
    // user message, not the most recent one.
    expect(digest.startsWith("Fix the broken telemetry exporter")).toBe(true);
    // Reasoning is neither a statement nor an action: no digest credit.
    expect(digest).not.toContain("quixotic");
  });

  it("filters stopwords, short and letterless tokens, and caps the vocabulary at eight", () => {
    const words = [
      "ambera",
      "brindle",
      "cascade",
      "dorval",
      "estuary",
      "fjordic",
      "gantry",
      "harbinger",
      "icicle",
      "jamboree",
      "kestrel",
      "lantern",
    ];
    const digest = digestOf([
      {
        info: { id: "m1", role: "user", time: { created: 100 } },
        parts: [textPart("p1", "s", "m1", "go do")],
      },
      {
        info: { id: "m2", role: "assistant", time: { created: 200 } },
        parts: [textPart("p2", "s", "m2", `should with this 1234 ab ${words.join(" ")}`)],
      },
    ] as never);
    // Equal counts tie-break alphabetically; only the first eight survive.
    expect(digest).toBe("go do ambera brindle cascade dorval estuary fjordic gantry harbinger");
  });

  it("keeps sessions with no statements or commands digest-free", () => {
    const digest = digestOf([
      { info: { id: "m1", role: "assistant", time: { created: 100 } }, parts: [] },
    ] as never);
    expect(digest).toBe("");
  });
});

describe("assembleSession", () => {
  async function synced(h = makeFakeHarness(), id = "s-current", updated = 1_000) {
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const result = await cache.sync([target(id, updated)]);
    result.release();
    return result.sessions[0]!;
  }

  it("binds the title candidate to the newest eligible candidate", async () => {
    const entry = await synced();
    const assembledAll = assembleSession(entry, { type: "all", role: "all" }, true);
    expect(assembledAll.titleCandidate).toBeDefined();
    // Newest-first candidate order: the representative is the newest message.
    expect(assembledAll.titleCandidate!.messageID).toBe(assembledAll.candidates[0]!.messageID);

    // Role filter changes the representative to the newest matching message.
    const assembledUser = assembleSession(entry, { type: "all", role: "user" }, true);
    expect(assembledUser.titleCandidate).toBeDefined();
    expect(assembledUser.titleCandidate!.role).toBe("user");
  });

  it("yields no title hit when every candidate is filtered out", async () => {
    const entry = await synced();
    const assembled = assembleSession(entry, { type: "all", role: "all", before: 1 }, true);
    expect(assembled.candidates).toEqual([]);
    expect(assembled.titleCandidate).toBeUndefined();
    expect(assembled.messagesSearched).toBe(0);
    expect(assembled.partsSearched).toBe(0);
  });

  it("counts coverage from eligible candidates", async () => {
    const entry = await synced();
    const assembled = assembleSession(entry, { type: "tool", role: "all" }, false);
    expect(assembled.partsSearched).toBe(assembled.candidates.length);
    expect(assembled.messagesSearched).toBeLessThanOrEqual(assembled.partsSearched);
    expect(assembled.titleCandidate).toBeUndefined();
  });
});

describe("expansion over the cache", () => {
  it("fetches expanded sessions on demand and degrades to a warning on failure", async () => {
    const h = makeFakeHarness();
    let failMessages = false;
    const original = h.client.session.messages.bind(h.client.session);
    // First (sync) loads succeed; the expansion re-fetch fails.
    (h.client.session as unknown as Record<string, unknown>).messages = async (params: {
      sessionID: string;
    }) => {
      if (failMessages) return { error: { data: { message: "expansion fetch down" } } };
      return original(params);
    };
    const cache = new CorpusCache(h.client, TEST_LIMITS);
    const tool = search(h.client, h.unscoped, true, TEST_LIMITS, cache);

    // Warm the cache, then break the message endpoint for the expansion fetch.
    const warm = await runTool<SearchOutput>(tool, { query: "walkthrough" });
    expect(warm.results.length).toBeGreaterThan(0);

    failMessages = true;
    const out = await runTool<SearchOutput>(tool, {
      query: "walkthrough",
      expand: "context",
    });
    expect(out.ok).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.expanded).toBeUndefined();
    expect(out.warnings?.some((w) => w.includes("Expansion could not load session"))).toBe(true);
  });
});
