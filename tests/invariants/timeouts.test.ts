import { describe, it, expect } from "vitest";
import { withTimeout, resolveTimeoutMs } from "../../src/core/timeouts.js";
import { ok, type Result } from "../../src/core/errors.js";

describe("invariant: bounded timeouts never hang (spec §2.3)", () => {
  it("resolves with ETIMEDOUT when task exceeds deadline", async () => {
    const start = Date.now();
    const res = await withTimeout<Result<{ done: true }>>(
      () => new Promise((resolve) => setTimeout(() => resolve(ok({ done: true })), 5000)),
      100,
      { tool: "test_hang" },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect("ok" in res && res.ok === false).toBe(true);
    if (!("ok" in res) || res.ok !== false) throw new Error("expected timeout error");
    expect(res.error.code).toBe("ETIMEDOUT");
    expect(res.error.message).toMatch(/test_hang/);
  });

  it("returns the task value when task beats the deadline", async () => {
    const res = await withTimeout<Result<{ value: number }>>(
      () => Promise.resolve(ok({ value: 42 })),
      1000,
      { tool: "test_fast" },
    );
    expect("ok" in res && res.ok === true).toBe(true);
  });

  it("aborts the signal on timeout so cooperative tasks can clean up", async () => {
    let abortedFlag = false;
    await withTimeout(
      (signal) =>
        new Promise<Result<unknown>>((resolve) => {
          signal.addEventListener("abort", () => {
            abortedFlag = true;
            resolve(ok({}));
          });
          setTimeout(() => resolve(ok({})), 5000);
        }),
      50,
      { tool: "test_abort" },
    );
    expect(abortedFlag).toBe(true);
  });

  it("resolveTimeoutMs clamps to [1, maxMs] and defaults sanely", () => {
    expect(resolveTimeoutMs(undefined, 10_000, 60_000)).toBe(10_000);
    expect(resolveTimeoutMs(100_000, 10_000, 60_000)).toBe(60_000);
    expect(resolveTimeoutMs(0, 10_000, 60_000)).toBe(10_000);
    expect(resolveTimeoutMs(-5, 10_000, 60_000)).toBe(10_000);
    expect(resolveTimeoutMs(500, 10_000, 60_000)).toBe(500);
  });
});
