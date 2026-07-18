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
  GHOST_DIR,
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

/** A long generated skill payload rich in tuistory vocabulary — reference
 *  material that must not outrank concrete actions for workflow queries. */
function tuistorySkillPayload(): string {
  return (
    "# tuistory\n\ntmux for AI agents. Run dev servers and TUIs in named background " +
    "sessions that agents can read, wait on, snapshot, and type into. " +
    "Commands: tuistory launch <cmd> -s <name> --cols --rows --cwd --background; " +
    "tuistory -s <name> wait <pattern> --timeout; tuistory -s <name> type <text>; " +
    "tuistory -s <name> press enter; tuistory -s <name> snapshot; tuistory -s <name> " +
    "read --all; tuistory -s <name> close. Use launchTerminal from the JS API for " +
    "programmatic control and Playwright-style terminal tests. " +
    longFiller(30) +
    " tuistory launch wait type press snapshot close opencode plugin test debug " +
    longFiller(30)
  );
}

export function makeEvalCorpus(now = Date.now()): EvalCorpus {
  // ── Sessions across two projects ─────────────────────────────────────
  const sAuth = session("e-auth", "OAuth redirect loop fix", PROJECT_DIR, now - 10_000);
  const sRate = session("e-rate", "Rate limit middleware", PROJECT_DIR, now - 20_000);
  const sDb = session("e-db", "Postgres migration decision", PROJECT_DIR, now - 30_000);
  const sNoise = session("e-noise", "General refactoring", PROJECT_DIR, now - 5_000);
  const sOther = session("e-other", "Deploy pipeline", OTHER_DIR, now - 40_000);

  // ── Field-report sessions (docs/multikey-debugging-recall-field-report.md) ──
  // e-cur: the CURRENT conversation — repeats the historical query's vocabulary
  // because the user just asked for it, but contains no workflow evidence.
  const sCur = session("e-cur", "Multikey auth login debugging", PROJECT_DIR, now - 2_000);
  // e-cur-sub: a subagent spawned FROM e-cur that restates the query and
  // "findings" — the delegation-tree leak from round-2 dogfooding.
  const sCurSub = session(
    "e-cur-sub",
    "Evaluate recall search results",
    PROJECT_DIR,
    now - 1_500,
    undefined,
    "e-cur",
  );
  // e-flow: the useful workflow session. Misleading title on purpose; lives in
  // the ghostauth project; holds the real tuistory command sequence plus a
  // large generated skill payload that must not become the representative.
  const sFlow = session("e-flow", "Profile and audit CLI usage tracking", GHOST_DIR, now - 60_000);
  // e-docs: docs-review session — many mentions in large file reads, no actions.
  const sDocs = session("e-docs", "Ghostauth docs audit", GHOST_DIR, now - 50_000);
  // e-tui: unrelated recent TUI session in another directory.
  const sTui = session("e-tui", "Terminal UI spike", OTHER_DIR, now - 8_000);

  // ── Distill-then-search tier probes (round-4) ────────────────────────
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  // e-inv: card-INVENTORY needle. A distinctive SCREAMING_CASE token lives only
  // in a bash tool INPUT (never the title), so the distiller lifts it into the
  // card inventory (and the FTS index). A smart query on it is answered by the
  // tier-1 card ranker alone. Recent, so it is never a near-miss casualty.
  const sInv = session("e-inv", "Release deploy tuning", PROJECT_DIR, now - 6_000);
  // The three OLDEST sessions below are, by construction, the three the tier-1
  // recency near-miss fallback drops (the corpus has exactly 12 newer sessions,
  // and the fallback keeps only the newest 12). That is load-bearing:
  //   • e-fts reaches the shortlist ONLY through the tier-1.5 FTS tier, proving
  //     the FTS needle path (its card carries nothing the query matches).
  //   • e-out is never drilled by a non-deep query, so its output-only needle is
  //     an honest miss until an explicit deep sweep reaches it.
  // Keep e-out/e-fts/e-temp-old the three oldest if you extend the corpus.
  // e-fts: FTS-ONLY needle. A rare plain word ("florplaxle") appears only in a
  // reasoning part — a class the inventory samples weakly (reasoning is not
  // digest-bearing) and which is not a code token, so the card never carries it.
  const sFts = session("e-fts", "Cache layer notes", PROJECT_DIR, now - 8 * DAY);
  // e-out: OUTPUT-ONLY needle. "quaxolith" exists solely in a tool OUTPUT, which
  // the distiller never indexes — invisible to cards and FTS alike.
  const sOut = session("e-out", "Nightly log triage", PROJECT_DIR, now - 6 * DAY);
  // e-temp-old / e-temp-new: same query token, different `time.updated`, for the
  // since/until temporal-filter cases. 10 days vs 2 hours, split cleanly by a
  // "2d" bound.
  const sTempOld = session("e-temp-old", "Widget sync pass A", PROJECT_DIR, now - 10 * DAY);
  const sTempNew = session("e-temp-new", "Widget sync pass B", PROJECT_DIR, now - 2 * HOUR);

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

    // ── e-cur: current conversation, parrots the historical query ───────
    [sCur.id]: [
      bundle(userMessage("ec-1", sCur.id, now - 3_000), [
        textPart(
          "ec-1p",
          sCur.id,
          "ec-1",
          "The opencode-multikey plugin fails on auth login. Use recall to find how we " +
            "tested ghostauth plugins before with tuistory — the auth login debug workflow " +
            "for opencode plugin testing.",
        ),
      ]),
      bundle(assistantMessage("ec-2", sCur.id, now - 2_500), [
        textPart(
          "ec-2p",
          sCur.id,
          "ec-2",
          "Searching prior history for the ghostauth tuistory test workflow now.",
        ),
      ]),
    ],

    // ── e-cur-sub: delegation-tree echo of the current conversation ─────
    [sCurSub.id]: [
      bundle(assistantMessage("ecs-1", sCurSub.id, now - 1_400), [
        textPart(
          "ecs-1p",
          sCurSub.id,
          "ecs-1",
          "Findings: the ghostauth tuistory test workflow for the opencode plugin " +
            "auth login debug involved launching the TUI. Query terms repeated: " +
            "ghostauth tuistory test opencode plugin auth login debug workflow.",
        ),
      ]),
    ],

    // ── e-flow: the real workflow session (misleading title) ────────────
    [sFlow.id]: [
      bundle(userMessage("ef-1", sFlow.id, now - 100_000), [
        textPart(
          "ef-1p",
          sFlow.id,
          "ef-1",
          "Run an interactive test of the ghostauth opencode plugin: drive the real " +
            "TUI with tuistory and verify auth login end to end.",
        ),
      ]),
      bundle(assistantMessage("ef-2", sFlow.id, now - 99_000), [
        completedToolPart(
          "ef-2p",
          sFlow.id,
          "ef-2",
          "skill",
          { skill: "tuistory" },
          tuistorySkillPayload(),
          { title: "tuistory skill" },
        ),
      ]),
      bundle(assistantMessage("ef-2c", sFlow.id, now - 98_600), [
        completedToolPart(
          "ef-2cp",
          sFlow.id,
          "ef-2c",
          "skill",
          { skill: "tuistory" },
          "tuistory skill quick reference. " + tuistorySkillPayload(),
          { title: "tuistory skill reference" },
        ),
      ]),
      bundle(assistantMessage("ef-2b", sFlow.id, now - 98_500), [
        completedToolPart(
          "ef-2bp",
          sFlow.id,
          "ef-2b",
          "skill",
          { skill: "tuistory" },
          "tuistory skill addendum: opencode-specific notes. " + tuistorySkillPayload(),
          { title: "tuistory skill addendum" },
        ),
      ]),
      bundle(assistantMessage("ef-3", sFlow.id, now - 98_000), [
        completedToolPart(
          "ef-3p",
          sFlow.id,
          "ef-3",
          "bash",
          { command: 'npx tuistory launch "opencode" -s t1 --cols 160 --rows 50 --background' },
          "session t1 started",
          { title: "Launch opencode in tuistory" },
        ),
      ]),
      bundle(assistantMessage("ef-4", sFlow.id, now - 97_000), [
        completedToolPart(
          "ef-4p",
          sFlow.id,
          "ef-4",
          "bash",
          { command: 'tuistory -s t1 wait "/Ask anything/i" --timeout 35000' },
          "matched",
          { title: "Wait for prompt" },
        ),
        completedToolPart(
          "ef-4q",
          sFlow.id,
          "ef-4",
          "bash",
          { command: 'tuistory -s t1 type "/usage"' },
          "typed",
          { title: "Type usage command" },
        ),
        completedToolPart(
          "ef-4r",
          sFlow.id,
          "ef-4",
          "bash",
          { command: "tuistory -s t1 press enter" },
          "pressed",
          { title: "Press enter" },
        ),
      ]),
      bundle(assistantMessage("ef-5", sFlow.id, now - 96_000), [
        completedToolPart(
          "ef-5p",
          sFlow.id,
          "ef-5",
          "read",
          { filePath: "/workspace/ghostauth/docs/testing.md" },
          longFiller(25) +
            " GHOSTAUTH_LIVE_TUI live smoke lane tuistory launch snapshot " +
            longFiller(25),
          { title: "Read testing docs" },
        ),
      ]),
      bundle(assistantMessage("ef-6", sFlow.id, now - 95_000), [
        textPart(
          "ef-6p",
          sFlow.id,
          "ef-6",
          "Wrote the live smoke test with launchTerminal from the tuistory JS API: " +
            "it drives opencode, waits for the prompt, and asserts the auth flow.",
        ),
      ]),
    ],

    // ── e-docs: docs review, mentions without actions ────────────────────
    [sDocs.id]: [
      bundle(assistantMessage("eg-1", sDocs.id, now - 55_000), [
        completedToolPart(
          "eg-1p",
          sDocs.id,
          "eg-1",
          "read",
          { filePath: "/workspace/ghostauth/README.md" },
          longFiller(40) +
            " GHOSTAUTH_LIVE_TUI tuistory ghostauth live TUI testing reference " +
            longFiller(40),
          { title: "Read README" },
        ),
      ]),
      bundle(assistantMessage("eg-2", sDocs.id, now - 54_000), [
        completedToolPart(
          "eg-2p",
          sDocs.id,
          "eg-2",
          "read",
          { filePath: "/workspace/ghostauth/docs/audit.md" },
          longFiller(35) + " tuistory ghostauth docs audit notes " + longFiller(35),
          { title: "Read audit doc" },
        ),
      ]),
    ],

    // ── e-tui: unrelated TUI work in another directory ───────────────────
    [sTui.id]: [
      bundle(userMessage("et-1", sTui.id, now - 9_000), [
        textPart(
          "et-1p",
          sTui.id,
          "et-1",
          "Spike a live TUI test harness with waitForText for the dashboard.",
        ),
      ]),
    ],

    // ── e-inv: card-inventory needle (distinctive token in a tool INPUT) ──
    [sInv.id]: [
      bundle(userMessage("ei-1", sInv.id, now - 7_000), [
        textPart("ei-1p", sInv.id, "ei-1", "Tune the release deploy flags for the prod stage."),
      ]),
      bundle(assistantMessage("ei-2", sInv.id, now - 6_500), [
        completedToolPart(
          "ei-2p",
          sInv.id,
          "ei-2",
          "bash",
          { command: "npm run deploy -- --token QUAXFLINT_CALIB --stage prod" },
          "deploy queued",
          { title: "Deploy" },
        ),
      ]),
    ],

    // ── e-fts: FTS-only needle (rare word only in a reasoning part) ───────
    [sFts.id]: [
      bundle(userMessage("eftq-1", sFts.id, now - 8 * DAY - 2_000), [
        textPart(
          "eftq-1p",
          sFts.id,
          "eftq-1",
          "Review the cache warming approach for cold starts.",
        ),
      ]),
      bundle(assistantMessage("eftq-2", sFts.id, now - 8 * DAY - 1_000), [
        reasoningPart(
          "eftq-2p",
          sFts.id,
          "eftq-2",
          "The cache miss cascade traces back to florplaxle eviction under sustained load; " +
            "florplaxle is the internal codename for the tiered eviction policy.",
        ),
      ]),
      bundle(assistantMessage("eftq-3", sFts.id, now - 8 * DAY), [
        textPart("eftq-3p", sFts.id, "eftq-3", "Documented the cache warming plan and next steps."),
      ]),
    ],

    // ── e-out: output-only needle ("quaxolith" only in a tool OUTPUT) ─────
    [sOut.id]: [
      bundle(userMessage("eou-1", sOut.id, now - 6 * DAY - 1_000), [
        textPart("eou-1p", sOut.id, "eou-1", "Review last night's batch job summary."),
      ]),
      bundle(assistantMessage("eou-2", sOut.id, now - 6 * DAY), [
        completedToolPart(
          "eou-2p",
          sOut.id,
          "eou-2",
          "bash",
          { command: "cat /var/log/nightly.log" },
          // Benign output (no error/failed/exception tokens) so the distiller
          // captures no error signature — the needle stays output-only.
          "job summary: quaxolith checksum verified for 42 rows",
          { title: "Read nightly log" },
        ),
      ]),
    ],

    // ── e-temp-old / e-temp-new: same token, different time.updated ───────
    [sTempOld.id]: [
      bundle(userMessage("eto-1", sTempOld.id, now - 10 * DAY), [
        textPart("eto-1p", sTempOld.id, "eto-1", "Handle the sprocketwidget rollout for batch A."),
      ]),
    ],
    [sTempNew.id]: [
      bundle(userMessage("etn-1", sTempNew.id, now - 2 * HOUR), [
        textPart("etn-1p", sTempNew.id, "etn-1", "Handle the sprocketwidget rollout for batch B."),
      ]),
    ],
  };

  const sessions = [sAuth, sRate, sDb, sNoise, sCur, sCurSub, sInv, sFts, sOut, sTempOld, sTempNew];
  const globalSessions = [
    sAuth,
    sRate,
    sDb,
    sNoise,
    sOther,
    sCur,
    sCurSub,
    sFlow,
    sDocs,
    sTui,
    sInv,
    sFts,
    sOut,
    sTempOld,
    sTempNew,
  ].map(globalSessionFrom);

  return { sessions, globalSessions, messagesBySession };
}
