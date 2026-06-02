import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createTransportLogger,
  instrumentTransport,
} from "../../../src/core/transport_log.js";

const RECV_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) RECV (\S+) (\S+) (\d+)$/;
const SEND_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) SEND (\S+) (\S+) (\d+) (\S+)$/;

describe("core/transport_log", () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-tlog-"));
    logPath = path.join(dir, "transport.log");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // ── the off-by-default no-op path ──────────────────────────────────────

  it("returns null when the env path is unset (zero-overhead no-op)", () => {
    expect(createTransportLogger(undefined)).toBeNull();
  });

  it("returns null when the env path is empty or whitespace", () => {
    expect(createTransportLogger("")).toBeNull();
    expect(createTransportLogger("   ")).toBeNull();
  });

  it("does not create the log file until an event is logged", async () => {
    createTransportLogger(logPath);
    await expect(fs.access(logPath)).rejects.toBeTruthy();
  });

  // ── RECV / SEND schema ──────────────────────────────────────────────────

  it("writes a RECV line with `timestamp RECV id method bytes` schema", async () => {
    const logger = createTransportLogger(logPath)!;
    logger.recv({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { a: 1 } });
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const m = lines[0].match(RECV_RE);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("7"); // id
    expect(m![3]).toBe("tools/call"); // method
    expect(Number(m![4])).toBeGreaterThan(0); // bytes
  });

  it("writes a SEND line with `timestamp SEND id status bytes duration` schema", async () => {
    const logger = createTransportLogger(logPath)!;
    logger.send({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    const line = (await fs.readFile(logPath, "utf8")).trim();
    const m = line.match(SEND_RE);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("7"); // id
    expect(m![3]).toBe("ok"); // status
    expect(Number(m![4])).toBeGreaterThan(0); // bytes
  });

  it("SEND status is `error` for a JSON-RPC error response", async () => {
    const logger = createTransportLogger(logPath)!;
    logger.send({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "x" } });
    const m = (await fs.readFile(logPath, "utf8")).trim().match(SEND_RE);
    expect(m![3]).toBe("error");
  });

  it("computes RECV→SEND duration for a matching request id", async () => {
    const logger = createTransportLogger(logPath)!;
    logger.recv({ jsonrpc: "2.0", id: 42, method: "read" });
    logger.send({ jsonrpc: "2.0", id: 42, result: {} });
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    const sendMatch = lines[1].match(SEND_RE)!;
    expect(Number(sendMatch[5])).toBeGreaterThanOrEqual(0); // duration is numeric ms
  });

  it("uses `-` for id and duration on a request with no id (notification)", async () => {
    const logger = createTransportLogger(logPath)!;
    logger.recv({ jsonrpc: "2.0", method: "notifications/initialized" });
    logger.send({ jsonrpc: "2.0", method: "notifications/somethingElse" });
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    expect(lines[0].match(RECV_RE)![2]).toBe("-"); // recv id
    const sendMatch = lines[1].match(SEND_RE)!;
    expect(sendMatch[2]).toBe("-"); // send id
    expect(sendMatch[5]).toBe("-"); // duration unknown without a matching recv
  });

  // ── the load-bearing safety invariant: NEVER log bodies ──────────────────

  it("never writes request/response BODIES to the log", async () => {
    const logger = createTransportLogger(logPath)!;
    const SECRET_IN = "SUPER_SECRET_REQUEST_TOKEN_abc123";
    const SECRET_OUT = "SUPER_SECRET_RESPONSE_CONTENT_xyz789";
    logger.recv({
      jsonrpc: "2.0",
      id: 1,
      method: "write",
      params: { path: "C:/x", content: SECRET_IN },
    });
    logger.send({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: SECRET_OUT }] },
    });
    const body = await fs.readFile(logPath, "utf8");
    expect(body).not.toContain(SECRET_IN);
    expect(body).not.toContain(SECRET_OUT);
    // sanity: it DID log the metadata
    expect(body).toContain("RECV");
    expect(body).toContain("write");
    expect(body).toContain("SEND");
  });

  // ── instrumentTransport wiring ────────────────────────────────────────────

  it("instrumentTransport logs RECV on inbound and still calls the assigned handler", async () => {
    const recvSeen: unknown[] = [];
    const handlerSeen: unknown[] = [];
    const fakeLogger = { recv: (m: unknown) => recvSeen.push(m), send: () => {} };
    const transport: { send: (m: unknown) => Promise<void>; onmessage?: (m: unknown) => void } = {
      send: async () => {},
      onmessage: undefined,
    };
    instrumentTransport(transport, fakeLogger);
    // Protocol assigns its handler AFTER instrumentation, as connect() does.
    transport.onmessage = (m) => handlerSeen.push(m);
    const msg = { jsonrpc: "2.0", id: 1, method: "ping" };
    transport.onmessage!(msg);
    expect(recvSeen).toEqual([msg]);
    expect(handlerSeen).toEqual([msg]);
  });

  it("instrumentTransport logs SEND before delegating to the real send (survives an outbound stall)", async () => {
    const order: string[] = [];
    const fakeLogger = { recv: () => {}, send: () => order.push("log") };
    const transport: { send: (m: unknown) => Promise<void>; onmessage?: (m: unknown) => void } = {
      send: async () => {
        order.push("write");
      },
      onmessage: undefined,
    };
    instrumentTransport(transport, fakeLogger);
    await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(order).toEqual(["log", "write"]);
  });
});
