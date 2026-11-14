import { describe, expect, it } from "vitest";
import { buildLedger, sliceLedger, type LedgerInvoice, type LedgerReceipt } from "../shared/ledger";

const invoices: LedgerInvoice[] = [
  { id: "i1", number: "INV-1", dateAd: "2026-10-01", dateBs: "2083-06-15", total: 1000, items: [{ name: "Pillar Farma", qty: 2 }] },
  { id: "i2", number: "INV-2", dateAd: "2026-10-10", dateBs: "2083-06-24", total: 500, items: [{ name: "Plate Farma", qty: 1 }] },
  { id: "i3", number: "INV-3", dateAd: "2026-10-20", dateBs: "2083-07-04", total: 2000, items: [] },
];

const receipts: LedgerReceipt[] = [
  { id: "r1", amount: 300, dateAd: "2026-10-05", dateBs: "2083-06-19", description: "Receipt" },
  { id: "r2", amount: 700, dateAd: "2026-10-15", dateBs: "2083-06-29", description: "Receipt" },
];

describe("buildLedger", () => {
  it("carries the item list through to the invoice row", () => {
    const { rows } = buildLedger(0, invoices, receipts);
    const inv1 = rows.find((r) => r.id === "i1");
    expect(inv1?.items).toEqual([{ name: "Pillar Farma", qty: 2 }]);
  });

  it("omits items entirely when the invoice has none", () => {
    const { rows } = buildLedger(0, invoices, receipts);
    const inv3 = rows.find((r) => r.id === "i3");
    expect(inv3?.items).toBeUndefined();
  });

  it("computes the closing due as opening + invoiced − received", () => {
    const { totals } = buildLedger(100, invoices, receipts);
    expect(totals.totalInvoiced).toBe(3500);
    expect(totals.totalReceived).toBe(1000);
    expect(totals.closingDue).toBe(2600);
  });
});

describe("sliceLedger", () => {
  it("returns everything when no range is given", () => {
    const built = buildLedger(0, invoices, receipts);
    const sliced = sliceLedger(built.rows, 0, null, null);
    expect(sliced.rows).toHaveLength(built.rows.length);
    expect(sliced.totals.closingDue).toBe(built.totals.closingDue);
  });

  it("carries pre-range activity into the opening balance instead of restarting at zero", () => {
    // Range starts 2026-10-10: INV-1 (1000) and r1 (300) happened before it.
    const built = buildLedger(0, invoices, receipts);
    const sliced = sliceLedger(built.rows, 0, "2026-10-10", "2026-10-20");
    expect(sliced.totals.openingBalance).toBe(700); // 1000 invoiced − 300 received
    // First row in range continues from that carried balance.
    expect(sliced.rows[0].running).toBe(1200); // 700 + 500
  });

  it("keeps the closing due equal to the full-history closing when the range covers everything", () => {
    const built = buildLedger(0, invoices, receipts);
    const sliced = sliceLedger(built.rows, 0, "2026-10-01", "2026-10-31");
    expect(sliced.totals.closingDue).toBe(built.totals.closingDue);
  });

  it("is inclusive on both boundary days", () => {
    const built = buildLedger(0, invoices, receipts);
    const sliced = sliceLedger(built.rows, 0, "2026-10-10", "2026-10-20");
    const ids = sliced.rows.map((r) => r.id);
    expect(ids).toContain("i2"); // exactly on the start
    expect(ids).toContain("i3"); // exactly on the end
    expect(ids).not.toContain("i1"); // one day before
  });

  it("reports range totals, not lifetime totals", () => {
    const built = buildLedger(0, invoices, receipts);
    const sliced = sliceLedger(built.rows, 0, "2026-10-10", "2026-10-20");
    expect(sliced.totals.totalInvoiced).toBe(2500); // i2 + i3
    expect(sliced.totals.totalReceived).toBe(700); // r2 only
  });
});
