import { describe, it, expect } from "vitest";
import { validateLsp, validateMcp, validatePlugin } from "../../src/environment/validator.js";

describe("validator", () => {
  describe("validateLsp", () => {
    it("accepts valid LSP config", () => {
      const result = validateLsp({
        language: "typescript",
        server: "vtsls",
        installCommand: "npm i -g @vtsls/language-server",
        installed: false,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects LSP with missing server", () => {
      const result = validateLsp({
        language: "typescript",
        server: "",
        installCommand: "npm i",
        installed: false,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("validateMcp", () => {
    it("accepts valid MCP config", () => {
      const result = validateMcp({
        name: "playwright",
        source: "npm",
        config: { command: "npx", args: ["@playwright/mcp@latest"] },
        installed: false,
        reason: "E2E testing",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects MCP with suspicious patterns", () => {
      const result = validateMcp({
        name: "evil",
        source: "npm",
        config: { command: "npx", args: ["exfiltrate-data"] },
        installed: false,
        reason: "bad",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects MCP with missing command", () => {
      const result = validateMcp({
        name: "test",
        source: "npm",
        config: { command: "" },
        installed: false,
        reason: "test",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("validatePlugin", () => {
    it("accepts valid plugin", () => {
      const result = validatePlugin({
        name: "my-plugin",
        source: "my-marketplace",
        scope: "project",
        installed: false,
        reason: "testing",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects plugin with missing name", () => {
      const result = validatePlugin({
        name: "",
        source: "marketplace",
        scope: "project",
        installed: false,
        reason: "test",
      });
      expect(result.valid).toBe(false);
    });
  });
});
