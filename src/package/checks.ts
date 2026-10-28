import { worstStatus } from "../domain/aggregation.js";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import type { CheckOutcome, PluginInfo } from "../domain/types.js";
import type { PluginManifest } from "./manifest.js";
import { validateManifest } from "./manifest.js";

/** Package.json structural validation as a CheckOutcome. */
export function manifestCheckOutcome(manifest: PluginManifest): CheckOutcome {
  const diagnostics = validateManifest(manifest);
  const fatal = diagnostics.filter((d) => d.code !== "PKG009" && d.code !== "PKG012");
  const warnings = diagnostics.filter((d) => d.code === "PKG009" || d.code === "PKG012");
  return {
    name: "package-manifest",
    status: worstStatus(fatal.length > 0 ? ["fail"] : warnings.length > 0 ? ["warn"] : ["pass"]),
    diagnostics,
  };
}

/** Packed tarball inspection as a CheckOutcome. */
export function artifactCheckOutcome(missingPackedFiles: readonly string[]): CheckOutcome {
  const diagnostics: Diagnostic[] = missingPackedFiles.map((file) =>
    diag(
      "PKG",
      "007",
      `exported file missing from the packed tarball: ${file}`,
      "check the package.json files field",
    ),
  );
  return {
    name: "packed-artifact",
    status: missingPackedFiles.length > 0 ? "fail" : "pass",
    diagnostics,
  };
}

/** Host-side plugin state + declared surfaces as a CheckOutcome. */
export function pluginRegistrationCheckOutcome(
  plugin: PluginInfo,
  surfaces: readonly string[],
): CheckOutcome {
  const diagnostics: Diagnostic[] = [];
  let status: "pass" | "fail" = "pass";
  if (plugin.state.status === "failed") {
    status = "fail";
    diagnostics.push(diag("HOST", "006", `plugin failed during setup: ${plugin.state.error}`));
  }
  const missingSurfaces = surfaces.filter(
    (s) => plugin.features[s as keyof PluginInfo["features"]] !== true,
  );
  if (missingSurfaces.length > 0) {
    status = "fail";
    diagnostics.push(
      diag(
        "HOST",
        "007",
        `plugin does not expose declared surface(s): ${missingSurfaces.join(", ")}`,
        "declare them in the exports map (./tui, ./rpc) or drop them from config surfaces",
      ),
    );
  }
  return { name: "plugin-registration", status, diagnostics };
}
