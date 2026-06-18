/**
 * Relevance evaluation corpus.
 *
 * A purpose-built, labeled history corpus that exercises ranking quality
 * distinctions the production search must get right:
 *
 *  - rare discriminative terms vs. boilerplate saturation (IDF)
 *  - tight relevant message vs. long tool dump that merely mentions terms
 *    (field-length normalization)
 *  - typo tolerance
 *  - multi-term coverage
 *  - exact-phrase preference
 *  - cross-session / cross-project recall
 *  - old-but-strong vs. recent-but-weak
 *
 * The corpus is intentionally separate from `makeFixture` in helpers.ts so
 * eval cases stay stable even if the unit-test fixture changes.
 */
import type { GlobalSession, Message, Part, Session } from "@opencode-ai/sdk/v2";
import {
  assistantMessage,
  bundle,
  completedToolPart,
  errorToolPart,
  globalSessionFrom,
  reasoningPart,
  session,
  textPart,
  userMessage,
  PROJECT_DIR,
  OTHER_DIR,
} from "../helpers.js";

export type MessageBundle = { info: Message; parts: Part[] };

export type EvalCorpus = {
  sessions: Session[];
  globalSessions: GlobalSession[];
  messagesBySession: Record<string, MessageBundle[]>;
};

/** Filler text full of boilerplate tokens that recur across the whole corpus. */
const BOILERPLATE =
  "error failed session message config result typescript src tool output update " +
  "function const return import export test build run check log value data type";

/** Repeat boilerplate to simulate a long, low-signal document. */
function longFiller(times: number): string {
  return Array.from({ length: times }, () => BOILERPLATE).join(" ");
}

export function makeEvalCorpus(now = Date.now()): EvalCorpus {
  // ── Sessions across two projects ─────────────────────────────────────
  const sAuth = session("e-auth", "OAuth redirect loop fix", PROJECT_DIR, now - 10_000);
  const sRate = session("e-rate", "Rate limit middleware", PROJECT_DIR, now - 20_000);
  const sDb = session("e-db", "Postgres migration decision", PROJECT_DIR, now - 30_000);
  const sNoise = session("e-noise", "General refactoring", PROJECT_DIR, now - 5_000);
  const sOther = session("e-other", "Deploy pipeline", OTHER_DIR, now - 40_000);

  const messagesBySession: Record<string, MessageBundle[]> = {
    // ── e-auth: rare-term recall + exact phrase ────────────────────────
    [sAuth.id]: [
      bundle(userMessage("ea-1", sAuth.id, now - 100_000), [
        textPart(
          "ea-1p",
          sAuth.id,
          "ea-1",
          "The login callback keeps looping after the OAuth provider redirect. " +
            "We need to fix the ECONNREFUSED retry on the token endpoint.",
        ),
      ]),
      bundle(assistantMessage("ea-2", sAuth.id, now - 99_000), [
        reasoningPart(
          "ea-2p",
          sAuth.id,
          "ea-2",
          "The redirect loop happens because the state cookie is dropped. " +
            "Resolved login callback loop after OAuth provider redirect by setting SameSite=Lax.",
        ),
      ]),
      // Long boilerplate-heavy tool dump that mentions "redirect" once.
      bundle(assistantMessage("ea-3", sAuth.id, now - 98_000), [
        completedToolPart(
          "ea-3p",
          sAuth.id,
          "ea-3",
          "bash",
          { command: "npm run build" },
          longFiller(40) + " redirect " + longFiller(40),
          { title: "Build output" },
        ),
      ]),
    ],

    // ── e-rate: multi-term coverage + tight message vs long dump ───────
    [sRate.id]: [
      bundle(userMessage("er-1", sRate.id, now - 90_000), [
        textPart(
          "er-1p",
          sRate.id,
          "er-1",
          "Implement rate limit middleware for the checkout API using a token bucket.",
        ),
      ]),
      // Long tool dump that contains the words but is not "about" them.
      bundle(assistantMessage("er-2", sRate.id, now - 89_000), [
        completedToolPart(
          "er-2p",
          sRate.id,
          "er-2",
          "bash",
          { command: "npm test" },
          longFiller(30) + " rate limit middleware token " + longFiller(60),
          { title: "Test run" },
        ),
      ]),
      bundle(assistantMessage("er-3", sRate.id, now - 88_000), [
        reasoningPart(
          "er-3p",
          sRate.id,
          "er-3",
          "Chose a token bucket rate limiter over a sliding window for the checkout middleware.",
        ),
      ]),
    ],

    // ── e-db: decision recall + reasoning ──────────────────────────────
    [sDb.id]: [
      bundle(userMessage("ed-1", sDb.id, now - 80_000), [
        textPart("ed-1p", sDb.id, "ed-1", "Should we use Postgres or DynamoDB for the ledger?"),
      ]),
      bundle(assistantMessage("ed-2", sDb.id, now - 79_000), [
        reasoningPart(
          "ed-2p",
          sDb.id,
          "ed-2",
          "We chose Postgres over DynamoDB because the ledger needs multi-row transactions.",
        ),
      ]),
    ],

    // ── e-noise: boilerplate-only session, should rarely win ───────────
    [sNoise.id]: [
      bundle(assistantMessage("en-1", sNoise.id, now - 50_000), [
        completedToolPart(
          "en-1p",
          sNoise.id,
          "en-1",
          "bash",
          { command: "npm run lint" },
          longFiller(80),
          { title: "Lint" },
        ),
      ]),
      // Recent but weak: mentions "rate" once amid noise. Recency must not
      // let this outrank the strong older e-rate hits for a rate query.
      bundle(assistantMessage("en-2", sNoise.id, now - 1_000), [
        textPart("en-2p", sNoise.id, "en-2", "Minor cleanup; touched the rate variable name."),
      ]),
    ],

    // ── e-other: cross-project error recall ────────────────────────────
    [sOther.id]: [
      bundle(assistantMessage("eo-1", sOther.id, now - 70_000), [
        errorToolPart(
          "eo-1p",
          sOther.id,
          "eo-1",
          "bash",
          { command: "kubectl apply -f deploy.yaml" },
          "permission denied: cannot create resource configmaps in namespace prod",
        ),
      ]),
    ],
  };

  const sessions = [sAuth, sRate, sDb, sNoise];
  const globalSessions = [sAuth, sRate, sDb, sNoise, sOther].map(globalSessionFrom);

  return { sessions, globalSessions, messagesBySession };
}
