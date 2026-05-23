import { describe, expect, it } from "vitest";
import { HarnessError } from "../../src/errors.js";
import { RED_BLUE_MEMORY_MAP } from "../../src/pokemon/memoryMap.js";
import { PokemonStateReader } from "../../src/pokemon/PokemonStateReader.js";

type ReadCall =
  | { method: "read8"; address: number }
  | { method: "read16"; address: number }
  | { method: "readRange"; address: number; length: number };

interface FakeRamClient {
  read8(address: number): Promise<number>;
  read16(address: number): Promise<number>;
  readRange(address: number, length: number): Promise<Uint8Array>;
  calls: ReadCall[];
}

const map = RED_BLUE_MEMORY_MAP;

function createFakeRamClient(options: {
  bytes?: Record<number, number>;
  ranges?: Record<string, readonly number[]>;
}): FakeRamClient {
  const calls: ReadCall[] = [];
  return {
    calls,
    async read8(address: number): Promise<number> {
      calls.push({ method: "read8", address });
      return options.bytes?.[address] ?? 0;
    },
    async read16(address: number): Promise<number> {
      calls.push({ method: "read16", address });
      return options.bytes?.[address] ?? 0;
    },
    async readRange(address: number, length: number): Promise<Uint8Array> {
      calls.push({ method: "readRange", address, length });
      return Uint8Array.from(options.ranges?.[rangeKey(address, length)] ?? Array.from({ length }, () => 0));
    }
  };
}

function rangeKey(address: number, length: number): string {
  return `${address}:${length}`;
}

function overworldRange(overrides: Record<number, number> = {}): number[] {
  return rangeBytes(map.wLetterPrintingDelayFlags, map.wXBlockCoord - map.wLetterPrintingDelayFlags + 1, {
    [map.wLetterPrintingDelayFlags]: 0x01,
    [map.wCurMap]: 0x02,
    [map.wYCoord]: 0x08,
    [map.wXCoord]: 0x0b,
    [map.wYBlockCoord]: 0x03,
    [map.wXBlockCoord]: 0x04,
    ...overrides
  });
}


function mapHeaderRange(overrides: Record<number, number> = {}): number[] {
  const currentViewPointer = map.wOverworldMap + 7 * 16 + 8;
  return rangeBytes(map.wCurMap, map.wCurMapWidth - map.wCurMap + 1, {
    [map.wCurMap]: 0x02,
    [map.wCurrentTileBlockMapViewPointer]: currentViewPointer & 0xff,
    [map.wCurrentTileBlockMapViewPointer + 1]: currentViewPointer >> 8,
    [map.wYCoord]: 0x08,
    [map.wXCoord]: 0x0b,
    [map.wYBlockCoord]: 0x03,
    [map.wXBlockCoord]: 0x04,
    [map.wCurMapTileset]: 0x01,
    [map.wCurMapHeight]: 0x09,
    [map.wCurMapWidth]: 0x0a,
    ...overrides
  });
}

function overworldMapRange(): number[] {
  const width = 10;
  const height = 9;
  const stride = width + 6;
  const bytes = Array.from({ length: stride * (height + 6) }, (_value, index) => index & 0xff);
  bytes[7 * stride + 8] = 0x44;
  bytes[7 * stride + 9] = 0x45;
  bytes[8 * stride + 8] = 0x54;
  return bytes;
}

function partyRange(partyCount: number, currentHp = 45, maxHp = 50): number[] {
  return rangeBytes(map.wPartyCount, map.wPartyMon1MaxHP - map.wPartyCount + 2, {
    [map.wPartyCount]: partyCount,
    [map.wPartyMon1HP]: currentHp >> 8,
    [map.wPartyMon1HP + 1]: currentHp & 0xff,
    [map.wPartyMon1MaxHP]: maxHp >> 8,
    [map.wPartyMon1MaxHP + 1]: maxHp & 0xff
  });
}

function rangeBytes(startAddress: number, length: number, valuesByAddress: Record<number, number>): number[] {
  return Array.from({ length }, (_, offset) => valuesByAddress[startAddress + offset] ?? 0);
}

function createStateClient(partyCount = 1, currentHp = 45, maxHp = 50): FakeRamClient {
  return createFakeRamClient({
    bytes: {
      [map.wBattleResult]: 0x00,
      [map.wCurrentMenuItem]: 0x02,
      [map.wObtainedBadges]: 0x85,
      [map.wSpritePlayerStateData1FacingDirection]: 0x0c,
      [map.wTextBoxID]: 0x00,
      [map.wLetterPrintingDelayFlags]: 0x01,
      [map.wNamingScreenNameLength]: 0x00,
      [map.wNamingScreenSubmitName]: 0x00,
      [map.wNamingScreenType]: 0x00
    },
    ranges: {
      [rangeKey(map.wEnemyMonHP, 2)]: [0x18, 0x00],
      [rangeKey(map.wBattleMonHP, 2)]: [0x2d, 0x00],
      [rangeKey(map.wIsInBattle, map.wBattleType - map.wIsInBattle + 1)]: [0x00, 0x00, 0x00, 0x00],
      [rangeKey(map.wLetterPrintingDelayFlags, map.wXBlockCoord - map.wLetterPrintingDelayFlags + 1)]: overworldRange(),
      [rangeKey(map.wCurMap, map.wCurMapWidth - map.wCurMap + 1)]: mapHeaderRange(),
      [rangeKey(map.wOverworldMap, overworldMapRange().length)]: overworldMapRange(),
      [rangeKey(map.wPartyCount, map.wPartyMon1MaxHP - map.wPartyCount + 2)]: partyRange(partyCount, currentHp, maxHp),
      [rangeKey(map.wTileMap, map.wTileMapLength)]: tileMapBytes("Hello there! Welcome to the world of POKEMON!")
    }
  });
}

function tileMapBytes(text: string): number[] {
  const bytes = Array.from({ length: map.wTileMapLength }, () => 0x7f);
  Array.from(text).forEach((character, index) => {
    bytes[index] = encodeTile(character);
  });
  return bytes;
}

function encodeTile(character: string): number {
  if (character >= "A" && character <= "Z") {
    return 0x80 + character.charCodeAt(0) - "A".charCodeAt(0);
  }

  if (character >= "a" && character <= "z") {
    return 0xa0 + character.charCodeAt(0) - "a".charCodeAt(0);
  }

  switch (character) {
    case " ":
      return 0x7f;
    case "!":
      return 0xe7;
    case ".":
      return 0xe8;
    default:
      return 0x7f;
  }
}

describe("PokemonStateReader", () => {
  it("reads grouped RAM ranges and returns a validated overworld state with Stage1-compatible fields", async () => {
    const client = createStateClient();
    const reader = new PokemonStateReader({ client, version: "red" });

    await expect(reader.readState()).resolves.toMatchObject({
      battle: { kind: "none", raw: 0 },
      coordinates: { mapId: 2, y: 8, x: 11, yBlock: 3, xBlock: 4 },
      playerFacing: { raw: 0x0c, direction: "right" },
      party: { count: 1, firstPokemonHp: { current: 45, max: 50 } },
      menuText: {
        currentMenuItem: 2,
        textBoxId: 0,
        letterPrintingDelayFlags: 1,
        screenText: "Hello there! Welcome to the world of POKEMON!",
        screenTextKind: "oak_intro",
        namingScreenNameLength: 0,
        namingScreenSubmitName: 0,
        namingScreenType: 0
      },
      wIsInBattle: 0,
      wPartyCount: 1,
      wObtainedBadges: 0x85,
      badgeCount: 3,
      badgesObtained: [true, false, true, false, false, false, false, true],
      hallOfFameComplete: false,
      wCurMap: 2,
      wYCoord: 8,
      wXCoord: 11,
      wSpritePlayerStateData1FacingDirection: 0x0c,
      playerFacingDirection: "right",
      wCurrentMenuItem: 2,
      wNamingScreenNameLength: 0,
      wNamingScreenSubmitName: 0,
      wNamingScreenType: 0,
      wTextBoxID: 0,
      wLetterPrintingDelayFlags: 1,
      screenText: "Hello there! Welcome to the world of POKEMON!",
      screenTextKind: "oak_intro",
      partyCount: 1,
      mapId: 2,
      y: 8,
      x: 11,
      menuItem: 2,
      textBoxId: 0,
      letterDelayFlags: 1,
      mapStructure: {
        mapId: 2,
        width: 10,
        height: 9,
        stride: 16,
        tileset: 1,
        currentBlockRow: 7,
        currentBlockCol: 8,
        currentBlockId: 0x44
      }
    });

    expect(client.calls).toEqual(expect.arrayContaining([
      { method: "read8", address: map.wBattleResult },
      { method: "read8", address: map.wObtainedBadges },
      { method: "readRange", address: map.wEnemyMonHP, length: 2 },
      { method: "readRange", address: map.wBattleMonHP, length: 2 },
      { method: "readRange", address: map.wIsInBattle, length: map.wBattleType - map.wIsInBattle + 1 },
      { method: "readRange", address: map.wLetterPrintingDelayFlags, length: map.wXBlockCoord - map.wLetterPrintingDelayFlags + 1 },
      { method: "readRange", address: map.wPartyCount, length: map.wPartyMon1MaxHP - map.wPartyCount + 2 },
      { method: "readRange", address: map.wTileMap, length: map.wTileMapLength },
      { method: "readRange", address: map.wCurMap, length: map.wCurMapWidth - map.wCurMap + 1 },
      { method: "readRange", address: map.wOverworldMap, length: overworldMapRange().length },
      { method: "read8", address: map.wSpritePlayerStateData1FacingDirection },
      { method: "read8", address: map.wCurrentMenuItem },
      { method: "read8", address: map.wTextBoxID },
      { method: "read8", address: map.wLetterPrintingDelayFlags },
      { method: "read8", address: map.wNamingScreenNameLength },
      { method: "read8", address: map.wNamingScreenSubmitName },
      { method: "read8", address: map.wNamingScreenType }
    ]));
    expect(client.calls).not.toContainEqual(expect.objectContaining({ method: "read16" }));
  });



  it("reads WRAM map structure blocks around the player for map-aware heuristics", async () => {
    const reader = new PokemonStateReader({ client: createStateClient(), version: "red" });

    await expect(reader.readMapStructureState()).resolves.toMatchObject({
      mapId: 2,
      width: 10,
      height: 9,
      stride: 16,
      tileset: 1,
      currentBlockRow: 7,
      currentBlockCol: 8,
      currentBlockId: 0x44,
      visibleBlocks: expect.arrayContaining([expect.arrayContaining([0x44, 0x45])]),
      directionCandidates: expect.arrayContaining([
        expect.objectContaining({ direction: "right", targetY: 8, targetX: 12, targetBlockRow: 7, targetBlockCol: 9, blockId: 0x45, inBounds: true }),
        expect.objectContaining({ direction: "down", targetY: 9, targetX: 11, targetBlockRow: 7, targetBlockCol: 8, blockId: 0x44, inBounds: true })
      ])
    });
  });

  it("derives Hall of Fame completion from the observed map id without memory writes", async () => {
    const client = createStateClient();
    client.calls.length = 0;
    const reader = new PokemonStateReader({ client, version: "red" });
    client.readRange = async (address: number, length: number): Promise<Uint8Array> => {
      client.calls.push({ method: "readRange", address, length });
      if (address === map.wLetterPrintingDelayFlags) {
        return Uint8Array.from(overworldRange({ [map.wCurMap]: 0x76 }));
      }
      return Uint8Array.from(Array.from({ length }, () => 0));
    };

    await expect(reader.readState()).resolves.toMatchObject({ mapId: 0x76, hallOfFameComplete: true });
    expect(client.calls).not.toContainEqual(expect.objectContaining({ method: "read16" }));
  });

  it("treats party count 0 as no first Pokemon HP while party count 1 validates HP", async () => {
    const emptyPartyReader = new PokemonStateReader({ client: createStateClient(0, 99, 0), version: "blue" });
    await expect(emptyPartyReader.readPartyState()).resolves.toEqual({ count: 0 });

    const onePokemonReader = new PokemonStateReader({ client: createStateClient(1, 12, 20), version: "red" });
    await expect(onePokemonReader.readPartyState()).resolves.toEqual({
      count: 1,
      firstPokemonHp: { current: 12, max: 20 }
    });
  });

  it("keeps transient starter acquisition party count when HP bytes are not populated yet", async () => {
    const reader = new PokemonStateReader({ client: createStateClient(1, 0, 0), version: "red" });

    await expect(reader.readPartyState()).resolves.toEqual({ count: 1 });
  });

  it("decodes party HP as big-endian words from the Gen 1 party struct", async () => {
    const reader = new PokemonStateReader({ client: createStateClient(1, 19, 19), version: "red" });

    await expect(reader.readPartyState()).resolves.toEqual({
      count: 1,
      firstPokemonHp: { current: 19, max: 19 }
    });
  });

  it("throws INVALID_RAM_STATE when party HP exceeds max HP", async () => {
    const reader = new PokemonStateReader({ client: createStateClient(1, 51, 50), version: "red" });

    await expect(reader.readPartyState()).rejects.toMatchObject({ code: "INVALID_RAM_STATE" });
    await expect(reader.readPartyState()).rejects.toBeInstanceOf(HarnessError);
  });

  it("throws INVALID_RAM_STATE for unsupported battle flags", async () => {
    const client = createFakeRamClient({
      bytes: { [map.wBattleResult]: 0 },
      ranges: {
        [rangeKey(map.wEnemyMonHP, 2)]: [1, 0],
        [rangeKey(map.wBattleMonHP, 2)]: [1, 0],
        [rangeKey(map.wIsInBattle, map.wBattleType - map.wIsInBattle + 1)]: [3, 0, 0, 0]
      }
    });
    const reader = new PokemonStateReader({ client, version: "red" });

    await expect(reader.readBattleState()).rejects.toMatchObject({ code: "INVALID_RAM_STATE" });
  });

  it("throws INVALID_RAM_STATE for unsupported player facing values", async () => {
    const client = createFakeRamClient({
      bytes: { [map.wSpritePlayerStateData1FacingDirection]: 0x02 }
    });
    const reader = new PokemonStateReader({ client, version: "red" });

    await expect(reader.readPlayerFacingState()).rejects.toMatchObject({ code: "INVALID_RAM_STATE" });
  });

  it("rejects unsupported runtime versions", () => {
    const options = { client: createStateClient(), version: "yellow" } as unknown as ConstructorParameters<typeof PokemonStateReader>[0];

    expect(() => new PokemonStateReader(options)).toThrow(HarnessError);
    expect(() => new PokemonStateReader(options)).toThrow("only supports Pokemon Red and Blue");
  });
});
