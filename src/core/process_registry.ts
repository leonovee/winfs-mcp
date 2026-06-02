import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "./config.js";
import { buildExecEnv, STANDARD_WINDOWS_PATHEXT } from "./exec_safety.js";

/**
 * v0.7 wave 2b: stateful in-memory process registry. First long-lived
 * shared mutable state in the server. Backs the four process-control
 * tools (start_process / interact / list_process / kill_process).
 *
 * Session lifecycle:
 *   created → running → settle (exited | killed | timed_out | spawn_failed)
 *   → stays in registry for sessionTtlMs → GC removes.
 *
 * Concurrency is bounded by config.processMaxConcurrent (default 16).
 * Each session's stdout/stderr is captured to a per-stream buffer capped at
 * config.processBufferCap (default 1 MB). Overflow drops bytes and sets the
 * `truncated_*` flag.
 *
 * Long-poll: interact's read path uses `session.waitForOutput(...)`, which
 * resolves on (1) new output past the caller's offset, (2) session settle,
 * or (3) the long-poll deadline — whichever fires first.
 */

export type SessionStatus =
  | "running"
  | "exited"
  | "killed"
  | "timed_out"
  | "spawn_failed";

export interface SessionSnapshot {
  session_id: string;
  status: SessionStatus;
  exit_code: number | null;
  started_at: string;
  settled_at: string | null;
  stdout: string;
  stderr: string;
  stdout_offset: number;
  stderr_offset: number;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
}

export interface SessionSummary {
  session_id: string;
  command_prefix: string;
  started_at: string;
  status: SessionStatus;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
  settled_at: string | null;
}

interface Waiter {
  resolve: (snap: SessionSnapshot) => void;
  stdoutSince: number;
  stderrSince: number;
  timer: NodeJS.Timeout;
}

export class ProcessSession {
  public readonly session_id: string;
  public readonly command: string[];
  public readonly started_at: string;
  public status: SessionStatus = "running";
  public exit_code: number | null = null;
  public settled_at: string | null = null;
  public truncated_stdout = false;
  public truncated_stderr = false;
  public stdin_closed = false;
  public child: ChildProcess | null = null;
  /** Set by the registry timeout handler so the close event reclassifies
   *  what would normally settle as 'exited' / 'killed' into 'timed_out'. */
  public deadlineFired = false;

  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private readonly bufferCap: number;
  private readonly waiters: Waiter[] = [];
  private timeoutTimer: NodeJS.Timeout | null = null;

  constructor(command: string[], bufferCap: number) {
    this.session_id = randomUUID();
    this.command = [...command];
    this.started_at = new Date().toISOString();
    this.bufferCap = bufferCap;
  }

  /** Append output to a stream buffer respecting the bufferCap. Returns true
   *  if any waiters need to be woken (always true on non-empty append). */
  appendStdout(chunk: Buffer): boolean {
    if (this.stdoutBytes >= this.bufferCap) {
      this.truncated_stdout = true;
      this.wakeWaiters();
      return false;
    }
    const remaining = this.bufferCap - this.stdoutBytes;
    if (chunk.length > remaining) {
      this.stdoutChunks.push(chunk.subarray(0, remaining));
      this.stdoutBytes = this.bufferCap;
      this.truncated_stdout = true;
    } else {
      this.stdoutChunks.push(chunk);
      this.stdoutBytes += chunk.length;
    }
    this.wakeWaiters();
    return true;
  }

  appendStderr(chunk: Buffer): boolean {
    if (this.stderrBytes >= this.bufferCap) {
      this.truncated_stderr = true;
      this.wakeWaiters();
      return false;
    }
    const remaining = this.bufferCap - this.stderrBytes;
    if (chunk.length > remaining) {
      this.stderrChunks.push(chunk.subarray(0, remaining));
      this.stderrBytes = this.bufferCap;
      this.truncated_stderr = true;
    } else {
      this.stderrChunks.push(chunk);
      this.stderrBytes += chunk.length;
    }
    this.wakeWaiters();
    return true;
  }

  /** Mark session as settled. Wakes all waiters with the final snapshot.
   *  Also explicitly destroys the child's stdio streams so Node releases
   *  the underlying pipe handles immediately — without this, Windows can
   *  hold the child's cwd handle for many seconds after `taskkill /F /T`
   *  returns, causing `fs.rm({recursive: true})` on the tempdir to hit
   *  EBUSY during `afterEach`. Stream destroy is the trigger that lets
   *  the kernel reap the process record + release the dir handle. */
  settle(status: SessionStatus, exitCode: number | null): void {
    if (this.status !== "running") return;
    this.status = status;
    this.exit_code = exitCode;
    this.settled_at = new Date().toISOString();
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.child) {
      // Destroy in/out/err pipes so Node's internal libuv handles are
      // closed. Wrapped in try/catch since the stream may already be
      // closed (natural-exit path) — that's not an error, just a no-op.
      try { this.child.stdin?.destroy(); } catch { /* already closed */ }
      try { this.child.stdout?.destroy(); } catch { /* already closed */ }
      try { this.child.stderr?.destroy(); } catch { /* already closed */ }
    }
    this.wakeWaiters();
  }

  /** Arm the per-session timeout. Calls onFire when it expires (which the
   *  registry uses to escalate to SIGKILL + settle as 'timed_out'). */
  armTimeout(timeoutSeconds: number, onFire: () => void): void {
    if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(onFire, timeoutSeconds * 1000);
    if (typeof this.timeoutTimer.unref === "function") this.timeoutTimer.unref();
  }

  /** Build a snapshot of the session's current state, slicing stdout/stderr
   *  from the caller's offsets. Slice is UTF-8 boundary-safe: we decode the
   *  full buffer to a string then slice by byte offset of UTF-8 bytes. For
   *  simplicity we currently decode bytewise; partial multi-byte sequences
   *  show as the U+FFFD replacement char (Node's default Buffer→string). */
  snapshot(stdoutSince = 0, stderrSince = 0): SessionSnapshot {
    const fullStdout = Buffer.concat(this.stdoutChunks);
    const fullStderr = Buffer.concat(this.stderrChunks);
    const stdoutSlice = stdoutSince >= fullStdout.length
      ? Buffer.alloc(0)
      : fullStdout.subarray(stdoutSince);
    const stderrSlice = stderrSince >= fullStderr.length
      ? Buffer.alloc(0)
      : fullStderr.subarray(stderrSince);
    return {
      session_id: this.session_id,
      status: this.status,
      exit_code: this.exit_code,
      started_at: this.started_at,
      settled_at: this.settled_at,
      stdout: stdoutSlice.toString("utf8"),
      stderr: stderrSlice.toString("utf8"),
      stdout_offset: fullStdout.length,
      stderr_offset: fullStderr.length,
      truncated_stdout: this.truncated_stdout,
      truncated_stderr: this.truncated_stderr,
    };
  }

  summary(): SessionSummary {
    const commandStr = this.command.join(" ");
    return {
      session_id: this.session_id,
      command_prefix: commandStr.slice(0, 256),
      started_at: this.started_at,
      status: this.status,
      exit_code: this.exit_code,
      stdout_bytes: this.stdoutBytes,
      stderr_bytes: this.stderrBytes,
      truncated_stdout: this.truncated_stdout,
      truncated_stderr: this.truncated_stderr,
      settled_at: this.settled_at,
    };
  }

  /** Resolve when the session settles, or maxWaitMs expires. Distinct from
   *  `waitForOutput` because output chunks alone do not wake this waiter. */
  waitForSettle(maxWaitMs: number): Promise<SessionSnapshot> {
    if (this.status !== "running") return Promise.resolve(this.snapshot());
    return new Promise((resolve) => {
      const baseOffset = this.stdoutBytes + this.stderrBytes;
      const poll = (): void => {
        if (this.status !== "running") {
          resolve(this.snapshot());
          return;
        }
        // Re-arm a long-poll wait against the current offsets; loop until
        // settled or deadline.
        const since = Date.now();
        this.waitForOutput(this.stdoutBytes, this.stderrBytes, Math.min(maxWaitMs, 200)).then(() => {
          maxWaitMs -= Date.now() - since;
          if (this.status !== "running") {
            resolve(this.snapshot());
          } else if (maxWaitMs <= 0) {
            resolve(this.snapshot());
          } else {
            poll();
          }
        });
      };
      // baseOffset is just a sentinel; we always re-read live offsets in poll().
      void baseOffset;
      poll();
    });
  }

  /** Long-poll: resolve with a snapshot when new output arrives past the
   *  caller's offsets, OR when the session settles, OR when maxWaitMs expires.
   *  Deadline is normal (resolves, never rejects). */
  waitForOutput(stdoutSince: number, stderrSince: number, maxWaitMs: number): Promise<SessionSnapshot> {
    // Fast path: if already settled, or new output already buffered, resolve
    // immediately.
    if (
      this.status !== "running" ||
      this.stdoutBytes > stdoutSince ||
      this.stderrBytes > stderrSince
    ) {
      return Promise.resolve(this.snapshot(stdoutSince, stderrSince));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w === waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(this.snapshot(stdoutSince, stderrSince));
      }, maxWaitMs);
      if (typeof timer.unref === "function") timer.unref();
      const waiter: Waiter = { resolve, stdoutSince, stderrSince, timer };
      this.waiters.push(waiter);
    });
  }

  private wakeWaiters(): void {
    if (this.waiters.length === 0) return;
    const settled = this.status !== "running";
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      if (
        settled ||
        this.stdoutBytes > w.stdoutSince ||
        this.stderrBytes > w.stderrSince
      ) {
        clearTimeout(w.timer);
        w.resolve(this.snapshot(w.stdoutSince, w.stderrSince));
      } else {
        remaining.push(w);
      }
    }
    this.waiters.length = 0;
    this.waiters.push(...remaining);
  }

  writeStdin(input: string): boolean {
    if (this.stdin_closed || this.status !== "running" || !this.child || !this.child.stdin) {
      return false;
    }
    try {
      this.child.stdin.write(input);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(): void {
    if (this.stdin_closed) return;
    if (this.child && this.child.stdin) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
    }
    this.stdin_closed = true;
  }
}

export interface SpawnOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
}

export class ProcessRegistry {
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly maxConcurrent: number;
  private readonly bufferCap: number;
  private readonly sessionTtlMs: number;
  private readonly gcInterval: NodeJS.Timeout;
  private readonly config: ResolvedConfig;
  private shuttingDown = false;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.maxConcurrent = config.processMaxConcurrent;
    this.bufferCap = config.processBufferCap;
    this.sessionTtlMs = config.processSessionTtlMs;
    this.gcInterval = setInterval(() => this.gc(), config.processGcIntervalMs);
    if (typeof this.gcInterval.unref === "function") this.gcInterval.unref();
  }

  runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "running") n++;
    }
    return n;
  }

  /** Spawn a child and register the session. Returns the new ProcessSession.
   *  Caller is responsible for the EBUSY check (runningCount >= max) and
   *  for the blocklist / allowedRoots check on cwd. */
  async spawn(
    command: string[],
    cwd: string,
    extraEnv: Record<string, string>,
    timeoutSeconds: number,
  ): Promise<ProcessSession> {
    const session = new ProcessSession(command, this.bufferCap);
    this.sessions.set(session.session_id, session);

    const env = { ...buildExecEnv(this.config), ...extraEnv };
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Synchronous spawn failure (rare on Windows — usually surfaces async).
      session.settle("spawn_failed", null);
      return session;
    }
    session.child = child;

    // Async-spawn-error path: mirrors v0.6 §U exec_safety fix. spawn()
    // returned synchronously but the OS rejected the process — emitted as
    // an 'error' event on the child.
    child.on("error", () => {
      session.settle("spawn_failed", null);
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => session.appendStdout(chunk));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => session.appendStderr(chunk));
    }
    child.on("close", (code) => {
      if (session.status !== "running") return;
      if (session.deadlineFired) {
        session.settle("timed_out", null);
      } else {
        session.settle("exited", code);
      }
    });

    // Per-session deadline. Set the marker flag, force-kill, and prefer
    // the child's `close` event to drive the actual settle. If close
    // doesn't fire within a defensive grace window (e.g. Windows occasionally
    // doesn't propagate close after `taskkill /F /T` on a PowerShell tree
    // for several seconds), force-settle as `timed_out` so the session
    // doesn't sit in `running` forever. Same defensive shape as `kill()`.
    session.armTimeout(timeoutSeconds, () => {
      if (session.status !== "running") return;
      session.deadlineFired = true;
      const child = session.child;
      if (!child) {
        session.settle("timed_out", null);
        return;
      }
      this.platformKill(child, true);
      const grace = setTimeout(() => {
        if (session.status === "running") {
          session.settle("timed_out", null);
        }
      }, 3000);
      if (typeof grace.unref === "function") grace.unref();
    });

    return session;
  }

  get(session_id: string): ProcessSession | undefined {
    return this.sessions.get(session_id);
  }

  list(): SessionSummary[] {
    const arr: SessionSummary[] = [];
    for (const s of this.sessions.values()) arr.push(s.summary());
    arr.sort((a, b) => a.started_at.localeCompare(b.started_at));
    return arr;
  }

  async kill(session_id: string, force: boolean): Promise<boolean> {
    const session = this.sessions.get(session_id);
    if (!session) return false;
    if (session.status !== "running") return false;
    const child = session.child;
    if (!child || child.pid === undefined) {
      session.settle("killed", null);
      return true;
    }
    if (force) {
      this.platformKill(child, true);
    } else {
      this.platformKill(child, false);
      // 5 s grace, then SIGKILL if still running.
      await Promise.race([
        new Promise<void>((res) => {
          const onSettle = (): void => res();
          child.once("close", onSettle);
        }),
        new Promise<void>((res) => {
          const t = setTimeout(() => res(), 5000);
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
      if (session.status === "running") {
        this.platformKill(child, true);
      }
    }
    // Await final close, capped at 2 s.
    if (session.status === "running") {
      await Promise.race([
        new Promise<void>((res) => child.once("close", () => res())),
        new Promise<void>((res) => {
          const t = setTimeout(() => res(), 2000);
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
    }
    if (session.status === "running") {
      session.settle("killed", null);
    } else if (session.status === "exited") {
      // Race: close fired first as 'exited' just before kill landed. Reclassify.
      session.status = "killed";
    }
    return true;
  }

  private platformKill(child: ChildProcess, force: boolean): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      try {
        const args = force ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
        // Phase C: pin PATHEXT so bare-name `taskkill` resolves under a
        // mangled inherited .CPL (else the session kill itself would fail).
        const killer = spawn("taskkill", args, {
          windowsHide: true,
          stdio: "ignore",
          env: { ...process.env, PATHEXT: STANDARD_WINDOWS_PATHEXT },
        });
        killer.on("error", () => {
          try {
            child.kill(force ? "SIGKILL" : "SIGTERM");
          } catch {
            /* ignore */
          }
        });
      } catch {
        try {
          child.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }

  /** GC sweep: drop sessions whose settled_at is older than sessionTtlMs.
   *  Running sessions are never GC'd. */
  private gc(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.settled_at === null) continue;
      const settledMs = Date.parse(s.settled_at);
      if (now - settledMs >= this.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }

  /** SIGKILL all running children, await their exit (10 s hard deadline),
   *  clear the GC interval. Called on SIGINT/SIGTERM. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.gcInterval);
    const pending: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      if (s.status !== "running" || !s.child) continue;
      this.platformKill(s.child, true);
      pending.push(
        new Promise<void>((res) => {
          s.child!.once("close", () => res());
          const t = setTimeout(() => res(), 10_000);
          if (typeof t.unref === "function") t.unref();
        }),
      );
    }
    await Promise.all(pending);
    // Mark anything still flagged running as killed (defensive — close may
    // never have fired on the children if the platform refused).
    for (const s of this.sessions.values()) {
      if (s.status === "running") s.settle("killed", null);
    }
  }
}
