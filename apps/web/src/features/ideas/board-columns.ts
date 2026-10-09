/** Minimum width of an ideas board column; columns grow to fill spare room, the board scrolls sideways when they do not fit. */
export const BOARD_COLUMN_WIDTHS = {
  narrow: { label: "Narrow", min: "14rem" },
  normal: { label: "Normal", min: "18rem" },
  wide: { label: "Wide", min: "24rem" },
  "extra-wide": { label: "Extra wide", min: "30rem" },
} as const;

export type BoardColumnWidth = keyof typeof BOARD_COLUMN_WIDTHS;

export const DEFAULT_BOARD_COLUMN_WIDTH: BoardColumnWidth = "normal";

export const BOARD_COLUMN_WIDTH_KEYS = Object.keys(BOARD_COLUMN_WIDTHS) as BoardColumnWidth[];

export function isBoardColumnWidth(value: unknown): value is BoardColumnWidth {
  return typeof value === "string" && Object.hasOwn(BOARD_COLUMN_WIDTHS, value);
}

/** `grid-template-columns` for a board of `count` stage columns. */
export function boardGridColumns(count: number, width: BoardColumnWidth): string {
  return `repeat(${count}, minmax(${BOARD_COLUMN_WIDTHS[width].min}, 1fr))`;
}
