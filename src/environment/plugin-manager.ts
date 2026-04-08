import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginDiscovery } from "../state/project-state.js";
import { validatePlugin } from "./validator.js";

const execFileAsync = promisify(execFile);

export async function installPlugins(plugins: PluginDiscovery[]): Promise<PluginDiscovery[]> {
  const results: PluginDiscovery[] = [];

  for (const plugin of plugins) {
    const validation = validatePlugin(plugin);
    if (!validation.valid) {
      console.log(`[plugin] Skipping ${plugin.name}: ${validation.reason}`);
      results.push(plugin);
      continue;
    }

    try {
      const pluginRef = plugin.source
        ? `${plugin.name}@${plugin.source}`
        : plugin.name;
      const cmdArgs = ["plugin", "install", pluginRef, "--scope", plugin.scope];

      console.log(`[plugin] Installing: ${plugin.name} (${plugin.reason})`);
      await execFileAsync("claude", cmdArgs, { timeout: 60_000 });
      console.log(`[plugin] Installed: ${plugin.name}`);
      results.push({ ...plugin, installed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[plugin] Failed to install ${plugin.name}: ${msg}`);
      results.push(plugin);
    }
  }

  return results;
}
