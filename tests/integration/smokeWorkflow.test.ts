import { describe, expect, it } from "vitest";
import type { PressAction } from "../../src/control/ActionTypes.js";
import { runMgbaSmokeWorkflow } from "../../src/loop/MgbaSmokeWorkflow.js";
import type { MgbaPreflightReport } from "../../src/mgba/preflight.js";

const passingPreflight: MgbaPreflightReport = {
  ok: true,
  checks: [
    { name: "config", status: "pass", message: "ok" },
    { name: "current_frame", status: "pass", message: "ok" },
    { name: "ram_wCurMap", status: "pass", message: "ok" },
    { name: "ram_wYCoord", status: "pass", message: "ok" },
    { name: "ram_wXCoord", status: "pass", message: "ok" },
    { name: "screenshot", status: "pass", message: "ok" },
    { name: "button_tap", status: "pass", message: "ok" }
  ]
};

describe("mGBA smoke workflow", () => {
  it("runs fake dependencies in order: preflight, snapshot, press B, snapshot", async () => {
    const calls: string[] = [];
    const actions: PressAction[] = [];

    const result = await runMgbaSmokeWorkflow({
      config: {
        harnessRunId: "smoke-test",
        evidenceDir: "runs",
        defaultTapFrames: 5,
        mgbaHttpBaseUrl: "http://127.0.0.1:5000",
        pokemonVersion: "red"
      },
      dependencies: {
        async runPreflight() {
          calls.push("preflight");
          return passingPreflight;
        },
        async snapshot() {
          calls.push("snapshot");
          return { ok: true };
        },
        async press(action) {
          calls.push(`press ${action.button}`);
          actions.push(action);
        }
      }
    });

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["preflight", "snapshot", "press B", "snapshot"]);
    expect(actions).toEqual([{ type: "press", button: "B", frames: 5 }]);
    expect(actions).not.toContainEqual(expect.objectContaining({ button: "A" }));
  });
});
