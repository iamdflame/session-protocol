/* ───────────────────────────────────────────────────────────────────────────
   Bad-print rejection.

   These are thin Solana pools. A single fill against a stale quote puts one
   hourly close 10–13% away from its neighbours and the next bar puts it
   straight back — the price never went there, and no holder could have traded
   at it.

   Left in, such a bar is merely noisy. Combined with session attribution it is
   worse than noisy: SPYx printed −12.2% at 19:00 UTC on 2026-08-10 and +12.1%
   at 20:00, and 20:00 UTC *is* 16:00 ET, so the recovery straddles the closing
   bell and is dropped as unattributable while the drop is charged in full to
   the day. One bad fill became a permanent 12% cliff in one class's curve.

   So the spike is removed at the price level, before any return is computed,
   which means neither half of it can be attributed to anything.

   The test is deliberately narrow — a bar only goes if it is far from *both*
   neighbours and those neighbours agree with each other. A real gap moves the
   level and its neighbours disagree, so it survives.

   The threshold is also scaled to each asset's own noise. A fixed 6% cut
   removed 154 bars from TQQQx, which is a 3× leveraged ETF where a 6% hour is
   ordinary; measuring the cut in multiples of that asset's median absolute
   hourly move keeps a quiet name sensitive and stops a volatile one from being
   shredded.
   ─────────────────────────────────────────────────────────────────────────── */

export type Row = [number, number];

export interface CleanResult {
  rows: Row[];
  dropped: number;
}

/** Floor on the spike threshold, so a very quiet series stays sane. */
const MIN_SPIKE = 0.06;
/** Spike size in multiples of the asset's median absolute hourly move. */
const SPIKE_MAD = 10;
/** Neighbours must agree this closely for the middle bar to be the odd one. */
const AGREE_MAD = 2;
const MIN_AGREE = 0.005;

/** Median absolute hourly log return — a robust scale that ignores the spikes. */
function typicalMove(rows: Row[]): number {
  const moves: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1][1], b = rows[i][1];
    if (a > 0 && b > 0) {
      const r = Math.abs(Math.log(b / a));
      if (Number.isFinite(r)) moves.push(r);
    }
  }
  if (!moves.length) return 0;
  moves.sort((x, y) => x - y);
  return moves[moves.length >> 1];
}

export function dropSpikes(rows: Row[]): CleanResult {
  if (rows.length < 3) return { rows, dropped: 0 };

  const mad = typicalMove(rows);
  const spike = Math.max(MIN_SPIKE, mad * SPIKE_MAD);
  const agree = Math.max(MIN_AGREE, mad * AGREE_MAD);

  const keep: Row[] = [rows[0]];
  let dropped = 0;

  for (let i = 1; i < rows.length - 1; i++) {
    const prev = rows[i - 1][1];
    const cur = rows[i][1];
    const next = rows[i + 1][1];

    if (prev > 0 && cur > 0 && next > 0) {
      const toPrev = Math.abs(Math.log(cur / prev));
      const toNext = Math.abs(Math.log(cur / next));
      const between = Math.abs(Math.log(prev / next));

      if (toPrev > spike && toNext > spike && between < agree) {
        dropped++;
        continue;
      }
    }
    keep.push(rows[i]);
  }

  keep.push(rows[rows.length - 1]);
  return { rows: keep, dropped };
}
