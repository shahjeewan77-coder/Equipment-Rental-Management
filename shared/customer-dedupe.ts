// ── Duplicate customer detection (pure) ───────────────────────────────────────
//
// Two customers with the same name AND the same phone number are the same
// customer. Recording them twice splits their ledger in half: the invoices land
// on one row and the receipts on the other, and neither statement is true.
//
// The comparison has to be forgiving, because the same person is typed
// differently every time:
//
//   • Name  — case-insensitive, trimmed, inner whitespace collapsed. "  ram
//             bahadur " and "Ram  Bahadur" are the same name.
//   • Phone — every non-digit removed, so "+977-981-875-5517", "977 981 875
//             5517" and "9779818755517" all compare equal. This is the same
//             formatting rule `contact-split.ts` uses when it extracts a number,
//             so a phone stored by the splitter and one typed by hand still
//             match.
//
// BOTH must match. A shared name with a different number is a different
// customer (two sites of the same builder, two people called Ram Bahadur), and
// blocking that would be worse than the duplicate it prevents. A shared number
// with a different name is likewise allowed — a family sharing one phone.
//
// An empty phone never matches: two customers with no number recorded are not
// evidence of a duplicate, and blocking on that would make the second one
// impossible to add.

/** Case-insensitive, trimmed, inner whitespace collapsed. */
export function normalizeCustomerName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Digits only — every formatting character removed. */
export function normalizeCustomerPhone(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

export interface CustomerIdentity {
  id: string;
  name: string;
  phone?: string | null;
}

/**
 * The existing customer that `candidate` duplicates, or null.
 *
 * `excludeId` is the row being edited: a customer always "matches" itself, so
 * without it every save of an unchanged record would be refused.
 */
export function findDuplicateCustomer<T extends CustomerIdentity>(
  existing: readonly T[],
  candidate: { name: string; phone?: string | null },
  excludeId?: string | null,
): T | null {
  const name = normalizeCustomerName(candidate.name);
  const phone = normalizeCustomerPhone(candidate.phone);
  // No name or no phone is not a duplicate — see the note above.
  if (!name || !phone) return null;

  for (const row of existing) {
    if (excludeId && row.id === excludeId) continue;
    if (normalizeCustomerName(row.name) !== name) continue;
    if (normalizeCustomerPhone(row.phone) !== phone) continue;
    return row;
  }
  return null;
}

/** The message shown inline, naming the customer that already exists. */
export function duplicateCustomerMessage(existing: CustomerIdentity): string {
  const phone = (existing.phone ?? "").trim();
  return phone
    ? `"${existing.name}" already exists with this contact number (${phone}). Pick that customer instead of adding a duplicate.`
    : `"${existing.name}" already exists with this contact number. Pick that customer instead of adding a duplicate.`;
}

/**
 * Every group of existing customers that already duplicate each other on
 * (name, phone). Reported, never deleted — merging two ledgers is a decision
 * for the owner, not something a migration should do silently.
 */
export function findExistingDuplicateGroups<T extends CustomerIdentity>(
  existing: readonly T[],
): Array<{ name: string; phone: string; customers: T[] }> {
  const groups = new Map<string, T[]>();
  for (const row of existing) {
    const name = normalizeCustomerName(row.name);
    const phone = normalizeCustomerPhone(row.phone);
    if (!name || !phone) continue;
    const key = `${name}\u0000${phone}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({
      name: list[0].name,
      phone: list[0].phone ?? "",
      customers: list,
    }));
}
