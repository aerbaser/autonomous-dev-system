import { describe, it, expect } from "vitest";
import { renderDashboard } from "../../src/dashboard/template.js";
import type { DashboardData } from "../../src/dashboard/generate.js";

function makeMinimalData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    projectId: "proj-abc",
    idea: "Test project idea",
    currentPhase: "ideation",
    totalCostUsd: 0.42,
    createdAt: "2026-04-17T10:00:00.000Z",
    generatedAt: "2026-04-17T10:05:00.000Z",
    stateExists: true,
    phases: [
      { phase: "ideation", status: "completed", costUsd: 0.2, durationMs: 1_200 },
      { phase: "specification", status: "current" },
      { phase: "architecture", status: "pending" },
    ],
    events: [],
    agents: [],
    evolution: [],
    ...overrides,
  };
}

describe("renderDashboard", () => {
  it("returns a full HTML document for a minimal state", () => {
    const html = renderDashboard(makeMinimalData());

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Autonomous Dev — Dashboard</title>");
    expect(html.trim().endsWith("</html>")).toBe(true);
  });

  it("embeds project identity and the current phase", () => {
    const html = renderDashboard(
      makeMinimalData({ projectId: "proj-xyz", idea: "Some cool idea", currentPhase: "development" }),
    );

    expect(html).toContain("proj-xyz");
    expect(html).toContain("Some cool idea");
    // currentPhase is rendered into the header stat block.
    expect(html).toContain("development");
  });

  it("renders the pipeline, cost, evolution and timeline sections", () => {
    const html = renderDashboard(makeMinimalData());

    // Section titles are rendered verbatim inside the HTML.
    expect(html).toContain("Phase Pipeline");
    expect(html).toContain("Cost per Phase");
    expect(html).toContain("Self-Improvement Metrics");
    expect(html).toContain("Event Timeline");
    expect(html).toContain("Agent Registry");
  });

  it("HTML-escapes dangerous characters in user-supplied idea text", () => {
    const html = renderDashboard(
      makeMinimalData({ idea: `<script>alert("xss")</script>` }),
    );

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
  });

  it("shows empty-state placeholders when there are no events or agents", () => {
    const html = renderDashboard(makeMinimalData());
    expect(html).toContain("No events yet");
    expect(html).toContain("No agents registered yet");
  });
});
