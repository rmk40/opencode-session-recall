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
  OUTPUT_BUDGET,
  resumeParts,
  section,
  writeError,
  writeOutput,
  type PartPosition,
} from "./output.js";

/**
 * Body bytes a continuation into a message's part rows reads ahead: twice
 * what one output shows, since a part as stored can carry more than the part
 * as shown. A continuation starts at the part the last output stopped in, so
 * a call reads that part (whatever its size), about this much after it and
 * nothing before it. A message's inline content cannot be read in pieces,
 * so a call that reaches it reads it whole.
 */
const CONTINUATION_READ_BYTES = 2 * OUTPUT_BUDGET.bytes;

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
      let atFirst = false;
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
        atFirst = decoded.value.atFirst === true;
      }
      // A read into the part rows is capped when the output starts at its
      // first part; a cursor whose part lies further into its read gets the
      // whole read, so that the part is in it.
      const capped = ordinal !== undefined && (at === undefined || atFirst);
      ctx.metadata({
        title: `Retrieving message ${messageID.slice(0, 20)}...`,
      });

      try {
        const result = await gate.runQuery(() =>
          ordinal === undefined
            ? source.getMessage(sessionID, messageID)
            : source.getMessage(sessionID, messageID, {
                partOrdinal: ordinal,
                ...(capped && { maxBytes: CONTINUATION_READ_BYTES }),
              }),
        );
        if (!result.ok) return writeError(result.error ?? `Message not found: ${messageID}`);

        const item = formatMsg(result.value);
        const partial = result.value.partial;
        // A partial message ends in the reader's note on where the rest
        // starts. After a capped read the output's continuation reads on from
        // there, so the note, which would only interrupt the parts, is left
        // out.
        let parts: PartOutput[] = capped && partial ? item.parts.slice(0, -1) : item.parts;
        if (at) {
          const resumed = resumeParts(parts, at);
          if (!resumed) {
            return writeError(
              `This cursor's part ${at.part} is no longer in message ${messageID}; retrieve it again without cursor`,
            );
          }
          parts = resumed;
        }
        const partOrdinals = result.partOrdinals;

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

        // The output stops inside this read, and its continuation reads from
        // the row of the part it stopped at (or, for a part without a row of
        // its own, from this read's ordinal) and resumes at that part; or,
        // when the read itself was cut short, it continues at the ordinal the
        // read stopped at.
        const resumeAt = (stopped: PartPosition): string => {
          const from = partOrdinals?.get(stopped.part);
          return from !== undefined && Number.isSafeInteger(from) && from >= 0
            ? encodeGetCursor({ message: messageID, ordinal: from, at: stopped, atFirst: true })
            : encodeGetCursor({ message: messageID, ordinal, at: stopped });
        };
        return writeOutput<PartPosition>({
          sections: [section("parts", parts, fitPart)],
          head: (stop) => {
            const stopped = stop?.rest ?? (stop && { part: parts[stop.index]!.id });
            const continuation = stopped
              ? resumeAt(stopped)
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
