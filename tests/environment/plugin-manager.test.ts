import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginDiscovery } from "../../src/state/project-state.js";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

const { installPlugins } = await import("../../src/environment/plugin-manager.js");

function makePlugin(overrides: Partial<PluginDiscovery> = {}): PluginDiscovery {
  return {
    name: "test-plugin",
    source: "marketplace",
    scope: "project",
    installed: false,
    reason: "testing",
    ...overrides,
  };
}

describe("installPlugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a valid plugin as installed after a successful command", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, "", "");
    });

    const [result] = await installPlugins([makePlugin({ source: "registry" })]);

    expect(result.installed).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "claude",
      ["plugin", "install", "test-plugin@registry", "--scope", "project"],
      { timeout: 60_000 },
      expect.any(Function)
    );
  });

  it("skips plugins rejected by validation", async () => {
    const [result] = await installPlugins([makePlugin({ scope: "workspace" })]);

    expect(result.installed).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns the original plugin when the install command fails", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error("plugin install failed"));
    });

    const [result] = await installPlugins([makePlugin()]);

    expect(result.installed).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
