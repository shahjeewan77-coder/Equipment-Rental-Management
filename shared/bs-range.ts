// ── Bikram Sambat date RANGE (pure) ───────────────────────────────────────────
//
// Every report in the app filters on the stored Gregorian `date_ad` column,
// because that is what a range comparison can be done against. The user,
// however, thinks and types in Bikram Sambat. This module is the one place that
// converts between the two, so a report never has to re-derive the rule.
//
// The rule, stated once:
//
//   startDateBS / endDateBS  →  [fromAd, toAd]  INCLUSIVE on both ends
//
// A BS date is a whole day, so the AD equivalent is that day's midnight-to-
// midnight span. Comparing `date_ad` strings (YYYY-MM-DD) against the AD
// endpoints is therefore inclusive by construction — no timezone arithmetic, no
// off-by-one at the boundary.
//
// Empty filters fall back to the CURRENT BS MONTH (1st → today), which is what
// an operator means by "this month's report" and is never an empty screen.

import { adIsoToBs, bsIso, bsToAd, kathmanduToday, parseBsIso, type BsDate } from "./bs-calendar";

export interface BsRange {
  /** YYYY-MM-DD (BS), or null when the filter is empty. */
  startDateBS: string | null;
  endDateBS: string | null;
}

export interface AdRange {
  /** YYYY-MM-DD (AD), inclusive. */
  fromAd: string;
  /** YYYY-MM-DD (AD), inclusive. */
  toAd: string;
  /** True when the caller supplied no filter and the default was applied. */
  isDefault: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A BS date → the AD ISO day it begins on. */
export function bsToAdIso(iso: string): string {
  const bs = parseBsIso(iso);
  const d = bsToAd(bs.year, bs.month, bs.day);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** An AD ISO day → its BS ISO. */
export function adIsoToBsIso(iso: string): string {
  return bsIso(adIsoToBs(iso));
}

/** First day of the BS month containing `bs`, as BS ISO. */
export function startOfBsMonth(bs: BsDate): string {
  return `${bs.year}-${pad(bs.month)}-01`;
}

/**
 * Resolve a BS range to the inclusive AD range a query filters on.
 *
 * - Both empty → the current BS month, 1st → today.
 * - Only a start → start → today.
 * - Only an end → the 1st of the end's BS month → end.
 * - Reversed input (start after end) is swapped rather than returning nothing,
 *   because an empty report from a mis-ordered pair looks like a data bug.
 */
export function resolveBsRange(range: BsRange, today = kathmanduToday()): AdRange {
  const start = range.startDateBS?.trim() || null;
  const end = range.endDateBS?.trim() || null;

  if (!start && !end) {
    return {
      fromAd: bsToAdIso(startOfBsMonth(today.bs)),
      toAd: today.ad,
      isDefault: true,
    };
  }

  if (start && !end) {
    return { fromAd: bsToAdIso(start), toAd: today.ad, isDefault: false };
  }

  if (!start && end) {
    return {
      fromAd: bsToAdIso(startOfBsMonth(parseBsIso(end))),
      toAd: bsToAdIso(end),
      isDefault: false,
    };
  }

  // Both present.
  const a = bsToAdIso(start as string);
  const b = bsToAdIso(end as string);
  return a <= b
    ? { fromAd: a, toAd: b, isDefault: false }
    : { fromAd: b, toAd: a, isDefault: false };
}

/** Human label for a resolved range, e.g. "Kartik 1 – Kartik 14, 2083 BS". */
export function bsRangeLabel(range: BsRange, today = kathmanduToday()): string {
  const resolved = resolveBsRange(range, today);
  const from = adIsoToBsIso(resolved.fromAd);
  const to = adIsoToBsIso(resolved.toAd);
  const f = parseBsIso(from);
  const t = parseBsIso(to);
  const suffix = resolved.isDefault ? " (this month)" : "";
  if (from === to) return `${f.year}-${pad(f.month)}-${pad(f.day)} BS${suffix}`;
  return `${f.year}-${pad(f.month)}-${pad(f.day)} → ${t.year}-${pad(t.month)}-${pad(t.day)} BS${suffix}`;
}

/** Is an AD ISO day inside the resolved range (inclusive)? */
export function inAdRange(adIsoDay: string, range: AdRange): boolean {
  return adIsoDay >= range.fromAd && adIsoDay <= range.toAd;
}
