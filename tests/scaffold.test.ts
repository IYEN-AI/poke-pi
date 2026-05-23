import { describe, expect, it } from "vitest";
import { getHarnessHelp } from "../src/index.js";

describe("scaffold", () => {
  it("exposes harness help without external services", () => {
    expect(getHarnessHelp()).toContain("Pokemon Red/Blue AI harness CLI");
    expect(getHarnessHelp()).toContain("mGBA preflight");
  });
});
