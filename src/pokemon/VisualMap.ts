import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

export type VisualTileKind = "path" | "grass" | "water" | "obstacle" | "interaction" | "ui" | "unknown";

export interface VisualTileObservation {
  readonly screenRow: number;
  readonly screenCol: number;
  readonly fingerprint: string;
  readonly kind: VisualTileKind;
  readonly confidence: number;
  readonly meanLuma: number;
  readonly darkRatio: number;
  readonly brightRatio: number;
  readonly edgeScore: number;
}

export interface VisibleMapObservation {
  readonly schema: "pokemon-visible-map.v1";
  readonly screenshotPath: string;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly rows: number;
  readonly cols: number;
  readonly playerScreenTile: { readonly row: number; readonly col: number };
  readonly tiles: readonly VisualTileObservation[];
  readonly kindCounts: Record<VisualTileKind, number>;
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const PNG_SIGNATURE = "89504e470d0a1a0a";
const GRID_COLS = 10;
const GRID_ROWS = 9;

export async function analyzeVisibleMap(screenshotPath: string): Promise<VisibleMapObservation | undefined> {
  try {
    const png = decodePng(await readFile(screenshotPath));
    const tileSize = Math.max(1, Math.floor(Math.min(png.width / GRID_COLS, png.height / GRID_ROWS)));
    const tiles: VisualTileObservation[] = [];
    const kindCounts = emptyKindCounts();

    for (let row = 0; row < GRID_ROWS; row += 1) {
      for (let col = 0; col < GRID_COLS; col += 1) {
        const tile = analyzeTile(png, row, col, tileSize);
        tiles.push(tile);
        kindCounts[tile.kind] += 1;
      }
    }

    return {
      schema: "pokemon-visible-map.v1",
      screenshotPath,
      width: png.width,
      height: png.height,
      tileSize,
      rows: GRID_ROWS,
      cols: GRID_COLS,
      playerScreenTile: { row: Math.floor(GRID_ROWS / 2), col: Math.floor(GRID_COLS / 2) },
      tiles,
      kindCounts
    };
  } catch {
    return undefined;
  }
}

function analyzeTile(png: DecodedPng, screenRow: number, screenCol: number, tileSize: number): VisualTileObservation {
  const startX = screenCol * tileSize;
  const startY = screenRow * tileSize;
  const samples: number[] = [];
  let dark = 0;
  let bright = 0;
  let edgeTotal = 0;
  let edgeSamples = 0;

  for (let y = startY; y < Math.min(startY + tileSize, png.height); y += 1) {
    for (let x = startX; x < Math.min(startX + tileSize, png.width); x += 1) {
      const luma = pixelLuma(png, x, y);
      samples.push(luma);
      if (luma < 70) dark += 1;
      if (luma > 190) bright += 1;
      if (x > startX) {
        edgeTotal += Math.abs(luma - pixelLuma(png, x - 1, y));
        edgeSamples += 1;
      }
      if (y > startY) {
        edgeTotal += Math.abs(luma - pixelLuma(png, x, y - 1));
        edgeSamples += 1;
      }
    }
  }

  const meanLuma = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const darkRatio = dark / Math.max(1, samples.length);
  const brightRatio = bright / Math.max(1, samples.length);
  const edgeScore = edgeTotal / Math.max(1, edgeSamples);
  const fingerprint = createHash("sha1")
    .update(Buffer.from(samples.map((value) => Math.round(value / 16))))
    .digest("hex")
    .slice(0, 12);
  const classified = classifyVisualTile({ screenRow, meanLuma, darkRatio, brightRatio, edgeScore });

  return {
    screenRow,
    screenCol,
    fingerprint,
    kind: classified.kind,
    confidence: classified.confidence,
    meanLuma: round(meanLuma),
    darkRatio: round(darkRatio),
    brightRatio: round(brightRatio),
    edgeScore: round(edgeScore)
  };
}

function classifyVisualTile(input: {
  readonly screenRow: number;
  readonly meanLuma: number;
  readonly darkRatio: number;
  readonly brightRatio: number;
  readonly edgeScore: number;
}): { kind: VisualTileKind; confidence: number } {
  if (input.screenRow >= 6 && input.brightRatio > 0.55 && input.edgeScore > 20) {
    return { kind: "ui", confidence: 0.72 };
  }

  if (input.darkRatio > 0.48 && input.edgeScore > 28) {
    return { kind: "obstacle", confidence: 0.58 };
  }

  if (input.edgeScore > 42 && input.darkRatio > 0.2) {
    return { kind: "interaction", confidence: 0.45 };
  }

  if (input.meanLuma > 150 && input.edgeScore < 26) {
    return { kind: "path", confidence: 0.42 };
  }

  if (input.edgeScore > 25 && input.meanLuma > 95) {
    return { kind: "grass", confidence: 0.38 };
  }

  return { kind: "unknown", confidence: 0.2 };
}

function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    throw new Error("not a png");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported png color type ${colorType} bit depth ${bitDepth}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = unfilterPng(inflated, width, height, channels, stride);
  const rgba = new Uint8Array(width * height * 4);

  for (let source = 0, target = 0; source < raw.length; source += channels, target += 4) {
    rgba[target] = raw[source] ?? 0;
    rgba[target + 1] = raw[source + 1] ?? 0;
    rgba[target + 2] = raw[source + 2] ?? 0;
    rgba[target + 3] = channels === 4 ? raw[source + 3] ?? 255 : 255;
  }

  return { width, height, rgba };
}

function unfilterPng(inflated: Buffer, width: number, height: number, channels: number, stride: number): Uint8Array {
  const output = new Uint8Array(height * stride);
  let source = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source] ?? 0;
    source += 1;
    const rowStart = y * stride;
    const previousRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[source++] ?? 0;
      const left = x >= channels ? output[rowStart + x - channels] ?? 0 : 0;
      const up = y > 0 ? output[previousRowStart + x] ?? 0 : 0;
      const upLeft = y > 0 && x >= channels ? output[previousRowStart + x - channels] ?? 0 : 0;
      output[rowStart + x] = (raw + filterValue(filter, left, up, upLeft)) & 0xff;
    }
  }

  return output;
}

function filterValue(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upLeft);
  throw new Error(`unsupported png filter ${filter}`);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function pixelLuma(png: DecodedPng, x: number, y: number): number {
  const offset = (y * png.width + x) * 4;
  const red = png.rgba[offset] ?? 0;
  const green = png.rgba[offset + 1] ?? 0;
  const blue = png.rgba[offset + 2] ?? 0;
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

function emptyKindCounts(): Record<VisualTileKind, number> {
  return { path: 0, grass: 0, water: 0, obstacle: 0, interaction: 0, ui: 0, unknown: 0 };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
