import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDb } from "../src/sqlite.js";
import { openStore, type Card, type Store } from "../src/store.js";
import {
  cardsLiteFromSessions,
  createCardsRuntime,
  exclusionFamilyFromCards,
} from "../src/cards.js";
import { exclusionFamily } from "../src/search.js";
import { parseQuery } from "../src/query.js";
import { makeEvalCorpus } from "./eval/corpus.js";

const tmpDirs: string[] = [];
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-cards-"));
  tmpDirs.push(dir);
  return join(dir, "store.db");
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function freshStore(): Promise<{ db: SqliteDb; store: Store }> {
  const db = await openSqlite(freshDbPath());
  if (!db) throw new Error("openSqlite returned null");
  const store = openStore(db);
  if (!store) throw new Error("openStore returned null");
  return { db, store };
}

function makeCard(sessionId: string, over: Partial<Card> = {}): Card {
  return {
    sessionId,
    parentId: null,
    rootId: sessionId,
    title: "",
    slug: sessionId,
    directory: "",
    projectId: "",
    agent: null,
    model: null,
    timeCreated: 1000,
    timeUpdated: 2000,
    partCount: 1,
    retainedChars: 1,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "full",
    distilledThrough: "m1",
    embedding: null,
    ...over,
  };
}

const storeSource = (store: Store) => ({
  getCards: () => store.allCards(),
  revision: () => store.getMeta("cards_rev"),
});

const ids = (hits: { sessionId: string }[]): string[] => hits.map((h) => h.sessionId);

describe("cards tier-1 rank", () => {
  it("ranks the session whose card matches the query first", async () => {
    const { db, store } = await freshStore();
    store.upsertCard(
      makeCard("s-rate", {
        title: "Rate limit middleware",
        inventory: "ratelimit token bucket checkout",
      }),
    );
    store.upsertCard(
      makeCard("s-db", { title: "Postgres migration", inventory: "postgres dynamodb migration" }),
    );
    store.upsertCard(
      makeCard("s-noise", { title: "General refactoring", inventory: "cleanup rename" }),
    );
    const runtime = createCardsRuntime({ source: storeSource(store) });

    expect(ids(runtime.rank(parseQuery("token bucket rate limit"), {}))[0]).toBe("s-rate");
    expect(ids(runtime.rank(parseQuery("postgres migration"), {}))[0]).toBe("s-db");
    db.close();
  });

  it("boosts an exact code-token hit in the inventory", async () => {
    const { db, store } = await freshStore();
    // Both match "launch"+"terminal" lexically; only s-flow has the verbatim compound.
    store.upsertCard(makeCard("s-flow", { inventory: "launchTerminal tuistory workflow" }));
    store.upsertCard(makeCard("s-docs", { inventory: "launch terminal docs review" }));
    const runtime = createCardsRuntime({ source: storeSource(store) });

    expect(ids(runtime.rank(parseQuery("launchTerminal"), {}))[0]).toBe("s-flow");
    db.close();
  });

  it("applies since/until, agent, scope, and directory filters", async () => {
    const { db, store } = await freshStore();
    store.upsertCard(
      makeCard("s-old", {
        inventory: "widget parser",
        timeUpdated: 1000,
        directory: "/a",
        projectId: "pa",
        agent: "build",
      }),
    );
    store.upsertCard(
      makeCard("s-new", {
        inventory: "widget parser",
        timeUpdated: 9000,
        directory: "/b",
        projectId: "pb",
        agent: "plan",
      }),
    );
    const runtime = createCardsRuntime({ source: storeSource(store) });
    const q = parseQuery("widget parser");

    expect(ids(runtime.rank(q, { since: 5000 }))).toEqual(["s-new"]);
    expect(ids(runtime.rank(q, { until: 5000 }))).toEqual(["s-old"]);
    expect(ids(runtime.rank(q, { agent: "plan" }))).toEqual(["s-new"]);
    expect(ids(runtime.rank(q, { directoryFilter: "/a" }))).toEqual(["s-old"]);
    expect(ids(runtime.rank(q, { scope: "exact", directory: "/b" }))).toEqual(["s-new"]);
    expect(ids(runtime.rank(q, { scope: "project", projectId: "pa" }))).toEqual(["s-old"]);
    db.close();
  });

  it("excludes the current session's family", async () => {
    const { db, store } = await freshStore();
    store.upsertCard(makeCard("root", { inventory: "auth login debug" }));
    store.upsertCard(
      makeCard("child", { inventory: "auth login debug", parentId: "root", rootId: "root" }),
    );
    store.upsertCard(makeCard("other", { inventory: "auth login debug" }));
    const runtime = createCardsRuntime({ source: storeSource(store) });

    const result = ids(runtime.rank(parseQuery("auth login debug"), { excludeFamilyOf: "child" }));
    expect(result).toContain("other");
    expect(result).not.toContain("root");
    expect(result).not.toContain("child");
    db.close();
  });

  it("reloads lazily on a revision change past the refresh interval", async () => {
    const { db, store } = await freshStore();
    let clock = 1_000_000;
    store.upsertCard(makeCard("s1", { inventory: "alpha beta" }));
    store.setMeta("cards_rev", "1");
    const runtime = createCardsRuntime({
      source: storeSource(store),
      now: () => clock,
      refreshIntervalMs: 5000,
    });

    expect(ids(runtime.rank(parseQuery("alpha"), {}))).toContain("s1");

    // New card + bumped revision, but within the refresh interval → not visible.
    store.upsertCard(makeCard("s2", { inventory: "alpha gamma" }));
    store.setMeta("cards_rev", "2");
    clock += 4000;
    expect(ids(runtime.rank(parseQuery("alpha"), {}))).not.toContain("s2");

    // Past the interval with a changed revision → reload picks it up.
    clock += 2000;
    expect(ids(runtime.rank(parseQuery("alpha"), {}))).toContain("s2");
    db.close();
  });

  it("blends a semantic signal so a lexically-disjoint card can outrank", async () => {
    // Fake embedder: any text mentioning the query anchor ("limiting") or the
    // semantically-close target ("walkthrough") maps to one axis, everything
    // else to the orthogonal axis — a lexically-disjoint card reaches cosine 1.
    const embedder = {
      ready: true,
      embed(text: string): Float32Array | undefined {
        const lower = text.toLowerCase();
        const aligned = lower.includes("limiting") || lower.includes("walkthrough");
        return Float32Array.from(aligned ? [1, 0] : [0, 1]);
      },
    };
    const { db, store } = await freshStore();
    // Neither card shares a content word with the query.
    store.upsertCard(makeCard("s-close", { inventory: "actualyze walkthrough pages" }));
    store.upsertCard(makeCard("s-far", { inventory: "postgres migration ledger" }));
    const runtime = createCardsRuntime({
      source: storeSource(store),
      embedder,
      semanticWeight: 0.5,
    });

    const ranked = ids(runtime.rank(parseQuery("checkout rate limiting"), {}));
    expect(ranked[0]).toBe("s-close");
    db.close();
  });

  it("ranks metadata-only cards-lite in degraded mode", () => {
    const liteCards = cardsLiteFromSessions([
      { id: "a", title: "Rate limit middleware", directory: "/p", time: { updated: 2000 } },
      { id: "b", title: "Postgres migration", directory: "/p", time: { updated: 1000 } },
    ]);
    const runtime = createCardsRuntime({
      source: { getCards: () => liteCards, revision: () => undefined, degraded: true },
    });
    expect(ids(runtime.rank(parseQuery("rate limit"), {}))[0]).toBe("a");
    expect(runtime.coverage()).toEqual({
      totalCards: 2,
      fullCards: 0,
      storeRecency: 0,
      degraded: true,
    });
  });
});

describe("cards exclusion family", () => {
  it("derives the SAME family from cards as exclusionFamily() derives from discovery", () => {
    const corpus = makeEvalCorpus();
    const metas = corpus.globalSessions.map((s) => ({
      id: s.id,
      title: s.title,
      directory: s.directory,
      updated: s.time.updated,
      parentID: s.parentID,
    }));
    const liteCards = cardsLiteFromSessions(corpus.globalSessions);

    // Same fixture, both derivation paths, same set — including the e-cur family.
    for (const id of ["e-cur", "e-cur-sub", "e-auth", "e-flow", "e-other"]) {
      const fromCards = [...exclusionFamilyFromCards(liteCards, id)].sort();
      const fromDiscovery = [...exclusionFamily(metas, id)].sort();
      expect(fromCards, `family(${id})`).toEqual(fromDiscovery);
    }
  });
});
