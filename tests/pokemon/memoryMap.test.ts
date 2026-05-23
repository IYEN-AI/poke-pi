import { describe, expect, it } from "vitest";
import {
  HALL_OF_FAME_MAP_ID,
  RED_BLUE_MEMORY_MAP,
  wBattleMonHP,
  wBattleResult,
  wBattleType,
  wCurMap,
  wCurrentMenuItem,
  wEnemyMonHP,
  wIsInBattle,
  wLetterPrintingDelayFlags,
  wNamingScreenNameLength,
  wNamingScreenSubmitName,
  wNamingScreenType,
  wPartyCount,
  wPartyMon1HP,
  wPartyMon1MaxHP,
  wObtainedBadges,
  wSpritePlayerStateData1FacingDirection,
  wTextBoxID,
  wTileMap,
  wTileMapLength,
  wXBlockCoord,
  wXCoord,
  wYBlockCoord,
  wYCoord
} from "../../src/pokemon/memoryMap.js";

describe("Red/Blue memory map", () => {
  it("exports the researched international Red/Blue RAM addresses", () => {
    expect(RED_BLUE_MEMORY_MAP).toEqual({
      wIsInBattle: 0xd057,
      wBattleType: 0xd05a,
      wBattleMonHP: 0xd015,
      wEnemyMonHP: 0xcfe6,
      wBattleResult: 0xcf0b,
      wCurrentMenuItem: 0xcc26,
      wTileMap: 0xc3a0,
      wTileMapLength: 360,
      wNamingScreenNameLength: 0xcee9,
      wNamingScreenSubmitName: 0xceea,
      wNamingScreenType: 0xd07d,
      wSpritePlayerStateData1FacingDirection: 0xc109,
      wTextBoxID: 0xd125,
      wPartyCount: 0xd163,
      wPartyMon1HP: 0xd16c,
      wPartyMon1MaxHP: 0xd18d,
      wObtainedBadges: 0xd356,
      wCurMap: 0xd35e,
      wYCoord: 0xd361,
      wXCoord: 0xd362,
      wYBlockCoord: 0xd363,
      wXBlockCoord: 0xd364,
      wLetterPrintingDelayFlags: 0xd358
    });
  });

  it("exports each symbolic address directly", () => {
    expect(wIsInBattle).toBe(0xd057);
    expect(wBattleType).toBe(0xd05a);
    expect(wBattleMonHP).toBe(0xd015);
    expect(wEnemyMonHP).toBe(0xcfe6);
    expect(wBattleResult).toBe(0xcf0b);
    expect(wCurrentMenuItem).toBe(0xcc26);
    expect(wTileMap).toBe(0xc3a0);
    expect(wTileMapLength).toBe(360);
    expect(wNamingScreenNameLength).toBe(0xcee9);
    expect(wNamingScreenSubmitName).toBe(0xceea);
    expect(wNamingScreenType).toBe(0xd07d);
    expect(wSpritePlayerStateData1FacingDirection).toBe(0xc109);
    expect(wTextBoxID).toBe(0xd125);
    expect(wPartyCount).toBe(0xd163);
    expect(wPartyMon1HP).toBe(0xd16c);
    expect(wPartyMon1MaxHP).toBe(0xd18d);
    expect(wObtainedBadges).toBe(0xd356);
    expect(wCurMap).toBe(0xd35e);
    expect(wYCoord).toBe(0xd361);
    expect(wXCoord).toBe(0xd362);
    expect(wYBlockCoord).toBe(0xd363);
    expect(wXBlockCoord).toBe(0xd364);
    expect(wLetterPrintingDelayFlags).toBe(0xd358);
    expect(HALL_OF_FAME_MAP_ID).toBe(0x76);
  });
});
