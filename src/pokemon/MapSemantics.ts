import type { PokemonMapBlockSemanticGuess, PokemonMapBlockSemanticKind } from "./PokemonTypes.js";

export const MAP_INTERACTION_BLOCK_IDS = new Set([
  0x03, 0x04, 0x05, 0x06, 0x07,
  0x0c, 0x0d,
  0x15, 0x16, 0x17,
  0x1c, 0x1d, 0x1e, 0x1f,
  0x2c, 0x2d, 0x2e
]);

const COMMON_PATH_BLOCK_IDS = new Set([
  0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x0b,
  0x10, 0x11, 0x12, 0x13, 0x14,
  0x20, 0x21, 0x22, 0x23, 0x24, 0x25,
  0x30, 0x31, 0x32, 0x33, 0x34
]);

const COMMON_OBSTACLE_BLOCK_IDS = new Set([
  0x18, 0x19, 0x1a, 0x1b,
  0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b
]);

const COMMON_WATER_BLOCK_IDS = new Set([0x14, 0x32, 0x33, 0x34]);
const COMMON_GRASS_BLOCK_IDS = new Set([0x20, 0x21, 0x22, 0x23, 0x24, 0x25]);
const COMMON_WARP_HINT_BLOCK_IDS = new Set([0x1e, 0x1f, 0x2d, 0x2e]);

export function classifyMapBlock(blockId: number | undefined): PokemonMapBlockSemanticGuess {
  if (blockId === undefined) {
    return semantic("unknown", "unknown", false, "missing_block_id", 0);
  }

  if (COMMON_WARP_HINT_BLOCK_IDS.has(blockId)) {
    return semantic("warp", "unknown", true, "static_block_id_hint", 0.45);
  }

  if (MAP_INTERACTION_BLOCK_IDS.has(blockId)) {
    return semantic("interaction", "unknown", true, "static_block_id_hint", 0.4);
  }

  if (COMMON_WATER_BLOCK_IDS.has(blockId)) {
    return semantic("water", "likely_blocked", false, "static_block_id_hint", 0.35);
  }

  if (COMMON_GRASS_BLOCK_IDS.has(blockId)) {
    return semantic("grass", "likely_walkable", false, "static_block_id_hint", 0.35);
  }

  if (COMMON_OBSTACLE_BLOCK_IDS.has(blockId)) {
    return semantic("obstacle", "likely_blocked", false, "static_block_id_hint", 0.3);
  }

  if (COMMON_PATH_BLOCK_IDS.has(blockId)) {
    return semantic("path", "likely_walkable", false, "static_block_id_hint", 0.3);
  }

  return semantic("unknown", "unknown", false, "unclassified_block_id", 0.1);
}

function semantic(
  kind: PokemonMapBlockSemanticKind,
  walkability: PokemonMapBlockSemanticGuess["walkability"],
  interactionCandidate: boolean,
  source: PokemonMapBlockSemanticGuess["source"],
  confidence: number
): PokemonMapBlockSemanticGuess {
  return { kind, walkability, interactionCandidate, source, confidence };
}
