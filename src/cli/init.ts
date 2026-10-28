import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT_INVOCATION, EXIT_OK } from "../domain/diagnostics.js";

const CONFIG_TEMPLATE = {
  $schema:
    "https://raw.githubusercontent.com/opencode-plugin-test/main/schema/plugin-test.config.schema.json",
  targets: ["current"],
  mode: "packed",
  surfaces: ["server"],
  scenarios: "./plugin-test.scenarios.ts",
  scenarioTimeoutMs: 30000,
  bootTimeoutMs: 60000,
  reporter: "pretty",
};

const SCENARIOS_TEMPLATE = `import { definePluginTestSuite } from "opencode-plugin-test";

export default definePluginTestSuite({
  name: "my-plugin",
  scenarios: {
    "greets on setup": async ({ plugin }) => {
      if (plugin.state.status !== "active") {
        throw new Error(\`plugin is \${plugin.state.status}\`);
      }
      // exercise your plugin through the server API here, e.g.:
      // const res = await ctx.request("/api/session", { method: "POST" });
    },
  },
});
`;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** `--init`: writes a starter config + scenarios template. */
export async function runInit(dir: string): Promise<number> {
  const target = path.resolve(dir);
  const configPath = path.join(target, "plugin-test.config.json");
  const scenariosPath = path.join(target, "plugin-test.scenarios.ts");
  if (await exists(configPath)) {
    console.log(`${configPath} already exists; leaving it untouched.`);
  } else {
    await writeFile(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, "utf8");
    console.log(`wrote ${configPath}`);
  }
  if (await exists(scenariosPath)) {
    console.log(`${scenariosPath} already exists; leaving it untouched.`);
  } else {
    await writeFile(scenariosPath, SCENARIOS_TEMPLATE, "utf8");
    console.log(`wrote ${scenariosPath}`);
  }
  console.log(
    `\nNext steps:
  1. Adjust targets/mode in plugin-test.config.json.
  2. Write scenarios in plugin-test.scenarios.ts.
  3. Run: opencode-plugin-test ${dir === "." ? "" : dir}`.trimEnd(),
  );
  return EXIT_OK;
}

export const INIT_EXIT_CODES = { ok: EXIT_OK, bad: EXIT_INVOCATION };
