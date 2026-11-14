import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Boxes, CalendarRange, Printer, Undo2 } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import {
  Badge,
  PageHeader,
  Spinner,
  StatCard,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  ErrorNote,
} from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatQty } from "@shared/rental";
import { buildMovementReport, type LedgerMovement } from "@shared/stock-ledger";
import { adIsoToBs, bsLong } from "@shared/bs-calendar";
import { BsDateRangeFilter, bsRangePrintLabel } from "@/components/BsDateRangeFilter";
import type { BsRange } from "@shared/bs-range";

/**
 * Stock movement report for ONE item — the page behind the Stock report's
 * clickable Closing Stock figure.
 *
 * Owner only: the route is behind `level="owner"` in App.tsx and the
 * `equipment.movementReport` procedure rejects a driver with a 403, so a driver
 * cannot reach this by URL or by calling the API.
 *
 * Date range: the server sends the item's FULL movement history and the range is
 * applied here by the shared, unit-tested `buildMovementReport`. That keeps
 * switching range instant, and — the part that matters — it rolls everything
 * before the range into the opening balance, so the running balance and the
 * closing figure stay true instead of restarting from zero.
 *
 * The filter is Bikram Sambat (शुरु मिति / अन्तिम मिति). The server resolves it to
 * an inclusive AD range and returns it, so the comparison is against the stored
 * `date_ad` while every date SHOWN is BS with the AD date beside it.
 */

function bsWithAd(ad: string): string {
  try {
    return bsLong(adIsoToBs(ad));
  } catch {
    return ad;
  }
}

export default function StockMovements() {
  const params = useParams<{ equipmentId: string }>();
  const equipmentId = params.equipmentId ?? "";
  const [, navigate] = useLocation();
  const [range, setRange] = useState<BsRange>({ startDateBS: null, endDateBS: null });

  const report = trpc.equipment.movementReport.useQuery(
    { equipmentId, startDateBS: range.startDateBS, endDateBS: range.endDateBS },
    { enabled: !!equipmentId },
  );

  // The server resolves the BS range to an inclusive AD range and returns it, so
  // the page filters on exactly what the API says it is showing. It returns
  // `null` when no filter was supplied — meaning the FULL history, which is what
  // makes this page's totals equal the Stock report's.
  const fromAd = report.data?.range?.fromAd ?? "";
  const toAd = report.data?.range?.toAd ?? "";

  const all: LedgerMovement[] = useMemo(
    () => (report.data?.movements ?? []) as LedgerMovement[],
    [report.data],
  );

  // The report is computed on every range change; it is a few hundred rows at
  // most (one item's whole life), so this is cheap and always in sync.
  const computed = useMemo(() => {
    if (!report.data) return null;
    return buildMovementReport({
      openingBase: report.data.equipment.totalQty,
      closingOnHand: report.data.equipment.closingOnHand,
      movements: all,
      fromAd: fromAd || null,
      toAd: toAd || null,
    });
  }, [report.data, all, fromAd, toAd]);

  const equipment = report.data?.equipment;

  // A range is OPT-IN. With no filter the page shows the item's whole life, so
  // its totals are the all-time figures the Stock report shows and the two
  // pages agree by construction. Only a supplied filter narrows them.
  const rangeActive = !!(range.startDateBS || range.endDateBS);
  const rangeLabel = rangeActive ? bsRangePrintLabel(range) : "All time (no date filter)";

  if (report.isLoading) {
    return (
      <AppLayout>
        <Spinner />
      </AppLayout>
    );
  }

  if (report.error) {
    return (
      <AppLayout>
        <PageHeader title="Stock movements" />
        <ErrorNote>{report.error.message}</ErrorNote>
      </AppLayout>
    );
  }

  if (!equipment || !computed) return null;

  return (
    <AppLayout>
      <div className="space-y-5">
        <div className="no-print">
          <button
            onClick={() => navigate("/stock")}
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Stock
          </button>
          <PageHeader
            title={`${equipment.name} — stock movements`}
            subtitle={
              <>
                Every delivery out and every return in, in order, with the balance after each.
                {equipment.code && <span className="ml-1 text-muted-foreground">Code {equipment.code}</span>}
              </>
            }
            actions={
              <Button variant="outline" onClick={() => window.print()}>
                <Printer className="h-4 w-4" /> Print
              </Button>
            }
          />
        </div>

        {/* Print-only heading: window.print() drops the app chrome, so the sheet
            needs to identify itself AND the period it covers. */}
        <div className="hidden print:block">
          <h1 className="text-xl font-bold">{equipment.name} — stock movement report</h1>
          <p className="text-sm">Reporting period: {rangeLabel}</p>
        </div>

        {/* ── range filter (Bikram Sambat) ── */}
        <Card className="no-print">
          <CardContent className="space-y-3 pt-4">
            <BsDateRangeFilter value={range} onChange={setRange} emptyMeansAllTime />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarRange className="h-3.5 w-3.5" />
              {rangeActive ? (
                <>
                  Showing {computed.rows.length} of {computed.movementCount} movements. Opening
                  balance already includes everything before {fromAd ? bsWithAd(fromAd) : "the range"},
                  so the closing balance below is the true stock on hand.
                </>
              ) : (
                <>
                  Showing all {computed.movementCount} movements — the item&apos;s full history, so
                  these totals are the same all-time figures the Stock report shows.
                </>
              )}
            </p>
          </CardContent>
        </Card>

        {/* ── summary ── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Opening balance"
            value={formatQty(computed.opening)}
            hint={rangeActive ? "Stock on hand at range start" : "Stock the item started with"}
            icon={<Boxes className="h-4 w-4" />}
            tone="muted"
          />
          <StatCard
            label={rangeActive ? "Total in (range)" : "Total in"}
            value={formatQty(computed.totalIn)}
            hint="Returned to the yard"
            icon={<ArrowDownToLine className="h-4 w-4" />}
            tone="success"
          />
          <StatCard
            label={rangeActive ? "Total out (range)" : "Total out"}
            value={formatQty(computed.totalOut)}
            hint="Delivered on rent"
            icon={<ArrowUpFromLine className="h-4 w-4" />}
            tone="warning"
          />
          <StatCard
            label="Closing balance"
            value={formatQty(computed.closing)}
            hint={`${formatQty(computed.opening)} + ${formatQty(computed.totalIn)} − ${formatQty(computed.totalOut)}`}
            icon={<Boxes className="h-4 w-4" />}
            tone="default"
          />
        </div>

        {/* A filtered view shows RANGE totals, which are legitimately smaller
            than the all-time columns on the Stock report. Say so, and show the
            all-time figures beside them, so a narrowed range is never mistaken
            for a mismatch. */}
        {rangeActive && (
          <p className="text-xs text-muted-foreground">
            These are totals for the selected range only. All time this item has{" "}
            <strong>{formatQty(computed.closingAll)}</strong> on hand — the figure the Stock report
            shows. Clear the filter to see the full history.
          </p>
        )}

        {/* The reconciliation line: proves the ledger agrees with the quantity
            used on the Stock screen, instead of silently trusting it. */}
        {computed.drift !== 0 && (
          <ErrorNote>
            The movement log does not reconcile with the stock quantity: the log says{" "}
            {formatQty(computed.closingAll)} on hand but Stock says{" "}
            {formatQty(equipment.closingOnHand)} — a difference of {formatQty(computed.drift)}.
            Everything is still shown; this is flagged rather than hidden.
          </ErrorNote>
        )}

        {/* ── the ledger ── */}
        {computed.rows.length === 0 ? (
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">
                {rangeActive
                  ? "No movements in this date range. Clear the range to see the full history."
                  : "No movements yet — one is logged each time this item is dispatched and each time it comes back."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Date (BS)</TH>
                <TH>Movement</TH>
                <TH className="text-right">In</TH>
                <TH className="text-right">Out</TH>
                <TH className="text-right">Balance</TH>
                <TH>Order</TH>
                <TH>Customer</TH>
                <TH>Driver</TH>
              </TR>
            </THead>
            <TBody>
              {/* Opening row makes the arithmetic visible even mid-range. */}
              <TR className="bg-muted/40">
                <TD className="text-xs text-muted-foreground" colSpan={4}>
                  Opening balance{rangeActive && fromAd ? ` at ${bsWithAd(fromAd)}` : ""}
                </TD>
                <TD className="text-right font-semibold tabular-nums">{formatQty(computed.opening)}</TD>
                <TD colSpan={3} />
              </TR>
              {computed.rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap">
                    <div className="font-medium">{bsWithAd(r.dateAd)}</div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">{r.dateAd} AD</div>
                  </TD>
                  <TD>
                    {r.reversalOfId ? (
                      <Badge tone="warning">
                        <Undo2 className="mr-1 inline h-3 w-3" /> Reversal
                      </Badge>
                    ) : r.type === "in" ? (
                      <Badge tone={r.autoReturn ? "info" : "success"}>
                        <ArrowDownToLine className="mr-1 inline h-3 w-3" />
                        {r.autoReturn ? "Stock received" : "Returned in"}
                      </Badge>
                    ) : (
                      <Badge tone="accent">
                        <ArrowUpFromLine className="mr-1 inline h-3 w-3" /> Dispatched out
                      </Badge>
                    )}
                    {r.reversalOfId && r.note && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{r.note}</div>
                    )}
                    {/* A transfer between customers is two movements, and each
                        names the other end, so the pair reads as one story:
                          in  → "Stock received from Annapurna Infra"
                          out → "Sent to Sita Construction"            */}
                    {r.type === "in" && r.sourceCustomerName && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        Stock received from <span className="font-medium">{r.sourceCustomerName}</span>
                      </div>
                    )}
                    {r.type === "out" && r.customerName && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        Sent to <span className="font-medium">{r.customerName}</span>
                      </div>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {r.qtyIn > 0 ? <span className="font-medium text-emerald-700 dark:text-emerald-400">{formatQty(r.qtyIn)}</span> : "—"}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {r.qtyOut > 0 ? <span className="font-medium text-orange-600 dark:text-orange-400">{formatQty(r.qtyOut)}</span> : "—"}
                  </TD>
                  <TD className="text-right font-semibold tabular-nums">{formatQty(r.balance)}</TD>
                  <TD className="whitespace-nowrap">
                    {r.orderNo ? (
                      <span className="text-xs font-medium tabular-nums">{r.orderNo}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">order deleted</span>
                    )}
                    {r.invoiceNo && (
                      <div className="text-[11px] text-muted-foreground tabular-nums">{r.invoiceNo}</div>
                    )}
                  </TD>
                  <TD className="text-muted-foreground">{r.customerName ?? "—"}</TD>
                  <TD>
                    {r.personName ? (
                      <span className="text-sm">
                        {r.personName}
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          {r.type === "in" ? "· returned it" : "· took it out"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TD>
                </TR>
              ))}
              <TR className="bg-muted/40">
                <TD colSpan={2} className="font-semibold">
                  Closing balance
                </TD>
                <TD className="text-right font-semibold tabular-nums">{formatQty(computed.totalIn)}</TD>
                <TD className="text-right font-semibold tabular-nums">{formatQty(computed.totalOut)}</TD>
                <TD className="text-right text-base font-bold tabular-nums">{formatQty(computed.closing)}</TD>
                <TD colSpan={3} />
              </TR>
            </TBody>
          </Table>
        )}

        <p className="no-print text-xs text-muted-foreground">
          Closing balance is also shown as <strong>Available</strong> on the Stock screen ({formatQty(equipment.closingOnHand)} now).
          {computed.drift === 0 && " The movement log reconciles with it exactly."}
        </p>
      </div>
    </AppLayout>
  );
}
