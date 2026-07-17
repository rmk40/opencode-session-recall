import type {
  Part,
  ToolStateCompleted,
  Message,
  AssistantMessage,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import {
  TOOLS,
  type EvidenceClass,
  type PartOutput,
  type MessageItem,
  type ResultWhy,
} from "./types.js";

const INPUT_SEARCH_LIMIT = 10_000;
/** Separators a host may use when namespacing a tool (e.g. `mcp__server__recall`,
 *  `opencode-session-recall_recall`, `provider.recall`). */
const SELF_BOUNDARY = /[._/-]$/;
export type SearchableField = { field: ResultWhy["matchedFields"][number]; text: string };

/**
 * Whether a tool name is `base` or a host-namespaced variant of it (e.g.
 * `mcp__server__read`, `provider.read`). Requires a separator before the
 * suffix so an unrelated name such as `myread` does not match.
 */
export function toolNameMatches(toolName: string, base: string): boolean {
  if (toolName === base) return true;
  if (!toolName.endsWith(base)) return false;
  const prefix = toolName.slice(0, toolName.length - base.length);
  return prefix.length > 0 && SELF_BOUNDARY.test(prefix);
}

/**
 * Whether a tool-part's tool name is one of OUR recall tools, so its output is
 * never searchable by recall (prevents recall from finding prior recall
 * results). Matches the bare registered name and host-namespaced variants.
 */
export function isSelfTool(toolName: string): boolean {
  return TOOLS.some((self) => toolNameMatches(toolName, self));
}

const TOOL_INPUT_FIELDS = new Set<ResultWhy["matchedFields"][number]>([
  "command",
  "cwd",
  "toolName",
]);

/** Fetch-shaped tool bases (suffix-matched): their OUTPUT is fetched
 *  reference material. Order matters — the tool-input check runs first, so
 *  an input-only match on a fetch/search tool still counts as the action it
 *  records; toolInputTexts files the whole JSON input under the command
 *  field, so a before-input check would swallow every fetch part. */
const WEB_FETCH_BASES = ["webfetch", "fetch", "scrape", "crawl", "search", "extract"] as const;

/**
 * Deterministic evidence classification for a hit. Note the `command` scope:
 * toolInputTexts() files the whole JSON input under the `command` matched
 * field in addition to the specific command/cwd strings, so a tool part whose
 * only match is inside its JSON input classifies as tool-input regardless of
 * tool. That is intended — "matched in what was asked of the tool" — and it
 * makes non-bash tool invocations count as actions.
 */
export function evidenceClassFor(
  partType: string,
  toolName: string | undefined,
  matchedFields: ResultWhy["matchedFields"],
): EvidenceClass {
  if (partType === "title") return "session-title";
  if (partType === "reasoning") return "reasoning";
  if (partType !== "tool") return "human-text";
  if (toolName && toolNameMatches(toolName, "skill")) return "skill-definition";
  if (toolName && toolNameMatches(toolName, "read")) return "file-read";
  if (matchedFields.length > 0 && matchedFields.every((field) => TOOL_INPUT_FIELDS.has(field))) {
    return "tool-input";
  }
  if (toolName && WEB_FETCH_BASES.some((base) => toolNameMatches(toolName, base))) {
    return "web-fetch";
  }
  return "tool-output";
}

function input(val: unknown): string {
  const raw = JSON.stringify(val);
  return raw.length > INPUT_SEARCH_LIMIT ? raw.slice(0, INPUT_SEARCH_LIMIT) : raw;
}

function stringInputField(val: unknown, key: string): string | undefined {
  if (!val || typeof val !== "object") return undefined;
  const field = (val as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function toolInputTexts(val: unknown): SearchableField[] {
  const result: SearchableField[] = [];
  const command = stringInputField(val, "command");
  const cwd = stringInputField(val, "cwd");
  if (command) result.push({ field: "command", text: command });
  if (cwd) result.push({ field: "cwd", text: cwd });
  result.push({ field: "command", text: input(val) });
  return result;
}

export function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export function searchable(part: Part): string[] {
  return searchableFields(part).map((field) => field.text);
}

export function searchableFields(part: Part): SearchableField[] {
  if (part.type === "tool" && isSelfTool(part.tool)) return [];
  switch (part.type) {
    case "text":
      // Auto-recall injects synthetic <recall-auto> text parts that restate
      // query-like terms; indexing them would let recall find its own prior
      // injections. Only our sentinel is excluded — other synthetic parts
      // (e.g. host-injected context) stay searchable.
      if (
        (part as { synthetic?: boolean }).synthetic === true &&
        part.text?.startsWith("<recall-auto>")
      ) {
        return [];
      }
      return part.text ? [{ field: "text", text: part.text }] : [];
    case "reasoning":
      return part.text ? [{ field: "reasoning", text: part.text }] : [];
    case "tool": {
      const result: SearchableField[] = [];
      const state = part.state;
      if (state.status === "completed") {
        if (state.output) result.push({ field: "stdout", text: state.output });
        if (state.title) result.push({ field: "toolName", text: state.title });
        if (state.input) result.push(...toolInputTexts(state.input));
      }
      if (state.status === "error") {
        if (state.error) result.push({ field: "stderr", text: state.error });
        if (state.input) result.push(...toolInputTexts(state.input));
      }
      if (state.status === "running" || state.status === "pending") {
        if (state.input) result.push(...toolInputTexts(state.input));
      }
      return result;
    }
    case "subtask":
      return [
        { field: "text", text: part.description },
        { field: "text", text: part.prompt },
      ];
    default:
      return [];
  }
}

export function snippet(text: string, query: string, width = 200): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, width) + (text.length > width ? "..." : "");

  const half = Math.floor(width / 2);
  let start = Math.max(0, idx - half);
  const end = Math.min(text.length, start + width);
  if (end - start < width && start > 0) start = Math.max(0, end - width);

  let result = text.slice(start, end);
  if (start > 0) result = "..." + result;
  if (end < text.length) result = result + "...";
  return result;
}

export function pruned(part: Part): boolean {
  if (part.type !== "tool") return false;
  if (part.state.status !== "completed") return false;
  return (part.state as ToolStateCompleted).time.compacted != null;
}

export function format(part: Part): PartOutput {
  const base = { id: part.id, type: part.type, pruned: pruned(part) };

  switch (part.type) {
    case "text":
    case "reasoning":
      return { ...base, content: part.text };
    case "tool": {
      const state = part.state;
      if (state.status === "completed")
        return {
          ...base,
          toolName: part.tool,
          title: state.title,
          input: state.input,
          output: state.output,
        };
      if (state.status === "error")
        return {
          ...base,
          toolName: part.tool,
          input: state.input,
          error: state.error,
        };
      return {
        ...base,
        toolName: part.tool,
        input: state.input,
      };
    }
    case "subtask":
      return { ...base, content: `[subtask] ${part.description}` };
    case "compaction":
      return {
        ...base,
        content: `[compaction boundary${part.auto ? " (auto)" : ""}]`,
      };
    case "file":
      return { ...base, content: `[file] ${part.filename ?? part.url}` };
    case "snapshot":
      return { ...base, content: `[snapshot] ${part.snapshot}` };
    case "patch":
      return { ...base, content: `[patch] ${part.files.join(", ")}` };
    case "agent":
      return { ...base, content: `[agent] ${part.name}` };
    case "retry":
      return {
        ...base,
        content: `[retry] attempt ${part.attempt}`,
        error: part.error.data.message,
      };
    case "step-start":
      return { ...base, content: "[step-start]" };
    case "step-finish":
      return { ...base, content: `[step-finish] ${part.reason}` };
    default:
      return { ...base, content: `[${(part as Part).type}]` };
  }
}

export function formatMsg(msg: { info: Message; parts: Array<Part> }): MessageItem {
  const info = msg.info;
  let model: string | undefined;
  if (info.role === "assistant") model = (info as AssistantMessage).modelID;
  else model = (info as UserMessage).model.modelID;

  return {
    message: {
      id: info.id,
      role: info.role,
      time: info.time.created,
      agent: info.agent,
      model,
    },
    parts: msg.parts.map(format),
  };
}
