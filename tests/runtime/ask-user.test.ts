import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import { promptUser, AskUserRecordSchema } from "../../src/runtime/ask-user.js";

const ROOT = join(tmpdir(), `ads-askuser-test-${process.pid}`);
const JOURNAL = join(ROOT, "pending-questions.jsonl");

function readJournal(): Array<Record<string, unknown>> {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Build a fake readline interface. We use DI (`readlineFactory`) to sidestep
 * the complexity of mocking node:readline/promises' module surface. The
 * production call site uses the default factory (no DI), so the DI hook only
 * runs under tests — keeping the production code path unchanged.
 */
function fakeReadline(answer: string | Promise<string>): ReadlineInterface {
  const closed = { value: false };
  const fake = {
    question: (_prompt: string) => Promise.resolve(answer),
    close: () => {
      closed.value = true;
    },
    // The DI contract only exercises `question` + `close`; cast to satisfy
    // the ReadlineInterface surface without implementing every method.
  } as unknown as ReadlineInterface;
  return fake;
}

describe("promptUser", () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });
    mkdirSync(ROOT, { recursive: true });
    // Snapshot TTY; each test sets it explicitly.
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("flag=false: returns default, journals 'skipped-flag-off'", async () => {
    const result = await promptUser(
      "Proceed?",
      { defaultValue: "yes" },
      { allowAskUser: false, stateDir: ROOT },
    );
    expect(result).toEqual({ answer: "yes", source: "default" });

    const entries = readJournal();
    expect(entries).toHaveLength(1);
    const parsed = AskUserRecordSchema.parse(entries[0]);
    expect(parsed.resolution).toBe("skipped-flag-off");
    expect(parsed.question).toBe("Proceed?");
    expect(parsed.defaultValue).toBe("yes");
  });

  it("non-TTY + flag=true: returns default, journals 'skipped-non-interactive'", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    });

    const result = await promptUser(
      "Proceed?",
      { defaultValue: "skip" },
      { allowAskUser: true, stateDir: ROOT },
    );
    expect(result).toEqual({ answer: "skip", source: "default" });

    const entries = readJournal();
    expect(entries).toHaveLength(1);
    const parsed = AskUserRecordSchema.parse(entries[0]);
    expect(parsed.resolution).toBe("skipped-non-interactive");
  });

  it("TTY + flag=true + user answers 'yes': returns {answer:'yes', source:'user'}", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });

    const result = await promptUser(
      "Proceed?",
      { defaultValue: "no" },
      {
        allowAskUser: true,
        stateDir: ROOT,
        readlineFactory: () => fakeReadline("yes\n"),
      },
    );
    expect(result).toEqual({ answer: "yes", source: "user" });

    const entries = readJournal();
    expect(entries).toHaveLength(1);
    const parsed = AskUserRecordSchema.parse(entries[0]);
    expect(parsed.resolution).toBe("answered");
  });

  it("TTY + flag=true + empty input: returns default with source='default'", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });

    const result = await promptUser(
      "Proceed?",
      { defaultValue: "fallback" },
      {
        allowAskUser: true,
        stateDir: ROOT,
        readlineFactory: () => fakeReadline(""),
      },
    );
    expect(result).toEqual({ answer: "fallback", source: "default" });

    const entries = readJournal();
    expect(entries).toHaveLength(1);
    const parsed = AskUserRecordSchema.parse(entries[0]);
    expect(parsed.resolution).toBe("default-empty");
  });

  it("TTY + flag=true + timeout fires: returns default with source='timeout'", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });

    // Never-resolving answer promise triggers the timeout branch.
    const neverResolve = new Promise<string>(() => { /* hang */ });
    const result = await promptUser(
      "Proceed?",
      { defaultValue: "timed-out", timeoutMs: 20 },
      {
        allowAskUser: true,
        stateDir: ROOT,
        readlineFactory: () => fakeReadline(neverResolve),
      },
    );
    expect(result).toEqual({ answer: "timed-out", source: "timeout" });

    const entries = readJournal();
    expect(entries).toHaveLength(1);
    const parsed = AskUserRecordSchema.parse(entries[0]);
    expect(parsed.resolution).toBe("timeout");
  });
});
