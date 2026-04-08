import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

const { discoverLspServers, checkExistingLsp } = await import(
  "../../src/environment/lsp-manager.js"
);

describe("LSP Discovery", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  describe("discoverLspServers", () => {
    it("discovers servers for a known language", () => {
      const results = discoverLspServers(["typescript"]);

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.language === "typescript")).toBe(true);
      expect(results.every((r) => r.installed === false)).toBe(true);
      expect(results.every((r) => r.installCommand.length > 0)).toBe(true);

      const serverNames = results.map((r) => r.server);
      expect(serverNames).toContain("vtsls");
      expect(serverNames).toContain("typescript-language-server");
    });

    it("returns empty array for unknown language", () => {
      const results = discoverLspServers(["brainfuck"]);
      expect(results).toEqual([]);
    });

    it("handles multiple languages at once", () => {
      const results = discoverLspServers(["python", "rust", "go"]);

      const languages = new Set(results.map((r) => r.language));
      expect(languages).toContain("python");
      expect(languages).toContain("rust");
      expect(languages).toContain("go");

      const pythonServers = results.filter((r) => r.language === "python");
      expect(pythonServers.length).toBeGreaterThanOrEqual(3);
      expect(pythonServers.map((s) => s.server)).toContain("pyright");

      const rustServers = results.filter((r) => r.language === "rust");
      expect(rustServers.length).toBe(1);
      expect(rustServers[0]!.server).toBe("rust-analyzer");

      const goServers = results.filter((r) => r.language === "go");
      expect(goServers.length).toBe(1);
      expect(goServers[0]!.server).toBe("gopls");
    });

    it("is case-insensitive for language names", () => {
      const results = discoverLspServers(["TypeScript", "PYTHON"]);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.language === r.language.toLowerCase())).toBe(true);
    });
  });

  describe("checkExistingLsp", () => {
    it("returns installed config when server binary is found", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pyright"));

      const result = checkExistingLsp("python");

      expect(result).not.toBeNull();
      expect(result!.language).toBe("python");
      expect(result!.server).toBe("pyright");
      expect(result!.installed).toBe(true);
    });

    it("returns null when no server is installed", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const result = checkExistingLsp("rust");
      expect(result).toBeNull();
    });

    it("returns null for unknown language", () => {
      const result = checkExistingLsp("cobol");
      expect(result).toBeNull();
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it("returns first found server when multiple are installed", () => {
      // First which call succeeds (first server in registry)
      mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/vtsls"));

      const result = checkExistingLsp("typescript");

      expect(result).not.toBeNull();
      expect(result!.server).toBe("vtsls");
      // Should only check once since the first one was found
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    });
  });
});
