import { describe, it, expect } from "vitest";
import { wrapUserInput, extractFirstJson, errMsg, isRecord } from "../../src/utils/shared.js";

describe("wrapUserInput", () => {
  it("wraps content in XML delimiters", () => {
    const result = wrapUserInput("project-idea", "Build a todo app");
    expect(result).toBe("<project-idea>\nBuild a todo app\n</project-idea>");
  });

  it("handles multiline content", () => {
    const result = wrapUserInput("spec", "line1\nline2\nline3");
    expect(result).toBe("<spec>\nline1\nline2\nline3\n</spec>");
  });

  it("handles content with XML-like characters", () => {
    const result = wrapUserInput("input", "test <script>alert('xss')</script>");
    expect(result).toContain("<input>\n");
    expect(result).toContain("\n</input>");
  });
});

describe("extractFirstJson", () => {
  it("extracts JSON from mixed text", () => {
    const text = 'Some text {"key": "value"} more text';
    expect(extractFirstJson(text)).toBe('{"key": "value"}');
  });

  it("returns null for no JSON", () => {
    expect(extractFirstJson("no json here")).toBeNull();
  });

  it("handles nested braces", () => {
    const text = '{"a": {"b": 1}}';
    expect(extractFirstJson(text)).toBe('{"a": {"b": 1}}');
  });

  it("handles braces inside strings", () => {
    const text = '{"msg": "hello {world}"}';
    expect(extractFirstJson(text)).toBe('{"msg": "hello {world}"}');
  });
});

describe("errMsg", () => {
  it("extracts message from Error", () => {
    expect(errMsg(new Error("fail"))).toBe("fail");
  });

  it("converts non-Error to string", () => {
    expect(errMsg("oops")).toBe("oops");
    expect(errMsg(42)).toBe("42");
  });
});

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});
