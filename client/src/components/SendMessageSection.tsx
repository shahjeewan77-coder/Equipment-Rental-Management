import { useMemo, useState } from "react";
import {
  Send,
  Truck,
  MessageSquarePlus,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Users,
  Info,
  Loader2,
} from "lucide-react";
import { trpc } from "@/_core/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, Spinner, ErrorNote, EmptyState } from "@/components/ui/primitives";
import { MAX_CUSTOM_MESSAGE_LENGTH, type MessageMode } from "@shared/sms";

/**
 * "Send Message" — the owner's two ways to reach customers.
 *
 * The two modes are mutually exclusive, and the radio group is the whole
 * interface: pick one, and the panel below it changes to match.
 *
 *   Option 1 — Message on delivery. A switch. When it is ON, the customer is
 *   texted automatically the moment the driver clicks Dispatch, using the number
 *   from that customer's own details. Nothing to type, nothing to pick.
 *
 *   Option 2 — Custom message. A composer plus a tick-list of every customer,
 *   with a Select-all box. The owner types the words and chooses who gets them.
 *
 * The recipient list is rendered from ONE server read (`sms.messageOptions`),
 * which already carries each customer's normalised number and whether it is
 * dialable — so a customer who could not receive a message is visibly disabled
 * rather than silently skipped after the fact.
 */
export function SendMessageSection() {
  const utils = trpc.useUtils();
  const options = trpc.sms.messageOptions.useQuery();

  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{
    sent: number;
    failed: number;
    skipped: number;
    requested: number;
    note?: string;
    recipients: Array<{ customerId: string; customerName: string; to: string | null; status: string; error?: string }>;
  } | null>(null);

  const setMode = trpc.sms.setMessageMode.useMutation({
    onSuccess: () => {
      void utils.sms.messageOptions.invalidate();
      void utils.sms.status.invalidate();
    },
  });

  const sendCustom = trpc.sms.sendCustom.useMutation({
    onSuccess: (res) => {
      setResult(res);
      void utils.sms.log.invalidate();
      void utils.sms.status.invalidate();
    },
    onError: (e) => {
      setResult({
        sent: 0,
        failed: 0,
        skipped: 0,
        requested: 0,
        note: e.message,
        recipients: [],
      });
    },
  });

  const mode: MessageMode = options.data?.mode ?? "off";
  const customers = options.data?.customers ?? [];
  const dialable = useMemo(() => customers.filter((c) => c.dialable), [customers]);
  const allSelected = dialable.length > 0 && dialable.every((c) => selected.has(c.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (dialable.length > 0 && dialable.every((c) => prev.has(c.id))) return new Set();
      return new Set(dialable.map((c) => c.id));
    });
  }

  const canSend = message.trim().length > 0 && selected.size > 0 && !sendCustom.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquarePlus className="h-4 w-4" /> Send Message
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {options.isLoading ? (
          <Spinner />
        ) : options.error ? (
          <ErrorNote>{options.error.message}</ErrorNote>
        ) : (
          <>
            {/* ── the mode chooser ─────────────────────────────────────────── */}
            <div className="space-y-2">
              <ModeOption
                active={mode === "delivery"}
                onSelect={() => setMode.mutate({ mode: "delivery" })}
                disabled={setMode.isPending}
                icon={<Truck className="h-4 w-4" />}
                title="Option 1 — Message on delivery"
                description="When this is ON, the customer is texted automatically right after the driver clicks Dispatch. The number is taken from that customer's details."
                badge={mode === "delivery" ? <Badge tone="success">ON</Badge> : <Badge tone="muted">OFF</Badge>}
              />
              <ModeOption
                active={mode === "custom"}
                onSelect={() => setMode.mutate({ mode: "custom" })}
                disabled={setMode.isPending}
                icon={<MessageSquarePlus className="h-4 w-4" />}
                title="Option 2 — Custom message to all customers once"
                description="Type a message and tick the customers who should receive it. Nothing is sent automatically in this mode."
                badge={mode === "custom" ? <Badge tone="info">SELECTED</Badge> : <Badge tone="muted">OFF</Badge>}
              />
              {mode !== "off" && (
                <button
                  type="button"
                  onClick={() => setMode.mutate({ mode: "off" })}
                  disabled={setMode.isPending}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Turn both options off
                </button>
              )}
            </div>

            {/* ── Option 1 panel ───────────────────────────────────────────── */}
            {mode === "delivery" && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-500/30 dark:bg-emerald-500/10">
                <p className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    <strong>Message on delivery is ON.</strong> Every dispatch will text the customer automatically,
                    using the contact number saved in their details. A customer with no dialable number is recorded as{" "}
                    <strong>skipped</strong> in the log and never blocks the dispatch.
                  </span>
                </p>
              </div>
            )}

            {/* ── Option 2 panel ───────────────────────────────────────────── */}
            {mode === "custom" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="custom-message" className="text-sm font-medium">
                    Your message
                  </label>
                  <textarea
                    id="custom-message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value.slice(0, MAX_CUSTOM_MESSAGE_LENGTH))}
                    rows={4}
                    placeholder="Type the message to send to the selected customers…"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <p className="text-xs text-muted-foreground">
                    {message.length}/{MAX_CUSTOM_MESSAGE_LENGTH} characters · sent exactly as typed
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Users className="h-4 w-4" /> Recipients
                      <span className="text-xs font-normal text-muted-foreground">
                        {selected.size} of {dialable.length} selected
                      </span>
                    </p>
                    {customers.length > 0 && (
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          className="h-4 w-4 rounded border-input accent-primary"
                        />
                        <span className="font-medium">Select all</span>
                      </label>
                    )}
                  </div>

                  {customers.length === 0 ? (
                    <EmptyState
                      title="No customers yet"
                      description="Add customers with a phone number and they will appear here to pick from."
                    />
                  ) : (
                    <div className="max-h-72 overflow-y-auto rounded-lg border">
                      {customers.map((c) => (
                        <label
                          key={c.id}
                          className={
                            "flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 " +
                            (c.dialable ? "hover:bg-muted/50" : "cursor-not-allowed opacity-60")
                          }
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(c.id)}
                            disabled={!c.dialable}
                            onChange={() => toggle(c.id)}
                            className="h-4 w-4 rounded border-input accent-primary"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{c.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {c.dialable ? c.normalised : c.phone ? `${c.phone} — not dialable` : "No phone number"}
                            </span>
                          </span>
                          {!c.dialable && <Badge tone="warning">skip</Badge>}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => sendCustom.mutate({ customerIds: Array.from(selected), message })} disabled={!canSend}>
                    {sendCustom.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {sendCustom.isPending ? "Sending…" : `Send to ${selected.size} customer${selected.size === 1 ? "" : "s"}`}
                  </Button>
                  {selected.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Clear selection
                    </button>
                  )}
                </div>

                {result && <SendResult result={result} />}
              </div>
            )}

            {mode === "off" && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Neither option is selected, so nothing extra is sent. The rental status messages (approved, on the way,
                delivered, returned) and the festive greeting still go out as before.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ModeOption({
  active,
  onSelect,
  disabled,
  icon,
  title,
  description,
  badge,
}: {
  active: boolean;
  onSelect: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  badge: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-60 " +
        (active ? "border-primary bg-primary/5" : "border-input hover:bg-muted/50")
      }
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {badge}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function SendResult({
  result,
}: {
  result: {
    sent: number;
    failed: number;
    skipped: number;
    requested: number;
    note?: string;
    recipients: Array<{ customerId: string; customerName: string; to: string | null; status: string; error?: string }>;
  };
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Result</span>
        <Badge tone="success">
          <CheckCircle2 className="h-3 w-3" /> {result.sent} sent
        </Badge>
        <Badge tone="danger">
          <XCircle className="h-3 w-3" /> {result.failed} failed
        </Badge>
        <Badge tone="warning">
          <AlertTriangle className="h-3 w-3" /> {result.skipped} skipped
        </Badge>
        <span className="text-xs text-muted-foreground">of {result.requested} selected</span>
      </div>
      {result.note && <p className="text-xs text-muted-foreground">{result.note}</p>}
      {result.recipients.length > 0 && (
        <div className="max-h-56 overflow-y-auto rounded border">
          {result.recipients.map((r) => (
            <div key={r.customerId} className="flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0">
              <Badge tone={r.status === "sent" ? "success" : r.status === "skipped" ? "warning" : "danger"}>
                {r.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-medium">{r.customerName}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{r.to ?? "—"}</span>
              {r.error && <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">{r.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
