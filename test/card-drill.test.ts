import { describe, expect, it } from "vitest";
import { createCardDrill } from "../src/card-drill.js";
import { createCardsRuntime } from "../src/cards.js";
import { candidateFilter } from "../src/candidates.js";
import type { DrillTarget, TimeWindow } from "../src/drill.js";
import { parseQuery } from "../src/query.js";
import type { Card } from "../src/store.js";
import { PROJECT_DIR } from "./helpers.js";

/**
 * The card drill offers a session's title as a candidate of its own, dated
 * by the card. A time-bounded search selects a session that overlaps its
 * window, so a session that kept running past the window's upper bound has
 * its title dated inside the window, where the query's time filter keeps it.
 */

const BEFORE = 10_000;

function makeCard(sessionId: string, timeCreated: number, timeUpdated: number): Card {
  return {
    sessionId,
    parentId: null,
    rootId: sessionId,
    title: "Quokka migration plan",
    slug: sessionId,
    directory: PROJECT_DIR,
    projectId: "project-main",
    agent: null,
    model: null,
    timeCreated,
    timeUpdated,
    partCount: 0,
    retainedChars: 0,
    summaryHead: "",
    outcomeHead: "",
    inventory: "",
    files: [],
    tools: [],
    errors: [],
    familyRollup: [],
    distillState: "metadata",
    distilledThrough: null,
    embedding: null,
    embeddingGen: null,
    nlSummary: "",
    summaryHash: "",
  };
}

const target = (sessionId: string, timeUpdated: number): DrillTarget => ({
  sessionId,
  title: "Quokka migration plan",
  directory: PROJECT_DIR,
  timeUpdated,
  parentID: null,
});

/** The title candidate the card drill offers for `t`, with the time filter
 *  of `window` applied when `filtered`. */
async function titleOf(
  cards: Card[],
  t: DrillTarget,
  window: TimeWindow | undefined,
  filtered = false,
): Promise<{ time: number } | undefined> {
  const runtime = createCardsRuntime({ source: { getCards: () => cards, revision: () => "1" } });
  await runtime.ready();
  const filters = { type: "all", role: "all", ...window };
  const drill = createCardDrill(runtime, { filters, authorshipNarrowed: false });
  const out = await drill.pools({
    sessions: [t],
    deepSet: new Set(),
    query: parseQuery("Quokka"),
    mode: "smart",
    explain: false,
    searchTitles: true,
    ...(window && { window }),
    ...(filtered && { filter: candidateFilter(filters) }),
  });
  const title = out.pools[0]?.candidates.find((c) => c.partType === "title");
  return title && { time: title.time };
}

describe("card drill title dating", () => {
  it("dates the title by the card's last update without an upper bound", async () => {
    const card = makeCard("s-a", 1_000, 50_000);
    expect(await titleOf([card], target("s-a", 50_000), undefined)).toEqual({ time: 50_000 });
    expect(await titleOf([card], target("s-a", 50_000), { after: 500 })).toEqual({ time: 50_000 });
  });

  it("dates the title by the card's last update when the session ended before the upper bound", async () => {
    const card = makeCard("s-a", 1_000, BEFORE - 1);
    expect(await titleOf([card], target("s-a", BEFORE - 1), { before: BEFORE })).toEqual({
      time: BEFORE - 1,
    });
  });

  it("dates the title just inside the upper bound when the session ran past it", async () => {
    for (const updated of [BEFORE, BEFORE + 40_000]) {
      const card = makeCard("s-a", 1_000, updated);
      const window = { after: 500, before: BEFORE };
      expect(await titleOf([card], target("s-a", updated), window), String(updated)).toEqual({
        time: BEFORE - 1,
      });
      // So the query's own time filter keeps it.
      expect(await titleOf([card], target("s-a", updated), window, true)).toEqual({
        time: BEFORE - 1,
      });
    }
  });

  it("keeps the card's last update for a session created at or after the upper bound", async () => {
    for (const created of [BEFORE, BEFORE + 1]) {
      const card = makeCard("s-a", created, BEFORE + 40_000);
      expect(
        await titleOf([card], target("s-a", BEFORE + 40_000), { before: BEFORE }),
        String(created),
      ).toEqual({ time: BEFORE + 40_000 });
    }
  });

  it("dates the title of a session without a card by its target's last update", async () => {
    expect(await titleOf([], target("s-none", BEFORE + 40_000), { before: BEFORE })).toEqual({
      time: BEFORE + 40_000,
    });
  });
});
