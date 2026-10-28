import { describe, expect, it } from "vitest";
import {
  CODE_CATALOG,
  diag,
  EXIT_INVOCATION,
  EXIT_OK,
  EXIT_TEST_FAILURE,
  exitCodeForDiagnostics,
} from "../src/domain/diagnostics.js";

describe("diagnostics", () => {
  it("creates diagnostics with optional hints", () => {
    const plain = diag("PKG", "003", "missing name");
    expect(plain).toEqual({ code: "PKG003", family: "PKG", message: "missing name" });
    const hinted = diag("PKG", "003", "missing name", "add it");
    expect(hinted.hint).toBe("add it");
  });

  it("rejects unknown codes", () => {
    expect(() => diag("PKG", "999", "x")).toThrow(/Unknown diagnostic code/);
  });

  it("accepts any cataloged code (catalog validates family+code pairs)", () => {
    expect(diag("PKG", "005", "x").code).toBe("PKG005");
  });

  it("catalog codes start with their family prefix", () => {
    for (const [code, description] of Object.entries(CODE_CATALOG)) {
      expect(code).toMatch(/^(PKG|HOST|API|SCEN|CFG|ENV|SYS)\d{3}$/);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it("maps families to exit codes with severity", () => {
    expect(exitCodeForDiagnostics([])).toBe(EXIT_OK);
    for (const family of ["PKG", "HOST", "API", "SCEN"] as const) {
      const d = diag(
        family,
        family === "PKG" ? "003" : family === "HOST" ? "006" : family === "API" ? "002" : "001",
        "x",
      );
      expect(exitCodeForDiagnostics([d])).toBe(EXIT_TEST_FAILURE);
    }
    for (const family of ["CFG", "ENV", "SYS"] as const) {
      const d = diag(family, family === "CFG" ? "003" : family === "ENV" ? "002" : "001", "x");
      expect(exitCodeForDiagnostics([d])).toBe(EXIT_INVOCATION);
    }
    expect(EXIT_INVOCATION).toBe(2);
    expect(EXIT_TEST_FAILURE).toBe(1);
  });

  it("returns the worst exit code across diagnostics", () => {
    const pass = diag("PKG", "009", "warning only");
    const fail = diag("CFG", "003", "config");
    expect(exitCodeForDiagnostics([pass, fail])).toBe(EXIT_INVOCATION);
  });

  it("does not escalate the exit code when a later diagnostic is less severe", () => {
    const cfg = diag("CFG", "003", "config");
    const pkg = diag("PKG", "003", "package");
    expect(exitCodeForDiagnostics([cfg, pkg])).toBe(EXIT_INVOCATION);
  });
});
