export const RED_BLUE_MEMORY_MAP = {
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
} as const;

export const HALL_OF_FAME_MAP_ID = 0x76;

export type RedBlueMemorySymbol = keyof typeof RED_BLUE_MEMORY_MAP;

export const wIsInBattle = RED_BLUE_MEMORY_MAP.wIsInBattle;
export const wBattleType = RED_BLUE_MEMORY_MAP.wBattleType;
export const wBattleMonHP = RED_BLUE_MEMORY_MAP.wBattleMonHP;
export const wEnemyMonHP = RED_BLUE_MEMORY_MAP.wEnemyMonHP;
export const wBattleResult = RED_BLUE_MEMORY_MAP.wBattleResult;
export const wCurrentMenuItem = RED_BLUE_MEMORY_MAP.wCurrentMenuItem;
export const wTileMap = RED_BLUE_MEMORY_MAP.wTileMap;
export const wTileMapLength = RED_BLUE_MEMORY_MAP.wTileMapLength;
export const wNamingScreenNameLength = RED_BLUE_MEMORY_MAP.wNamingScreenNameLength;
export const wNamingScreenSubmitName = RED_BLUE_MEMORY_MAP.wNamingScreenSubmitName;
export const wNamingScreenType = RED_BLUE_MEMORY_MAP.wNamingScreenType;
export const wSpritePlayerStateData1FacingDirection = RED_BLUE_MEMORY_MAP.wSpritePlayerStateData1FacingDirection;
export const wTextBoxID = RED_BLUE_MEMORY_MAP.wTextBoxID;
export const wPartyCount = RED_BLUE_MEMORY_MAP.wPartyCount;
export const wPartyMon1HP = RED_BLUE_MEMORY_MAP.wPartyMon1HP;
export const wPartyMon1MaxHP = RED_BLUE_MEMORY_MAP.wPartyMon1MaxHP;
export const wObtainedBadges = RED_BLUE_MEMORY_MAP.wObtainedBadges;
export const wCurMap = RED_BLUE_MEMORY_MAP.wCurMap;
export const wYCoord = RED_BLUE_MEMORY_MAP.wYCoord;
export const wXCoord = RED_BLUE_MEMORY_MAP.wXCoord;
export const wYBlockCoord = RED_BLUE_MEMORY_MAP.wYBlockCoord;
export const wXBlockCoord = RED_BLUE_MEMORY_MAP.wXBlockCoord;
export const wLetterPrintingDelayFlags = RED_BLUE_MEMORY_MAP.wLetterPrintingDelayFlags;
