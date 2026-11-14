import { describe, expect, it } from "vitest";
import { destinationLabel, destinationTense } from "./destination-label";

describe("destinationTense", () => {
  it("says 'delivering' only while the driver is still en route", () => {
    expect(destinationTense("on_transit")).toBe("delivering");
  });

  it("says 'delivered' as soon as the driver has dispatched", () => {
    // THE bug: equipment sitting at the customer's site for days is on_rent,
    // and it must never read as "Delivering to".
    expect(destinationTense("on_rent")).toBe("delivered");
  });

  it("says 'delivered' once the order is returned", () => {
    expect(destinationTense("returned")).toBe("delivered");
    expect(destinationTense("completed")).toBe("delivered");
  });

  it("shows nothing before dispatch", () => {
    // Pre-dispatch withholds the destination everywhere, so it must not leak here.
    expect(destinationTense("approved")).toBe("none");
    expect(destinationTense("pending_approval")).toBe("none");
  });

  it("shows nothing when there is no order at all", () => {
    expect(destinationTense(null)).toBe("none");
    expect(destinationTense(undefined)).toBe("none");
    expect(destinationTense("")).toBe("none");
  });

  it("is case-insensitive, because the value crosses an API boundary", () => {
    expect(destinationTense("ON_TRANSIT")).toBe("delivering");
    expect(destinationTense("On_Rent")).toBe("delivered");
  });

  it("does not depend on any other order being 'active'", () => {
    // Regression: a driver may hold two live orders, so an earlier version that
    // compared against `active[0]` from a list made an en-route driver read as
    // delivered. The tense is a pure function of the one status it is given.
    expect(destinationTense("on_transit")).toBe("delivering");
  });
});

describe("destinationLabel", () => {
  it("uses the right tense for each case", () => {
    expect(destinationLabel("Annapurna Infra", "delivering")).toBe("Delivering to Annapurna Infra");
    expect(destinationLabel("Annapurna Infra", "delivered")).toBe("Delivered to Annapurna Infra");
    expect(destinationLabel("Annapurna Infra", "none")).toBeNull();
  });

  it("never renders a label without a name", () => {
    expect(destinationLabel(null, "delivering")).toBeNull();
    expect(destinationLabel("   ", "delivered")).toBeNull();
  });
});
