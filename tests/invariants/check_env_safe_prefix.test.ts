import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkEnvImpl } from "../../src/tools/system/check_env.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * Spec §2 invariant #8 ABSOLUTE: the exposed prefix MUST be 0 chars (when
 * value length < 4) or exactly 4 chars. Never more. This invariant exists
 * because check_env is the LAST line of defense against env-var
 * exfiltration — even if a caller could probe many env vars, knowing only
 * `{present, length, prefix[0:4]}` cannot mathematically reveal the value
 * past the 4-char window.
 */
describe("invariant: check_env safe-prefix mathematical bound (spec §2 #8)", () => {
  let config: ResolvedConfig;
  let root: string;
  const ENV = "WINFS_INVARIANT_CHECK_ENV_TEST";

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    delete process.env[ENV];
    await cleanupTempConfig(root);
  });

  // Adversarial cases: regardless of value length, prefix.length must be in
  // {0, 4}. We probe a wide range of lengths including pathological ones.
  const VALUE_LENGTHS = [0, 1, 2, 3, 4, 5, 10, 64, 1024, 65536];

  for (const len of VALUE_LENGTHS) {
    it(`value length ${len}: prefix.length ∈ {0, 4}`, async () => {
      process.env[ENV] = "x".repeat(len);
      const res = await checkEnvImpl({ name: ENV }, config);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      // Length is reported verbatim.
      expect(res.value.length).toBe(len);
      // CRITICAL: prefix.length is bounded.
      expect([0, 4]).toContain(res.value.prefix.length);
      // And specifically: 0 iff len < 4, else exactly 4.
      if (len < 4) {
        expect(res.value.prefix).toBe("");
      } else {
        expect(res.value.prefix.length).toBe(4);
      }
    });
  }

  it("varying first 4 chars: prefix reflects them exactly, no more", async () => {
    process.env[ENV] = "PASSWORD-SECRET-DO-NOT-LEAK";
    const res = await checkEnvImpl({ name: ENV }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.prefix).toBe("PASS");
    // Mathematically: no part of "WORD-SECRET-DO-NOT-LEAK" appears.
    expect(res.value.prefix.includes("W")).toBe(false);
    expect(res.value.prefix.includes("O")).toBe(false);
    expect(res.value.prefix.includes("R")).toBe(false);
    expect(res.value.prefix.includes("D")).toBe(false);
  });

  it("multibyte chars in the first 4 codepoints are still exactly the first 4 chars (slice semantics)", async () => {
    // String.slice operates on UTF-16 code UNITS. With surrogate pairs the
    // exposed prefix is bounded by code-unit count, not codepoints. This is
    // the spec's intent: bounded leak regardless of value composition.
    process.env[ENV] = "Привет, мир!";
    const res = await checkEnvImpl({ name: ENV }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.prefix.length).toBe(4);
    expect(res.value.prefix).toBe("Прив");
  });
});
