import { Plugin } from "@opencode/plugin";
import { writeFileSync } from "node:fs";

export default Plugin.define({
  id: "fixture-options",
  async setup(ctx) {
    const options = (ctx as { options?: { echoFile?: string; greeting?: string } }).options ?? {};
    if (typeof options.echoFile === "string") {
      writeFileSync(options.echoFile, JSON.stringify(options), "utf8");
    }
  },
});
