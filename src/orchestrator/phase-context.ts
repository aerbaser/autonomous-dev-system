import type { ProjectState } from "../state/project-state.js";
import type { PhaseContext } from "./phase-contract.js";

/**
 * Hard cap on serialized phase context length. The primitive enforces this
 * before the context is injected into a lead prompt. The intent is a
 * belt-and-suspenders guard against context-window explosions on later
 * phases — not a replacement for each contract's own selector discipline.
 */
export const MAX_PHASE_CONTEXT_CHARS = 20000;

/**
 * Stringify a PhaseContext into the deterministic `<phase-context>` block
 * consumed by the lead prompt. Throws if the rendered block exceeds the
 * safety cap — at that point the selector is picking up too much state
 * and must be tightened.
 */
export function renderPhaseContext(ctx: PhaseContext): string {
  const lines: string[] = [];
  lines.push("<phase-context>");
  if (ctx.summary.length > 0) {
    lines.push("<summary>");
    for (const line of ctx.summary) lines.push(`- ${line}`);
    lines.push("</summary>");
  }
  for (const [key, value] of Object.entries(ctx.slices)) {
    lines.push(`<slice name="${escapeXmlAttr(key)}">`);
    lines.push(JSON.stringify(value, null, 2));
    lines.push("</slice>");
  }
  lines.push("</phase-context>");
  const rendered = lines.join("\n");
  if (rendered.length > MAX_PHASE_CONTEXT_CHARS) {
    throw new Error(
      `Phase context exceeded ${MAX_PHASE_CONTEXT_CHARS} chars (got ${rendered.length}). ` +
        `Tighten the contract's contextSelector to return smaller slices.`,
    );
  }
  return rendered;
}

function escapeXmlAttr(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "\"": return "&quot;";
      default: return "&apos;";
    }
  });
}

/**
 * Default context selector — returns an empty PhaseContext. Handlers that
 * need real context should pass their own selector through the contract.
 * The default exists only so tests and new phases can start from a valid
 * zero value.
 */
export const emptyPhaseContextSelector = (_state: ProjectState): PhaseContext => ({
  summary: [],
  slices: {},
});
