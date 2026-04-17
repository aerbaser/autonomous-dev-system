import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvelope,
  detectPackageManager,
  renderEnvelopeBlock,
  ExecutionEnvelopeSchema,
} from "../../src/runtime/execution-envelope.js";

const ROOT = join(tmpdir(), `ads-envelope-test-${process.pid}`);

describe("execution-envelope", () => {
  beforeEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });
    mkdirSync(ROOT, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });
  });

  describe("detectPackageManager", () => {
    it("detects npm from package-lock.json", () => {
      writeFileSync(join(ROOT, "package-lock.json"), "{}");
      expect(detectPackageManager(ROOT)).toBe("npm");
    });

    it("detects pnpm from pnpm-lock.yaml", () => {
      writeFileSync(join(ROOT, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(ROOT)).toBe("pnpm");
    });

    it("detects yarn from yarn.lock", () => {
      writeFileSync(join(ROOT, "yarn.lock"), "");
      expect(detectPackageManager(ROOT)).toBe("yarn");
    });

    it("detects bun from bun.lockb", () => {
      writeFileSync(join(ROOT, "bun.lockb"), "");
      expect(detectPackageManager(ROOT)).toBe("bun");
    });

    it("prefers bun over pnpm when both lockfiles exist", () => {
      writeFileSync(join(ROOT, "bun.lockb"), "");
      writeFileSync(join(ROOT, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(ROOT)).toBe("bun");
    });

    it("falls back to npm when only package.json exists", () => {
      writeFileSync(join(ROOT, "package.json"), "{}");
      expect(detectPackageManager(ROOT)).toBe("npm");
    });

    it("returns unknown with no manifest", () => {
      expect(detectPackageManager(ROOT)).toBe("unknown");
    });
  });

  describe("buildEnvelope", () => {
    it("builds an envelope for a valid project root", async () => {
      writeFileSync(join(ROOT, "package.json"), "{}");
      writeFileSync(join(ROOT, "package-lock.json"), "{}");
      const env = await buildEnvelope(ROOT);

      expect(env.projectRoot).toBe(ROOT);
      expect(env.writableRoot).toBe(ROOT);
      expect(env.environment.packageManager).toBe("npm");
      expect(env.environment.nodeVersion).toBe(process.version);
      expect(env.environment.os.length).toBeGreaterThan(0);
      expect(env.allowedVerificationCommands).toContain("npm test");
      // branch: may be null (temp dir isn't a git repo) — test it's either null or a string
      expect(env.branch === null || typeof env.branch === "string").toBe(true);
      // Schema round-trip
      expect(() => ExecutionEnvelopeSchema.parse(env)).not.toThrow();
    });

    it("throws a descriptive error when projectRoot does not exist", async () => {
      await expect(
        buildEnvelope(join(ROOT, "does-not-exist")),
      ).rejects.toThrow(/does not exist/);
    });

    it("throws a descriptive error when projectRoot is a file", async () => {
      const filePath = join(ROOT, "not-a-dir.txt");
      writeFileSync(filePath, "hello");
      await expect(buildEnvelope(filePath)).rejects.toThrow(/not a directory/);
    });

    it("throws when projectRoot is empty", async () => {
      await expect(buildEnvelope("")).rejects.toThrow(/non-empty string/);
    });

    it("honors a pnpm lockfile for default verification commands", async () => {
      writeFileSync(join(ROOT, "pnpm-lock.yaml"), "");
      const env = await buildEnvelope(ROOT);
      expect(env.environment.packageManager).toBe("pnpm");
      expect(env.allowedVerificationCommands).toContain("pnpm test");
    });

    it("falls back to npm commands when detection is unknown", async () => {
      const env = await buildEnvelope(ROOT);
      expect(env.environment.packageManager).toBe("unknown");
      expect(env.allowedVerificationCommands).toEqual([
        "npm test",
        "npm run typecheck",
        "npm run lint",
      ]);
    });

    it("accepts explicit verification command override", async () => {
      const env = await buildEnvelope(ROOT, {
        allowedVerificationCommands: ["cargo test"],
      });
      expect(env.allowedVerificationCommands).toEqual(["cargo test"]);
    });

    it("includes packageRoot only when it diverges from projectRoot", async () => {
      const pkgDir = join(ROOT, "packages", "core");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), "{}");
      writeFileSync(join(pkgDir, "pnpm-lock.yaml"), "");

      const env = await buildEnvelope(ROOT, { packageRoot: pkgDir });
      expect(env.packageRoot).toBe(pkgDir);
      // packageManager detection uses packageRoot when provided
      expect(env.environment.packageManager).toBe("pnpm");
    });

    it("omits packageRoot when equal to projectRoot", async () => {
      const env = await buildEnvelope(ROOT, { packageRoot: ROOT });
      expect(env.packageRoot).toBeUndefined();
    });

    it("throws when packageRoot does not exist", async () => {
      await expect(
        buildEnvelope(ROOT, { packageRoot: join(ROOT, "missing") }),
      ).rejects.toThrow(/packageRoot does not exist/);
    });
  });

  describe("renderEnvelopeBlock", () => {
    it("renders a structured XML-like block", async () => {
      writeFileSync(join(ROOT, "package.json"), "{}");
      const env = await buildEnvelope(ROOT);
      const block = renderEnvelopeBlock(env);

      expect(block.startsWith("<execution-envelope>")).toBe(true);
      expect(block.endsWith("</execution-envelope>")).toBe(true);
      expect(block).toContain(`projectRoot: ${ROOT}`);
      expect(block).toContain("packageManager:");
      expect(block).toContain("allowedVerificationCommands:");
    });

    it("surfaces '(not a git repo)' when branch is null", async () => {
      // Build envelope in a non-git tmpdir and confirm the rendered block is
      // readable rather than literal `null`.
      writeFileSync(join(ROOT, "package.json"), "{}");
      const env = await buildEnvelope(ROOT);
      if (env.branch === null) {
        expect(renderEnvelopeBlock(env)).toContain("branch: (not a git repo)");
      }
    });
  });
});
