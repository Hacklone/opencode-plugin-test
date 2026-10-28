import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "fixture-startup-throw",
  async setup() {
    throw new Error("startup-throw fixture: setup exploded");
  },
});
