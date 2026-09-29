import type { Part, ToolState } from "@opencode-ai/sdk/v2";
import type { HistoryMessage, HistoryMessageInfo, HistorySession } from "./model.js";

/**
 * The v2 projector: maps `opencode.db` rows (`session_v2`, `session_message`,
 * `project`) into the read model the core already consumes, so `extract.ts`,
 * `candidates.ts`, `distill.ts` and `authorship.ts` read v2 history unchanged.
 * The field mapping follows opencode v2's `schema/src/session-message.ts`
 * and `core/src/session/sql.ts`.
 *
 * Pure and total: no I/O, and a row of the wrong shape degrades field by field
 * (a missing string becomes `""`, a missing number `0`) rather than throwing.
 * Only an unparseable `data` column is reported, as `malformed`, so the source
 * can skip it or, under `strict`, quarantine the session.
 */

// ── Row shapes (columns as selected by history/v2.ts) ────────────────────────

export type V2SessionRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string | null;
  version: string;
  agent: string | null;
  /** Raw JSON text: `{ id, providerID, variant? }`. */
  model: string | null;
  time_created: number;
  time_updated: number;
  time_idle: number | null;
  time_archived: number | null;
  project_name: string | null;
  project_worktree: string | null;
};

export type V2MessageRow = {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  /** The encoded message minus `id` and `type` (`core/src/session/sql.ts:22`). */
  data: string;
};

/** A v2 model reference (`schema/src/model.ts` `Model.Ref`). */
export type ModelRef = { id: string; providerID: string; variant?: string };

/** The agent and model a user-role message is attributed to. v2 user rows
 *  carry neither, but `formatMsg` reads `info.model.modelID`. */
export type UserIdentity = { agent: string; model: ModelRef };

/** What the projector needs to know about the owning session. */
export type SessionContext = {
  id: string;
  directory: string;
  agent: string | null;
  model: ModelRef | null;
};

/** Message types that carry content. Everything else (`system`, `idle`,
 *  `agent-switched`, `model-switched`, `location-switched`, and unknown future
 *  types) is not content; `compaction` counts only once completed. */
export const CONTENT_TYPES = ["user", "synthetic", "skill", "shell", "assistant", "compaction"];

/** The marker the v1-to-v2 migration wrote in place of tool output that v1
 *  compaction had pruned (`core/src/database/v1-migration.bun.ts:975`). */
export const CLEARED_TOOL_OUTPUT = "[Old tool result content cleared]";

// ── Small defensive readers ──────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function obj(value: unknown): Obj {
  return isObj(value) ? value : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Parse a `Model.Ref` from decoded JSON or a raw JSON string. */
export function parseModelRef(value: unknown): ModelRef | undefined {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isObj(decoded)) return undefined;
  const id = str(decoded.id);
  if (!id) return undefined;
  const ref: ModelRef = { id, providerID: str(decoded.providerID) };
  if (typeof decoded.variant === "string") ref.variant = decoded.variant;
  return ref;
}

/** Last path segment, ignoring trailing separators (`node:path` basename). */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(cut + 1);
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Normalized recency: `max(time_updated, time_idle)`. v2 does not move
 * `time_updated` on assistant output or on going idle
 * (`core/src/session/projector.ts:58-73,403-431`); `time_idle` does.
 */
export function sessionRecency(row: Pick<V2SessionRow, "time_updated" | "time_idle">): number {
  return Math.max(num(row.time_updated), num(row.time_idle));
}

export function projectSession(row: V2SessionRow): HistorySession {
  const session: HistorySession = {
    id: row.id,
    slug: str(row.slug),
    projectID: str(row.project_id),
    directory: str(row.directory),
    title: str(row.title),
    version: str(row.version),
    time: { created: num(row.time_created), updated: sessionRecency(row) },
  };
  // Roots omit `parentID`, as the v1 SDK does. Forks have `parent_id` NULL
  // and are roots too.
  if (row.parent_id) session.parentID = row.parent_id;
  if (row.agent) session.agent = row.agent;
  const model = parseModelRef(row.model);
  if (model) session.model = model;
  if (row.time_archived != null) session.time.archived = num(row.time_archived);
  if (typeof row.project_worktree === "string") {
    session.project = {
      id: str(row.project_id),
      // `project.name` is NULL for every project on the measured machine.
      name: row.project_name || basename(row.project_worktree),
      worktree: row.project_worktree,
    };
  }
  return session;
}

export function sessionContext(row: V2SessionRow): SessionContext {
  return {
    id: row.id,
    directory: str(row.directory),
    agent: row.agent || null,
    model: parseModelRef(row.model) ?? null,
  };
}

// ── Message decoding ─────────────────────────────────────────────────────────

export type DecodedRow =
  | { ok: true; row: V2MessageRow; data: Obj }
  | { ok: false; row: V2MessageRow; reason: string };

/** Parse a row's `data` column; the `id`/`type` columns are authoritative. */
export function decodeRow(row: V2MessageRow): DecodedRow {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    return { ok: false, row, reason: `message ${row.id} data is not valid JSON` };
  }
  if (!isObj(data)) return { ok: false, row, reason: `message ${row.id} data is not an object` };
  return { ok: true, row, data };
}

/** Whether a decoded row carries content (see {@link CONTENT_TYPES}). */
export function isContentRow(decoded: { row: V2MessageRow; data: Obj }): boolean {
  if (!CONTENT_TYPES.includes(decoded.row.type)) return false;
  if (decoded.row.type === "compaction") return decoded.data.status === "completed";
  return true;
}

/** Whether a message type is attributed to the user role. */
export function isUserRoleType(type: string): boolean {
  return type === "user" || type === "synthetic" || type === "skill" || type === "shell";
}

/** Partial identity carried by a row: an assistant's own agent/model, or a
 *  switch row's new value. Used by the source to attribute user rows. */
export function identityOf(decoded: { row: V2MessageRow; data: Obj }): Partial<UserIdentity> {
  const { type } = decoded.row;
  const data = decoded.data;
  if (type === "assistant") {
    const out: Partial<UserIdentity> = {};
    if (typeof data.agent === "string" && data.agent) out.agent = data.agent;
    const model = parseModelRef(data.model);
    if (model) out.model = model;
    return out;
  }
  if (type === "agent-switched") {
    return typeof data.agent === "string" && data.agent ? { agent: data.agent } : {};
  }
  if (type === "model-switched") {
    const model = parseModelRef(data.model);
    return model ? { model } : {};
  }
  return {};
}

/**
 * Resolve a user row's agent and model from candidates in priority order
 * (latest preceding switch, then the next assistant, then the session), each
 * field independently. Always yields strings, never undefined.
 */
export function resolveIdentity(
  candidates: Array<Partial<UserIdentity> | undefined>,
  session: SessionContext,
): UserIdentity {
  let agent: string | undefined;
  let model: ModelRef | undefined;
  for (const candidate of candidates) {
    agent ??= candidate?.agent;
    model ??= candidate?.model;
  }
  return {
    agent: agent ?? session.agent ?? "",
    model: model ?? session.model ?? { id: "", providerID: "" },
  };
}

// ── Message projection ───────────────────────────────────────────────────────

type PartBase = { id: string; sessionID: string; messageID: string };

function toolPart(base: PartBase, callID: string, tool: string, state: ToolState): Part {
  return { ...base, type: "tool", callID, tool, state };
}

/** A completed tool state from v2 `state.content`: text entries joined, file
 *  entries (data URIs) never indexed, only `toolCalls` kept from metadata. */
function completedState(
  input: Obj,
  content: unknown[],
  metadata: unknown,
  time: { start: number; end: number },
  clearedAt: number,
): ToolState {
  const texts = content.filter(
    (entry): entry is { type: "text"; text: string } =>
      isObj(entry) && entry.type === "text" && typeof entry.text === "string",
  );
  const cleared =
    content.length === 1 && texts.length === 1 && texts[0]!.text === CLEARED_TOOL_OUTPUT;
  const toolCalls = obj(metadata).toolCalls;
  return {
    status: "completed",
    input,
    output: cleared ? "" : texts.map((entry) => entry.text).join("\n"),
    // v2 has no tool title.
    title: "",
    metadata: Array.isArray(toolCalls) ? { toolCalls } : {},
    // The cleared marker projects as a pruned output (`pruned()` reads
    // `time.compacted`), so its many copies stay out of every index.
    time: cleared ? { ...time, compacted: clearedAt } : time,
  };
}

function errorMessageOf(error: unknown): string {
  if (typeof error === "string") return error;
  const shaped = obj(error);
  return str(shaped.message) || str(shaped.type) || "unknown error";
}

function assistantContentPart(
  base: PartBase,
  item: unknown,
  messageCreated: number,
  rowUpdated: number,
): Part | undefined {
  if (!isObj(item)) return undefined;
  switch (item.type) {
    case "text":
      return { ...base, type: "text", text: str(item.text) };
    case "reasoning": {
      const time = obj(item.time);
      return {
        ...base,
        type: "reasoning",
        text: str(item.text),
        time: { start: num(time.created, messageCreated) },
      };
    }
    case "tool": {
      const state = obj(item.state);
      const time = obj(item.time);
      const start = num(time.created, messageCreated);
      const end = num(time.completed, start);
      const input = obj(state.input);
      const callID = str(item.id);
      const name = str(item.name);
      switch (state.status) {
        case "streaming":
          // The input is a partial JSON string; never parsed.
          return toolPart(base, callID, name, { status: "pending", input: {}, raw: "" });
        case "running": {
          // Like completed and error: only `toolCalls` survives from metadata.
          const toolCalls = obj(state.metadata).toolCalls;
          return toolPart(base, callID, name, {
            status: "running",
            input,
            ...(Array.isArray(toolCalls) ? { metadata: { toolCalls } } : {}),
            time: { start },
          });
        }
        case "completed":
          return toolPart(
            base,
            callID,
            name,
            completedState(
              input,
              arr(state.content),
              state.metadata,
              { start, end },
              num(time.completed, rowUpdated),
            ),
          );
        case "error": {
          const toolCalls = obj(state.metadata).toolCalls;
          return toolPart(base, callID, name, {
            status: "error",
            input,
            error: errorMessageOf(state.error),
            ...(Array.isArray(toolCalls) ? { metadata: { toolCalls } } : {}),
            time: { start, end },
          });
        }
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

function tokensOf(value: unknown): {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
} {
  const tokens = obj(value);
  const cache = obj(tokens.cache);
  return {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cache: { read: num(cache.read), write: num(cache.write) },
  };
}

function assistantInfo(
  row: V2MessageRow,
  session: SessionContext,
  fields: {
    agent: string;
    model: ModelRef | null;
    completed?: number;
    cost?: unknown;
    tokens?: unknown;
    finish?: unknown;
    summary?: boolean;
  },
): HistoryMessageInfo {
  const info: HistoryMessageInfo = {
    id: row.id,
    sessionID: row.session_id,
    role: "assistant",
    seq: row.seq,
    time: { created: row.time_created },
    // v2 does not link an assistant to a user message id.
    parentID: "",
    modelID: fields.model?.id ?? "",
    providerID: fields.model?.providerID ?? "",
    mode: fields.agent,
    agent: fields.agent,
    path: { cwd: session.directory, root: session.directory },
    cost: num(fields.cost),
    tokens: tokensOf(fields.tokens),
  };
  if (fields.completed !== undefined) info.time.completed = fields.completed;
  if (typeof fields.finish === "string") info.finish = fields.finish;
  if (fields.summary) info.summary = true;
  return info;
}

function userInfo(row: V2MessageRow, identity: UserIdentity): HistoryMessageInfo {
  const model: { providerID: string; modelID: string; variant?: string } = {
    providerID: identity.model.providerID,
    modelID: identity.model.id,
  };
  if (identity.model.variant !== undefined) model.variant = identity.model.variant;
  return {
    id: row.id,
    sessionID: row.session_id,
    role: "user",
    seq: row.seq,
    time: { created: row.time_created },
    agent: identity.agent,
    model,
  };
}

/**
 * Project one decoded content row. Returns `undefined` for a row that is not
 * content (see {@link isContentRow}). `identity` attributes user-role rows and
 * is ignored for assistant and compaction rows.
 *
 * Part ids are `${messageId}:<suffix>`: deterministic, unique
 * (message ids are the table's primary key), and free of `#`, which the
 * distiller appends to them. Tool call ids repeat across sessions and are
 * never used.
 */
export function projectMessage(
  decoded: { row: V2MessageRow; data: Obj },
  session: SessionContext,
  identity: UserIdentity,
): HistoryMessage | undefined {
  if (!isContentRow(decoded)) return undefined;
  const { row, data } = decoded;
  const at = (suffix: string): PartBase => ({
    id: `${row.id}:${suffix}`,
    sessionID: row.session_id,
    messageID: row.id,
  });
  const time = obj(data.time);

  switch (row.type) {
    case "user": {
      const parts: Part[] = [];
      // An empty text is how migrated v1 ignored-only messages look.
      const text = str(data.text);
      if (text) parts.push({ ...at("t"), type: "text", text });
      arr(data.files).forEach((file, i) => {
        const f = obj(file);
        const mime = str(f.mime);
        // No data URI: attachment bytes are never read or indexed.
        parts.push({ ...at(`f${i}`), type: "file", mime, filename: str(f.name) || mime, url: "" });
      });
      arr(data.agents).forEach((agent, i) => {
        parts.push({ ...at(`a${i}`), type: "agent", name: str(obj(agent).name) });
      });
      // Skills attached to the prompt: a completed `skill` tool part each, the
      // shape of the standalone `skill` message type, so the skill text is
      // searchable and classified as injected, not typed.
      arr(data.skills).forEach((skill, i) => {
        const sk = obj(skill);
        const created = row.time_created;
        parts.push(
          toolPart(at(`s${i}`), `${row.id}:s${i}`, "skill", {
            status: "completed",
            input: { id: str(sk.id), name: str(sk.name) },
            output: str(sk.text),
            title: "",
            metadata: {},
            time: { start: created, end: created },
          }),
        );
      });
      return { info: userInfo(row, identity), parts };
    }
    case "synthetic": {
      const text = str(data.text);
      const parts: Part[] = text ? [{ ...at("0"), type: "text", text, synthetic: true }] : [];
      return { info: userInfo(row, identity), parts };
    }
    case "skill": {
      const created = row.time_created;
      const part = toolPart(at("0"), row.id, "skill", {
        status: "completed",
        input: { id: str(data.skill), name: str(data.name) },
        output: str(data.text),
        title: "",
        metadata: {},
        time: { start: created, end: created },
      });
      return { info: userInfo(row, identity), parts: [part] };
    }
    case "shell": {
      const start = row.time_created;
      const end = num(time.completed, start);
      const input = { command: str(data.command) };
      const output = str(obj(data.output).output);
      const status = str(data.status);
      let state: ToolState;
      if (status === "running") {
        state = { status: "running", input, time: { start } };
      } else if (status === "exited" && data.exit === 0) {
        state = {
          status: "completed",
          input,
          output,
          title: "",
          metadata: {},
          time: { start, end },
        };
      } else {
        const exit = typeof data.exit === "number" ? ` (exit ${data.exit})` : "";
        state = {
          status: "error",
          input,
          error: output || `shell ${status || "failed"}${exit}`,
          time: { start, end },
        };
      }
      return { info: userInfo(row, identity), parts: [toolPart(at("0"), row.id, "shell", state)] };
    }
    case "assistant": {
      const parts: Part[] = [];
      arr(data.content).forEach((item, i) => {
        const part = assistantContentPart(at(String(i)), item, row.time_created, row.time_updated);
        if (part) parts.push(part);
      });
      const completed = typeof time.completed === "number" ? time.completed : undefined;
      const info = assistantInfo(row, session, {
        agent: str(data.agent) || session.agent || "",
        model: parseModelRef(data.model) ?? session.model,
        completed,
        cost: data.cost,
        tokens: data.tokens,
        finish: data.finish,
      });
      return { info, parts };
    }
    case "compaction": {
      const parts: Part[] = [{ ...at("c"), type: "compaction", auto: data.reason === "auto" }];
      // `recent` re-serializes the tail that follows; it is not indexed.
      const summary = str(data.summary);
      if (summary) parts.push({ ...at("s"), type: "text", text: summary });
      const info = assistantInfo(row, session, {
        agent: session.agent ?? "",
        model: parseModelRef(data.model) ?? session.model,
        cost: data.cost,
        tokens: data.tokens,
        summary: true,
      });
      return { info, parts };
    }
    default:
      return undefined;
  }
}
