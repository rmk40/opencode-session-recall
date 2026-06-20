import type {
  Part,
  ToolStateCompleted,
  Message,
  AssistantMessage,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import { TOOLS, type PartOutput, type MessageItem, type ResultWhy } from "./types.js";

const INPUT_SEARCH_LIMIT = 10_000;
const SELF = new Set<string>(TOOLS);
/** Separators a host may use when namespacing a tool (e.g. `mcp__server__recall`,
 *  `opencode-session-recall_recall`, `provider.recall`). */
const SELF_BOUNDARY = /[._/-]$/;
export type SearchableField = { field: ResultWhy["matchedFields"][number]; text: string };

/**
 * Whether a tool-part's tool name is one of OUR recall tools, so its output is
 * never searchable by recall (prevents recall from finding prior recall
 * results). Matches the bare registered name and host-namespaced variants like
 * `mcp__opencode-session-recall__recall` — but requires a separator before the
 * suffix so an unrelated tool such as `myrecall` is not excluded.
 */
export function isSelfTool(toolName: string): boolean {
  if (SELF.has(toolName)) return true;
  for (const self of TOOLS) {
    if (!toolName.endsWith(self)) continue;
    const prefix = toolName.slice(0, toolName.length - self.length);
    if (prefix.length > 0 && SELF_BOUNDARY.test(prefix)) return true;
  }
  return false;
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
