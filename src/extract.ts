import type { Part, ToolStateCompleted } from "@opencode-ai/sdk/v2";
import type { PartOutput } from "./types.js";

const INPUT_SEARCH_LIMIT = 10_000;

export function searchable(part: Part): string[] {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text ? [part.text] : [];
    case "tool": {
      const result: string[] = [];
      const state = part.state;
      if (state.status === "completed") {
        if (state.output) result.push(state.output);
        if (state.title) result.push(state.title);
        if (state.input) {
          const raw = JSON.stringify(state.input);
          result.push(
            raw.length > INPUT_SEARCH_LIMIT
              ? raw.slice(0, INPUT_SEARCH_LIMIT)
              : raw,
          );
        }
      }
      if (state.status === "error") {
        if (state.error) result.push(state.error);
        if (state.input) {
          const raw = JSON.stringify(state.input);
          result.push(
            raw.length > INPUT_SEARCH_LIMIT
              ? raw.slice(0, INPUT_SEARCH_LIMIT)
              : raw,
          );
        }
      }
      if (state.status === "running" || state.status === "pending") {
        if (state.input) {
          const raw = JSON.stringify(state.input);
          result.push(
            raw.length > INPUT_SEARCH_LIMIT
              ? raw.slice(0, INPUT_SEARCH_LIMIT)
              : raw,
          );
        }
      }
      return result;
    }
    case "subtask":
      return [part.description, part.prompt];
    default:
      return [];
  }
}

export function snippet(text: string, query: string, width = 200): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1)
    return text.slice(0, width) + (text.length > width ? "..." : "");

  const half = Math.floor(width / 2);
  let start = Math.max(0, idx - half);
  let end = Math.min(text.length, start + width);
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
