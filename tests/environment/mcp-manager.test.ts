import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureMcpServers, getMcpServerConfigs } from "../../src/environment/mcp-manager.js";
import type { McpDiscovery } from "../../src/state/project-state.js";

const TEST_DIR = join(tmpdir(), `ads-test-mcp-${process.pid}`);

describe("MCP Manager", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("configureMcpServers", () => {
    it("creates .mcp.json with server configs", () => {
      const servers: McpDiscovery[] = [
        {
          name: "playwright",
          source: "npm",
          config: { command: "npx", args: ["@playwright/mcp@latest"] },
          installed: false,
          reason: "E2E testing",
        },
      ];

      const results = configureMcpServers(TEST_DIR, servers);

      expect(results[0].installed).toBe(true);

      const mcpConfig = JSON.parse(readFileSync(join(TEST_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers.playwright).toBeDefined();
      expect(mcpConfig.mcpServers.playwright.command).toBe("npx");
      expect(mcpConfig.mcpServers.playwright.args).toEqual(["@playwright/mcp@latest"]);
    });

    it("merges with existing .mcp.json config", () => {
      // Create initial config
      const initialServers: McpDiscovery[] = [
        {
          name: "github",
          source: "npm",
          config: { command: "npx", args: ["github-mcp"] },
          installed: false,
          reason: "GitHub integration",
        },
      ];
      configureMcpServers(TEST_DIR, initialServers);

      // Add another server
      const newServers: McpDiscovery[] = [
        {
          name: "playwright",
          source: "npm",
          config: { command: "npx", args: ["@playwright/mcp@latest"] },
          installed: false,
          reason: "E2E testing",
        },
      ];
      const results = configureMcpServers(TEST_DIR, newServers);

      expect(results[0].installed).toBe(true);

      const mcpConfig = JSON.parse(readFileSync(join(TEST_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers.github).toBeDefined();
      expect(mcpConfig.mcpServers.playwright).toBeDefined();
    });

    it("skips already configured servers", () => {
      const servers: McpDiscovery[] = [
        {
          name: "github",
          source: "npm",
          config: { command: "npx", args: ["github-mcp"] },
          installed: false,
          reason: "GitHub integration",
        },
      ];

      configureMcpServers(TEST_DIR, servers);
      const results = configureMcpServers(TEST_DIR, servers);

      expect(results[0].installed).toBe(true);
    });

    it("skips servers that fail validation", () => {
      const servers: McpDiscovery[] = [
        {
          name: "evil",
          source: "npm",
          config: { command: "npx", args: ["exfiltrate-data"] },
          installed: false,
          reason: "bad",
        },
      ];

      const results = configureMcpServers(TEST_DIR, servers);
      expect(results[0].installed).toBe(false);
    });

    it("skips servers with missing command", () => {
      const servers: McpDiscovery[] = [
        {
          name: "broken",
          source: "npm",
          config: { command: "" },
          installed: false,
          reason: "test",
        },
      ];

      const results = configureMcpServers(TEST_DIR, servers);
      expect(results[0].installed).toBe(false);
    });
  });

  describe("getMcpServerConfigs", () => {
    it("returns configs only for installed servers", () => {
      const servers: McpDiscovery[] = [
        {
          name: "installed-one",
          source: "npm",
          config: { command: "npx", args: ["server1"] },
          installed: true,
          reason: "test1",
        },
        {
          name: "not-installed",
          source: "npm",
          config: { command: "npx", args: ["server2"] },
          installed: false,
          reason: "test2",
        },
      ];

      const configs = getMcpServerConfigs(servers);
      expect(Object.keys(configs)).toEqual(["installed-one"]);
      expect(configs["installed-one"].command).toBe("npx");
    });

    it("returns empty object for no installed servers", () => {
      const configs = getMcpServerConfigs([]);
      expect(configs).toEqual({});
    });
  });
});
