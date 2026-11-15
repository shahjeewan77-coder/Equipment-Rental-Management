// Compact "what was ordered / delivered / invoiced" summary for the Orders list.
//
// The list shows, under the customer name, one short token per equipment line:
//
//     Concrete Mixer 2/2, Steel Pillar 10/8
//
// where the pair is DELIVERED / INVOICED. Those two numbers are the whole point
// of the feature: an operator needs to see at a glance that 10 pillars went out
// but only 8 were billed, without opening the order.
//
// Kept in `shared/` so the server (which builds the rows) and the client (which
// renders them) agree on the shape, and so the truncation rule is unit-testable
// without a browser.

/** One equipment line, reduced to what the list needs. */
export type OrderLineSummary = {
  equipmentName: string;
  /** Actual quantity that physically left the godown (`order_items.actual_qty`). */
  deliveredQty: number;
  /** Quantity the invoice charges for (`order_items.billed_qty`). */
  invoicedQty: number;
};

/**
 * The statuses that show the line summary.
 *
 * These are the four "live" states — the order exists and is somewhere between
 * being placed and being out on rent. `returned` and `rejected` are finished, so
 * the row stays clean; `dispatched` is listed for completeness even though this
 * app's lifecycle goes `on_transit → on_rent` and never writes it.
 */
export const ORDER_LINE_STATUSES = [
  "pending_approval",
  "approved",
  "on_transit",
  "dispatched",
  "on_rent",
] as const;

export function showsOrderLines(status: string | null | undefined): boolean {
  if (!status) return false;
  return (ORDER_LINE_STATUSES as readonly string[]).includes(status);
}

/**
 * Quantities are stored as `doublePrecision`, so 2 can arrive as 2.0000000001.
 * Whole numbers print without a decimal point; anything else is rounded to two
 * places and trailing zeros dropped, so a row never reads "2.00/2.00".
 */
export function formatQtyShort(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "0";
  const rounded = Math.round(v * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** `Concrete Mixer 2/2` — delivered/invoiced. */
export function formatLine(line: OrderLineSummary): string {
  const name = (line.equipmentName ?? "").trim() || "Unnamed item";
  return `${name} ${formatQtyShort(line.deliveredQty)}/${formatQtyShort(line.invoicedQty)}`;
}

export type LinesSummary = {
  /** What the row renders — possibly cut short with an ellipsis. */
  text: string;
  /** The full list, for the hover tooltip. Always complete. */
  full: string;
  /** True when `text` is shorter than `full`. */
  truncated: boolean;
  /** How many lines were hidden behind the ellipsis. */
  hidden: number;
};

/**
 * Build the row text, cutting it off after `maxLines` entries.
 *
 * Truncation is by LINE COUNT, not character count: a character cut would slice
 * an equipment name in half ("Concrete Mi…"), which reads as a typo rather than
 * as "there is more here". Cutting on a line boundary keeps every visible token
 * whole and makes the "+2 more" honest about what is missing.
 */
export function summarizeLines(lines: OrderLineSummary[] | null | undefined, maxLines = 2): LinesSummary {
  const all = (lines ?? []).filter(Boolean);
  if (all.length === 0) return { text: "", full: "", truncated: false, hidden: 0 };

  const full = all.map(formatLine).join(", ");
  if (all.length <= maxLines) return { text: full, full, truncated: false, hidden: 0 };

  const shown = all.slice(0, maxLines).map(formatLine).join(", ");
  const hidden = all.length - maxLines;
  return {
    text: `${shown} … +${hidden} more`,
    full,
    truncated: true,
    hidden,
  };
}

/**
 * The tooltip body: one line per equipment, spelling out which number is which.
 * The row itself is too narrow for labels, so the hover is where the legend
 * lives.
 */
export function linesTooltip(lines: OrderLineSummary[] | null | undefined): string {
  const all = (lines ?? []).filter(Boolean);
  if (all.length === 0) return "";
  return all
    .map(
      (l) =>
        `${(l.equipmentName ?? "").trim() || "Unnamed item"} — delivered ${formatQtyShort(
          l.deliveredQty,
        )} / invoiced ${formatQtyShort(l.invoicedQty)}`,
    )
    .join("\n");
}
