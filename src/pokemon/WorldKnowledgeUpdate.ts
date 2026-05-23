import type { LearnedEdgeStatus, LearnedTileStatus, VisualEdgeEvidence, WorldKnowledgeUpdate, WorldKnowledgeUpdateEntry } from "./MapKnowledge.js";
import type { PlayerFacingDirection } from "./PokemonTypes.js";
import type { VisualTileKind } from "./VisualMap.js";

const directions = new Set<PlayerFacingDirection>(["down", "up", "left", "right"]);
const tileStatuses = new Set<LearnedTileStatus>(["visited", "frontier"]);
const edgeStatuses = new Set<LearnedEdgeStatus>(["walkable", "blocked", "transition"]);
const visualKinds = new Set<VisualTileKind>(["path", "grass", "water", "obstacle", "interaction", "ui", "unknown"]);
const visualEvidenceValues = new Set<VisualEdgeEvidence>(["walk_step", "blocked", "transition", "visual_change", "none"]);

export function validateWorldKnowledgeUpdate(value: unknown): WorldKnowledgeUpdate | undefined {
  const record = objectRecord(value);
  if (record.schema !== "pokemon-world-update.v1" || !Array.isArray(record.entries)) {
    return undefined;
  }

  const entries = record.entries.map(parseEntry);
  if (entries.some((entry) => entry === undefined)) {
    return undefined;
  }

  return {
    schema: "pokemon-world-update.v1",
    source: stringField(record.source),
    note: stringField(record.note),
    entries: entries.filter((entry): entry is WorldKnowledgeUpdateEntry => entry !== undefined)
  };
}

function parseEntry(value: unknown): WorldKnowledgeUpdateEntry | undefined {
  const record = objectRecord(value);
  if (record.type === "tile") {
    const mapId = numberField(record.mapId);
    const y = numberField(record.y);
    const x = numberField(record.x);
    if (mapId === undefined || y === undefined || x === undefined) return undefined;
    const status = enumField(record.status, tileStatuses);
    const visualKind = enumField(record.visualKind, visualKinds);
    return {
      type: "tile",
      mapId,
      y,
      x,
      status,
      blockId: numberField(record.blockId),
      visualKind,
      visualConfidence: numberField(record.visualConfidence),
      visualFingerprint: stringField(record.visualFingerprint),
      step: numberField(record.step)
    };
  }

  if (record.type === "edge") {
    const mapId = numberField(record.mapId);
    const y = numberField(record.y);
    const x = numberField(record.x);
    const direction = enumField(record.direction, directions);
    const status = enumField(record.status, edgeStatuses);
    if (mapId === undefined || y === undefined || x === undefined || direction === undefined || status === undefined) return undefined;
    return {
      type: "edge",
      mapId,
      y,
      x,
      direction,
      status,
      blockId: numberField(record.blockId),
      visualEvidence: enumField(record.visualEvidence, visualEvidenceValues),
      step: numberField(record.step)
    };
  }

  if (record.type === "map") {
    const mapId = numberField(record.mapId);
    if (mapId === undefined) return undefined;
    return {
      type: "map",
      mapId,
      width: numberField(record.width),
      height: numberField(record.height),
      tileset: numberField(record.tileset),
      visibleBlockHash: stringField(record.visibleBlockHash),
      semanticAlias: stringField(record.semanticAlias),
      step: numberField(record.step)
    };
  }

  if (record.type === "transition") {
    const fromMapId = numberField(record.fromMapId);
    const fromY = numberField(record.fromY);
    const fromX = numberField(record.fromX);
    const toMapId = numberField(record.toMapId);
    const toY = numberField(record.toY);
    const toX = numberField(record.toX);
    const direction = enumField(record.direction, directions);
    if (fromMapId === undefined || fromY === undefined || fromX === undefined || toMapId === undefined || toY === undefined || toX === undefined || direction === undefined) return undefined;
    return {
      type: "transition",
      fromMapId,
      fromY,
      fromX,
      toMapId,
      toY,
      toX,
      direction,
      semanticAlias: stringField(record.semanticAlias),
      step: numberField(record.step)
    };
  }

  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function enumField<T extends string>(value: unknown, values: ReadonlySet<T>): T | undefined {
  return typeof value === "string" && values.has(value as T) ? value as T : undefined;
}
