import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notificationHook } from "../../src/hooks/notifications.js";

const signal = new AbortController().signal;

function makeNotificationInput(message: string) {
  return {
    hook_event_name: "Notification" as const,
    session_id: "test-session",
    transcript_path: "/tmp/test-transcript",
    cwd: "/tmp",
    message,
  };
}

describe("Notification Hook", () => {
  const originalEnv = process.env.SLACK_WEBHOOK_URL;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalEnv !== undefined) {
      process.env.SLACK_WEBHOOK_URL = originalEnv;
    } else {
      delete process.env.SLACK_WEBHOOK_URL;
    }
  });

  it("sends notification to webhook URL", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";

    const result = await notificationHook(
      makeNotificationInput("Build completed"),
      undefined,
      { signal }
    );

    expect(result).toEqual({});
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "[autonomous-dev] Build completed" }),
      })
    );
  });

  it("returns empty when SLACK_WEBHOOK_URL is not set", async () => {
    delete process.env.SLACK_WEBHOOK_URL;

    const result = await notificationHook(
      makeNotificationInput("Build completed"),
      undefined,
      { signal }
    );

    expect(result).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores non-Notification events", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";

    const result = await notificationHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "test",
        transcript_path: "/tmp/t",
        cwd: "/tmp",
        tool_name: "Bash",
        tool_input: {},
        tool_response: "",
        tool_use_id: "t1",
      } as any,
      undefined,
      { signal }
    );

    expect(result).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not throw when fetch fails", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const result = await notificationHook(
      makeNotificationInput("Something happened"),
      undefined,
      { signal }
    );

    expect(result).toEqual({});
  });
});
