// ── Is this a phone? ──────────────────────────────────────────────────────────
//
// A hook, not a CSS class, because the mobile enhancements on the order screen
// change WHERE a panel lives in the DOM (an inline popover anchored to the
// button vs. a centred modal), not just how it looks. Two different trees cannot
// be expressed with `hidden md:block`, and rendering both would mount two copies
// of a form with two Geolocation requests.
//
// The breakpoint is deliberately the same `md` boundary Tailwind uses (768px), so
// a phone gets the inline popover and anything at tablet width or above keeps
// exactly the dialog it has today. 390×844 → true; 1440 → false.
//
// SSR-safe: `matchMedia` is guarded, and the initial read happens in a lazy
// initialiser so the very first render already knows the answer (no flash of the
// wrong wrapper). A `resize`/orientation change re-evaluates, so rotating a phone
// or dragging a desktop window across the breakpoint switches cleanly.

import { useEffect, useState } from "react";

export const MOBILE_QUERY = "(max-width: 767px)";

function matches(query: string): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") {
    // Very old browsers: fall back to the width, which is what the query means.
    return window.innerWidth <= 767;
  }
  return window.matchMedia(query).matches;
}

export function useIsMobile(query: string = MOBILE_QUERY): boolean {
  const [isMobile, setIsMobile] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") {
      const onResize = () => setIsMobile(window.innerWidth <= 767);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return isMobile;
}
