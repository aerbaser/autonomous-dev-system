import { execFileSync } from "node:child_process";
import type { PluginDiscovery } from "../state/project-state.js";
import { validatePlugin } from "./validator.js";

export function installPlugins(plugins: PluginDiscovery[]): PluginDiscovery[] {
  return plugins.map((plugin) => {
    const validation = validatePlugin(plugin);
    if (!validation.valid) {
      console.log(`[plugin] Skipping ${plugin.name}: ${validation.reason}`);
      return plugin;
    }

    try {
      const pluginRef = plugin.source
        ? `${plugin.name}@${plugin.source}`
        : plugin.name;
      const cmdArgs = ["plugin", "install", pluginRef, "--scope", plugin.scope];

      console.log(`[plugin] Installing: ${plugin.name} (${plugin.reason})`);
      execFileSync("claude", cmdArgs, { stdio: "pipe", timeout: 60_000 });
      console.log(`[plugin] Installed: ${plugin.name}`);
      return { ...plugin, installed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[plugin] Failed to install ${plugin.name}: ${msg}`);
      return plugin;
    }
  });
}
