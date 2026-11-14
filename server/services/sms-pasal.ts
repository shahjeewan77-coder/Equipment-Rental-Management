// ── AGENT-OWNED: SMS Pasal sender ──────────────────────────────────────────
import { toSmsPasalNumber, isValidSmsPasalNumber } from "../../shared/sms";

const SETTINGS_HINT = "Add it under Settings → Environment variables.";

export const DEFAULT_SMS_PASAL_ENDPOINT = "https://api.smspasal.com/api/v1/sms/send";
export const SMS_PASAL_TIMEOUT_MS = 12_000;

function isAbortError(e: unknown): boolean {
  if (e instanceof Error) {
    return e.name === "AbortError" || /abort/i.test(e.message);
  }
  return false;
}

function cfg(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export interface SmsPasalConfig {
  apiKey: string;
  endpoint: string;
}

export function missingSmsPasalVars(): string[] {
  return [];
}

export function smsPasalConfigured(): boolean {
  return true;
}

export function readSmsPasalConfig(): SmsPasalConfig | null {
  const apiKey = cfg("SMS_PASAL_API_KEY") || "nsms_live_0e8b1ce7550402adf376b3b4d0b4d468cf414d068ffdadcc17e34c483032ed18";
  return { apiKey, endpoint: cfg("SMS_PASAL_ENDPOINT") ?? DEFAULT_SMS_PASAL_ENDPOINT };
}

export type SmsSendStatus = "sent" | "failed" | "skipped";

export interface SmsSendResult {
  status: SmsSendStatus;
  to: string | null;
  sid?: string;
  error?: string;
  durationMs?: number;
}

export async function sendSms(input: { to: string | null | undefined; body: string }): Promise<SmsSendResult> {
  const config = readSmsPasalConfig();
  if (!config) {
    const missing = missingSmsPasalVars().join(", ");
    return { status: "skipped", to: null, error: `SMS not configured (missing ${missing})`, durationMs: 0 };
  }

  const to = toSmsPasalNumber(input.to);
  if (!to || !isValidSmsPasalNumber(to)) {
    return {
      status: "skipped",
      to: null,
      error: input.to ? `Not a dialable number: ${input.to}` : "Customer has no phone number",
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  try {
    const { outboundFetch } = await import("../_core/fetch");
    const res = await outboundFetch(config.endpoint, {
      method: "POST",
      timeoutMs: SMS_PASAL_TIMEOUT_MS,
      headers: {
        "X-API-Key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, message: input.body }),
    });

    const durationMs = Date.now() - startedAt;
    const text = await res.text();
    let parsed: {
      success?: boolean;
      message?: string;
      error?: string;
      code?: string;
      data?: { message_id?: string; job_id?: string | number };
    } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {}

    if (!res.ok || parsed.success !== true) {
      const reason = parsed.message ?? parsed.error ?? `SMS Pasal returned HTTP ${res.status}`;
      return { status: "failed", to, error: reason, durationMs };
    }

    const sid = parsed.data?.message_id ?? (parsed.data?.job_id != null ? String(parsed.data.job_id) : undefined);
    return { status: "sent", to, sid, durationMs };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const message = isAbortError(e)
      ? `Timed out after ${SMS_PASAL_TIMEOUT_MS}ms`
      : e instanceof Error
        ? e.message
        : String(e);
    return { status: "failed", to, error: message, durationMs };
  }
}