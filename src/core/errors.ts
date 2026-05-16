export type ErrorCode =
  | "EPERM_ROOT"
  | "ENOENT"
  | "EISDIR"
  | "ENOTDIR"
  | "EEXIST"
  | "ETIMEDOUT"
  | "EUNIQUE"
  | "ENOMATCH"
  | "EBLOCKED_CMD"
  | "EFORBIDDEN_HOST"
  | "ETOOLARGE"
  | "EENCODING"
  | "EGITMUTATION"
  | "EBUSY"
  | "EBADJSON"
  | "EINVAL"
  | "EIO";

export interface StructuredError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    hint?: string;
  };
}

export interface Ok<T> {
  ok: true;
  value: T;
}

export type Result<T> = Ok<T> | StructuredError;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function buildError(
  code: ErrorCode,
  message: string,
  opts?: { details?: Record<string, unknown>; hint?: string },
): StructuredError {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(opts?.details ? { details: opts.details } : {}),
      ...(opts?.hint ? { hint: opts.hint } : {}),
    },
  };
}

/**
 * Maps a Node.js fs errno (NodeJS.ErrnoException) to a structured error.
 * Falls back to EIO for anything unrecognised.
 */
export function fromNodeError(err: unknown, fallbackMessage: string): StructuredError {
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? "";
  switch (code) {
    case "ENOENT":
      return buildError("ENOENT", `Path does not exist: ${e.path ?? "<unknown>"}`);
    case "EISDIR":
      return buildError("EISDIR", "Expected a file, got a directory", {
        hint: "Use list for directories",
      });
    case "ENOTDIR":
      return buildError("ENOTDIR", "Expected a directory, got a file");
    case "EEXIST":
      return buildError("EEXIST", "Path already exists", {
        hint: "Pass overwrite=true if intended",
      });
    case "EBUSY":
    case "EPERM":
    case "EACCES":
      return buildError("EBUSY", `File or resource busy / not accessible (${code})`);
    case "EMFILE":
    case "ENFILE":
      return buildError("EIO", `Too many open files (${code})`);
    default:
      return buildError("EIO", `${fallbackMessage}: ${e?.message ?? String(err)}`);
  }
}
