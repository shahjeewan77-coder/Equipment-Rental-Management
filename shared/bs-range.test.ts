import { describe, expect, it } from "vitest";
import { adIsoToBsIso, bsToAdIso, inAdRange, resolveBsRange, startOfBsMonth } from "../shared/bs-range";
import { kathmanduToday } from "../shared/bs-calendar";

// A fixed "today" so these tests do not drift with the calendar.
const TODAY = kathmanduToday();

describe("bsToAdIso / adIsoToBsIso", () => {
  it("round-trips a BS date through AD and back", () => {
    for (const bs of ["2083-07-01", "2083-07-14", "2080-01-01", "2083-12-30"]) {
      expect(adIsoToBsIso(bsToAdIso(bs))).toBe(bs);
    }
  });

  it("maps the BS month start to a real AD day", () => {
    expect(bsToAdIso("2083-07-01")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("resolveBsRange", () => {
  it("falls back to the current BS month when both filters are empty", () => {
    const r = resolveBsRange({ startDateBS: null, endDateBS: null }, TODAY);
    expect(r.isDefault).toBe(true);
    expect(r.fromAd).toBe(bsToAdIso(startOfBsMonth(TODAY.bs)));
    expect(r.toAd).toBe(TODAY.ad);
  });

  it("treats a start-only filter as start → today", () => {
    const r = resolveBsRange({ startDateBS: "2083-07-01", endDateBS: null }, TODAY);
    expect(r.isDefault).toBe(false);
    expect(r.fromAd).toBe(bsToAdIso("2083-07-01"));
    expect(r.toAd).toBe(TODAY.ad);
  });

  it("treats an end-only filter as the 1st of that BS month → end", () => {
    const r = resolveBsRange({ startDateBS: null, endDateBS: "2083-07-14" }, TODAY);
    expect(r.fromAd).toBe(bsToAdIso("2083-07-01"));
    expect(r.toAd).toBe(bsToAdIso("2083-07-14"));
  });

  it("swaps a reversed pair rather than returning an empty range", () => {
    const forward = resolveBsRange({ startDateBS: "2083-07-01", endDateBS: "2083-07-14" }, TODAY);
    const reversed = resolveBsRange({ startDateBS: "2083-07-14", endDateBS: "2083-07-01" }, TODAY);
    expect(reversed.fromAd).toBe(forward.fromAd);
    expect(reversed.toAd).toBe(forward.toAd);
  });

  it("is inclusive on both ends", () => {
    const r = resolveBsRange({ startDateBS: "2083-07-01", endDateBS: "2083-07-14" }, TODAY);
    expect(inAdRange(r.fromAd, r)).toBe(true);
    expect(inAdRange(r.toAd, r)).toBe(true);
    const before = new Date(`${r.fromAd}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    const after = new Date(`${r.toAd}T00:00:00Z`);
    after.setUTCDate(after.getUTCDate() + 1);
    expect(inAdRange(before.toISOString().slice(0, 10), r)).toBe(false);
    expect(inAdRange(after.toISOString().slice(0, 10), r)).toBe(false);
  });
});
