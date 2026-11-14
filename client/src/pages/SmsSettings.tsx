import { useState } from "react";
import { MessageSquare, Send, CheckCircle2, XCircle, AlertTriangle, Info, PartyPopper } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Badge, Table, THead, TBody, TR, TH, TD, Spinner, EmptyState, ErrorNote } from "@/components/ui/primitives";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { SMS_EVENT_LABELS, FESTIVE_GREETING, type SmsEvent } from "@shared/sms";
import { SendMessageSection } from "@/components/SendMessageSection";

/**
 * SMS notifications — the owner's window into the SMS Pasal integration.
 *
 * Four things, in the order the owner needs them:
 *
 *   1. Is it configured? If not, exactly which variables are missing, so the
 *      answer is "add SMS_PASAL_API_KEY" rather than "something is wrong".
 *   2. Send Message — the two sending options: automatic on delivery, or a
 *      custom message to hand-picked customers.
 *   3. Prove it works — a test send to a number the owner types. This is the
 *      SAFE path: it never reads a customer's number, so the owner can verify
 *      the credentials without texting a real customer. The owner can send
 *      either the plain test message or the exact festive greeting.
 *   4. The log of every attempt, sent or not. A skipped send is as important to
 *      see as a failed one: "this customer has no phone" is a data problem the
 *      owner can fix, and it is invisible if only successes are recorded.
 *
 * Owner-only. The log names customers and their phone numbers.
 */
export default function SmsSettings() {
  const utils = trpc.useUtils();
  const status = trpc.sms.status.useQuery();
  const log = trpc.sms.log.useQuery({ limit: 100 });
  const [to, setTo] = useState("");
  const [kind, setKind] = useState<"test" | "festive">("test");
  const [result, setResult] = useState<{ status: string; to: string | null; error?: string; body: string } | null>(null);

  const test = trpc.sms.test.useMutation({
    onSuccess: (res) => {
      setResult(res);
      void utils.sms.status.invalidate();
      void utils.sms.log.invalidate();
    },
    onError: (e) => setResult({ status: "failed", to: null, error: e.message, body: "" }),
  });

  const configured = status.data?.configured ?? false;
  const missing = status.data?.missing ?? [];
  const summary = status.data?.summary;

  return (
    <AppLayout>
      <PageHeader
        title="SMS notifications"
        subtitle={
          <>
            Customers are texted automatically when their rental changes state.{" "}
            <MessageSquare className="inline h-3.5 w-3.5" />
          </>
        }
      />

      {/* ── 1. Configuration status ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            SMS Pasal status
            {status.isLoading ? (
              <Spinner />
            ) : configured ? (
              <Badge tone="success">
                <CheckCircle2 className="h-3 w-3" /> Configured
              </Badge>
            ) : (
              <Badge tone="warning">
                <AlertTriangle className="h-3 w-3" /> Not configured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {configured ? (
            <p className="text-sm text-muted-foreground">
              SMS Pasal is configured. Status changes will text the customer automatically, and the festive greeting
              rides along with each one.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                SMS is <strong>off</strong>. The app works normally — orders, stock and invoices are unaffected — but
                no customer is texted. Add these under{" "}
                <strong>Settings → Environment variables</strong> to switch it on:
              </p>
              <ul className="space-y-1">
                {missing.map((m) => (
                  <li key={m} className="flex items-center gap-2 text-sm">
                    <XCircle className="h-3.5 w-3.5 text-rose-500" />
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">{m}</code>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                <code>SMS_PASAL_API_KEY</code> is the <code>X-API-Key</code> value from SMS Pasal.{" "}
                <code>SMS_PASAL_ENDPOINT</code> is optional and defaults to{" "}
                <code>https://api.smspasal.com/api/v1/sms/send</code>.
              </p>
            </div>
          )}

          {summary && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Sent" value={summary.sent} tone="text-emerald-600 dark:text-emerald-400" />
              <Stat label="Failed" value={summary.failed} tone="text-rose-600 dark:text-rose-400" />
              <Stat label="Skipped" value={summary.skipped} tone="text-amber-600 dark:text-amber-400" />
              <Stat label="Total attempts" value={summary.total} tone="text-foreground" />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 2. Send Message options ─────────────────────────────────────── */}
      <SendMessageSection />

      {/* ── 3. Test send ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Send a test message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Sends one message to a number <strong>you</strong> type — never to a customer. Use your own phone to prove
            the credentials work.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="9804632537 or +9779804632537"
              className="h-9 w-64 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex overflow-hidden rounded-md border border-input">
              <button
                type="button"
                onClick={() => setKind("test")}
                className={
                  "px-3 py-1.5 text-sm " +
                  (kind === "test" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")
                }
              >
                Test message
              </button>
              <button
                type="button"
                onClick={() => setKind("festive")}
                className={
                  "px-3 py-1.5 text-sm " +
                  (kind === "festive" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground")
                }
              >
                Festive greeting
              </button>
            </div>
            <Button onClick={() => test.mutate({ to, kind })} disabled={!to.trim() || test.isPending}>
              <Send className="h-4 w-4" />
              {test.isPending ? "Sending…" : "Send test SMS"}
            </Button>
          </div>

          {result && (
            <div
              className={
                "rounded-lg border p-3 text-sm " +
                (result.status === "sent"
                  ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10"
                  : result.status === "skipped"
                    ? "border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10"
                    : "border-rose-200 bg-rose-50 dark:border-rose-500/30 dark:bg-rose-500/10")
              }
            >
              <p className="font-semibold">
                {result.status === "sent"
                  ? `Sent to ${result.to}`
                  : result.status === "skipped"
                    ? "Skipped — nothing was sent"
                    : "Failed"}
              </p>
              {result.error && <p className="mt-1 text-xs text-muted-foreground">{result.error}</p>}
              {result.body && (
                <p className="mt-2 whitespace-pre-line rounded bg-background/60 p-2 font-mono text-xs">{result.body}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 4. The festive greeting template ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PartyPopper className="h-4 w-4" /> Festive greeting
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This exact message is sent to the customer alongside every rental notification (approved, dispatched,
            delivered, returned).
          </p>
          <pre className="whitespace-pre-line rounded-lg border bg-muted/40 p-3 font-mono text-sm">
            {FESTIVE_GREETING}
          </pre>
        </CardContent>
      </Card>

      {/* ── 5. What triggers a message ──────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">When a customer is texted</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            <Trigger event="approved" when="The owner approves the order" />
            <Trigger event="on_transit" when="A driver locks the order for dispatch — the truck is on its way" />
            <Trigger event="delivered" when="The driver confirms delivery — the equipment has arrived" />
            <Trigger event="delivery" when="Message on delivery is ON — sent automatically after Dispatch" />
            <Trigger event="returned" when="The equipment is picked back up" />
            <Trigger event="festive" when="Rides along with every one of the four notifications above" />
            <Trigger event="custom" when="You send a custom message to selected customers" />
          </ul>
          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            A message is only sent when the customer has a dialable number. A missing or invalid number is recorded in
            the log as <strong>skipped</strong> — it never blocks the order.
          </p>
        </CardContent>
      </Card>

      {/* ── 6. The log ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notification log</CardTitle>
        </CardHeader>
        <CardContent>
          {log.isLoading ? (
            <Spinner />
          ) : log.error ? (
            <ErrorNote>{log.error.message}</ErrorNote>
          ) : !log.data || log.data.length === 0 ? (
            <EmptyState
              title="No messages yet"
              description="Every SMS the app tries to send is recorded here — sent, failed or skipped. Change an order's status and it will appear."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Event</TH>
                    <TH>Customer</TH>
                    <TH>Order</TH>
                    <TH>Number</TH>
                    <TH>Status</TH>
                    <TH>Detail</TH>
                  </TR>
                </THead>
                <TBody>
                  {log.data.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(r.createdAt)}</TD>
                      <TD className="whitespace-nowrap text-xs font-medium">
                        {SMS_EVENT_LABELS[r.event as SmsEvent] ?? r.event}
                      </TD>
                      <TD className="text-xs">{r.customerName ?? "—"}</TD>
                      <TD className="whitespace-nowrap text-xs tabular-nums">{r.orderRef ?? "—"}</TD>
                      <TD className="whitespace-nowrap text-xs tabular-nums">{r.toNumber ?? "—"}</TD>
                      <TD>
                        <Badge
                          tone={r.status === "sent" ? "success" : r.status === "skipped" ? "warning" : "danger"}
                        >
                          {r.status}
                        </Badge>
                      </TD>
                      <TD className="max-w-xs text-xs text-muted-foreground">
                        {r.error ?? <span className="truncate">{r.body}</span>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={"text-xl font-bold tabular-nums " + tone}>{value}</p>
    </div>
  );
}

function Trigger({ event, when }: { event: SmsEvent; when: string }) {
  return (
    <li className="flex items-start gap-2">
      <Badge tone="info" className="mt-0.5 shrink-0">
        {SMS_EVENT_LABELS[event]}
      </Badge>
      <span className="text-muted-foreground">{when}</span>
    </li>
  );
}
