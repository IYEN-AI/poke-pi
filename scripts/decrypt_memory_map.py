#!/usr/bin/env python3
"""Decode ('decrypt') Pokemon Red/Blue current map bytes from WRAM.

The ROM map is compressed/static, but the game keeps a decoded current map block
buffer in WRAM at wOverworldMap. This script reads the live mGBA RAM, fixes the
current-map header offsets, and writes a compact tactical map artifact for the
supervisor/orchestrator.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SUP = ROOT / "runs" / ".loop-supervisor"
SUP.mkdir(parents=True, exist_ok=True)
OUT_JSON = SUP / "decrypted-memory-map.json"
OUT_MD = SUP / "decrypted-memory-map-summary.md"

# International Red/Blue WRAM symbols. Note: wLastMap and wUnusedLastMapWidth are
# at d365/d366; wCurMapHeader starts at d367.
W = {
    "wCurMap": 0xD35E,
    "wCurrentTileBlockMapViewPointer": 0xD35F,
    "wYCoord": 0xD361,
    "wXCoord": 0xD362,
    "wYBlockCoord": 0xD363,
    "wXBlockCoord": 0xD364,
    "wCurMapTileset": 0xD367,
    "wCurMapHeight": 0xD368,
    "wCurMapWidth": 0xD369,
    "wOverworldMap": 0xC580,
    "wOverworldMapLength": 1300,
}
MAP_BORDER = 3
SCREEN_BLOCK_WIDTH = 6
SCREEN_BLOCK_HEIGHT = 5
MAP_NAMES = {0: "Pallet Town", 1: "Viridian City", 2: "Pewter City", 12: "Route 2", 13: "Route 3", 37: "Player house 1F", 38: "Player house 2F", 40: "Oak Lab", 43: "Viridian Trainer School"}
INTERACTION = {0x03,0x04,0x05,0x06,0x07,0x0c,0x0d,0x15,0x16,0x17,0x1c,0x1d,0x1e,0x1f,0x2c,0x2d,0x2e}
PATH = {0x00,0x01,0x02,0x08,0x09,0x0a,0x0b,0x10,0x11,0x12,0x13,0x14,0x20,0x21,0x22,0x23,0x24,0x25,0x30,0x31,0x32,0x33,0x34}
OBST = {0x18,0x19,0x1a,0x1b,0x26,0x27,0x28,0x29,0x2a,0x2b,0x35,0x36,0x37,0x38,0x39,0x3a,0x3b}
WATER = {0x14,0x32,0x33,0x34}
GRASS = {0x20,0x21,0x22,0x23,0x24,0x25}
WARP = {0x1e,0x1f,0x2d,0x2e}


def status_base() -> str:
    env = os.environ.get("MGBA_HTTP_BASE_URL")
    if env:
        return env.rstrip("/")
    out = subprocess.check_output("npm run harness -- status", cwd=ROOT, shell=True, text=True, stderr=subprocess.STDOUT, timeout=30)
    m = re.search(r'"mgbaHttpBaseUrl"\s*:\s*"([^"]+)"', out)
    if not m:
        raise RuntimeError("could not discover mgbaHttpBaseUrl")
    return m.group(1).rstrip("/")


def get_text(base: str, path: str, query: dict[str, str], timeout: int = 8) -> str:
    return urlopen(f"{base}{path}?{urlencode(query)}", timeout=timeout).read().decode().strip()


def read8(base: str, address: int) -> int:
    return int(get_text(base, "/core/read8", {"address": f"0x{address:04X}"}))


def readrange(base: str, address: int, length: int) -> list[int]:
    s = get_text(base, "/core/readrange", {"address": f"0x{address:04X}", "length": str(length)}, timeout=12)
    if s.startswith("["):
        return [int(x) for x in json.loads(s)]
    return [int(p.strip().removeprefix("0x"), 16) for p in s.split(",") if p.strip()]


def classify(block: int | None) -> dict[str, object]:
    if block is None:
        return {"kind": "unknown", "walkability": "unknown", "interactionCandidate": False}
    if block in WARP:
        return {"kind": "warp", "walkability": "unknown", "interactionCandidate": True}
    if block in INTERACTION:
        return {"kind": "interaction", "walkability": "unknown", "interactionCandidate": True}
    if block in WATER:
        return {"kind": "water", "walkability": "likely_blocked", "interactionCandidate": False}
    if block in GRASS:
        return {"kind": "grass", "walkability": "likely_walkable", "interactionCandidate": False}
    if block in OBST:
        return {"kind": "obstacle", "walkability": "likely_blocked", "interactionCandidate": False}
    if block in PATH:
        return {"kind": "path", "walkability": "likely_walkable", "interactionCandidate": False}
    return {"kind": "unknown", "walkability": "unknown", "interactionCandidate": False}


def block_at(buf: list[int], stride: int, row: int, col: int) -> int | None:
    idx = row * stride + col
    return buf[idx] if 0 <= idx < len(buf) else None


def main() -> int:
    base = status_base()
    header = readrange(base, W["wCurMap"], W["wCurMapWidth"] - W["wCurMap"] + 1)
    get = lambda sym: header[W[sym] - W["wCurMap"]]
    cur_map = get("wCurMap")
    ptr = get("wCurrentTileBlockMapViewPointer") | (header[W["wCurrentTileBlockMapViewPointer"] + 1 - W["wCurMap"]] << 8)
    y, x = get("wYCoord"), get("wXCoord")
    yb, xb = get("wYBlockCoord"), get("wXBlockCoord")
    tileset, height, width = get("wCurMapTileset"), get("wCurMapHeight"), get("wCurMapWidth")
    if not (0 < width <= 100 and 0 < height <= 100):
        raise RuntimeError(f"bad decoded map dimensions width={width} height={height}; header={header}")
    stride = width + MAP_BORDER * 2
    expected = min(W["wOverworldMapLength"], stride * (height + MAP_BORDER * 2))
    overworld = readrange(base, W["wOverworldMap"], expected)
    view_offset = ptr - W["wOverworldMap"]
    current_block_row = y // 2 + MAP_BORDER
    current_block_col = x // 2 + MAP_BORDER
    current_block = block_at(overworld, stride, current_block_row, current_block_col)
    visible = []
    for r in range(SCREEN_BLOCK_HEIGHT):
        row = []
        for c in range(SCREEN_BLOCK_WIDTH):
            b = block_at(overworld, stride, view_offset // stride + r, view_offset % stride + c) if 0 <= view_offset < len(overworld) else None
            row.append({"row": r, "col": c, "blockId": b, "semantic": classify(b)})
        visible.append(row)
    dirs = []
    for name, dy, dx in [("up", -1, 0), ("right", 0, 1), ("down", 1, 0), ("left", 0, -1)]:
        ty, tx = y + dy, x + dx
        br, bc = ty // 2 + MAP_BORDER, tx // 2 + MAP_BORDER
        b = block_at(overworld, stride, br, bc)
        dirs.append({"direction": name, "targetY": ty, "targetX": tx, "blockRow": br, "blockCol": bc, "blockId": b, "semantic": classify(b)})
    counts = Counter(cell["semantic"]["kind"] for row in visible for cell in row)
    rec = {
        "schema": "poke-pi-decrypted-memory-map.v1",
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "live mGBA WRAM wOverworldMap decoded with corrected wCurMapHeader offsets",
        "baseUrl": base,
        "location": {"mapId": cur_map, "mapName": MAP_NAMES.get(cur_map, "unknown"), "y": y, "x": x, "yBlock": yb, "xBlock": xb},
        "header": {"tileset": tileset, "height": height, "width": width, "stride": stride, "currentViewPointer": ptr, "viewOffset": view_offset},
        "currentBlock": {"row": current_block_row, "col": current_block_col, "blockId": current_block, "semantic": classify(current_block)},
        "directionCandidates": dirs,
        "visibleBlocks": visible,
        "visibleKindCounts": dict(counts),
    }
    OUT_JSON.write_text(json.dumps(rec, ensure_ascii=False, indent=2))
    lines = ["# Decrypted memory map", "", f"- Updated: {rec['updatedAt']}", f"- Source: {rec['source']}", f"- Location: map {cur_map} {rec['location']['mapName']} y={y} x={x} block=({current_block_row},{current_block_col})", f"- Header: width={width} height={height} stride={stride} tileset={tileset} view=0x{ptr:04x}", f"- Current block: {current_block} {rec['currentBlock']['semantic']}", "", "## Direction candidates"]
    for d in dirs:
        lines.append(f"- {d['direction']}: y={d['targetY']} x={d['targetX']} block={d['blockId']} {d['semantic']}")
    lines += ["", "## Visible block semantic counts"]
    for k, v in counts.most_common():
        lines.append(f"- {k}: {v}")
    OUT_MD.write_text("\n".join(lines) + "\n")
    print(json.dumps({"ok": True, "map": cur_map, "y": y, "x": x, "width": width, "height": height, "out": str(OUT_MD.relative_to(ROOT))}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
