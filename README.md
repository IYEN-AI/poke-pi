# TypeScript Pokemon Harness

Stage 1 is the default bounded Pokemon Red and Blue harness mode for mGBA-http. It reads RAM state, records evidence, chooses safe controller actions, and stops at the Stage 1 contract described below. An opt-in full-game mode exists, but it only treats Hall of Fame map observation as completion.

This project does not bundle a ROM. You must provide your own legal Pokemon Red or Pokemon Blue ROM and load it in mGBA yourself.

## Safety First

If an API key was ever pasted into chat, rotate it now. Treat it as exposed. Put new keys only in `.env`, never in source, tests, shell history, README edits, or evidence files.

Run `npm run check:secrets` before sharing changes. The scanner checks project text files for OpenAI-style `sk-` values while skipping generated, dependency, run, and orchestration evidence directories such as `node_modules`, `.git`, `runs`, `coverage`, `dist`, and `.omo`.

The harness never writes emulator memory. It uses safe Game Boy inputs only: `A`, `B`, `Start`, `Select`, `Up`, `Down`, `Left`, and `Right`.

## Setup

1. Install Node.js 20 or newer.
2. Install dependencies.

```bash
npm install
```

3. Copy the example env file.

```bash
cp .env.example .env
```

4. Edit `.env` for your local machine. Keep `.env` private.

5. Start mGBA-http, then start mGBA with `mGBASocketServer.lua` loaded and your legal ROM loaded. The harness CLI will not download ROMs.

On macOS, port `5000` may already be owned by Control Center/AirTunes. If so, run mGBA-http on `5001` and set `MGBA_HTTP_BASE_URL=http://127.0.0.1:5001`.

The mGBA 0.10.5 app can load scripts through Tools > Scripting. Newer mGBA HEAD builds also support non-interactive script loading:

```bash
brew install mgba --HEAD
mgba --script .local-tools/mgba-http/mGBASocketServer.lua /absolute/path/to/legal/rom.gb
```

Keep mGBA-http running separately. Download `mGBA-http` and `mGBASocketServer.lua` from the official mGBA-http release, or use the workspace-local `.local-tools/mgba-http/` install if it exists on your machine.

## Environment

Common settings:

```text
MGBA_HTTP_BASE_URL=http://127.0.0.1:5001
POKEMON_VERSION=red
POKEMON_ROM_PATH=/absolute/path/to/legal/rom.gb
EVIDENCE_DIR=runs
HARNESS_MODE=stage1
AI_PROVIDER=heuristic
```

`HARNESS_MODE` defaults to `stage1`. Set `HARNESS_MODE=full-game` or pass `--mode full-game` to opt into full-game detection. Full-game mode reads badge progress as a signal, but badges alone do not complete the run.

Set `AI_PROVIDER=heuristic` for local deterministic actions, or `AI_PROVIDER=openai` to select actions through the OpenAI-compatible Chat Completions policy. For CodexLB, keep `AI_PROVIDER=openai` and point `OPENAI_BASE_URL` at the CodexLB-compatible endpoint.

```text
OPENAI_BASE_URL=https://codex.nekos.me/v1
OPENAI_API_KEY=your-provider-key-in-dotenv-only
OPENAI_MODEL=gpt-5.5
OPENAI_TEMPERATURE=0.2
```

Heuristic mode does not need an API key. `AI_PROVIDER=openai` requires `OPENAI_API_KEY` and sends it only to `OPENAI_BASE_URL`. If `OPENAI_BASE_URL` points at a third-party OpenAI-compatible endpoint, put that provider's key in `OPENAI_API_KEY`; do not send a real OpenAI key to a third-party endpoint. `OPENAI_TEMPERATURE` is the non-secret sampling setting.

## Easy repo control

Use the `poke` wrapper for day-to-day control instead of remembering the lower-level harness flags. The wrapper talks to the dashboard/control server over HTTP when it is already running; if no compatible server is available, `play`/`llm` start one. The wrapper does **not** start or stop mGBA itself; keep the mGBA app, your ROM, the Lua socket script, and mGBA-http running.

### Recommended loop

1. Verify the emulator chain is alive.

```bash
npm run poke -- status
```

2. Start the map-aware heuristic player.

```bash
npm run poke -- play --max-steps 100 --run-id map-1
```

3. Open the dashboard printed by the command, or start it separately. The page can now start/stop agent runs through the same HTTP control server.

```bash
npm run poke -- ui --port 3030
```

4. Stop repo-started Node processes when you are done.

```bash
npm run poke -- stop
```

### `poke` command reference

| Command | What it does | Typical use |
| --- | --- | --- |
| `npm run poke -- status` | Prints redacted config and runs mGBA preflight. | First check when anything looks stuck. |
| `npm run poke -- play --max-steps 100 --run-id map-1` | Runs Stage 1 with the map-aware heuristic policy and starts the dashboard. | Default autonomous map exploration. |
| `npm run poke -- scout --max-steps 300 --run-id scout-1` | Alias for `play` that names the intent: cheap map/state/action evidence collection. | Feed Hermes/policy synthesis. |
| `npm run poke -- synthesize-policy --from-run scout-1 --policy-id pallet-v1` | Creates `policies/generated/pallet-v1.json`, a schema-validated heuristic policy DSL artifact. | Let Hermes turn scout logs into a new executable heuristic. |
| `npm run poke -- play-policy --policy-file policies/generated/pallet-v1.json --run-id exec-1` | Executes a generated JSON heuristic policy through the normal harness runner. | Validate synthesized policies before using expensive LLM execution. |
| `npm run poke -- llm --max-steps 100 --run-id llm-1` | Runs Stage 1 through the configured OpenAI-compatible provider and starts the dashboard. | Compare LLM decisions against heuristic behavior. |
| `npm run poke -- ui --port 3030` | Starts only the web dashboard/control server. | Watch screen/RAM/telemetry, start heuristic or LLM agent runs, and stop the active run. |
| `npm run poke -- press A --frames 5` | Sends one safe manual button input. | Smoke checks or unblocking a prompt manually. |
| `npm run poke -- stop` | Stops repo-started Node harness/dashboard processes. Leaves mGBA and mGBA-http alone. | Cleanly stop automation without closing the emulator. |
| `npm run poke -- clean-failed --yes` | Deletes run directories whose summary status is not `completed`. | Clean noisy failed attempts from `runs/`. |
| `npm run poke -- doctor` | Alias for preflight. | Quick connectivity diagnosis. |

`play` is the recommended default for map exploration. It forces `AI_PROVIDER=heuristic`, defaults to `HARNESS_MODE=stage1`, and sends `POST /api/control/play` to the dashboard/control server. The server spawns the harness run and records evidence under the chosen `--run-id`.

### Common options

```text
--max-steps N       Number of decision/action steps before the run stops.
--run-id ID         Evidence directory name under runs/. Use a new ID per run.
--port N            Dashboard port for play, llm, or ui. Defaults to 3030.
--from-run ID       Scout/evidence run to synthesize from.
--policy-id ID      Generated policy artifact id.
--policy-file FILE  Generated policy JSON path.
--objective TEXT    Optional policy synthesis objective.
--yes               Required for destructive cleanup commands.
```

### Control server HTTP API

The dashboard on `:3030` is also the harness control server. `poke` commands and the web UI use these endpoints when possible:

| Endpoint | Meaning |
| --- | --- |
| `GET /api/control/status` | Current active run, last run, and whether a child harness process is running. |
| `POST /api/control/play` | Start a map-aware heuristic run. JSON body accepts `maxSteps`, `runId`, and `mode`. |
| `POST /api/control/llm` | Start an OpenAI-compatible LLM run. JSON body accepts `maxSteps`, `runId`, and `mode`. |
| `POST /api/control/press` | Send one manual safe button via a short child harness command. JSON body accepts `button` and `frames`. |
| `POST /api/control/stop` | Stop the active child harness process. |
| `POST /api/control/clean-failed` | Delete non-completed run directories from `runs/`. |

`mGBA-http` remains the low-level emulator bridge. The dashboard/control server is the higher-level run manager that knows about run IDs, policies, evidence, and active child harness processes.

### Hermes / generated-policy API

Hermes-style agents should not send Game Boy button input directly. They should observe, synthesize/tune policy artifacts, and ask the harness to run those policies:

| Endpoint | Meaning |
| --- | --- |
| `GET /api/agent/observation` | Machine-readable current control status plus live RAM/screen-derived state. |
| `GET /api/agent/evaluate/:runId` | Condensed run evaluation with recent improvement signals and a recommended next adjustment. |
| `POST /api/agent/synthesize-policy` | Create a generated policy JSON artifact from a scout run. Body: `fromRun`, `policyId`, optional `objective`, optional `policyFile`. |
| `POST /api/agent/run` | Start a heuristic, LLM, or generated-policy run. Body accepts `policy`, `policyFile`, `maxSteps`, `runId`, and `mode`. |

Generated policies use a constrained JSON DSL (`pokemon-generated-policy.v1`) rather than arbitrary TypeScript. That gives Hermes room to create new heuristics while the harness still validates every action through the normal action schema.

### What `play` does internally

`play` roughly does this:

```text
try GET http://127.0.0.1:3030/api/control/status
if compatible control server exists:
  POST /api/control/play { maxSteps, runId, mode: "stage1" }
else:
  start dashboard/control server, then POST /api/control/play
```

The lower-level equivalent remains available when you do not want the HTTP control server:

```bash
npm run harness -- map-heuristic --with-dashboard --mode stage1 --max-steps 100 --run-id map-1
```

The map-aware heuristic reads Red/Blue WRAM map structure (`wOverworldMap`, current map width/height, current block coordinates, and neighboring direction candidates). It explores with directional inputs first and only presses `A` in normal overworld movement when the tile/block in front is treated as an interaction candidate. Text boxes, menus, and battles still use prompt/battle-specific controls.

### Scout → synthesize → execute loop

Use this when you want “cheap heuristic information gathering → Hermes-generated heuristic → expensive LLM/hybrid execution”:

```bash
npm run poke -- scout --max-steps 300 --run-id scout-1
npm run poke -- synthesize-policy --from-run scout-1 --policy-id pallet-v1
npm run poke -- play-policy --policy-file policies/generated/pallet-v1.json --max-steps 200 --run-id exec-1
npm run poke -- llm --max-steps 100 --run-id llm-guided-1
```

The generated policy phase is intentionally separate from the LLM phase. Scout runs collect map/action/outcome telemetry cheaply; Hermes can synthesize a JSON policy from those logs; the harness validates and executes that policy; then the LLM can be reserved for higher-cost planning or unresolved states.

### What stays outside the wrapper

You still need to keep these running manually:

- mGBA app with the ROM loaded.
- `mGBASocketServer.lua` loaded in mGBA's scripting window.
- `mGBA-http` listening at `MGBA_HTTP_BASE_URL`.

If `status` fails with `MGBA_UNAVAILABLE`, fix the emulator/mGBA-http/Lua chain first before running `play` or `llm`.

## CLI Commands

Show help:

```bash
npm run harness -- --help
```

Print a redacted config summary without constructing mGBA or OpenAI clients:

```bash
npm run harness -- snapshot --dry-run
```

Run mGBA preflight against your already running mGBA-http service:

```bash
npm run harness -- preflight
```

Start a local dashboard for live game screen, RAM state, and harness evidence events:

```bash
npm run dashboard -- --port 3030
```

Open `http://127.0.0.1:3030`. Keep mGBA, `mGBASocketServer.lua`, and mGBA-http running; the dashboard polls mGBA-http for screenshots/state and reads `runs/` for recent decisions/actions.

The dashboard UI includes:

- **Control server**: enter `runId`, `maxSteps`, and mode, then start `Play heuristic` or `LLM run`, stop the active child harness, or clean failed runs. The dashboard intentionally does not expose manual game input; gameplay is agent-only.
- **mGBA screen**: live screenshot stream from mGBA-http, with latest evidence screenshot fallback when mGBA screenshot capture fails.
- **Map structure**: current map dimensions, tileset, block row/column/id, direction candidates, and visible blocks read from Red/Blue WRAM.
- **Harness telemetry**: recent run summary, last LLM decision, last button action, route context, map/x/y/facing, battle HP, screen text, selected action, confidence, checkpoint progress, repeated-state signals, and fallback/low-confidence markers.

Start the Stage 1 harness loop with the local heuristic policy:

```bash
npm run harness -- run --policy heuristic --mode stage1 --max-steps 100 --run-id local-stage1
```

Start a live Stage 1 LLM run through the configured OpenAI-compatible endpoint after setting `OPENAI_API_KEY` privately in `.env`:

```bash
npm run harness -- run --policy openai --max-steps 100 --run-id local-stage1-openai
```

Start an opt-in full-game run. Completion is recorded only after observing Hall of Fame map id `0x76` through RAM-derived map state:

```bash
npm run harness -- run --mode full-game --policy openai --max-steps 1000 --run-id local-full-game
```

Send one safe button press for manual smoke checks:

```bash
npm run harness -- press A --frames 5
```

Run the opt-in real mGBA smoke workflow against an already running mGBA-http service:

```bash
RUN_MGBA_INTEGRATION=1 MGBA_HTTP_BASE_URL=http://127.0.0.1:5001 npm run smoke:mgba
```

`npm run smoke:mgba` refuses to contact mGBA unless both `RUN_MGBA_INTEGRATION=1` and `MGBA_HTTP_BASE_URL` are set. When enabled, it runs preflight, records a snapshot, presses safe `B` once, then records a second snapshot. It does not press `A`, start mGBA, open ROMs, load ROMs, or validate ROM files beyond the existing config summary showing whether `POKEMON_ROM_PATH` is present. Evidence is written under `runs/<runId>/` by default, or under `EVIDENCE_DIR/<runId>/` when configured.

Supported common options:

```text
--dry-run              Snapshot only. Prints config summary and exits.
--policy heuristic     Use the local heuristic policy.
--policy openai        Use the OpenAI-compatible policy. Requires OPENAI_API_KEY.
--mode stage1          Use the default Stage 1 detector.
--mode full-game       Use the opt-in full-game detector.
--max-steps N          Override LOOP_MAX_STEPS for snapshot or run.
--run-id ID            Override HARNESS_RUN_ID for evidence paths.
```

`press` also accepts `--frames N`.

## Preflight

`preflight` checks the configured mGBA-http endpoint in this order:

1. Config summary.
2. Current frame endpoint.
3. `wCurMap` RAM read.
4. `wYCoord` RAM read.
5. `wXCoord` RAM read.
6. Screenshot endpoint.
7. Safe `B` tap.

If mGBA is absent, the command exits nonzero and prints setup guidance instead of a raw stack trace. Start mGBA manually, enable mGBA-http, load your own ROM, then confirm `MGBA_HTTP_BASE_URL` points to it.

## Stage 1 Contract

Stage 1 means the harness attempts to progress from the Pallet start through Oak and starter flow, starter acquisition, Rival battle entry, and Rival battle exit.

The runner must base each action on current observed RAM state and recent actions. It must not use a global hardcoded input timeline. Evidence includes states, decisions, actions, screenshots, errors, and a final summary under `EVIDENCE_DIR`.

When an LLM-backed provider falls back to the local heuristic policy, the recorded decision rationale and citations are marked with `LLM fallback after <CODE>` so fallback-driven progress is distinguishable from LLM-selected actions.

## Full-Game Mode

Full-game mode is opt in through `HARNESS_MODE=full-game` or `--mode full-game`. It preserves the same safe-input and read-only-RAM rules as Stage 1.

The detector tracks early Stage 1 milestones, badge observation, all-badges observation, and Hall of Fame observation. It does not complete on Rival battle exit or all badges alone. Completion requires observing Hall of Fame map id `0x76` or the derived `hallOfFameComplete` state field.

The LLM full-game prompt treats badges as progress only, forbids memory writes and hardcoded global input timelines, and forbids route-facts-alone completion claims. The local heuristic policy remains a Stage 1-oriented fallback and does not claim reliable full-game clears.

## Tests

Run the default checks:

```bash
npm run check:secrets
npm run typecheck
npm test
```

Integration tests are opt in so the default suite never contacts mGBA, OpenAI, ROMs, or the network:

```bash
RUN_MGBA_INTEGRATION=1 MGBA_HTTP_BASE_URL=http://127.0.0.1:5001 npm run test:integration
```

Only enable integration tests when mGBA-http is already running with your ROM loaded.

The fake smoke workflow test runs in the default suite and uses dependency injection only; it does not contact mGBA.

## Limitations

This is an MVP harness for Pokemon Red and Blue. Stage 1 remains the default and best-supported mode. Full-game mode is an opt-in foundation with read-only progress signals and Hall of Fame-only completion detection; it does not include a full reliable game-clearing strategy. It does not bundle, download, or verify ROM files. It does not start emulator processes. It does not include OBS or Twitch integration. It does not write emulator memory.
