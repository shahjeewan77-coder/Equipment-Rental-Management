import { describe, expect, it } from "vitest";
import {
  MIN_PHONE_DIGITS,
  applyContactSplit,
  splitContactName,
  splitPastedContact,
  typeIntoContact,
} from "./contact-split";

// These cases are the spec. If one of them has to change, the behaviour the
// shop relies on has changed, so change it deliberately.

describe("splitContactName", () => {
  it("splits name-then-number", () => {
    expect(splitContactName("Ram Bahadur 9818755517")).toMatchObject({
      name: "Ram Bahadur",
      phone: "9818755517",
    });
  });

  it("splits number-then-name", () => {
    expect(splitContactName("9818755517 Ram")).toMatchObject({
      name: "Ram",
      phone: "9818755517",
    });
  });

  it("strips formatting and keeps EVERY digit", () => {
    // Country code kept on purpose: dropping 977 would change the number dialled.
    const r = splitContactName("+977-981-875-5517");
    expect(r.phone).toBe("9779818755517");
    expect(r.name).toBe("");
  });

  it("handles parentheses, dots and slashes in the number", () => {
    expect(splitContactName("Sita Tamang (9841) 234.567")).toMatchObject({
      name: "Sita Tamang",
      phone: "9841234567",
    });
  });

  it("leaves a name with no digits untouched and reports no phone", () => {
    const r = splitContactName("Annapurna Infra");
    expect(r).toMatchObject({ name: "Annapurna Infra", phone: null, raw: null });
  });

  it("does not mistake a short number in a name for a phone", () => {
    // "Tower 5" and "Site 2" are real names; a bare 5 is not a phone.
    expect(splitContactName("Tower 5")).toMatchObject({ name: "Tower 5", phone: null });
    expect(splitContactName("Site 2 Ram")).toMatchObject({ name: "Site 2 Ram", phone: null });
  });

  it("prefers a compact number over a space-joined reading", () => {
    // "5 9818755517" must NOT become 59818755517: the space is a word boundary.
    expect(splitContactName("Ram 5 9818755517")).toMatchObject({
      name: "Ram 5",
      phone: "9818755517",
    });
  });

  it("still reads a number typed in spaced groups", () => {
    // No compact reading exists here, so the spaced fallback is what finds it.
    expect(splitContactName("Ram 977 981 875 5517")).toMatchObject({
      name: "Ram",
      phone: "9779818755517",
    });
  });

  it("fills only the phone when the input is nothing but digits", () => {
    expect(splitContactName("9818755517")).toMatchObject({ name: "", phone: "9818755517" });
  });

  it("drops a pasted label instead of putting it in the name", () => {
    expect(splitContactName("Ph: 9818755517")).toMatchObject({ name: "", phone: "9818755517" });
    expect(splitContactName("Mobile 9818755517 Hari")).toMatchObject({
      name: "Hari",
      phone: "9818755517",
    });
  });

  it("accepts a number exactly at the minimum length", () => {
    const digits = "9".repeat(MIN_PHONE_DIGITS);
    expect(splitContactName(`Ram ${digits}`)).toMatchObject({ name: "Ram", phone: digits });
    // One digit fewer stays in the name.
    const short = "9".repeat(MIN_PHONE_DIGITS - 1);
    expect(splitContactName(`Ram ${short}`)).toMatchObject({ name: `Ram ${short}`, phone: null });
  });

  it("keeps a long number whole even past 13 digits", () => {
    expect(splitContactName("Ram 977981875551799").phone).toBe("977981875551799");
  });

  it("is safe on empty and whitespace-only input", () => {
    expect(splitContactName("")).toMatchObject({ name: "", phone: null });
    expect(splitContactName("   ")).toMatchObject({ name: "", phone: null });
  });

  it("does not run the label regex into a name that starts with 'No'", () => {
    // "Norbu" must not lose its first two letters to the "no" label.
    expect(splitContactName("Norbu Sherpa 9818755517")).toMatchObject({
      name: "Norbu Sherpa",
      phone: "9818755517",
    });
  });

  it("leaves interior punctuation in a name alone", () => {
    expect(splitContactName("Ram & Sons 9818755517")).toMatchObject({
      name: "Ram & Sons",
      phone: "9818755517",
    });
  });
});

describe("applyContactSplit", () => {
  it("replaces the phone when the name carries one", () => {
    expect(applyContactSplit({ name: "", phone: "9800000000" }, "Hari 9841234567")).toEqual({
      name: "Hari",
      phone: "9841234567",
    });
  });

  it("never overwrites a hand-typed phone with a name that has no digits", () => {
    expect(applyContactSplit({ name: "", phone: "9800000000" }, "Hari Gurung")).toEqual({
      name: "Hari Gurung",
      phone: "9800000000",
    });
  });

  it("keeps a number-only name in BOTH fields instead of emptying the name", () => {
    // A walk-in customer whose only identifier is a phone number. Peeling the
    // digits out left the name blank and the form refused to save, so the
    // customer could not be recorded at all.
    expect(applyContactSplit({ name: "Ram", phone: "" }, "9818755517")).toEqual({
      name: "9818755517",
      phone: "9818755517",
    });
  });

  it("still strips digits when real text is left behind", () => {
    expect(applyContactSplit({ name: "", phone: "" }, "Ram Bahadur 9818755517")).toEqual({
      name: "Ram Bahadur",
      phone: "9818755517",
    });
  });

  it("never returns an empty name for any phone-bearing input", () => {
    for (const input of ["9818755517", "+977-981-875-5517", "Ph: 9818755517", "9818755517 Ram"]) {
      expect(applyContactSplit({ name: "", phone: "" }, input).name).not.toBe("");
    }
  });
});

describe("splitPastedContact", () => {
  it("splits a full contact paste into name + phone", () => {
    expect(splitPastedContact("Ram Bahadur 9818755517", "")).toEqual({
      query: "Ram Bahadur",
      phone: "9818755517",
    });
  });

  it("keeps a number-only paste searchable", () => {
    // Searching by phone must still work after pasting one.
    expect(splitPastedContact("9818755517", "")).toEqual({
      query: "9818755517",
      phone: "9818755517",
    });
  });

  it("appends ordinary text to the current query", () => {
    expect(splitPastedContact("Infra", "Annapurna ")).toEqual({
      query: "Annapurna Infra",
      phone: null,
    });
  });
});

// ── live typing ──────────────────────────────────────────────────────────────
//
// These replay REAL keystrokes. Splitting a finished string is easy; not
// destroying it while it is half-typed is the actual job.

describe("typeIntoContact (live typing)", () => {
  /** Feed `text` one character at a time, the way a keyboard does. */
  function typeCharacters(text: string, start = { name: "", phone: "" }) {
    let state = start;
    for (let i = 1; i <= text.length; i += 1) {
      state = typeIntoContact(state, text.slice(0, i));
    }
    return state;
  }

  it("never eats the space between two name words", () => {
    // "Ram " must not collapse to "Ram", or the next word is glued on.
    expect(typeIntoContact({ name: "", phone: "" }, "Ram ")).toEqual({ name: "Ram ", phone: "" });
    const state = typeCharacters("Ram Bahadur");
    expect(state).toEqual({ name: "Ram Bahadur", phone: "" });
  });

  it("keeps a half-typed number in the name box until it is finished", () => {
    // 4 digits is below MIN_PHONE_DIGITS and the run is still growing: moving it
    // now would strand the rest of the number in the name box.
    const mid = typeCharacters("Ram 9818");
    expect(mid).toEqual({ name: "Ram 9818", phone: "" });
    // Even once it is long enough, a number that still ENDS the string stays put.
    const longer = typeCharacters("Ram 98187555");
    expect(longer.name).toBe("Ram 98187555");
    expect(longer.phone).toBe("98187555");
  });

  it("moves a finished number out and keeps the name's trailing space", () => {
    const done = typeCharacters("Ram Bahadur 9818755517 ");
    expect(done).toEqual({ name: "Ram Bahadur ", phone: "9818755517" });
  });

  it("reaches the same split as a paste, once the number is followed by a space", () => {
    const typed = typeCharacters("Ram Bahadur 9818755517 ");
    const pasted = splitContactName("Ram Bahadur 9818755517");
    expect(typed.name.trim()).toBe(pasted.name);
    expect(typed.phone).toBe(pasted.phone);
  });

  it("lets the user go on typing digits after the number moved", () => {
    // After "Ram 9818755517 " the number is out and the name box holds "Ram ".
    // Typing a second full contact into that box must replace the phone.
    let state = typeCharacters("Ram 9818755517 ");
    state = typeCharacters("Ram 9841234567 ", state);
    expect(state.phone).toBe("9841234567");
    expect(state.name.trim()).toBe("Ram");
  });

  it("leaves a hand-typed phone alone while a plain name is typed", () => {
    const state = typeCharacters("Annapurna Infra", { name: "", phone: "9800000000" });
    expect(state).toEqual({ name: "Annapurna Infra", phone: "9800000000" });
  });

  it("does not treat a growing short number as a phone", () => {
    expect(typeCharacters("Tower 5")).toEqual({ name: "Tower 5", phone: "" });
  });
});
