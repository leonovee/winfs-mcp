/**
 * Opt-in transport-level request/response METADATA logger (#3 transport-hang
 * investigation, v0.9).
 *
 * Gated entirely on the `WINFS_TRANSPORT_LOG` env var (a file path). When unset
 * the server never constructs a logger and never instruments the transport —
 * a true zero-overhead no-op path. When set, one line is appended per inbound
 * request and per outbound response so a captured log, correlated with Claude
 * Desktop's own MCP log, localizes which leg of the stdio transport stalls.
 *
 * SAFETY INVARIANT — this logger records ONLY metadata: ISO timestamp, JSON-RPC
 * id, method name, approximate byte count, response status, processing duration.
 * It NEVER writes request/response bodies (which can carry file contents,
 * command output, secrets). `JSON.stringify` is used solely to MEASURE length;
 * its result is never written.
 *
 * Durability over performance: the debug path appends synchronously and flushes
 * each line immediately (`appendFileSync`). A buffered logger that lost its last
 * line right before a hang would be useless — surviving the stall is the point.
 */
import { appendFileSync } from "node:fs";

/** A JSON-RPC-ish message; we only ever read a few metadata fields. */
interface RpcMessage {
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
}

export interface TransportLogger {
  /** Inbound message (client → winfs). */
  recv(message: unknown): void;
  /** Outbound message (winfs → client). Logged just before the wire write. */
  send(message: unknown): void;
}

/**
 * Build a transport logger from the raw `WINFS_TRANSPORT_LOG` value, or `null`
 * when logging is disabled. A `null` return is the signal to the caller to skip
 * instrumentation entirely (zero overhead).
 */
export function createTransportLogger(logPath: string | undefined): TransportLogger | null {
  if (typeof logPath !== "string" || logPath.trim() === "") return null;
  return new FileTransportLogger(logPath);
}

class FileTransportLogger implements TransportLogger {
  /** request id → recv timestamp (ms), for RECV→SEND duration. */
  private readonly pending = new Map<string | number, number>();

  constructor(private readonly path: string) {}

  recv(message: unknown): void {
    const m = (message ?? {}) as RpcMessage;
    const id = idKey(m.id);
    if (id !== null) this.pending.set(id, Date.now());
    const method = typeof m.method === "string" ? m.method : "-";
    this.write(`${iso()} RECV ${idStr(m.id)} ${method} ${approxBytes(message)}`);
  }

  send(message: unknown): void {
    const m = (message ?? {}) as RpcMessage;
    const id = idKey(m.id);
    let duration = "-";
    if (id !== null && this.pending.has(id)) {
      duration = String(Date.now() - this.pending.get(id)!);
      this.pending.delete(id);
    }
    const status = m.error !== undefined ? "error" : "ok";
    this.write(`${iso()} SEND ${idStr(m.id)} ${status} ${approxBytes(message)} ${duration}`);
  }

  private write(line: string): void {
    try {
      appendFileSync(this.path, line + "\n");
    } catch {
      // A logging failure must never perturb transport behavior.
    }
  }
}

/**
 * Wire a {@link TransportLogger} into an MCP transport in place. Outbound: wrap
 * `send` so the SEND line is written immediately BEFORE the wire write (so it
 * survives even if the outbound pipe then stalls, and its duration reflects
 * winfs processing time). Inbound: trap `onmessage` assignment so the handler
 * the SDK installs during `connect()` is routed through `recv()` first.
 */
export function instrumentTransport(
  // Adapter boundary against the SDK's `Transport` (and our test fake). The
  // message params are `any` on purpose: the SDK types `send`/`onmessage` over
  // the concrete `JSONRPCMessage`, and a narrower-or-`unknown` param here would
  // trip `strictFunctionTypes` contravariance. We only ever read metadata.
  transport: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (message: any, options?: any) => Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onmessage?: ((message: any) => void) | undefined;
  },
  logger: TransportLogger,
): void {
  const originalSend = transport.send.bind(transport);
  transport.send = (message: unknown, options?: unknown): Promise<void> => {
    try {
      logger.send(message);
    } catch {
      /* never block the response on a logging failure */
    }
    return originalSend(message, options);
  };

  let wrapped: ((message: unknown) => void) | undefined;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get() {
      return wrapped;
    },
    set(handler: ((message: unknown) => void) | undefined) {
      wrapped = handler
        ? (message: unknown): void => {
            try {
              logger.recv(message);
            } catch {
              /* never drop the message on a logging failure */
            }
            handler(message);
          }
        : undefined;
    },
  });
}

function iso(): string {
  return new Date().toISOString();
}

/** Stable map key for an id, or null when there is no usable id. */
function idKey(id: string | number | null | undefined): string | number | null {
  return id === undefined || id === null ? null : id;
}

/** Display form for an id: the id, or `-` when absent. */
function idStr(id: string | number | null | undefined): string {
  return id === undefined || id === null ? "-" : String(id);
}

/** Approximate serialized size in bytes. Result is measured, never logged. */
function approxBytes(message: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(message) ?? "", "utf8");
  } catch {
    return 0;
  }
}
