import { tool } from "./tool-def.js";
import type { ToolDefinition, ToolContext } from "./host/opencode-v1-types.js";
import type { HistorySource } from "./history/source.js";
import type { PartOutput } from "./types.js";
import { errmsg, optionalString } from "./types.js";
import { formatMsg } from "./extract.js";
import type { FetchGate } from "./fetch-gate.js";
import {
  decodeGetCursor,
  encodeGetCursor,
  fitPart,
  resumeParts,
  section,
  writeError,
  writeOutput,
  type PartPosition,
} from "./output.js";

export function get(source: HistorySource, gate: FetchGate): ToolDefinition {
  return tool({
    description: `Retrieve one full message from recall results, including text, reasoning, tool inputs/outputs, and pruned tool output. Use recall_context for surrounding conversation. A large message comes back trimmed: pass its continuation as cursor for the rest.

If memory exists, store only durable findings surfaced here; skip ephemeral details/minutiae.`,
    args: {
      sessionID: tool.schema.string().describe("Session containing the message"),
      messageID: tool.schema.string().describe("Message to retrieve"),
      cursor: tool.schema
        .string()
        .optional()
        .describe("continuation from a trimmed result; omit for the start"),
    },
    async execute(args, ctx: ToolContext): Promise<string> {
      // Defensive: the live MCP host can bypass Zod, so required args may be
      // missing rather than schema-validated, and a non-string cursor reads
      // as none.
      const sessionID = optionalString(args.sessionID);
      const messageID = optionalString(args.messageID);
      const cursor = optionalString(args.cursor);
      if (!sessionID || !messageID) return writeError("sessionID and messageID are required");
      let ordinal: number | undefined;
      let at: PartPosition | undefined;
      if (cursor) {
        const decoded = decodeGetCursor(cursor);
        if (!decoded.ok) return writeError(decoded.error);
        if (decoded.value.message !== messageID) {
          return writeError(
            `This cursor continues message ${decoded.value.message}, not ${messageID}`,
          );
        }
        ordinal = decoded.value.ordinal;
        at = decoded.value.at;
      }
      ctx.metadata({
        title: `Retrieving message ${messageID.slice(0, 20)}...`,
      });

      try {
        const result = await gate.runQuery(() =>
          ordinal === undefined
            ? source.getMessage(sessionID, messageID)
            : source.getMessage(sessionID, messageID, { partOrdinal: ordinal }),
        );
        if (!result.ok) return writeError(result.error ?? `Message not found: ${messageID}`);

        const item = formatMsg(result.value);
        let parts: PartOutput[] = item.parts;
        if (at) {
          const resumed = resumeParts(parts, at);
          if (!resumed) {
            return writeError(
              `This cursor's part ${at.part} is no longer in message ${messageID}; retrieve it again without cursor`,
            );
          }
          parts = resumed;
        }
        const partial = result.value.partial;

        let title: string | undefined;
        let directory: string | undefined;
        try {
          const sess = await gate.runQuery(() =>
            source.getSession(sessionID, { scope: "project" }),
          );
          if (sess.ok) {
            title = sess.value.title;
            directory = sess.value.directory;
          }
        } catch {
          // Cross-project session — can't get context, that's fine
        }

        ctx.metadata({
          title: `${item.message.role} message (${parts.length} part${parts.length !== 1 ? "s" : ""})${title ? ` from "${title}"` : ""}`,
        });

        // The output stops inside this read (its continuation re-reads from
        // the same ordinal and resumes at the part it stopped at), or, when
        // the read itself was cut short, continues at the ordinal it stopped
        // at.
        return writeOutput<PartPosition>({
          sections: [section("parts", parts, fitPart)],
          head: (stop) => {
            const stopped = stop?.rest ?? (stop && { part: parts[stop.index]!.id });
            const continuation = stopped
              ? encodeGetCursor({ message: messageID, ordinal, at: stopped })
              : partial
                ? encodeGetCursor({ message: messageID, ordinal: partial.nextOrdinal })
                : undefined;
            return {
              ...(continuation && { continuation }),
              fields: {
                message: item.message,
                ...(partial && {
                  partial: {
                    omittedParts: partial.omittedParts,
                    omittedBytes: partial.omittedBytes,
                  },
                }),
                context: { sessionTitle: title, directory },
              },
            };
          },
        }).text;
      } catch (e) {
        return writeError(errmsg(e));
      }
    },
  });
}
