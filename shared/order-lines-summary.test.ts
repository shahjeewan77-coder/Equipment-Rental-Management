import { describe, expect, it } from "vitest";
import {
  formatLine,
  formatQtyShort,
  linesTooltip,
  showsOrderLines,
  summarizeLines,
  type OrderLineSummary,
} from "./order-lines-summary";

const line = (equipmentName: string, deliveredQty: number, invoicedQty: number): OrderLineSummary => ({
  equipmentName,
  deliveredQty,
  invoicedQty,
});

describe("showsOrderLines", () => {
  it("shows the summary for the four live statuses", () => {
    for (const s of ["pending_approval", "approved", "on_transit", "on_rent"]) {
      expect(showsOrderLines(s)).toBe(true);
    }
  });

  it("hides it once the order is finished", () => {
    for (const s of ["returned", "rejected"]) {
      expect(showsOrderLines(s)).toBe(false);
    }
  });

  it("hides it for a missing status", () => {
    expect(showsOrderLines(null)).toBe(false);
    expect(showsOrderLines(undefined)).toBe(false);
    expect(showsOrderLines("")).toBe(false);
  });
});

describe("formatQtyShort", () => {
  it("prints whole numbers without decimals", () => {
    expect(formatQtyShort(2)).toBe("2");
    expect(formatQtyShort(10)).toBe("10");
    expect(formatQtyShort(0)).toBe("0");
  });

  it("drops float noise from doublePrecision", () => {
    expect(formatQtyShort(2.0000000001)).toBe("2");
    expect(formatQtyShort(9.999999999)).toBe("10");
  });

  it("keeps a real fraction, rounded to two places", () => {
    expect(formatQtyShort(2.5)).toBe("2.5");
    expect(formatQtyShort(1.234)).toBe("1.23");
  });

  it("treats null/undefined/NaN as zero", () => {
    expect(formatQtyShort(null)).toBe("0");
    expect(formatQtyShort(undefined)).toBe("0");
    expect(formatQtyShort(Number.NaN)).toBe("0");
  });
});

describe("formatLine", () => {
  it("renders name and delivered/invoiced", () => {
    expect(formatLine(line("Concrete Mixer", 2, 2))).toBe("Concrete Mixer 2/2");
  });

  it("shows a delivered/invoiced difference, which is the point of the feature", () => {
    expect(formatLine(line("Steel Pillar", 10, 8))).toBe("Steel Pillar 10/8");
  });

  it("falls back to a placeholder for a nameless line", () => {
    expect(formatLine(line("", 1, 1))).toBe("Unnamed item 1/1");
  });
});

describe("summarizeLines", () => {
  it("returns nothing for an order with no lines", () => {
    expect(summarizeLines([])).toEqual({ text: "", full: "", truncated: false, hidden: 0 });
    expect(summarizeLines(null)).toEqual({ text: "", full: "", truncated: false, hidden: 0 });
  });

  it("lists a single line in full", () => {
    const s = summarizeLines([line("Concrete Mixer", 2, 2)]);
    expect(s.text).toBe("Concrete Mixer 2/2");
    expect(s.truncated).toBe(false);
  });

  it("lists two lines in full, comma separated", () => {
    const s = summarizeLines([line("Concrete Mixer", 2, 2), line("Steel Pillar", 10, 8)]);
    expect(s.text).toBe("Concrete Mixer 2/2, Steel Pillar 10/8");
    expect(s.truncated).toBe(false);
    expect(s.hidden).toBe(0);
  });

  it("truncates past the limit and says how many are hidden", () => {
    const s = summarizeLines(
      [line("Concrete Mixer", 2, 2), line("Steel Pillar", 10, 8), line("Water Pump", 3, 3)],
      2,
    );
    expect(s.text).toBe("Concrete Mixer 2/2, Steel Pillar 10/8 … +1 more");
    expect(s.truncated).toBe(true);
    expect(s.hidden).toBe(1);
  });

  it("keeps the full list for the tooltip even when the row is cut", () => {
    const lines = [
      line("Concrete Mixer", 2, 2),
      line("Steel Pillar", 10, 8),
      line("Water Pump", 3, 3),
      line("Jack Hammer", 1, 1),
    ];
    const s = summarizeLines(lines, 2);
    expect(s.hidden).toBe(2);
    expect(s.full).toBe("Concrete Mixer 2/2, Steel Pillar 10/8, Water Pump 3/3, Jack Hammer 1/1");
    // The visible text is a strict prefix of the full text, so nothing shown is
    // invented and nothing hidden is silently dropped from the tooltip.
    expect(s.full.startsWith("Concrete Mixer 2/2, Steel Pillar 10/8")).toBe(true);
  });

  it("never cuts an equipment name in half", () => {
    const s = summarizeLines([line("Concrete Mixer", 2, 2), line("Steel Pillar", 10, 8), line("X", 1, 1)], 2);
    // Every visible token is a complete "name d/i" pair.
    expect(s.text).not.toMatch(/Concrete Mi[^x]/);
    expect(s.text.split(" … ")[0].split(", ")).toHaveLength(2);
  });
});

describe("linesTooltip", () => {
  it("spells out which number is delivered and which is invoiced", () => {
    const t = linesTooltip([line("Steel Pillar", 10, 8)]);
    expect(t).toBe("Steel Pillar — delivered 10 / invoiced 8");
  });

  it("puts one line per equipment", () => {
    const t = linesTooltip([line("Concrete Mixer", 2, 2), line("Steel Pillar", 10, 8)]);
    expect(t.split("\n")).toHaveLength(2);
  });

  it("is empty when there is nothing to show", () => {
    expect(linesTooltip([])).toBe("");
    expect(linesTooltip(null)).toBe("");
  });
});
