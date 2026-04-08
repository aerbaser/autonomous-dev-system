import { describe, it, expect } from "vitest";
import {
  discoverMcpServers,
  prioritizeMcpServers,
  type McpDiscoveryEntry,
} from "../../src/environment/mcp-manager.js";

describe("MCP Discovery", () => {
  describe("discoverMcpServers", () => {
    it("maps known tech stack keywords to MCP servers", () => {
      const results = discoverMcpServers(["PostgreSQL", "Redis"], "web");

      expect(results.length).toBe(2);

      const names = results.map((r) => r.packageName);
      expect(names).toContain("@modelcontextprotocol/server-postgres");
      expect(names).toContain("redis-mcp");
    });

    it("returns results sorted by trust tier (official first)", () => {
      const results = discoverMcpServers(
        ["Redis", "GitHub", "Docker"],
        "devops"
      );

      // Official servers (GitHub) should come before community (Redis, Docker)
      const tiers = results.map((r) => r.trustTier);
      const officialIdx = tiers.indexOf("official");
      const communityIdx = tiers.indexOf("community");
      expect(officialIdx).toBeLessThan(communityIdx);
    });

    it("deduplicates servers when stack keywords overlap", () => {
      const results = discoverMcpServers(
        ["PostgreSQL", "postgres"],
        "backend"
      );

      expect(results.length).toBe(1);
      expect(results[0].packageName).toBe(
        "@modelcontextprotocol/server-postgres"
      );
    });

    it("returns empty array for unknown tech stack", () => {
      const results = discoverMcpServers(["Haskell", "Elm"], "functional");
      expect(results).toEqual([]);
    });

    it("discovers Playwright MCP for e2e testing stack", () => {
      const results = discoverMcpServers(["Playwright"], "testing");

      expect(results.length).toBe(1);
      expect(results[0].packageName).toBe("@anthropic-ai/mcp-playwright");
      expect(results[0].trustTier).toBe("official");
    });
  });

  describe("prioritizeMcpServers", () => {
    it("sorts official before community before other", () => {
      const servers: McpDiscoveryEntry[] = [
        {
          name: "other-tool",
          packageName: "other-mcp",
          trustTier: "other",
          installCommand: "npx other-mcp",
        },
        {
          name: "community-tool",
          packageName: "community-mcp",
          trustTier: "community",
          installCommand: "npx community-mcp",
        },
        {
          name: "official-tool",
          packageName: "official-mcp",
          trustTier: "official",
          installCommand: "npx official-mcp",
        },
      ];

      const sorted = prioritizeMcpServers(servers);

      expect(sorted[0].trustTier).toBe("official");
      expect(sorted[1].trustTier).toBe("community");
      expect(sorted[2].trustTier).toBe("other");
    });

    it("preserves order within the same trust tier", () => {
      const servers: McpDiscoveryEntry[] = [
        {
          name: "redis",
          packageName: "redis-mcp",
          trustTier: "community",
          installCommand: "npx redis-mcp",
        },
        {
          name: "docker",
          packageName: "docker-mcp",
          trustTier: "community",
          installCommand: "npx docker-mcp",
        },
      ];

      const sorted = prioritizeMcpServers(servers);
      expect(sorted[0].name).toBe("redis");
      expect(sorted[1].name).toBe("docker");
    });

    it("returns empty array when given empty input", () => {
      expect(prioritizeMcpServers([])).toEqual([]);
    });

    it("does not mutate the original array", () => {
      const servers: McpDiscoveryEntry[] = [
        {
          name: "community-tool",
          packageName: "community-mcp",
          trustTier: "community",
          installCommand: "npx community-mcp",
        },
        {
          name: "official-tool",
          packageName: "official-mcp",
          trustTier: "official",
          installCommand: "npx official-mcp",
        },
      ];

      const sorted = prioritizeMcpServers(servers);
      // Original array should still have community first
      expect(servers[0].name).toBe("community-tool");
      // Sorted array should have official first
      expect(sorted[0].name).toBe("official-tool");
    });
  });
});
