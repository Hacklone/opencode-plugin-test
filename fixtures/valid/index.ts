import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "fixture-valid",
  async setup(ctx) {
    console.log("[fixture-valid] setup", typeof ctx);
  },
});
