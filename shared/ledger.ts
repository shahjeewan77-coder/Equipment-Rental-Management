// ── Customer ledger maths (shared, pure) ─────────────────────────────────────
//
// A customer's due balance is DERIVED, never stored:
//
//     closing due = openingBalance + Σ sales invoices − Σ receipts
//
// Keeping the merge + running-balance arithmetic here (rather than inline in the
// data layer) means it can be unit-tested on its own, and the server and any
// client-side preview compute the same number the same way.

/** One dispatched line on an invoice, as the ledger shows it: "2x Pillar Farma". */
export interface LedgerItem {
  name: string;
  qty: number;
}

export interface LedgerInvoice {
  id: string;
  number: string;
  dateAd: string;
  dateBs: string;
  total: number;
  /**
   * The items this invoice dispatched, aggregated per equipment. Optional so an
   * older caller (or a test) that only knows the money still type-checks — the
   * ledger simply shows no item list for that row.
   */
  items?: LedgerItem[];
}

export interface LedgerReceipt {
  id: string;
  amount: number;
  dateAd: string;
  dateBs: string;
  description: string;
}

export interface LedgerRow {
  kind: "invoice" | "receipt";
  id: string;
  dateAd: string;
  dateBs: string;
  description: string;
  debit: number;
  credit: number;
  /** Balance due AFTER this entry. */
  running: number;
  /** Invoice rows only: what was dispatched, for the muted list under the number. */
  items?: LedgerItem[];
}

export interface LedgerTotals {
  openingBalance: number;
  totalInvoiced: number;
  totalReceived: number;
  closingDue: number;
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Merge invoices (debits) and receipts (credits) into one date-ordered series and
 * stamp each with the running due. Oldest first, so `running` accumulates
 * downward; the caller may reverse for newest-first display without the balance
 * changing.
 *
 * A same-day invoice sorts before a receipt, so money received that day is shown
 * as paying down that day's bill rather than the other way round.
 */
export function buildLedger(
  openingBalance: number,
  invoices: LedgerInvoice[],
  receipts: LedgerReceipt[],
): { rows: LedgerRow[]; totals: LedgerTotals } {
  const opening = round2(openingBalance || 0);

  const merged: Omit<LedgerRow, "running">[] = [
    ...invoices.map((i) => ({
      kind: "invoice" as const,
      id: i.id,
      dateAd: i.dateAd,
      dateBs: i.dateBs,
      description: `Sales invoice ${i.number}`,
      debit: round2(Number(i.total) || 0),
      credit: 0,
      // Carried through so the ledger can show what was actually dispatched
      // beside the invoice number. Absent on a caller that only knows the money.
      ...(i.items && i.items.length > 0 ? { items: i.items } : {}),
    })),
    ...receipts.map((r) => ({
      kind: "receipt" as const,
      id: r.id,
      dateAd: r.dateAd,
      dateBs: r.dateBs,
      description: r.description,
      debit: 0,
      credit: round2(Number(r.amount) || 0),
    })),
  ];

  merged.sort((a, b) => {
    if (a.dateAd !== b.dateAd) return a.dateAd < b.dateAd ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "invoice" ? -1 : 1;
    return 0;
  });

  let running = opening;
  const rows: LedgerRow[] = merged.map((e) => {
    running = round2(running + e.debit - e.credit);
    return { ...e, running };
  });

  const totalInvoiced = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalReceived = round2(rows.reduce((s, r) => s + r.credit, 0));

  return {
    rows,
    totals: {
      openingBalance: opening,
      totalInvoiced,
      totalReceived,
      closingDue: round2(opening + totalInvoiced - totalReceived),
    },
  };
}

/** The one number that matters: opening + invoiced − received. */
export function closingDue(openingBalance: number, invoices: LedgerInvoice[], receipts: LedgerReceipt[]): number {
  return buildLedger(openingBalance, invoices, receipts).totals.closingDue;
}

/**
 * Narrow a built ledger to an inclusive [fromAd, toAd] range.
 *
 * The running balance is NOT restarted from zero: everything before the range is
 * rolled into the opening figure, so the first row of the range continues from
 * the real balance the customer actually owed that day. That is the whole point
 * of a range-filtered statement — a statement that opens at 0 is a lie.
 *
 * `totals` describe the RANGE (what was invoiced and received inside it), while
 * `openingBalance` is the balance carried in at the range start and `closingDue`
 * is the balance at the range end.
 */
export function sliceLedger(
  rows: LedgerRow[],
  openingBalance: number,
  fromAd: string | null,
  toAd: string | null,
): { rows: LedgerRow[]; totals: LedgerTotals } {
  const opening = round2(openingBalance || 0);
  if (!fromAd && !toAd) {
    const totalInvoiced = round2(rows.reduce((s, r) => s + r.debit, 0));
    const totalReceived = round2(rows.reduce((s, r) => s + r.credit, 0));
    return {
      rows,
      totals: {
        openingBalance: opening,
        totalInvoiced,
        totalReceived,
        closingDue: round2(opening + totalInvoiced - totalReceived),
      },
    };
  }

  // Everything strictly before the range folds into the opening balance.
  let carried = opening;
  for (const r of rows) {
    if (fromAd && r.dateAd < fromAd) carried = round2(carried + r.debit - r.credit);
  }

  const kept = rows.filter((r) => (!fromAd || r.dateAd >= fromAd) && (!toAd || r.dateAd <= toAd));

  let running = carried;
  const sliced = kept.map((r) => {
    running = round2(running + r.debit - r.credit);
    return { ...r, running };
  });

  const totalInvoiced = round2(sliced.reduce((s, r) => s + r.debit, 0));
  const totalReceived = round2(sliced.reduce((s, r) => s + r.credit, 0));

  return {
    rows: sliced,
    totals: {
      openingBalance: carried,
      totalInvoiced,
      totalReceived,
      closingDue: round2(carried + totalInvoiced - totalReceived),
    },
  };
}
