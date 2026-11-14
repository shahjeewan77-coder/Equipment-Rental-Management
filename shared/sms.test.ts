import { describe, expect, it } from "vitest";
import {
  buildSmsBody,
  isValidE164,
  summarizeEquipment,
  toE164Nepal,
  SMS_EVENTS,
  ORDER_SMS_EVENTS,
  MESSAGE_MODES,
  MESSAGE_MODE_LABELS,
} from "./sms";

// ── E.164 normalisation ───────────────────────────────────────────────────────
//
// The app stores whatever the operator typed. Every one of these shapes is a
// real Nepali number and must reach the SAME E.164 string, because a message
// that goes to the wrong number is worse than one that is never sent.
describe("toE164Nepal", () => {
  it("normalises a bare 10-digit mobile", () => {
    expect(toE164Nepal("9818755517")).toBe("+9779818755517");
  });

  it("normalises the same number with a trunk 0", () => {
    expect(toE164Nepal("09818755517")).toBe("+9779818755517");
  });

  it("normalises the same number with the country code", () => {
    expect(toE164Nepal("9779818755517")).toBe("+9779818755517");
  });

  it("normalises a formatted number with + and separators", () => {
    expect(toE164Nepal("+977-981-875-5517")).toBe("+9779818755517");
    expect(toE164Nepal("(977) 981 875 5517")).toBe("+9779818755517");
    expect(toE164Nepal("+977 981-875-5517")).toBe("+9779818755517");
  });

  it("normalises a 9-digit landline", () => {
    expect(toE164Nepal("014234567")).toBe("+97714234567");
    expect(toE164Nepal("14234567")).toBe("+97714234567");
  });

  // The length check is what makes this safe. A bare 10-digit mobile that
  // happens to START with 97 must not have its first three digits eaten.
  it("does NOT strip 977 from a 10-digit number that merely starts with 97", () => {
    expect(toE164Nepal("9771234567")).toBe("+9779771234567");
  });

  it("returns null for a missing or empty number", () => {
    expect(toE164Nepal(null)).toBeNull();
    expect(toE164Nepal(undefined)).toBeNull();
    expect(toE164Nepal("")).toBeNull();
    expect(toE164Nepal("   ")).toBeNull();
  });

  it("returns null for a number that is too short or too long to dial", () => {
    expect(toE164Nepal("12345")).toBeNull();
    expect(toE164Nepal("12345678901234567890")).toBeNull();
  });

  it("returns null for text with no digits", () => {
    expect(toE164Nepal("Annapurna Infra")).toBeNull();
  });
});

describe("isValidE164", () => {
  it("accepts a well-formed E.164 string", () => {
    expect(isValidE164("+9779818755517")).toBe(true);
    expect(isValidE164("+15551234567")).toBe(true);
  });

  it("rejects a missing +, a leading zero, or a bad length", () => {
    expect(isValidE164("9779818755517")).toBe(false);
    expect(isValidE164("+09779818755517")).toBe(false);
    expect(isValidE164("+1234567")).toBe(false);
    expect(isValidE164(null)).toBe(false);
  });
});

// ── Equipment summary ─────────────────────────────────────────────────────────
describe("summarizeEquipment", () => {
  it("joins lines as name x qty", () => {
    expect(
      summarizeEquipment([
        { equipmentName: "Concrete Mixer", qty: 2 },
        { equipmentName: "Steel Pillar", qty: 10 },
      ]),
    ).toBe("Concrete Mixer x2, Steel Pillar x10");
  });

  it("drops a fractional trailing zero", () => {
    expect(summarizeEquipment([{ equipmentName: "Pipe", qty: 2.5 }])).toBe("Pipe x2.5");
  });

  it("falls back to 'equipment' when there are no lines", () => {
    expect(summarizeEquipment([])).toBe("equipment");
    expect(summarizeEquipment(null)).toBe("equipment");
  });

  it("truncates on a token boundary with an ellipsis, never mid-name", () => {
    const out = summarizeEquipment(
      [
        { equipmentName: "Concrete Mixer", qty: 2 },
        { equipmentName: "Steel Pillar", qty: 10 },
        { equipmentName: "Centering Plate", qty: 5 },
      ],
      30,
    );
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out.endsWith("…")).toBe(true);
    // The cut is between tokens, so no name is sliced in half.
    expect(out).not.toContain("Concrete Mi…");
  });
});

// ── Message bodies ────────────────────────────────────────────────────────────
describe("buildSmsBody", () => {
  const base = {
    customerName: "Annapurna Infra",
    orderRef: "ORD-2026-10-26-2",
    equipment: "Concrete Mixer x2",
    businessName: "Sharma Equipment",
  };

  it("names the business, customer, order, equipment and status for each event", () => {
    const approved = buildSmsBody({ ...base, event: "approved" });
    expect(approved).toContain("Sharma Equipment");
    expect(approved).toContain("Annapurna Infra");
    expect(approved).toContain("ORD-2026-10-26-2");
    expect(approved).toContain("Concrete Mixer x2");
    expect(approved).toContain("APPROVED");

    expect(buildSmsBody({ ...base, event: "on_transit" })).toContain("ON THE WAY");
    expect(buildSmsBody({ ...base, event: "delivered" })).toContain("DELIVERED");
    expect(buildSmsBody({ ...base, event: "returned" })).toContain("RETURNED");
  });

  it("keeps every message inside two SMS segments", () => {
    for (const event of ORDER_SMS_EVENTS) {
      expect(buildSmsBody({ ...base, event }).length).toBeLessThanOrEqual(320);
    }
  });

  it("degrades gracefully when the optional fields are missing", () => {
    const body = buildSmsBody({ event: "approved" });
    expect(body).toContain("customer");
    expect(body).toContain("equipment");
    expect(body).toContain("your order");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("null");
  });

  it("has a distinct test message that names no customer", () => {
    const body = buildSmsBody({ event: "test", businessName: "Sharma Equipment" });
    expect(body).toContain("test");
    expect(body).not.toContain("undefined");
  });
});

describe("event constants", () => {
  it("lists the four order events plus test", () => {
    expect([...ORDER_SMS_EVENTS]).toEqual(["approved", "on_transit", "delivered", "returned"]);
    expect([...SMS_EVENTS]).toContain("test");
  });

  it("includes the delivery, custom and festive events", () => {
    expect([...SMS_EVENTS]).toContain("delivery");
    expect([...SMS_EVENTS]).toContain("custom");
    expect([...SMS_EVENTS]).toContain("festive");
  });
});

// ── message modes ───────────────────────────────────────────────────────────
describe("message modes", () => {
  it("offers exactly off / delivery / custom", () => {
    expect([...MESSAGE_MODES]).toEqual(["off", "delivery", "custom"]);
  });

  it("labels every mode", () => {
    for (const m of MESSAGE_MODES) expect(MESSAGE_MODE_LABELS[m]).toBeTruthy();
  });
});

// ── the delivery message and the custom blast ───────────────────────────────
describe("buildSmsBody — delivery and custom", () => {
  const base = {
    customerName: "Annapurna Infra",
    orderRef: "ORD-2026-10-26-2",
    equipment: "Concrete Mixer x2",
    businessName: "Sharma Equipment",
  };

  it("names the customer, order and equipment in the delivery message", () => {
    const body = buildSmsBody({ ...base, event: "delivery" });
    expect(body).toContain("Annapurna Infra");
    expect(body).toContain("ORD-2026-10-26-2");
    expect(body).toContain("Concrete Mixer x2");
    expect(body).toContain("DELIVERED");
  });

  it("sends a custom message verbatim, with no prefix added", () => {
    const typed = "Dear customer, our office is closed tomorrow.";
    expect(buildSmsBody({ event: "custom", customBody: typed, businessName: "Sharma Equipment" })).toBe(typed);
  });

  it("trims a custom message but never invents content", () => {
    expect(buildSmsBody({ event: "custom", customBody: "  hi  " })).toBe("hi");
    expect(buildSmsBody({ event: "custom" })).toBe("");
  });
});
