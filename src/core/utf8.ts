const BOM_BYTES = [0xef, 0xbb, 0xbf] as const;

/** Returns true when the buffer starts with the UTF-8 BOM (EF BB BF). */
export function hasUtf8Bom(buf: Buffer): boolean {
  return (
    buf.length >= 3 && buf[0] === BOM_BYTES[0] && buf[1] === BOM_BYTES[1] && buf[2] === BOM_BYTES[2]
  );
}

/** Decode buffer as UTF-8, stripping a leading BOM if present. */
export function decodeUtf8StripBom(buf: Buffer): string {
  if (hasUtf8Bom(buf)) return buf.subarray(3).toString("utf8");
  return buf.toString("utf8");
}

/** Encode a string to UTF-8 bytes. NEVER writes a BOM (spec §2.1). */
export function encodeUtf8NoBom(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/**
 * Heuristic binary detector. If we see a NUL byte in the first `sampleBytes`
 * bytes, the file is almost certainly binary and should be rejected from text
 * tools with EENCODING. UTF-16 LE/BE BOMs also signal "not UTF-8 text".
 */
export function looksBinary(buf: Buffer, sampleBytes = 8192): boolean {
  if (buf.length >= 2) {
    // UTF-16 LE / BE BOM
    if (buf[0] === 0xff && buf[1] === 0xfe) return true;
    if (buf[0] === 0xfe && buf[1] === 0xff) return true;
  }
  const limit = Math.min(buf.length, sampleBytes);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}

/**
 * Validates that `buf` decodes cleanly as UTF-8 with no replacement chars.
 * Returns the decoded string on success, or undefined if invalid UTF-8.
 */
export function tryDecodeUtf8Strict(buf: Buffer): string | undefined {
  // Node's Buffer.toString('utf8') replaces invalid sequences silently with
  // U+FFFD. We re-encode and compare to detect that.
  const text = decodeUtf8StripBom(buf);
  const reEncoded = Buffer.from(text, "utf8");
  const original = hasUtf8Bom(buf) ? buf.subarray(3) : buf;
  if (reEncoded.length !== original.length) return undefined;
  for (let i = 0; i < reEncoded.length; i++) {
    if (reEncoded[i] !== original[i]) return undefined;
  }
  return text;
}
