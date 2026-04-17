import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LspConfig } from "../state/project-state.js";
import { validateLsp } from "./validator.js";

const execFileAsync = promisify(execFile);

// Shell metacharacters that must NEVER appear outside quoted strings. If any
// of these show up we refuse to tokenise because running the command with
// execFile would bypass a shell anyway, so their presence almost certainly
// signals an injected command the LLM produced.
const FORBIDDEN_METACHARS = new Set(["|", "&", ";", ">", "<", "`"]);

/**
 * Robust tokeniser for LSP install commands. Handles:
 *   - single- and double-quoted strings (spaces preserved verbatim)
 *   - backslash escapes inside quoted strings (e.g. `"foo\"bar"` -> foo"bar)
 *   - rejects any shell metachar outside quotes (|, &, ;, >, <, backticks, $()
 *
 * Exported so it can be unit-tested independently from the install pipeline.
 */
export function parseLspCommand(command: string): { bin: string; args: string[] } {
  const parts = tokenise(command);
  if (parts.length === 0) {
    throw new Error(`parseLspCommand: empty command`);
  }
  const [bin, ...args] = parts;
  return { bin: bin!, args };
}

function tokenise(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let touched = false; // have we added any char to `current` (including "")?

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (inQuote) {
      if (ch === "\\" && i + 1 < command.length) {
        // Backslash escape inside quotes — consume the next char verbatim.
        current += command[i + 1];
        i++;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
        continue;
      }
      current += ch;
      touched = true;
      continue;
    }

    // Outside quotes — detect shell metacharacters first so we fail loud.
    if (FORBIDDEN_METACHARS.has(ch)) {
      throw new Error(
        `parseLspCommand: forbidden shell metacharacter '${ch}' in command: ${command}`,
      );
    }
    if (ch === "$" && command[i + 1] === "(") {
      throw new Error(
        `parseLspCommand: forbidden command substitution '$(' in command: ${command}`,
      );
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      touched = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (touched) {
        parts.push(current);
        current = "";
        touched = false;
      }
      continue;
    }

    current += ch;
    touched = true;
  }

  if (inQuote) {
    throw new Error(`parseLspCommand: unterminated ${inQuote}-quoted string in: ${command}`);
  }
  if (touched) parts.push(current);
  return parts;
}

/** Internal helper kept for backward compatibility inside this module. */
function parseCommand(command: string): string[] {
  const { bin, args } = parseLspCommand(command);
  return [bin, ...args];
}

const ALLOWED_INSTALL_EXECUTABLES = new Set([
  'npm', 'npx', 'pip', 'pip3', 'brew', 'cargo', 'go',
]);

async function smokeTestLsp(server: string): Promise<boolean> {
  try {
    await execFileAsync("which", [server], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function installLspServers(servers: LspConfig[]): Promise<LspConfig[]> {
  const results: LspConfig[] = [];

  for (const lsp of servers) {
    const validation = validateLsp(lsp);
    if (!validation.valid) {
      console.log(`[lsp] Skipping ${lsp.server}: ${validation.reason}`);
      results.push(lsp);
      continue;
    }

    try {
      console.log(`[lsp] Installing ${lsp.server} for ${lsp.language}...`);
      const parts = parseCommand(lsp.installCommand);
      const executable = parts[0]!;
      if (!ALLOWED_INSTALL_EXECUTABLES.has(executable)) {
        console.log(`[lsp] Blocked: '${executable}' is not an allowed install executable`);
        results.push(lsp);
        continue;
      }
      await execFileAsync(executable, parts.slice(1), { timeout: 120_000 });

      if (await smokeTestLsp(lsp.server)) {
        console.log(`[lsp] Installed and verified: ${lsp.server}`);
        results.push({ ...lsp, installed: true });
      } else {
        console.log(`[lsp] Installed but smoke test failed: ${lsp.server}`);
        results.push(lsp);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[lsp] Failed to install ${lsp.server}: ${msg}`);
      results.push(lsp);
    }
  }

  return results;
}
