/**
 * Fractional indexing for ordering cards within a column.
 * `column` contains the target column's items, excluding the moved card, sorted by position.
 * `before_id` places the new card before that item; `after_id` places it after that item.
 * If neither is supplied, the card is appended to the column.
 * Returns `{ position, renumber }`. When `renumber` is true, adjacent positions are too close;
 * the caller should renumber the whole column and calculate again.
 */
export const POSITION_STEP = 1024;
export const MIN_GAP = 1e-6;

export interface PosItem {
  id: number;
  position: number;
}

export function computePosition(
  column: PosItem[],
  opts: { before_id?: number | null; after_id?: number | null } = {},
): { position: number; renumber: boolean } {
  const { before_id, after_id } = opts;
  const idx = (id: number | null | undefined) => (id == null ? -1 : column.findIndex((c) => c.id === id));
  const bi = idx(before_id);
  const ai = idx(after_id);

  let lo: number | null = null; // Lower bound (previous neighbor)
  let hi: number | null = null; // Upper bound (next neighbor)

  if (bi >= 0 && ai >= 0) {
    // With both bounds, place between after and before; if their order is invalid, honor before.
    if (column[ai].position < column[bi].position) {
      lo = column[ai].position;
      hi = column[bi].position;
    } else {
      hi = column[bi].position;
      lo = bi > 0 ? column[bi - 1].position : null;
    }
  } else if (bi >= 0) {
    hi = column[bi].position;
    lo = bi > 0 ? column[bi - 1].position : null;
  } else if (ai >= 0) {
    lo = column[ai].position;
    hi = ai < column.length - 1 ? column[ai + 1].position : null;
  } else {
    lo = column.length ? column[column.length - 1].position : null;
    hi = null;
  }

  if (lo == null && hi == null) return { position: POSITION_STEP, renumber: false };
  if (lo == null) return { position: (hi as number) - POSITION_STEP, renumber: false };
  if (hi == null) return { position: lo + POSITION_STEP, renumber: false };
  if (hi - lo < MIN_GAP * 2) return { position: (lo + hi) / 2, renumber: true };
  return { position: (lo + hi) / 2, renumber: false };
}
