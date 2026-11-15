import { describe, expect, it } from "vitest";
import {
  duplicateCustomerMessage,
  findDuplicateCustomer,
  findExistingDuplicateGroups,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from "./customer-dedupe";

const rows = [
  { id: "a", name: "Annapurna Infra", phone: "9833333333" },
  { id: "b", name: "Ram Bahadur", phone: "9818755517" },
  { id: "c", name: "Everest Construction", phone: "9822222222" },
  { id: "d", name: "No Phone Co", phone: null },
];

describe("normalizeCustomerName", () => {
  it("is case-insensitive, trimmed and collapses inner whitespace", () => {
    expect(normalizeCustomerName("  Ram   Bahadur ")).toBe("ram bahadur");
    expect(normalizeCustomerName("RAM BAHADUR")).toBe("ram bahadur");
    expect(normalizeCustomerName(null)).toBe("");
  });
});

describe("normalizeCustomerPhone", () => {
  it("strips every formatting character", () => {
    expect(normalizeCustomerPhone("+977-981-875-5517")).toBe("9779818755517");
    expect(normalizeCustomerPhone("(981) 875 5517")).toBe("9818755517");
    expect(normalizeCustomerPhone("981.875.5517")).toBe("9818755517");
    expect(normalizeCustomerPhone(null)).toBe("");
  });
});

describe("findDuplicateCustomer", () => {
  it("matches on name AND phone, ignoring case and phone formatting", () => {
    const dup = findDuplicateCustomer(rows, { name: "annapurna infra", phone: "(983) 333-3333" });
    expect(dup?.id).toBe("a");
  });

  it("does NOT match when the country code makes the digits different", () => {
    // The splitter keeps every digit (documented rule), so "+977-983-333-3333"
    // is 9779833333333 and is a different number from 9833333333. Treating them
    // as equal would mean silently rewriting which number is dialled.
    expect(
      findDuplicateCustomer(rows, { name: "Annapurna Infra", phone: "+977-983-333-3333" }),
    ).toBeNull();
  });

  it("allows the same name with a DIFFERENT number", () => {
    expect(findDuplicateCustomer(rows, { name: "Annapurna Infra", phone: "9800000000" })).toBeNull();
  });

  it("allows the same number with a DIFFERENT name", () => {
    expect(findDuplicateCustomer(rows, { name: "Sita Kumari", phone: "9833333333" })).toBeNull();
  });

  it("never matches when the phone is empty — two unnamed numbers are not a duplicate", () => {
    expect(findDuplicateCustomer(rows, { name: "No Phone Co", phone: "" })).toBeNull();
    expect(findDuplicateCustomer(rows, { name: "No Phone Co", phone: null })).toBeNull();
  });

  it("never matches when the name is empty", () => {
    expect(findDuplicateCustomer(rows, { name: "   ", phone: "9833333333" })).toBeNull();
  });

  it("excludes the row being edited, so an unchanged record always saves", () => {
    expect(
      findDuplicateCustomer(rows, { name: "Annapurna Infra", phone: "9833333333" }, "a"),
    ).toBeNull();
  });

  it("still catches a real duplicate when editing a DIFFERENT row", () => {
    const dup = findDuplicateCustomer(rows, { name: "Annapurna Infra", phone: "9833333333" }, "b");
    expect(dup?.id).toBe("a");
  });
});

describe("duplicateCustomerMessage", () => {
  it("names the existing customer and its number", () => {
    const msg = duplicateCustomerMessage(rows[0]);
    expect(msg).toContain("Annapurna Infra");
    expect(msg).toContain("9833333333");
    expect(msg).toMatch(/already exists/i);
  });
});

describe("findExistingDuplicateGroups", () => {
  it("reports groups that already duplicate each other", () => {
    const withDupes = [
      ...rows,
      { id: "e", name: "annapurna  infra", phone: "983-333-3333" },
    ];
    const groups = findExistingDuplicateGroups(withDupes);
    expect(groups).toHaveLength(1);
    expect(groups[0].customers.map((c) => c.id).sort()).toEqual(["a", "e"]);
  });

  it("returns nothing for a clean list", () => {
    expect(findExistingDuplicateGroups(rows)).toEqual([]);
  });

  it("ignores rows with no phone — they cannot be proven duplicates", () => {
    const twoBlank = [
      { id: "x", name: "Same Name", phone: null },
      { id: "y", name: "Same Name", phone: null },
    ];
    expect(findExistingDuplicateGroups(twoBlank)).toEqual([]);
  });
});
