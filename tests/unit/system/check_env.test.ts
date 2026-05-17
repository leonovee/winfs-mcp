import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkEnvImpl } from "../../../src/tools/system/check_env.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/system/check_env", () => {
  let config: ResolvedConfig;
  let root: string;
  const ENV_NAME_LONG = "WINFS_TEST_CHECK_ENV_LONG";
  const ENV_NAME_SHORT = "WINFS_TEST_CHECK_ENV_SHORT";
  const ENV_NAME_MISSING = "WINFS_TEST_CHECK_ENV_NOPE_99999";

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    process.env[ENV_NAME_LONG] = "ThisIsAReallyLongValueWithASecretInside";
    process.env[ENV_NAME_SHORT] = "ab"; // length 2, less than SAFE_PREFIX_LEN
    delete process.env[ENV_NAME_MISSING];
  });

  afterEach(async () => {
    delete process.env[ENV_NAME_LONG];
    delete process.env[ENV_NAME_SHORT];
    await cleanupTempConfig(root);
  });

  it("present long var: returns length + first 4 chars only", async () => {
    const res = await checkEnvImpl({ name: ENV_NAME_LONG }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.present).toBe(true);
    expect(res.value.length).toBe("ThisIsAReallyLongValueWithASecretInside".length);
    expect(res.value.prefix).toBe("This");
    expect(res.value.prefix.length).toBe(4);
  });

  it("present short var (< 4 chars): prefix is empty string", async () => {
    const res = await checkEnvImpl({ name: ENV_NAME_SHORT }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.present).toBe(true);
    expect(res.value.length).toBe(2);
    expect(res.value.prefix).toBe("");
  });

  it("missing var: present:false, length:0, prefix empty", async () => {
    const res = await checkEnvImpl({ name: ENV_NAME_MISSING }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.present).toBe(false);
    expect(res.value.length).toBe(0);
    expect(res.value.prefix).toBe("");
  });
});
