import { execSync } from "node:child_process";
import type { PluginDiscovery } from "../state/project-state.js";
import { validatePlugin } from "./validator.js";

// --- Discovery & conflict detection interfaces ---

export interface PluginRecommendation {
  name: string;
  description: string;
  installCommand: string;
  hooks?: string[];
  skills?: string[];
}

export interface ConflictReport {
  warnings: string[];
}

const PLUGIN_REGISTRY = {
  typescript: [
    {
      name: "ts-dev-kit",
      description: "TypeScript development toolkit with auto-formatting and strict mode helpers",
      installCommand: "claude plugin install ts-dev-kit",
      hooks: ["on-save", "pre-commit"],
      skills: ["format-ts", "strict-check"],
    },
    {
      name: "composure",
      description: "Code graph, quality enforcement, and structured thinking for Claude Code",
      installCommand: "claude plugin install composure",
      hooks: ["pre-commit", "post-commit"],
      skills: ["code-review", "build-graph", "audit"],
    },
  ],
  python: [
    {
      name: "python-lint",
      description: "Python linting and auto-fix with ruff integration",
      installCommand: "claude plugin install python-lint",
      hooks: ["on-save", "pre-commit"],
      skills: ["lint-python", "fix-imports"],
    },
    {
      name: "pytest-runner",
      description: "Automatic pytest discovery and execution",
      installCommand: "claude plugin install pytest-runner",
      hooks: ["post-save"],
      skills: ["run-tests", "coverage-report"],
    },
  ],
  react: [
    {
      name: "react-dev-tools",
      description: "React component scaffolding and hooks analysis",
      installCommand: "claude plugin install react-dev-tools",
      hooks: ["on-save"],
      skills: ["scaffold-component", "analyze-hooks"],
    },
  ],
  rust: [
    {
      name: "cargo-assistant",
      description: "Cargo build integration and clippy auto-fix",
      installCommand: "claude plugin install cargo-assistant",
      hooks: ["pre-commit"],
      skills: ["cargo-check", "clippy-fix"],
    },
  ],
  go: [
    {
      name: "go-tools",
      description: "Go formatting, vet, and test runner",
      installCommand: "claude plugin install go-tools",
      hooks: ["on-save", "pre-commit"],
      skills: ["go-fmt", "go-vet", "go-test"],
    },
  ],
} as const satisfies Record<string, readonly PluginRecommendation[]>;

const DOMAIN_PLUGINS = {
  web: [
    {
      name: "a11y-checker",
      description: "Accessibility audit for web applications",
      installCommand: "claude plugin install a11y-checker",
      skills: ["audit-a11y"],
    },
  ],
  api: [
    {
      name: "openapi-gen",
      description: "OpenAPI spec generation and validation",
      installCommand: "claude plugin install openapi-gen",
      skills: ["generate-spec", "validate-api"],
    },
  ],
  "machine-learning": [
    {
      name: "ml-experiment",
      description: "ML experiment tracking and model evaluation",
      installCommand: "claude plugin install ml-experiment",
      skills: ["track-experiment", "evaluate-model"],
    },
  ],
} as const satisfies Record<string, readonly PluginRecommendation[]>;

type PluginRegistryKey = keyof typeof PLUGIN_REGISTRY;
type DomainPluginKey = keyof typeof DOMAIN_PLUGINS;

function isPluginRegistryKey(key: string): key is PluginRegistryKey {
  return key in PLUGIN_REGISTRY;
}

function isDomainPluginKey(key: string): key is DomainPluginKey {
  return key in DOMAIN_PLUGINS;
}

export function discoverPlugins(
  techStack: string[],
  domain: string
): PluginRecommendation[] {
  const seen = new Set<string>();
  const results: PluginRecommendation[] = [];

  for (const tech of techStack) {
    const key = tech.toLowerCase();
    if (!isPluginRegistryKey(key)) continue;
    const matches = PLUGIN_REGISTRY[key];
    for (const plugin of matches) {
      if (!seen.has(plugin.name)) {
        seen.add(plugin.name);
        results.push(plugin);
      }
    }
  }

  const domainKey = domain.toLowerCase();
  if (isDomainPluginKey(domainKey)) {
    const domainMatches = DOMAIN_PLUGINS[domainKey];
    for (const plugin of domainMatches) {
      if (!seen.has(plugin.name)) {
        seen.add(plugin.name);
        results.push(plugin);
      }
    }
  }

  return results;
}

/**
 * Check for hook overlaps and skill duplications between existing and new plugins.
 * Returns warnings (non-blocking) — caller decides whether to proceed.
 */
export function checkPluginConflicts(
  existing: PluginRecommendation[],
  newPlugins: PluginRecommendation[]
): ConflictReport {
  const warnings: string[] = [];

  // Collect hooks and skills from existing plugins
  const existingHooks = new Map<string, string>();
  const existingSkills = new Map<string, string>();

  for (const plugin of existing) {
    for (const hook of plugin.hooks ?? []) {
      existingHooks.set(hook, plugin.name);
    }
    for (const skill of plugin.skills ?? []) {
      existingSkills.set(skill, plugin.name);
    }
  }

  // Check new plugins against existing ones
  for (const plugin of newPlugins) {
    for (const hook of plugin.hooks ?? []) {
      const owner = existingHooks.get(hook);
      if (owner) {
        warnings.push(
          `Hook "${hook}" in "${plugin.name}" overlaps with existing plugin "${owner}"`
        );
      }
    }
    for (const skill of plugin.skills ?? []) {
      const owner = existingSkills.get(skill);
      if (owner) {
        warnings.push(
          `Skill "${skill}" in "${plugin.name}" duplicates capability from "${owner}"`
        );
      }
    }
  }

  return { warnings };
}

/**
 * Install discovered plugins via Claude Code CLI.
 */
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
      const cmd = `claude plugin install ${pluginRef} --scope ${plugin.scope}`;

      console.log(`[plugin] Installing: ${plugin.name} (${plugin.reason})`);
      execSync(cmd, { stdio: "pipe", timeout: 60_000 });
      console.log(`[plugin] Installed: ${plugin.name}`);
      return { ...plugin, installed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[plugin] Failed to install ${plugin.name}: ${msg}`);
      return plugin;
    }
  });
}
