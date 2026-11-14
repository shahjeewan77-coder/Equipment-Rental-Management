// ── AGENT-OWNED: order status → customer SMS ───────────────────────────────
//
// The one place that decides "this order just changed state, tell the customer".
//
// THE CONTRACT, and it is the whole design:
//
//   * This is called AFTER the order transition has already been committed. It
//     never runs inside the transition, and it NEVER throws. An SMS is a
//     courtesy to a third party; an SMS Pasal outage, a bad number or a missing
//     credential must not be able to fail an approval, a dispatch or a return.
//     Every path returns a result and every attempt is logged.
//
//   * A skipped send is still a logged attempt. "The customer has no phone" and
//     "SMS Pasal is not configured" are both things the owner needs to be able
//     to see, so they are recorded with the reason rather than silently dropped.
//
//   * The message is built from the order's OWN data (customer name, derived
//     order reference, equipment lines), read fresh at send time, so it can
//     never describe a different order than the one that changed.
import { buildSmsBody, summarizeEquipment, type SmsEvent } from "../../shared/sms";
import { getOrderSmsContext, getProfile, logSmsNotification } from "../db";
import { sendSms, type SmsSendResult } from "./sms-pasal";

/** The business name shown at the start of every message. */
async function businessNameFor(accountId: string): Promise<string> {
  try {
    const profile = await getProfile(accountId);
    return profile?.displayName?.trim() || "Equipment Rental";
  } catch {
    return "Equipment Rental";
  }
}

export interface NotifyResult extends SmsSendResult {
  /** The message body that was (or would have been) sent. */
  body: string;
  /** The order reference used, when one could be derived. */
  orderRef: string | null;
}

/**
 * Notify the customer that one order changed state.
 *
 * `event` is the CUSTOMER-FACING event, which is not always the raw status:
 *
 *   approved    ← status became `approved`
 *   on_transit  ← a driver locked the order for dispatch (status `on_transit`)
 *   delivered   ← the driver dispatched it (status `on_rent`) — the equipment
 *                 has physically arrived, which is what the customer cares about
 *   returned    ← the equipment was picked back up (status `returned`)
 *
 * Never throws. Returns what happened so the caller can surface it if it wants.
 */
export async function notifyOrderStatus(
  accountId: string,
  orderId: string,
  event: SmsEvent,
): Promise<NotifyResult> {
  const empty: NotifyResult = { status: "skipped", to: null, body: "", orderRef: null, error: "Order not found" };

  let ctx: Awaited<ReturnType<typeof getOrderSmsContext>>;
  try {
    ctx = await getOrderSmsContext(accountId, orderId);
  } catch (e) {
    console.error("[sms] could not read order context", e instanceof Error ? e.message : e);
    return empty;
  }
  if (!ctx) return empty;

  const businessName = await businessNameFor(accountId);
  const body = buildSmsBody({
    event,
    customerName: ctx.customerName,
    orderRef: ctx.orderRef,
    equipment: summarizeEquipment(ctx.items),
    businessName,
  });

  const result = await sendSms({ to: ctx.customerPhone, body });

  await logSmsNotification({
    ownerId: accountId,
    orderId: ctx.orderId,
    customerId: ctx.customerId,
    customerName: ctx.customerName,
    orderRef: ctx.orderRef,
    event,
    toNumber: result.to ?? ctx.customerPhone ?? null,
    body,
    status: result.status,
    providerSid: result.sid ?? null,
    error: result.error ?? null,
  });

  return { ...result, body, orderRef: ctx.orderRef };
}

/**
 * Send a test message to a number the owner typed.
 *
 * This is the SAFE path the owner uses to prove the integration works without
 * texting a real customer: the number is supplied by the caller, nothing is
 * read from the customer table, and the attempt is logged with `event: "test"`
 * so it is distinguishable from a real notification in the log.
 */
export async function sendTestSms(
  accountId: string,
  to: string,
  kind: "test" | "festive" = "test",
): Promise<NotifyResult> {
  const businessName = await businessNameFor(accountId);
  const body = buildSmsBody({ event: kind, businessName });
  const result = await sendSms({ to, body });

  await logSmsNotification({
    ownerId: accountId,
    event: kind,
    toNumber: result.to ?? to,
    body,
    status: result.status,
    providerSid: result.sid ?? null,
    error: result.error ?? null,
  });

  return { ...result, body, orderRef: null };
}