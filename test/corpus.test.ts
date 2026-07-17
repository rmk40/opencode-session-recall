import { describe, expect, it } from "vitest";
import { CorpusCache, assembleSession, type CorpusSessionMeta } from "../src/corpus.js";
import {
  PROJECT_DIR,
  TEST_LIMITS,
  bundle,
  makeFakeHarness,
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
    // Budget fits roughly one big session at a time.
    const cache = new CorpusCache(h.client, { ...TEST_LIMITS, cacheMaxChars: 600 });

    const first = await cache.sync([target("s-big-1", 1_000)]);
    // Still pinned: syncing a second session over budget must not evict the
    // first while its query is in flight.
    const second = await cache.sync([target("s-big-2", 1_000)]);
    expect(cache.stats().sessions).toBe(2);

    first.release();
    second.release();
    // After release, LRU eviction brings the cache back under budget.
    expect(cache.stats().chars).toBeLessThanOrEqual(600);
    expect(cache.stats().sessions).toBe(1);

    // The evicted session is simply re-fetched next time: same results.
    const again = await cache.sync([target("s-big-1", 1_000)]);
    again.release();
    expect(again.sessions[0]!.candidates.length).toBe(1);
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
