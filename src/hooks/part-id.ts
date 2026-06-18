/**
 * Generate an opencode-compatible ascending part ID (`prt_…`).
 *
 * The `chat.message` hook fires AFTER core has already run `assign()` over the
 * resolved parts (which fills missing ids), so any part the plugin appends must
 * carry a valid id itself or it fails Part-schema decode and corrupts the
 * id-ordered persistence layer.
 *
 * This mirrors core's `Identifier.ascending("part")` exactly (verified against
 * opencode core packages/core/src/id/id.ts): prefix + "_" + 6 timestamp bytes
 * (hex, monotonic via a per-process counter) + base62 random padding to a total
 * body length of 26 chars. Ascending (not bitwise-inverted) so ids sort
 * chronologically, matching core's `PartID.ascending()`.
 *
 * Implemented with only standard-library globals (no node:crypto / Buffer) to
 * keep the plugin runtime-agnostic.
 */

const PREFIX = "prt";
const LENGTH = 26;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let counter = 0;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const webcrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } })
    .crypto;
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) result += BASE62[bytes[i]! % 62];
  return result;
}

export function partId(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  // 48-bit value: timestamp << 12 | counter, emitted as 6 big-endian hex bytes.
  const now = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter);
  let hex = "";
  for (let i = 0; i < 6; i++) {
    const byte = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
    hex += byte.toString(16).padStart(2, "0");
  }

  return `${PREFIX}_${hex}${randomBase62(LENGTH - 12)}`;
}
