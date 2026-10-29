/**
 * Hashing — docs/04-data-structures-and-algorithms.md §9.1.
 * SHA-256 (node:crypto) for content addressing; FNV-1a 32-bit for hot-path dedup.
 */
import { createHash } from "node:crypto";

/** SHA-256 hex digest of a UTF-8 string or bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit over the UTF-8 bytes of `str`. Returns an unsigned 32-bit integer. */
export function fnv1a(str: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      h = Math.imul(h ^ c, FNV_PRIME);
      continue;
    }
    // UTF-8 encode on the fly (surrogate pairs → 4 bytes; lone surrogates → 3 bytes)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    } else if (c < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (c >> 12)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    } else {
      h = Math.imul(h ^ (0xf0 | (c >> 18)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 12) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    }
  }
  return h >>> 0;
}

/** FNV-1a 32-bit as 8 lowercase hex chars. */
export function fnv1aHex(str: string): string {
  return fnv1a(str).toString(16).padStart(8, "0");
}
