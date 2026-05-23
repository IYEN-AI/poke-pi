export const MGBA_BUTTONS = [
  "A",
  "B",
  "Start",
  "Select",
  "Up",
  "Down",
  "Left",
  "Right"
] as const;

export type MgbaButton = (typeof MGBA_BUTTONS)[number];
