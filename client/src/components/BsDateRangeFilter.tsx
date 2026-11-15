// ── Bikram Sambat date-range filter ───────────────────────────────────────────
//
// The one control every report uses. It edits a BS range (शुरु मिति / अन्तिम
// मिति) and hands the caller the BS strings, which the server resolves to an
// inclusive AD range with `resolveBsRange`.
//
// Why three selects per side rather than a calendar popover: a BS month has 29
// to 32 days depending on the year, so a free-typed day can be invalid. Picking
// year → month → day from lists generated from the real BS calendar makes an
// impossible date unrepresentable, which is worth more on a report filter than
// the extra click.
//
// The AD equivalent of each end is shown underneath, because the stored data is
// Gregorian and an operator reconciling a report needs to see both.

import { useMemo } from "react";
import { CalendarRange, X } from "lucide-react";
import {
  BS_MAX_YEAR,
  BS_MIN_YEAR,
  BS_MONTHS_EN,
  BS_MONTHS_NP,
  daysInBsMonth,
  kathmanduToday,
  parseBsIso,
  type BsDate,
} from "@shared/bs-calendar";
import { adIsoToBsIso, bsToAdIso, resolveBsRange, type BsRange } from "@shared/bs-range";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

function toIso(bs: BsDate): string {
  return `${bs.year}-${pad(bs.month)}-${pad(bs.day)}`;
}

/** Clamp a BS date to a real day in its month (e.g. day 31 in a 30-day month). */
function clampBs(bs: BsDate): BsDate {
  const max = daysInBsMonth(bs.year, bs.month);
  return { ...bs, day: Math.min(bs.day, max) };
}

function BsDateInput({
  label,
  nepaliLabel,
  value,
  onChange,
  testId,
}: {
  label: string;
  nepaliLabel: string;
  value: string | null;
  onChange: (iso: string | null) => void;
  testId: string;
}) {
  const today = kathmanduToday();
  const bs = value ? parseBsIso(value) : null;
  const maxDay = bs ? daysInBsMonth(bs.year, bs.month) : 32;

  function set(part: "year" | "month" | "day", raw: number) {
    const base: BsDate = bs ?? today.bs;
    onChange(toIso(clampBs({ ...base, [part]: raw })));
  }

  return (
    <div className="space-y-1" data-testid={testId}>
      <label className="flex items-baseline gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        <span className="font-normal normal-case text-muted-foreground/70">{nepaliLabel}</span>
      </label>
      <div className="flex items-center gap-1">
        <select
          aria-label={`${label} year`}
          value={bs?.year ?? ""}
          onChange={(e) => set("year", Number(e.target.value))}
          className="h-9 rounded-md border border-input bg-background px-1.5 text-sm tabular-nums"
        >
          <option value="" disabled>
            YYYY
          </option>
          {Array.from({ length: BS_MAX_YEAR - BS_MIN_YEAR + 1 }, (_, i) => BS_MIN_YEAR + i).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label} month`}
          value={bs?.month ?? ""}
          onChange={(e) => set("month", Number(e.target.value))}
          className="h-9 rounded-md border border-input bg-background px-1.5 text-sm"
        >
          <option value="" disabled>
            Month
          </option>
          {BS_MONTHS_EN.map((m, i) => (
            <option key={m} value={i + 1}>
              {m} ({BS_MONTHS_NP[i]})
            </option>
          ))}
        </select>
        <select
          aria-label={`${label} day`}
          value={bs?.day ?? ""}
          onChange={(e) => set("day", Number(e.target.value))}
          className="h-9 rounded-md border border-input bg-background px-1.5 text-sm tabular-nums"
        >
          <option value="" disabled>
            DD
          </option>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        {value && (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => onChange(null)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {value ? `${bsToAdIso(value)} AD` : "not set"}
      </p>
    </div>
  );
}

export function BsDateRangeFilter({
  value,
  onChange,
  className,
  showPresets = true,
  emptyMeansAllTime = false,
}: {
  value: BsRange;
  onChange: (next: BsRange) => void;
  className?: string;
  showPresets?: boolean;
  /**
   * When true, an empty filter means "the whole history" rather than "this BS
   * month". The stock movement log uses this: its totals must equal the Stock
   * report's all-time columns, so it cannot default to a month. The summary line
   * then says so instead of claiming a default range that is not being applied.
   */
  emptyMeansAllTime?: boolean;
}) {
  const today = kathmanduToday();
  const resolved = useMemo(() => resolveBsRange(value, today), [value, today]);

  function preset(kind: "today" | "month" | "lastMonth" | "year") {
    const t = today.bs;
    if (kind === "today") {
      onChange({ startDateBS: today.bsIso, endDateBS: today.bsIso });
      return;
    }
    if (kind === "month") {
      onChange({ startDateBS: `${t.year}-${pad(t.month)}-01`, endDateBS: today.bsIso });
      return;
    }
    if (kind === "lastMonth") {
      const y = t.month === 1 ? t.year - 1 : t.year;
      const m = t.month === 1 ? 12 : t.month - 1;
      const last = daysInBsMonth(y, m);
      onChange({ startDateBS: `${y}-${pad(m)}-01`, endDateBS: `${y}-${pad(m)}-${pad(last)}` });
      return;
    }
    onChange({ startDateBS: `${t.year}-01-01`, endDateBS: today.bsIso });
  }

  const active = !!(value.startDateBS || value.endDateBS);

  return (
    <div className={cn("space-y-2", className)} data-testid="bs-range-filter">
      <div className="flex flex-wrap items-end gap-3">
        <BsDateInput
          label="From date"
          nepaliLabel="शुरु मिति"
          value={value.startDateBS}
          onChange={(iso) => onChange({ ...value, startDateBS: iso })}
          testId="bs-range-from"
        />
        <BsDateInput
          label="To date"
          nepaliLabel="अन्तिम मिति"
          value={value.endDateBS}
          onChange={(iso) => onChange({ ...value, endDateBS: iso })}
          testId="bs-range-to"
        />
        {showPresets && (
          <div className="flex flex-wrap items-center gap-1.5 pb-[1px]">
            <Button variant="outline" size="sm" onClick={() => preset("today")}>
              Today
            </Button>
            <Button variant="outline" size="sm" onClick={() => preset("month")}>
              This month
            </Button>
            <Button variant="outline" size="sm" onClick={() => preset("lastMonth")}>
              Last month
            </Button>
            <Button variant="outline" size="sm" onClick={() => preset("year")}>
              This year
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!active}
              onClick={() => onChange({ startDateBS: null, endDateBS: null })}
            >
              <X className="h-4 w-4" /> Clear
            </Button>
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="bs-range-summary">
        <CalendarRange className="h-3.5 w-3.5" />
        {emptyMeansAllTime && !active ? (
          <>No date filter — showing the full history.</>
        ) : (
          <>
            Showing <span className="font-medium text-foreground">{resolved.fromAd}</span> to{" "}
            <span className="font-medium text-foreground">{resolved.toAd}</span> AD
            {resolved.isDefault && !emptyMeansAllTime && " — this BS month by default"}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The range as one line for a print/PDF header, e.g.
 * "2083-07-01 to 2083-07-14 BS (2026-10-18 to 2026-10-31 AD)".
 */
export function bsRangePrintLabel(value: BsRange): string {
  const r = resolveBsRange(value);
  const f = parseBsIso(adIsoToBsIso(r.fromAd));
  const t = parseBsIso(adIsoToBsIso(r.toAd));
  return `${f.year}-${pad(f.month)}-${pad(f.day)} to ${t.year}-${pad(t.month)}-${pad(t.day)} BS (${r.fromAd} to ${r.toAd} AD)`;
}
