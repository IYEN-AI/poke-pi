import { HarnessError } from "../errors.js";
import type { MgbaHttpClient } from "../mgba/MgbaHttpClient.js";
import {
  decodeBattleFlag,
  decodeBigEndianWord,
  decodeCoordinates,
  decodePartyCount,
  decodePlayerFacing,
  decodeUnsignedByte
} from "./decoders.js";
import { HALL_OF_FAME_MAP_ID, RED_BLUE_MEMORY_MAP } from "./memoryMap.js";
import type { BadgeProgress, BattleFlag, HitPoints, MenuTextState, PartySummary, PlayerFacing, PlayerFacingDirection, PokemonCoordinates, PokemonGameState, PokemonMapDirectionCandidate, PokemonMapStructure } from "./PokemonTypes.js";

type RamClient = Pick<MgbaHttpClient, "read8" | "read16" | "readRange">;

export type PokemonGameVersion = "red" | "blue";

export interface PokemonStateReaderOptions {
  readonly client: RamClient;
  readonly version: PokemonGameVersion;
}

export interface PokemonBattleState {
  readonly flag: BattleFlag;
  readonly battleType: number;
  readonly battleResult: number;
  readonly battleMonHp: number;
  readonly enemyMonHp: number;
}

export interface PokemonGameStateSnapshot extends PokemonGameState {
  readonly battleState: PokemonBattleState;
  readonly wIsInBattle: number;
  readonly wBattleType: number;
  readonly wBattleResult: number;
  readonly wBattleMonHP: number;
  readonly wEnemyMonHP: number;
  readonly wPartyCount: number;
  readonly wObtainedBadges: number;
  readonly badgeCount: number;
  readonly badgesObtained: readonly boolean[];
  readonly hallOfFameComplete: boolean;
  readonly wPartyMon1HP?: number;
  readonly wPartyMon1MaxHP?: number;
  readonly wCurMap: number;
  readonly wYCoord: number;
  readonly wXCoord: number;
  readonly wYBlockCoord: number;
  readonly wXBlockCoord: number;
  readonly wSpritePlayerStateData1FacingDirection: number;
  readonly playerFacingDirection: string;
  readonly wCurrentMenuItem: number;
  readonly wNamingScreenNameLength: number;
  readonly wNamingScreenSubmitName: number;
  readonly wNamingScreenType: number;
  readonly wTextBoxID: number;
  readonly wLetterPrintingDelayFlags: number;
  readonly screenText: string;
  readonly screenTextKind: string;
  readonly mapId: number;
  readonly y: number;
  readonly x: number;
  readonly partyCount: number;
  readonly menuItem: number;
  readonly textBoxId: number;
  readonly letterDelayFlags: number;
  readonly mapStructure?: PokemonMapStructure;
}

const map = RED_BLUE_MEMORY_MAP;

const MAP_BORDER = 3;
const SCREEN_BLOCK_WIDTH = 6;
const SCREEN_BLOCK_HEIGHT = 5;

function littleEndianWord(lowByte: number, highByte: number): number {
  return lowByte | (highByte << 8);
}

function isUsableMapDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 100;
}

function readVisibleBlocks(overworldMap: Uint8Array, currentViewPointer: number, stride: number): readonly (readonly number[])[] {
  const viewOffset = currentViewPointer - map.wOverworldMap;
  if (viewOffset < 0 || viewOffset >= overworldMap.length) {
    return [];
  }

  return Array.from({ length: SCREEN_BLOCK_HEIGHT }, (_rowValue, row) => (
    Array.from({ length: SCREEN_BLOCK_WIDTH }, (_colValue, col) => overworldMap[viewOffset + row * stride + col] ?? 0)
  ));
}

function buildDirectionCandidates(input: {
  overworldMap: Uint8Array;
  stride: number;
  width: number;
  height: number;
  y: number;
  x: number;
}): readonly PokemonMapDirectionCandidate[] {
  return [
    buildDirectionCandidate(input, "up", -1, 0),
    buildDirectionCandidate(input, "right", 0, 1),
    buildDirectionCandidate(input, "down", 1, 0),
    buildDirectionCandidate(input, "left", 0, -1)
  ];
}

function buildDirectionCandidate(
  input: { overworldMap: Uint8Array; stride: number; width: number; height: number; y: number; x: number },
  direction: PlayerFacingDirection,
  deltaY: number,
  deltaX: number
): PokemonMapDirectionCandidate {
  const targetY = input.y + deltaY;
  const targetX = input.x + deltaX;
  const inBounds = targetY >= 0 && targetX >= 0 && targetY < input.height * 2 && targetX < input.width * 2;
  const targetBlockRow = Math.floor(targetY / 2) + MAP_BORDER;
  const targetBlockCol = Math.floor(targetX / 2) + MAP_BORDER;

  return {
    direction,
    targetY,
    targetX,
    targetBlockRow,
    targetBlockCol,
    blockId: blockAt(input.overworldMap, input.stride, targetBlockRow, targetBlockCol),
    inBounds
  };
}

function blockAt(overworldMap: Uint8Array, stride: number, row: number, col: number): number | undefined {
  const index = row * stride + col;
  return index >= 0 && index < overworldMap.length ? overworldMap[index] : undefined;
}

export class PokemonStateReader {
  private readonly client: RamClient;
  readonly version: PokemonGameVersion;

  constructor(options: PokemonStateReaderOptions) {
    this.client = options.client;
    this.version = validateVersion(options.version);
  }

  async readState(): Promise<PokemonGameStateSnapshot> {
    const [battleState, coordinates, playerFacing, party, badges, menuText, mapStructure] = await Promise.all([
      this.readBattleState(),
      this.readOverworldState(),
      this.readPlayerFacingState(),
      this.readPartyState(),
      this.readBadgeState(),
      this.readMenuTextState(),
      this.readMapStructureState()
    ]);

    return createSnapshot({ battleState, coordinates, playerFacing, party, badges, menuText, mapStructure });
  }

  async readOverworldState(): Promise<PokemonCoordinates> {
    const bytes = await this.readRangeExact(
      map.wLetterPrintingDelayFlags,
      map.wXBlockCoord - map.wLetterPrintingDelayFlags + 1,
      "overworldState"
    );

    return decodeCoordinates({
      mapId: byteAt(bytes, map.wCurMap - map.wLetterPrintingDelayFlags, "wCurMap"),
      y: byteAt(bytes, map.wYCoord - map.wLetterPrintingDelayFlags, "wYCoord"),
      x: byteAt(bytes, map.wXCoord - map.wLetterPrintingDelayFlags, "wXCoord"),
      yBlock: byteAt(bytes, map.wYBlockCoord - map.wLetterPrintingDelayFlags, "wYBlockCoord"),
      xBlock: byteAt(bytes, map.wXBlockCoord - map.wLetterPrintingDelayFlags, "wXBlockCoord")
    });
  }

  async readBattleState(): Promise<PokemonBattleState> {
    const [battleResult, enemyHpBytes, battleMonHpBytes, battleFlags] = await Promise.all([
      this.client.read8(map.wBattleResult),
      this.readRangeExact(map.wEnemyMonHP, 2, "wEnemyMonHP"),
      this.readRangeExact(map.wBattleMonHP, 2, "wBattleMonHP"),
      this.readRangeExact(map.wIsInBattle, map.wBattleType - map.wIsInBattle + 1, "battleFlags")
    ]);

    return {
      flag: decodeBattleFlag(byteAt(battleFlags, 0, "wIsInBattle")),
      battleType: decodeUnsignedByte(byteAt(battleFlags, map.wBattleType - map.wIsInBattle, "wBattleType"), "wBattleType"),
      battleResult: decodeUnsignedByte(battleResult, "wBattleResult"),
      battleMonHp: decodeBigEndianWord(
        byteAt(battleMonHpBytes, 0, "wBattleMonHP.lowByte"),
        byteAt(battleMonHpBytes, 1, "wBattleMonHP.highByte"),
        "wBattleMonHP"
      ),
      enemyMonHp: decodeBigEndianWord(
        byteAt(enemyHpBytes, 0, "wEnemyMonHP.lowByte"),
        byteAt(enemyHpBytes, 1, "wEnemyMonHP.highByte"),
        "wEnemyMonHP"
      )
    };
  }

  async readPlayerFacingState(): Promise<PlayerFacing> {
    return decodePlayerFacing(await this.client.read8(map.wSpritePlayerStateData1FacingDirection));
  }

  async readPartyState(): Promise<PartySummary> {
    const bytes = await this.readRangeExact(map.wPartyCount, map.wPartyMon1MaxHP - map.wPartyCount + 2, "partyState");
    const count = decodePartyCount(byteAt(bytes, 0, "wPartyCount"));

    if (count === 0) {
      return { count };
    }

    const currentHp = decodeBigEndianWord(
      byteAt(bytes, map.wPartyMon1HP - map.wPartyCount, "wPartyMon1HP.lowByte"),
      byteAt(bytes, map.wPartyMon1HP - map.wPartyCount + 1, "wPartyMon1HP.highByte"),
      "wPartyMon1HP"
    );
    const maxHp = decodeBigEndianWord(
      byteAt(bytes, map.wPartyMon1MaxHP - map.wPartyCount, "wPartyMon1MaxHP.lowByte"),
      byteAt(bytes, map.wPartyMon1MaxHP - map.wPartyCount + 1, "wPartyMon1MaxHP.highByte"),
      "wPartyMon1MaxHP"
    );

    if (currentHp === 0 && maxHp === 0) {
      return { count };
    }

    const firstPokemonHp = validatePartyHp({
      current: currentHp,
      max: maxHp
    });

    return { count, firstPokemonHp };
  }

  async readBadgeState(): Promise<BadgeProgress> {
    return decodeBadgeProgress(await this.client.read8(map.wObtainedBadges));
  }

  async readMapStructureState(): Promise<PokemonMapStructure | undefined> {
    const header = await this.readRangeExact(map.wCurMap, map.wCurMapWidth - map.wCurMap + 1, "mapStructureHeader");
    const mapId = byteAt(header, 0, "wCurMap");
    const currentViewPointer = littleEndianWord(
      byteAt(header, map.wCurrentTileBlockMapViewPointer - map.wCurMap, "wCurrentTileBlockMapViewPointer.lowByte"),
      byteAt(header, map.wCurrentTileBlockMapViewPointer - map.wCurMap + 1, "wCurrentTileBlockMapViewPointer.highByte")
    );
    const y = byteAt(header, map.wYCoord - map.wCurMap, "wYCoord");
    const x = byteAt(header, map.wXCoord - map.wCurMap, "wXCoord");
    const tileset = byteAt(header, map.wCurMapTileset - map.wCurMap, "wCurMapTileset");
    const height = byteAt(header, map.wCurMapHeight - map.wCurMap, "wCurMapHeight");
    const width = byteAt(header, map.wCurMapWidth - map.wCurMap, "wCurMapWidth");

    if (!isUsableMapDimension(width) || !isUsableMapDimension(height)) {
      return undefined;
    }

    const stride = width + MAP_BORDER * 2;
    const expectedLength = Math.min(map.wOverworldMapLength, stride * (height + MAP_BORDER * 2));
    const overworldMap = await this.readRangeExact(map.wOverworldMap, expectedLength, "wOverworldMap");
    const currentBlockRow = Math.floor(y / 2) + MAP_BORDER;
    const currentBlockCol = Math.floor(x / 2) + MAP_BORDER;
    const visibleBlocks = readVisibleBlocks(overworldMap, currentViewPointer, stride);

    return {
      mapId,
      width,
      height,
      stride,
      tileset,
      currentViewPointer,
      currentBlockRow,
      currentBlockCol,
      currentBlockId: blockAt(overworldMap, stride, currentBlockRow, currentBlockCol),
      visibleBlocks,
      directionCandidates: buildDirectionCandidates({ overworldMap, stride, width, height, y, x })
    };
  }

  async readMenuTextState(): Promise<MenuTextState> {
    const [currentMenuItem, textBoxId, letterPrintingDelayFlags, tileMap, namingScreenNameLength, namingScreenSubmitName, namingScreenType] = await Promise.all([
      this.client.read8(map.wCurrentMenuItem),
      this.client.read8(map.wTextBoxID),
      this.client.read8(map.wLetterPrintingDelayFlags),
      this.readRangeExact(map.wTileMap, map.wTileMapLength, "wTileMap"),
      this.client.read8(map.wNamingScreenNameLength),
      this.client.read8(map.wNamingScreenSubmitName),
      this.client.read8(map.wNamingScreenType)
    ]);

    const screenText = decodeTileMapText(tileMap);

    return {
      currentMenuItem: decodeUnsignedByte(currentMenuItem, "wCurrentMenuItem"),
      textBoxId: decodeUnsignedByte(textBoxId, "wTextBoxID"),
      letterPrintingDelayFlags: decodeUnsignedByte(letterPrintingDelayFlags, "wLetterPrintingDelayFlags"),
      screenText,
      screenTextKind: classifyScreenText(screenText),
      namingScreenNameLength: decodeUnsignedByte(namingScreenNameLength, "wNamingScreenNameLength"),
      namingScreenSubmitName: decodeUnsignedByte(namingScreenSubmitName, "wNamingScreenSubmitName"),
      namingScreenType: decodeUnsignedByte(namingScreenType, "wNamingScreenType")
    };
  }

  private async readRangeExact(address: number, length: number, fieldName: string): Promise<Uint8Array> {
    const bytes = await this.client.readRange(address, length);
    if (bytes.length !== length) {
      throw new HarnessError("INVALID_RAM_STATE", `${fieldName} read returned an unexpected byte count`, {
        context: { fieldName, expectedLength: length, actualLength: bytes.length }
      });
    }

    return bytes;
  }
}

function createSnapshot(input: {
  battleState: PokemonBattleState;
  coordinates: PokemonCoordinates;
  playerFacing: PlayerFacing;
  party: PartySummary;
  badges: BadgeProgress;
  menuText: MenuTextState;
  mapStructure?: PokemonMapStructure;
}): PokemonGameStateSnapshot {
  const { battleState, coordinates, playerFacing, party, badges, menuText, mapStructure } = input;

  return {
    battle: battleState.flag,
    battleState,
    coordinates,
    playerFacing,
    party,
    badges,
    menuText,
    wIsInBattle: battleState.flag.raw,
    wBattleType: battleState.battleType,
    wBattleResult: battleState.battleResult,
    wBattleMonHP: battleState.battleMonHp,
    wEnemyMonHP: battleState.enemyMonHp,
    wPartyCount: party.count,
    wObtainedBadges: badges.raw,
    badgeCount: badges.count,
    badgesObtained: badges.obtained,
    hallOfFameComplete: coordinates.mapId === HALL_OF_FAME_MAP_ID,
    wPartyMon1HP: party.firstPokemonHp?.current,
    wPartyMon1MaxHP: party.firstPokemonHp?.max,
    wCurMap: coordinates.mapId,
    wYCoord: coordinates.y,
    wXCoord: coordinates.x,
    wYBlockCoord: coordinates.yBlock,
    wXBlockCoord: coordinates.xBlock,
    wSpritePlayerStateData1FacingDirection: playerFacing.raw,
    playerFacingDirection: playerFacing.direction,
    wCurrentMenuItem: menuText.currentMenuItem,
    wNamingScreenNameLength: menuText.namingScreenNameLength,
    wNamingScreenSubmitName: menuText.namingScreenSubmitName,
    wNamingScreenType: menuText.namingScreenType,
    wTextBoxID: menuText.textBoxId,
    wLetterPrintingDelayFlags: menuText.letterPrintingDelayFlags,
    screenText: menuText.screenText,
    screenTextKind: menuText.screenTextKind,
    mapId: coordinates.mapId,
    y: coordinates.y,
    x: coordinates.x,
    partyCount: party.count,
    menuItem: menuText.currentMenuItem,
    textBoxId: menuText.textBoxId,
    letterDelayFlags: menuText.letterPrintingDelayFlags,
    mapStructure
  };
}

function decodeBadgeProgress(rawValue: number): BadgeProgress {
  const raw = decodeUnsignedByte(rawValue, "wObtainedBadges");
  const obtained = Array.from({ length: 8 }, (_value, index) => (raw & (1 << index)) !== 0);
  return {
    raw,
    count: obtained.filter(Boolean).length,
    obtained
  };
}

function decodeTileMapText(bytes: Uint8Array): string {
  return Array.from(bytes, decodeTile).join("").replace(/[ \n]+/g, " ").trim();
}

function decodeTile(byte: number): string {
  if (byte === 0x7f || byte === 0x00) {
    return " ";
  }

  if (byte >= 0x80 && byte <= 0x99) {
    return String.fromCharCode("A".charCodeAt(0) + byte - 0x80);
  }

  if (byte >= 0xa0 && byte <= 0xb9) {
    return String.fromCharCode("a".charCodeAt(0) + byte - 0xa0);
  }

  if (byte >= 0xf6 && byte <= 0xff) {
    return String.fromCharCode("0".charCodeAt(0) + byte - 0xf6);
  }

  switch (byte) {
    case 0x4f:
    case 0x50:
      return " ";
    case 0xe0:
      return "'";
    case 0xe3:
      return "-";
    case 0xe6:
      return "?";
    case 0xe7:
      return "!";
    case 0xe8:
      return ".";
    case 0xef:
      return "♂";
    case 0xf5:
      return "♀";
    default:
      return " ";
  }
}

function classifyScreenText(screenText: string): MenuTextState["screenTextKind"] {
  if (screenText.length === 0) {
    return "none";
  }

  if (screenText.includes("Hello there") || screenText.includes("Welcome to") || screenText.includes("world of POKEMON")) {
    return "oak_intro";
  }

  if (screenText.includes("NEW NAME") || screenText.includes("ASH") || screenText.includes("GARY")) {
    return "default_name_menu";
  }

  if (screenText.includes("lower case") || screenText.includes("UPPER CASE")) {
    return "naming_screen";
  }

  return "overworld_text";
}

function validatePartyHp(hitPoints: Required<HitPoints>): Required<HitPoints> {
  if (hitPoints.max === 0 || hitPoints.current > hitPoints.max) {
    throw new HarnessError("INVALID_RAM_STATE", "Party Pokemon HP cannot exceed max HP", {
      context: { currentHp: hitPoints.current, maxHp: hitPoints.max }
    });
  }

  return hitPoints;
}

function validateVersion(version: PokemonGameVersion): PokemonGameVersion {
  if (version !== "red" && version !== "blue") {
    throw new HarnessError("INVALID_RAM_STATE", "PokemonStateReader only supports Pokemon Red and Blue RAM maps", {
      context: { version }
    });
  }

  return version;
}

function byteAt(bytes: Uint8Array, index: number, fieldName: string): number {
  return decodeUnsignedByte(bytes[index], fieldName);
}
