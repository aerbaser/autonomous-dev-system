import { describe, it, expect } from "vitest";
import {
  isValidScope,
  isValidOssType,
  VALID_SCOPES,
  VALID_OSS_TYPES,
} from "../../src/utils/type-guards.js";

describe("type-guards", () => {
  describe("isValidScope", () => {
    it("accepts the known scope values", () => {
      expect(isValidScope("project")).toBe(true);
      expect(isValidScope("user")).toBe(true);
    });

    it("rejects unknown scope values", () => {
      expect(isValidScope("global")).toBe(false);
      expect(isValidScope("")).toBe(false);
    });

    it("exposes the complete VALID_SCOPES tuple", () => {
      expect([...VALID_SCOPES]).toEqual(["project", "user"]);
    });
  });

  describe("isValidOssType", () => {
    it("accepts every enumerated OSS type", () => {
      for (const t of VALID_OSS_TYPES) {
        expect(isValidOssType(t)).toBe(true);
      }
    });

    it("rejects unknown OSS types", () => {
      expect(isValidOssType("framework")).toBe(false);
      expect(isValidOssType("tool")).toBe(false);
    });

    it("exposes all five OSS types", () => {
      expect([...VALID_OSS_TYPES]).toEqual([
        "agent",
        "skill",
        "hook",
        "mcp-server",
        "pattern",
      ]);
    });
  });
});
