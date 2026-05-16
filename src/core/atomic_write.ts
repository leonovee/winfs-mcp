import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Atomically write `data` to `destPath`. Strategy:
 *   1. Write to `destPath + .<random>.tmp` in the same directory
 *   2. fsync the temp file to ensure bytes are durable
 *   3. fs.rename → destination. On NTFS this is atomic within a single volume.
 *
 * Spec §2.5: no partial writes if the process is killed mid-flight.
 *
 * If the rename fails (EACCES/EBUSY on Windows when the destination is open
 * in another process), the temp file is unlinked and the error re-thrown so
 * the caller can map it to EBUSY/EIO.
 */
export async function atomicWriteFile(destPath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  const suffix = crypto.randomBytes(8).toString("hex");
  const tmpPath = path.join(dir, `.${base}.${suffix}.tmp`);

  const handle = await fs.open(tmpPath, "w");
  try {
    if (typeof data === "string") {
      await handle.writeFile(data, { encoding: "utf8" });
    } else {
      await handle.writeFile(data);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    // Cleanup orphan temp file. Swallow secondary failures.
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Atomic append: read existing content into memory, concatenate, then perform
 * an atomic full-file write. For small log-style files this preserves atomicity
 * at the cost of memory; for v0.1 only `append` uses this and we already cap
 * file size via `readMaxBytes` upstream when needed.
 *
 * If `destPath` does not exist this behaves like atomicWriteFile.
 */
export async function atomicAppend(destPath: string, addition: Buffer): Promise<void> {
  let existing: Buffer = Buffer.alloc(0);
  try {
    existing = await fs.readFile(destPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") throw err;
  }
  const combined = Buffer.concat([existing, addition]);
  await atomicWriteFile(destPath, combined);
}
