// ── Destination label ────────────────────────────────────────────────────────
//
// What a driver's marker should say about a customer, derived from the ORDER's
// status — never from GPS or ping freshness.
//
// The bug this exists to kill: the tracking map labelled every marker
// "Delivering to {customerName}" whenever the marker had one. That name comes
// from the marker's LAST ping's order. A driver whose delivery finished hours
// ago still has that ping, so an offline driver sat there claiming to be
// "Delivering to 9866239058" long after they had delivered — and the owner read
// it as a delivery still in progress.
//
// The rule follows the app's own lifecycle:
//
//   approved  → (driver locks) → on_transit → (driver arrives, dispatches) → on_rent → (return) → returned
//
//   • on_transit — locked and en route, not yet delivered → "Delivering to".
//   • on_rent    — the driver dispatched it: it IS delivered → "Delivered to".
//     This is the state the complaint was about: equipment sitting at the
//     customer's site for days still read as "Delivering to".
//   • returned / cancelled / rejected — over → "Delivered to" (past tense).
//   • approved / pending — nobody has taken it yet → nothing.
//
// Crucially the state is a function of data the SERVER sends, so an offline
// driver's marker reports its true state: the order row does not go stale just
// because the phone stopped pinging.

export type DestinationTense = "delivering" | "delivered" | "none";

/** Statuses where the driver is still on the way to this customer. */
const EN_ROUTE = new Set(["on_transit"]);
/** Statuses where this customer's delivery is over — including already delivered. */
const DONE = new Set(["on_rent", "returned", "completed", "cancelled", "rejected"]);

/**
 * Which tense the destination label should use.
 *
 * Takes ONE status: the driver's current live trip when the server resolved
 * one, otherwise the status of the order their last ping belongs to. There is
 * deliberately no second "active order" argument — a driver may legitimately
 * hold two live orders, so comparing against whichever one happens to be first
 * in a list made a genuinely en-route driver read as delivered. Which order to
 * describe is the SERVER's decision (it knows the driver's live lock), and this
 * function only translates that answer into a tense.
 */
export function destinationTense(orderStatus: string | null | undefined): DestinationTense {
  const status = (orderStatus ?? "").toLowerCase();
  if (!status) return "none";
  if (EN_ROUTE.has(status)) return "delivering";
  if (DONE.has(status)) return "delivered";
  // pending_approval / approved: nobody has taken it, so there is no destination.
  return "none";
}

/**
 * The full label, or null when nothing should be shown.
 *
 * Kept out of the component so the wording is testable and identical wherever
 * it appears (map popup, drivers table, banner).
 */
export function destinationLabel(
  customerName: string | null | undefined,
  tense: DestinationTense,
): string | null {
  const name = (customerName ?? "").trim();
  if (!name || tense === "none") return null;
  return tense === "delivering" ? `Delivering to ${name}` : `Delivered to ${name}`;
}
