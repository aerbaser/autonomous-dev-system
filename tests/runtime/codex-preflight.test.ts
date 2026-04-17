import { describe, it, expect } from "vitest";
import {
  runCodexPreflight,
  UnsupportedTeamRuntimeError,
  isNightlyRun,
  NIGHTLY_ENV_FLAG,
  UNSUPPORTED_RUNTIME_PREFIX,
} from "../../src/runtime/codex-preflight.js";

describe("runCodexPreflight", () => {
  it("succeeds when the probe command returns a version string", async () => {
    // `node --version` is always available on any host running this test
    // suite, and the preflight accepts any non-empty stdout as a success
    // signal. Re-binding `command` lets us exercise the happy path without
    // needing Codex itself installed.
    const res = await runCodexPreflight({ command: "node" });
    expect(res.ok).toBe(true);
    expect(res.version).toMatch(/^v?\d/);
  });

  it("throws UnsupportedTeamRuntimeError when the binary is missing", async () => {
    await expect(
      runCodexPreflight({
        command: "definitely-not-a-binary-on-this-host-xyz",
        timeoutMs: 2000,
      }),
    ).rejects.toBeInstanceOf(UnsupportedTeamRuntimeError);
  });

  it("error message carries the unsupported_team_runtime reason code", async () => {
    try {
      await runCodexPreflight({
        command: "definitely-not-a-binary-on-this-host-xyz",
        timeoutMs: 2000,
      });
      throw new Error("expected preflight to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTeamRuntimeError);
      const e = err as UnsupportedTeamRuntimeError;
      expect(e.reasonCode).toBe("unsupported_team_runtime");
      expect(e.message).toContain(UNSUPPORTED_RUNTIME_PREFIX);
    }
  });
});

describe("isNightlyRun", () => {
  it("returns true when the nightly env flag is set to '1'", () => {
    expect(isNightlyRun({ [NIGHTLY_ENV_FLAG]: "1" })).toBe(true);
  });

  it("returns false when the flag is unset", () => {
    expect(isNightlyRun({})).toBe(false);
  });

  it("returns false for any value other than '1'", () => {
    expect(isNightlyRun({ [NIGHTLY_ENV_FLAG]: "true" })).toBe(false);
    expect(isNightlyRun({ [NIGHTLY_ENV_FLAG]: "" })).toBe(false);
    expect(isNightlyRun({ [NIGHTLY_ENV_FLAG]: "0" })).toBe(false);
  });
});
