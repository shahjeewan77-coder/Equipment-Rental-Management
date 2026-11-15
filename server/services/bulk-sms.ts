// ── AGENT-OWNED: custom message to many customers ───────────────────────────
//
// The "Custom message to all customers once" mode: the owner types a message,
// ticks the customers they want, and presses Send. This module does the fan-out.
//
// THE THREE RULES, and they are the whole design:
//
//   1. THE NUMBER COMES FROM THE CUSTOMER'S OWN RECORD. The caller passes
//      customer IDS, never phone numbers. Each number is then read from
//      `customers` (scoped to this account) and normalised at send time. That is
//      what "contact numbers must be picked from the customer details" means in
//      code — there is no path here that accepts a hand-typed number.
//
//   2. ONE ATTEMPT, ONE LOG ROW. Every customer produces exactly one
//      `sms_notifications` row — sent, failed or skipped — so the result summary
//      the owner sees and the log they can re-read are the same facts. A customer
//      with no phone, or an undialable one, is a `skipped` row with the reason,
//      not a gap.
//
//   3. NOTHING HERE THROWS. A bulk send is a sequence of independent attempts; a
//      failure on the fourth customer must not abandon the remaining ones, and no
//      failure may bubble up as a 500 that hides the ones that DID send. Each
//      attempt is caught individually and folded into the result.
//
// Deliberately SEQUENTIAL, not Promise.all: SMS Pasal is a rate-limited third
// party, and a hundred simultaneous requests is how an owner gets their key
// throttled (or blocked) rather than their message delivered.
import { MAX_CUSTOM_MESSAGE_LENGTH, toSmsPasalNumber } from "../../shared/sms";
import { getCustomersForMessaging, logSmsNotification } from "../db";
import { readSmsPasalConfig, sendSms, type SmsSendStatus } from "./sms-pasal";

/** One customer's outcome, as the owner sees it in the result list. */
export interface BulkSendRecipientResult {
  customerId: string;
  customerName: string;
  /** The local number dialled, or the raw stored value when it was unusable. */
  to: string | null;
  status: SmsSendStatus;
  error?: string;
  /** SMS Pasal's message id when it was accepted. */
  sid?: string;
}

export interface BulkSendResult {
  sent: number;
  failed: number;
  skipped: number;
  /** How many customers the caller asked to message. */
  requested: number;
  /** Per-customer detail, in the order they were processed. */
  recipients: BulkSendRecipientResult[];
  /** Set when the whole run was a no-op, e.g. SMS is not configured. */
  note?: string;
}

/**
 * Send one hand-typed message to the customers the owner selected.
 *
 * `message` is sent VERBATIM — no business-name prefix, no signature. The owner
 * wrote those words and the request says the typed message is what goes out; a
 * silent prefix would also risk pushing a 160-character message into two billed
 * segments.
 *
 * `isConfigured` is checked once for the whole run rather than per customer: if
 * SMS Pasal is not configured, there is nothing to attempt, and the honest
 * answer is one skipped row per selected customer explaining exactly that.
 */
export async function sendCustomMessageToCustomers(
  accountId: string,
  customerIds: string[],
  rawMessage: string,
): Promise<BulkSendResult> {
  const message = String(rawMessage ?? "").trim();
  const ids = Array.from(new Set(customerIds.filter(Boolean)));
  const result: BulkSendResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    requested: ids.length,
    recipients: [],
  };

  if (ids.length === 0) {
    result.note = "No customers were selected.";
    return result;
  }

  const rows = await getCustomersForMessaging(accountId, ids);
  // An id that is not this account's customer is dropped here rather than
  // messaged — the list is owner-scoped in the query, so a cross-tenant id
  // simply does not come back.
  const byId = new Map(rows.map((r) => [r.id, r]));

  const configured = readSmsPasalConfig() !== null;

  for (const id of ids) {
    const c = byId.get(id);
    if (!c) {
      result.skipped += 1;
      result.recipients.push({
        customerId: id,
        customerName: "Unknown customer",
        to: null,
        status: "skipped",
        error: "Customer not found in this business.",
      });
      continue;
    }

    const normalised = toSmsPasalNumber(c.phone);
    let status: SmsSendStatus;
    let to: string | null = normalised;
    let error: string | undefined;
    let sid: string | undefined;

    if (!message) {
      // The composer already blocks an empty send, but an empty message must
      // never reach the provider through a direct API call either.
      status = "skipped";
      error = "Message was empty.";
    } else if (message.length > MAX_CUSTOM_MESSAGE_LENGTH) {
      status = "skipped";
      error = `Message is longer than ${MAX_CUSTOM_MESSAGE_LENGTH} characters.`;
    } else if (!normalised) {
      status = "skipped";
      to = null;
      error = c.phone ? `Not a dialable number: ${c.phone}` : "Customer has no phone number";
    } else {
      const res = await sendSms({ to: normalised, body: message });
      status = res.status;
      to = res.to ?? normalised;
      error = res.error;
      sid = res.sid;
    }

    await logSmsNotification({
      ownerId: accountId,
      customerId: c.id,
      customerName: c.name,
      event: "custom",
      toNumber: to,
      body: message || "(empty message)",
      status,
      providerSid: sid ?? null,
      error: error ?? null,
    });

    if (status === "sent") result.sent += 1;
    else if (status === "failed") result.failed += 1;
    else result.skipped += 1;

    result.recipients.push({
      customerId: c.id,
      customerName: c.name,
      to,
      status,
      error,
      sid,
    });
  }

  if (!configured) {
    result.note =
      "SMS Pasal is not configured, so nothing was actually sent. Add SMS_PASAL_API_KEY under Settings → Environment variables.";
  }

  return result;
}

/**
 * Send the delivery message to ONE customer right after a dispatch.
 *
 * This is the "Message on delivery" mode's automatic path. It is narrower than
 * the order-status notifier on purpose: it fires on dispatch only, it reads the
 * customer's number from the customer record, and it does NOT ride the festive
 * greeting along (the mode is about the delivery notice, and a duplicate
 * greeting on every dispatch would be noise the owner did not ask for).
 *
 * Never throws.
 */
export async function sendDeliveryMessageForOrder(
  accountId: string,
  orderId: string,
): Promise<void> {
  try {
    const { getOrderSmsContext, getProfile } = await import("../db");
    const ctx = await getOrderSmsContext(accountId, orderId);
    if (!ctx) return;

    let businessName = "Equipment Rental";
    try {
      const profile = await getProfile(accountId);
      businessName = profile?.displayName?.trim() || businessName;
    } catch {
      // The name is cosmetic; a profile read failure must not stop the message.
    }

    const { buildSmsBody, summarizeEquipment } = await import("../../shared/sms");
    const body = buildSmsBody({
      event: "delivery",
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
      event: "delivery",
      toNumber: result.to ?? ctx.customerPhone ?? null,
      body,
      status: result.status,
      providerSid: result.sid ?? null,
      error: result.error ?? null,
    });
  } catch (e) {
    // The dispatch has already been committed. An SMS problem is logged and
    // swallowed so the driver's action can never appear to have failed.
    console.error(
      "[sms] delivery message threw",
      e instanceof Error ? e.message : e,
    );
  }
}
