// ── MobilePopover — an inline panel anchored to the button that opened it ─────
//
// On a phone, a centred modal for a two-tap decision ("where is this stock
// coming from?", "confirm the delivery point") puts the answer somewhere other
// than the question: the dialog covers the button you just pressed, and on a
// short viewport its footer buttons can sit below the fold, so the driver has to
// scroll a dialog to press Confirm.
//
// This panel is positioned from the anchor's own bounding box, so it opens
// directly under the tapped button and its footer buttons stay on screen. The
// calculation is deliberately conservative:
//
//   * it prefers to open BELOW the anchor; if there is not enough room below and
//     more above, it flips and is anchored by its bottom edge instead;
//   * its height is capped at the space actually available, and the footer is
//     OUTSIDE the scrolling region — so Confirm/Cancel are always reachable even
//     if the body has to scroll on a tiny screen;
//   * its horizontal position is clamped into the viewport, so an anchor near the
//     right edge cannot push the panel off screen.
//
// It re-measures on scroll and resize, because the page can move under an open
// panel (a poll re-render, the on-screen keyboard changing the visual viewport).
//
// Desktop never renders this component at all — the pages pass `mobile` only when
// `useIsMobile()` is true, so the dialog path stays byte-for-byte what it was.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const GAP = 10; // between the button and the panel
const MARGIN = 8; // from the viewport edge
const MIN_BELOW = 260; // below this much room, flipping upwards is worth it
const MAX_WIDTH = 380;
const CHROME = 118; // title bar + footer, which never scroll

interface Placement {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  /** Height available to the panel, chrome included. */
  maxHeight: number;
  /** Horizontal centre of the anchor, for the caret. */
  caret: number;
  below: boolean;
}

export function MobilePopover({
  open,
  anchorRef,
  onClose,
  title,
  children,
  footer,
  labelledBy,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    // `clientWidth`, not `innerWidth`: the latter INCLUDES the classic scrollbar, so
    // a panel sized from it overhangs the real layout width by ~15px and makes the
    // page scroll sideways on a phone. Caught by measuring the rendered panel.
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;

    const width = Math.min(MAX_WIDTH, vw - MARGIN * 2);
    const centre = r.left + r.width / 2;
    const left = Math.min(Math.max(centre - width / 2, MARGIN), vw - width - MARGIN);
    const caret = Math.min(Math.max(centre - left, 20), width - 20);

    const roomBelow = vh - r.bottom - GAP - MARGIN;
    const roomAbove = r.top - GAP - MARGIN;
    const below = roomBelow >= MIN_BELOW || roomBelow >= roomAbove;

    setPlacement(
      below
        ? { top: r.bottom + GAP, left, width, caret, maxHeight: Math.max(roomBelow, 180), below: true }
        : { bottom: vh - r.top + GAP, left, width, caret, maxHeight: Math.max(roomAbove, 180), below: false },
    );
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    measure();
    const onScrollOrResize = () => measure();
    window.addEventListener("resize", onScrollOrResize);
    // `true` = capture, so a scroll in any ancestor container is caught too.
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, measure]);

  // Escape closes it, and focus moves into the panel so the keyboard does not
  // stay on the button behind the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  // First paint before the measure lands: render nothing rather than a panel in
  // the top-left corner for one frame.
  if (!placement) {
    return (
      <div className="fixed inset-0 z-40" style={{ background: "rgba(0,0,0,0.18)" }} onClick={onClose} aria-hidden />
    );
  }

  const bodyMax = Math.max(140, placement.maxHeight - CHROME);

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.18)" }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden rounded-xl border bg-card shadow-2xl outline-none",
          "animate-in fade-in-0 zoom-in-95",
        )}
        style={{
          top: placement.top,
          bottom: placement.bottom,
          left: placement.left,
          width: placement.width,
          maxHeight: placement.maxHeight,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Caret: points at the button, so the panel is visibly attached to it. */}
        <span
          aria-hidden
          className="absolute h-2.5 w-2.5 rotate-45 border bg-card"
          style={
            placement.below
              ? { top: -5, left: placement.caret, borderRightWidth: 0, borderBottomWidth: 0 }
              : { bottom: -5, left: placement.caret, borderLeftWidth: 0, borderTopWidth: 0 }
          }
        />

        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
          <h2 id={labelledBy} className="text-sm font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3" style={{ maxHeight: bodyMax }}>
          <div className="space-y-3">{children}</div>
        </div>

        {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-2.5">{footer}</div>}
      </div>
    </>
  );
}
