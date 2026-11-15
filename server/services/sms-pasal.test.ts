import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sender reads process.env at call time and reaches the network through
// ./_core/fetch. Both are controlled here so every path — configured, not
// configured, bad number, SMS Pasal error, network throw — is deterministic.
vi.mock("../_core/fetch", () => ({
  outboundFetch: vi.fn(),
}));

const ENV_KEYS = ["SMS_PASAL_API_KEY", "SMS_PASAL_ENDPOINT"] as const;

function setFullConfig() {
  process.env.SMS_PASAL_API_KEY = "nsms_test_32fe4568db114cb3c40e76d3a6faec95a9d476342878237958b01bde250502b3";
  process.env.SMS_PASAL_ENDPOINT = "https://api.smspasal.com/api/v1/sms/send";
}

function clearConfig() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("sms-pasal", () => {
  beforeEach(() => {
    vi.resetModules();
    clearConfig();
  });
  afterEach(() => {
    clearConfig();
    vi.restoreAllMocks();
  });

  it("reports not configured when the key is missing", async () => {
    const { smsPasalConfigured, missingSmsPasalVars } = await import("./sms-pasal");
    expect(smsPasalConfigured()).toBe(false);
    expect(missingSmsPasalVars()).toEqual(["SMS_PASAL_API_KEY"]);
  });

  it("reports configured when the key is present (endpoint optional)", async () => {
    process.env.SMS_PASAL_API_KEY = "key";
    const { smsPasalConfigured, missingSmsPasalVars, readSmsPasalConfig } = await import("./sms-pasal");
    expect(smsPasalConfigured()).toBe(true);
    expect(missingSmsPasalVars()).toEqual([]);
    // The endpoint falls back to the documented default.
    expect(readSmsPasalConfig()?.endpoint).toBe("https://api.smspasal.com/api/v1/sms/send");
  });

  it("SKIPS without calling SMS Pasal when not configured", async () => {
    const { outboundFetch } = await import("../_core/fetch");
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("skipped");
    expect(res.error).toContain("not configured");
    expect(outboundFetch).not.toHaveBeenCalled();
  });

  it("SKIPS an undialable number without calling SMS Pasal", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "12345", body: "hi" });
    expect(res.status).toBe("skipped");
    expect(res.to).toBeNull();
    expect(outboundFetch).not.toHaveBeenCalled();
  });

  it("SKIPS a missing number", async () => {
    setFullConfig();
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: null, body: "hi" });
    expect(res.status).toBe("skipped");
    expect(res.error).toContain("no phone");
  });

  it("sends with the X-API-Key header and the LOCAL number", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    (outboundFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: true, message: "SMS queued successfully", data: { message_id: "m-1" } }), {
        status: 200,
      }),
    );

    const { sendSms } = await import("./sms-pasal");
    // A stored E.164 number must be reduced to the local form SMS Pasal wants.
    const res = await sendSms({ to: "+9779804632537", body: "hello" });

    expect(res.status).toBe("sent");
    expect(res.sid).toBe("m-1");
    expect(res.to).toBe("9804632537");

    const [url, init] = (outboundFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.smspasal.com/api/v1/sms/send");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(process.env.SMS_PASAL_API_KEY);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ to: "9804632537", message: "hello" });
  });

  it("returns failed (never throws) when SMS Pasal rejects the message", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    (outboundFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: false, message: "Invalid API key" }), { status: 401 }),
    );
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("Invalid API key");
  });

  it("surfaces SMS Pasal's `error` field on a 401 (the real response shape)", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    // This is the EXACT body SMS Pasal returns for a rejected key: the reason
    // lives in `error`, and there is no `message` at all. Reading only
    // `message` would degrade this to an opaque "HTTP 401".
    (outboundFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "Invalid API key", code: "INVALID_API_KEY" }), {
        status: 401,
      }),
    );
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("failed");
    expect(res.error).toBe("Invalid API key");
    expect(res.error).not.toContain("HTTP 401");
  });

  it("surfaces SMS Pasal's `error` field on a 200 carrying success:false", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    (outboundFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "Insufficient balance", code: "NO_BALANCE" }), {
        status: 200,
      }),
    );
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("failed");
    expect(res.error).toBe("Insufficient balance");
  });

  it("returns failed when a 200 carries success:false", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    (outboundFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: false, message: "Insufficient balance" }), { status: 200 }),
    );
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("Insufficient balance");
  });

  it("returns failed (never throws) when the network call throws", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    (outboundFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ETIMEDOUT"));
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("ETIMEDOUT");
  });

  it("reports a TIMEOUT clearly when the request is aborted", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    // What the AbortController in _core/fetch actually throws.
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    (outboundFetch as ReturnType<typeof vi.fn>).mockRejectedValue(abort);
    const { sendSms, SMS_PASAL_TIMEOUT_MS } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("failed");
    // The opaque platform wording must be replaced by a clear timeout message.
    expect(res.error).toBe(`Timed out after ${SMS_PASAL_TIMEOUT_MS}ms`);
    expect(res.error).not.toContain("aborted");
  });

  it("records how long a successful attempt took", async () => {
    setFullConfig();
    const { outboundFetch } = await import("../_core/fetch");
    (outboundFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { message_id: "m-2" } }), { status: 200 }),
    );
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("sent");
    expect(typeof res.durationMs).toBe("number");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports durationMs 0 for a pre-flight skip (no network)", async () => {
    const { sendSms } = await import("./sms-pasal");
    const res = await sendSms({ to: "9804632537", body: "hi" });
    expect(res.status).toBe("skipped");
    expect(res.durationMs).toBe(0);
  });
});
