import { definePluginTestSuite } from "@coool/opencode-plugin-test";

export default definePluginTestSuite({
  name: "fixture-suite-tests",
  scenarios: {
    "plugin-is-active": async ({ plugin }) => {
      if (plugin.state.status !== "active") {
        throw new Error(`expected active plugin, got ${plugin.state.status}`);
      }
    },
    "api-reachable": async ({ request }) => {
      const res = await request("/api/plugin");
      if (res.status !== 200) {
        throw new Error(`expected 200 from /api/plugin, got ${res.status}`);
      }
    },
  },
});
