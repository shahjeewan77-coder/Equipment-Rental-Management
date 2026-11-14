// ── Smart contact split ──────────────────────────────────────────────────────
//
// Shop staff type a customer as they would say them: "Ram Bahadur 9818755517",
// or paste "9818755517 Ram", or paste a formatted "+977-981-875-5517". One field
// is how a person thinks about a customer; two fields is how a ledger needs them.
// This module is the single place that turns the first into the second, so the
// create form, the edit form and the order form cannot disagree about it.
//
// The rules, in full — they are the spec, and the tests pin them:
//
//   • A phone is a run of digits with optional formatting around/between them.
//     Whitespace, dashes, dots, parentheses and plus signs are formatting.
//   • A run only COUNTs as a phone at >= MIN_PHONE_DIGITS digits. Below that it
//     stays where it was put: "Site 2 Ram" must not become phone "2", and a name
//     that legitimately contains a number ("Tower 5") must survive intact.
//   • When several runs qualify, the one with the MOST digits wins. "Ram 5
//     9818755517" therefore keeps the 5 in the name and takes the real number.
//   • Formatting is stripped and every digit is KEPT — "+977-981-875-5517"
//     becomes "9779818755517". Nothing is invented and nothing is discarded:
//     dropping the 977 country code would silently change which number is
//     dialled, and a shop in Nepal orders contacts both ways. Keeping all the
//     digits is the only choice that is lossless, so it is the rule chosen here.
//   • The phone is only ever replaced by digits found in the NAME. A phone the
//     user typed by hand is never touched by a name that contains none.
//   • A string of only digits leaves the name empty and fills the phone.

/** Digits needed before a run in the name field is treated as a phone. */
export const MIN_PHONE_DIGITS = 7;

/**
 * One candidate phone: digits joined by INNER formatting only — no spaces.
 *
 * Whitespace is deliberately excluded from the middle of a run. Allowing it
 * would make "Ram 5 9818755517" look like a single 12-digit number ("5 9818…"),
 * swallow the name's own number, and leave "Ram" + "59818755517". A space is a
 * word boundary in a name, so it must be a boundary here too.
 */
const DIGIT_RUN = /\d+(?:[().\-]\d+)*/g;

/** A run whose digits are separated by spaces: "977 981 875 5517". */
const SPACED_RUN = /\d+(?:[\s().\-]+\d+)+/g;

/**
 * Labels people paste in front of a number: "Ph: 9818…", "Mobile 9818…".
 *
 * The trailing `(?![a-zA-Z])` is what keeps this honest: without it, "Norbu"
 * matched the `no` alternative and lost its first two letters, and "Noel"
 * became "el". A label is a whole word or it is not a label.
 */
const LABEL_PREFIX =
  /^(?:ph|phone|tel|telephone|mobile|mob|cell|contact|no|n|whatsapp|viber|number)(?![a-zA-Z])\s*[:.]?\s*/i;

/** A name that is only one of these words is a label, not a customer. */
const LABEL_WORDS = new Set([
  "ph",
  "phone",
  "tel",
  "telephone",
  "mobile",
  "mob",
  "cell",
  "contact",
  "no",
  "n",
  "whatsapp",
  "viber",
  "call",
]);

/** Trim stray formatting left behind where the number used to be. */
function tidyName(name: string): string {
  return name
    .replace(/[()[\]{}+.,;:/|\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-.,;|/\\]+|[:\-.,;|/\\]+$/g, "")
    .trim();
}

export interface ContactSplit {
  /** What is left of the input once the phone has been taken out. */
  name: string;
  /** Digits-only phone, or null when the input contained no phone-like run. */
  phone: string | null;
  /** The raw text that was recognised as a phone, for showing back to the user. */
  raw: string | null;
}

/** Longest qualifying run of `re`, or null when none is long enough to be a phone. */
function pickBest(text: string, re: RegExp) {
  let found: { text: string; digits: string; index: number; length: number } | null = null;
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, "");
    if (digits.length < MIN_PHONE_DIGITS) continue;
    if (!found || digits.length > found.digits.length) {
      found = { text: raw, digits, index: match.index ?? 0, length: raw.length };
    }
  }
  return found;
}

/**
 * Split one typed/pasted string into a customer name and a phone number.
 *
 * Pure and synchronous: callers re-run it on every keystroke, so it must not
 * allocate anything it does not need or depend on anything outside its input.
 */
export function splitContactName(input: string): ContactSplit {
  const text = input ?? "";
  if (!text.trim()) return { name: "", phone: null, raw: null };
  // Already only digits and formatting — nothing to peel off a name.
  const strippedLabel = text.replace(LABEL_PREFIX, "");

  // COMPACT FIRST, spaced only as a fallback — and the order is the rule.
  //
  // A compact run is digits joined by inner punctuation ("+977-981-875-5517");
  // a spaced run is digits separated by spaces ("977 981 875 5517"). When both
  // could read as a phone, the compact one wins — because in "Ram 5 9818755517"
  // the space after that 5 is a word boundary, not a digit separator, and
  // greedily joining them would record 59818755517 as the customer's number.
  // Spaced runs still matter for the real case they exist for: a number typed
  // in groups, which has no compact reading at all.
  //
  // Written as an expression rather than a closure that assigns, so the type is
  // a plain union instead of being narrowed to `never` at the declaration.
  const best = pickBest(text, DIGIT_RUN) ?? pickBest(text, SPACED_RUN);

  if (!best) {
    // No phone in here. The name is whatever was typed, label prefix removed so a
    // stray "Ph:" does not become part of the customer's name.
    return { name: tidyName(strippedLabel), phone: null, raw: null };
  }

  const removed = text.slice(0, best.index) + " " + text.slice(best.index + best.length);
  let name = tidyName(removed.replace(LABEL_PREFIX, ""));

  // "Ph: 9818755517" leaves "Ph" behind. That is a label, not a customer.
  if (LABEL_WORDS.has(name.toLowerCase())) name = "";

  return { name, phone: best.digits, raw: best.text.trim() };
}

/**
 * Apply a split to a { name, phone } pair, honouring the no-overwrite rule.
 *
 * The contact field is replaced ONLY when the name itself carried a number. A
 * name with no digits leaves the phone exactly as the user typed it — otherwise
 * fixing a spelling mistake would quietly erase the number they had just entered.
 *
 * ── The name is NEVER emptied ──────────────────────────────────────────────
 * A shop that has only a number for a walk-in customer types that number into
 * the Name box. Peeling it out left the name blank, the form refused to save,
 * and the customer could not be recorded at all — the splitter was destroying
 * the only identifier the operator had.
 *
 * So when nothing alphabetic survives the split, the digits themselves become
 * the name: "9818755517" → name "9818755517", phone "9818755517". The number is
 * kept in BOTH fields, which is exactly what was asked for, and the record is
 * still saveable. Digits are only ever removed from the name when real text is
 * left behind ("Ram Bahadur 9818755517" → "Ram Bahadur").
 */
export function applyContactSplit(
  values: { name: string; phone: string },
  typedName: string,
): { name: string; phone: string } {
  const split = splitContactName(typedName);
  if (!split.phone) return { name: split.name, phone: values.phone };
  // Nothing but a number was typed: keep it as the name too, never blank.
  const name = split.name || split.phone;
  return { name, phone: split.phone };
}

/**
 * Live typing, as a reducer over one keystroke.
 *
 * `splitContactName` answers "what does this whole string mean". A text field
 * answering that on every keystroke breaks in two specific ways, and both were
 * observed rather than imagined:
 *
 *   1. "Ram " + "B" — splitting "Ram " returns name "Ram", so the field is
 *      rewritten without the space and the user types "RamBahadur".
 *   2. A trailing digit run is still growing. Splitting "Ram 9818" moves a
 *      half-typed number out of the name box on the fourth digit, so the rest of
 *      the number lands in the phone field as separate keystrokes — and once the
 *      name is empty, "5" typed next is a name again.
 *
 * So while typing, only a run that is FIXED SHAPE gets moved: it must be at
 * least MIN_PHONE_DIGITS long AND be followed by a separator or the end of the
 * string, i.e. it is no longer the thing being typed. A trailing space is kept
 * verbatim, because it is the user's next word boundary, not formatting.
 *
 * Pasting still goes through `splitPastedContact`, which takes the string as
 * final.
 */
export function typeIntoContact(
  values: { name: string; phone: string },
  typed: string,
): { name: string; phone: string } {
  const split = splitContactName(typed);
  // No number at all: the name is what was typed, and a trailing space survives.
  if (!split.phone) return { name: typed, phone: values.phone };

  // Is the recognised number still being typed? It is when it ends the string
  // WITH NO trailing separator — "Ram 9818755517" is still growing, while
  // "Ram 9818755517 " has been closed off by a space and is final.
  const endsTheString = split.raw != null && typed === typed.trimEnd() && typed.endsWith(split.raw.trim());
  if (endsTheString) {
    // Leave it in place, but still offer the digits — the phone field updating
    // live is what the shop asked for. The name keeps the raw text so the user
    // can go on typing the number.
    return { name: typed, phone: split.phone };
  }

  // A finished number: move it out and keep the name's own trailing space.
  const keptTrailing = /\s$/.test(typed) ? " " : "";
  return { name: split.name + keptTrailing, phone: split.phone };
}

/**
 * For a search box, which must keep working as a search: only a PASTE is
 * split. Typing "9818" into a search box is someone looking up a number, not
 * someone filling in a name.
 */
export function splitPastedContact(
  pasted: string,
  current: string,
): { query: string; phone: string | null } {
  const split = splitContactName(pasted);
  if (!split.phone) return { query: current + pasted, phone: null };
  // A paste that was nothing but a number keeps the number in the box so the
  // phone search still finds the customer; the digits are also offered to the
  // create form.
  if (!split.name) return { query: pasted.trim(), phone: split.phone };
  return { query: split.name, phone: split.phone };
}
