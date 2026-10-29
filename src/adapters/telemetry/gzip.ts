/**
 * Gzip detection for telemetry files — docs/03-engines/system-model.md §1 (runtime traces).
 * A file whose first bytes are the gzip magic (1f 8b) is decompressed before JSON / protobuf detection,
 * whatever its name. Zip-bomb guard: the decompressed size is capped at
 * min(maxBytes, max(minLimit, compressedBytes × maxRatio)); zlib stops at that cap (maxOutputLength),
 * so a bomb never allocates more than the cap.
 */
import { gunzipSync } from "node:zlib";

export interface GunzipLimits {
  /** Absolute cap on decompressed bytes (default 256 MiB, the protobuf decoder's input cap). */
  maxBytes?: number;
  /** Cap on decompressed/compressed size (default 200; OTLP JSON/protobuf compresses ~5–30×). */
  maxRatio?: number;
  /** The ratio cap never limits output below this (default 16 MiB), so small files are not penalised. */
  minLimit?: number;
}

export class GzipLimitError extends Error {
  readonly code = "SW_GZIP_LIMIT";
  constructor(message: string) {
    super(`gzip: ${message}`);
    this.name = "GzipLimitError";
  }
}

const MIB = 1024 * 1024;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Decompresses gzip content (by magic bytes) within the limits; other content is returned as is. */
export function maybeGunzip(
  bytes: Uint8Array,
  limits: GunzipLimits = {},
): { bytes: Uint8Array; gzipped: boolean } {
  if (!isGzip(bytes)) return { bytes, gzipped: false };
  const maxBytes = limits.maxBytes ?? 256 * MIB;
  const maxRatio = limits.maxRatio ?? 200;
  const byRatio = Math.max(limits.minLimit ?? 16 * MIB, bytes.length * maxRatio);
  const limit = Math.max(0, Math.floor(Math.min(maxBytes, byRatio)));
  try {
    return { bytes: gunzipSync(bytes, { maxOutputLength: Math.max(1, limit) }), gzipped: true };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      const why =
        limit === maxBytes
          ? `the ${maxBytes}-byte limit`
          : `${limit} bytes (compression ratio cap ${maxRatio}:1)`;
      throw new GzipLimitError(`decompressed size exceeds ${why}; ${bytes.length} compressed bytes`);
    }
    throw new GzipLimitError(`invalid gzip data (${err.message})`);
  }
}

/** File name without a trailing `.gz` / `.gzip`, so `traces.pb.gz` is detected as `.pb`. */
export function stripGzipExtension(file: string): string {
  return file.replace(/\.(gz|gzip)$/i, "");
}
