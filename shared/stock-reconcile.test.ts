import { describe, expect, it } from "vitest";
import { buildMovementReport, type LedgerMovement } from "./stock-ledger";

/**
 * The Stock report and the per-item movement log must show the SAME numbers.
 *
 * They disagreed in production, and the cause was not arithmetic — it was the
 * default date range. The Stock report's "Delivered out" / "Returned in"
 * columns are all-time; the movement log defaulted to the current BS month, so
 * for any item whose movements predate the month the log showed 0 / 0 while
 * both pages claimed the same closing figure. Concrete Mixer: Stock said 3 out
 * / 2 in, its log said 0 / 0, closing 11 on both.
 *
 * The fix is that an empty filter means the FULL history. These tests pin the
 * identity that makes the two pages agree, and pin that a supplied range is
 * still honoured (and still reconciles) rather than being silently ignored.
 */

function mv(partial: Partial<LedgerMovement> & { dateAd: string; type: "in" | "out"; qty: number }): LedgerMovement {
  return {
    id: partial.id ?? `${partial.dateAd}-${partial.type}-${partial.qty}`,
    dateBs: partial.dateBs ?? "2083-01-01",
    orderNo: partial.orderNo ?? null,
    invoiceNo: partial.invoiceNo ?? null,
    customerName: partial.customerName ?? null,
    personName: partial.personName ?? null,
    personRole: partial.personRole ?? null,
    createdAt: partial.createdAt ?? `${partial.dateAd}T10:00:00.000Z`,
    ...partial,
  } as LedgerMovement;
}

/** Concrete Mixer's real shape: 3 out / 2 in, all before the current BS month. */
const mixerMovements = [
  mv({ id: "m1", dateAd: "2026-10-17", type: "out", qty: 2 }),
  mv({ id: "m2", dateAd: "2026-10-17", type: "in", qty: 2 }),
  mv({ id: "m3", dateAd: "2026-10-17", type: "out", qty: 1 }),
];

describe("stock log vs closing stock — the identity that must hold", () => {
  it("with NO range, the log totals are the all-time figures the Stock report shows", () => {
    const r = buildMovementReport({
      openingBase: 12,
      closingOnHand: 11,
      movements: mixerMovements,
      fromAd: null,
      toAd: null,
    });
    // These are exactly the Stock report's columns for Concrete Mixer.
    expect(r.totalOut).toBe(3);
    expect(r.totalIn).toBe(2);
    expect(r.closing).toBe(11);
    expect(r.drift).toBe(0);
    // And the log's own arithmetic reproduces the closing figure.
    expect(r.opening + r.totalIn - r.totalOut).toBe(r.closing);
  });

  it("a range that EXCLUDES every movement still reconciles — it just shows range totals", () => {
    // This is the shape that looked like a bug: 0 in / 0 out, closing 11.
    const r = buildMovementReport({
      openingBase: 12,
      closingOnHand: 11,
      movements: mixerMovements,
      fromAd: "2026-10-18",
      toAd: "2026-11-01",
    });
    expect(r.totalOut).toBe(0);
    expect(r.totalIn).toBe(0);
    // The opening carries the pre-range movements, so the closing is still true.
    expect(r.opening).toBe(11);
    expect(r.closing).toBe(11);
    expect(r.drift).toBe(0);
    // The all-time figure is still available for the "all time" note.
    expect(r.closingAll).toBe(11);
  });

  it("holds for every item shape: no movements, only outs, only ins", () => {
    const cases = [
      { name: "no movements", base: 6, onHand: 6, movements: [] as LedgerMovement[] },
      { name: "only outs", base: 40, onHand: 20, movements: [mv({ dateAd: "2026-10-09", type: "out", qty: 20 })] },
      { name: "only ins", base: 10, onHand: 12, movements: [mv({ dateAd: "2026-10-09", type: "in", qty: 2 })] },
    ];
    for (const c of cases) {
      const r = buildMovementReport({
        openingBase: c.base,
        closingOnHand: c.onHand,
        movements: c.movements,
        fromAd: null,
        toAd: null,
      });
      expect(r.closing, c.name).toBe(c.onHand);
      expect(r.drift, c.name).toBe(0);
      expect(r.opening + r.totalIn - r.totalOut, c.name).toBe(r.closing);
    }
  });

  it("a reversal pair nets to zero, so undo never breaks the reconciliation", () => {
    const r = buildMovementReport({
      openingBase: 200,
      closingOnHand: 200,
      movements: [
        mv({ id: "r1", dateAd: "2026-10-27", type: "in", qty: 1 }),
        mv({ id: "r2", dateAd: "2026-10-27", type: "out", qty: 1, reversalOfId: "r1" }),
      ],
      fromAd: null,
      toAd: null,
    });
    expect(r.totalIn).toBe(1);
    expect(r.totalOut).toBe(1);
    expect(r.closing).toBe(200);
    expect(r.drift).toBe(0);
  });
});
