import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Plus, Trash2, UserPlus, ArrowLeft, Search, Check, AlertTriangle, ChevronDown } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Select, Textarea, Spinner, ErrorNote, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BASIS_LABELS, BASIS_UNIT_LABELS, RENTAL_BASES, formatMoney, type RentalBasis } from "@shared/rental";
import { todayBs } from "@/lib/format";
import { splitContactName, splitPastedContact, typeIntoContact, applyContactSplit } from "@shared/contact-split";
import { duplicateCustomerMessage, findDuplicateCustomer } from "@shared/customer-dedupe";

interface Line {
  key: string;
  equipmentId: string;
  basis: RentalBasis;
  rate: string;
  actualQty: string;
  billedQty: string;
  units: string;
}

const newLine = (): Line => ({
  key: crypto.randomUUID(),
  equipmentId: "",
  basis: "day",
  rate: "",
  actualQty: "1",
  billedQty: "1",
  units: "1",
});

export default function NewOrder() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const today = todayBs();

  const customers = trpc.customers.list.useQuery();
  const equipment = trpc.equipment.list.useQuery();
  const createOrder = trpc.orders.create.useMutation({
    onSuccess: (order) => {
      utils.orders.list.invalidate();
      utils.dashboard.summary.invalidate();
      navigate(`/orders/${order.id}`);
    },
  });

  const [customerId, setCustomerId] = useState("");
  // ── customer autocomplete ──
  // A plain <select> is unusable past a few dozen customers on a phone. This is
  // a search box: type any part of a name or phone number and matching customers
  // appear; if nothing matches, the list offers to create that customer on the
  // spot and selects it, so the order form is never abandoned mid-entry.
  const [customerQuery, setCustomerQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);
  // Which row the keyboard is on. -1 = nothing highlighted yet.
  const [activeIndex, setActiveIndex] = useState(-1);

  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", address: "" });
  // A phone peeled off a paste into the search box, held until a customer is
  // actually created — so "Ram Bahadur 9818755517" pasted here does not lose it.
  const [pastedPhone, setPastedPhone] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [error, setError] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);

  const createCustomer = trpc.customers.create.useMutation({
    onSuccess: (c) => {
      utils.customers.list.invalidate();
      selectCustomer(c.id, c.name);
      setAddingCustomer(false);
      setNewCustomer({ name: "", phone: "", address: "" });
    },
  });

  // Inline creation from the autocomplete: only a name is required, which is all
  // the order needs. Phone and address can be filled in later on the Customers
  // page — the point is not to lose the order being written.
  const quickCreate = trpc.customers.create.useMutation({
    onSuccess: (c) => {
      utils.customers.list.invalidate();
      // Select from the ROW THE SERVER RETURNED, not from the text still in the
      // box. The box is cleared as part of selecting, so reading it afterwards
      // would select the customer by a name that no longer exists on screen.
      selectCustomer(c.id, c.name);
      setPastedPhone(null);
      setActiveIndex(-1);
    },
    onError: (e) => setError(e.message),
  });

  const allCustomers = customers.data ?? [];
  const chosen = allCustomers.find((c) => c.id === customerId) ?? null;

  const matches = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return allCustomers.slice(0, 8);
    return allCustomers
      .filter(
        (c) => c.name.toLowerCase().includes(q) || (c.phone ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [allCustomers, customerQuery]);

  // Only offer creation when the typed text is a name nobody already has —
  // otherwise a typo would silently make a second "Annapurna Infra".
  const exactExists = allCustomers.some(
    (c) => c.name.trim().toLowerCase() === customerQuery.trim().toLowerCase(),
  );
  const canCreate = customerQuery.trim().length > 0 && !exactExists;

  function selectCustomer(id: string, name: string) {
    setCustomerId(id);
    setCustomerQuery(name);
    setListOpen(false);
    setActiveIndex(-1);
    // A number peeled off an earlier paste belongs to the customer that paste
    // was going to create. Once a real customer is chosen it must not be
    // carried into some later creation.
    setPastedPhone(null);
    setDuplicateId(null);
    setError(null);
  }

  /**
   * Create the customer named in the search box, then select it.
   *
   * The number comes from the paste if there was one, and otherwise is read out
   * of the text itself — so a number TYPED into the box (not pasted) still ends
   * up in the phone field instead of being lost. The name is never empty: if the
   * box holds only a number, that number is the name, which is what the operator
   * typed and the only identifier they have.
   */
  function createFromSearch() {
    const typed = customerQuery.trim();
    if (!typed || quickCreate.isPending) return;
    const split = splitContactName(typed);
    const phone = pastedPhone ?? split.phone ?? undefined;
    const name = split.name || typed;
    // Same name AND same number is the same customer. Checked here so the
    // operator is told immediately, and again on the server so a direct call
    // cannot slip a duplicate through.
    const dup = findDuplicateCustomer(allCustomers, { name, phone });
    if (dup) {
      setError(duplicateCustomerMessage(dup));
      return;
    }
    setError(null);
    quickCreate.mutate({ name, phone });
  }

  function clearCustomer() {
    setCustomerId("");
    setCustomerQuery("");
    setListOpen(true);
    setDuplicateId(null);
    setError(null);
  }

  const totals = useMemo(() => {
    let amount = 0;
    let actual = 0;
    let billed = 0;
    for (const l of lines) {
      const rate = Number(l.rate) || 0;
      const units = Number(l.units) || 0;
      const bq = Number(l.billedQty) || 0;
      amount += rate * units * bq;
      actual += Number(l.actualQty) || 0;
      billed += bq;
    }
    return { amount, actual, billed };
  }, [lines]);

  function update(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function onSubmit() {
    setError(null);
    setDuplicateId(null);
    if (!customerId && !addingCustomer) {
      setError("Choose a customer, or add a new one.");
      return;
    }
    const valid = lines.filter((l) => l.equipmentId && Number(l.rate) >= 0);
    if (valid.length === 0) {
      setError("Add at least one item with a rate.");
      return;
    }

    const items = valid.map((l) => ({
      equipmentId: l.equipmentId,
      basis: l.basis,
      rate: Number(l.rate) || 0,
      actualQty: Number(l.actualQty) || 0,
      billedQty: Number(l.billedQty) || 0,
      units: Number(l.units) || 0,
    }));

    // Check BEFORE submitting, so a duplicate shows as a clear inline message
    // rather than a red toast that looks like the app broke. The server enforces
    // the same rule regardless — this is only the friendly half.
    if (customerId) {
      try {
        const dup = await utils.orders.checkDuplicate.fetch({ customerId, items });
        if (dup.duplicate) {
          setDuplicateId(dup.orderId);
          setError(dup.message ?? "Duplicate entry: An identical order for this customer with the same items already exists.");
          return;
        }
      } catch {
        // A failed pre-check must never block the order: fall through to the
        // real submit, which re-runs the same rule on the server.
      }
    }

    try {
      await createOrder.mutateAsync({
        customerId: customerId || undefined,
        newCustomer:
          !customerId && addingCustomer
            ? { name: newCustomer.name, phone: newCustomer.phone || undefined, address: newCustomer.address || undefined }
            : undefined,
        notes: notes || undefined,
        items,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not create the order.";
      setError(message);
      if (message.includes("Duplicate entry")) setDuplicateId("server");
    }
  }

  return (
    <AppLayout>
      <PageHeader
        title="New order"
        subtitle={`${today.long} · ${today.weekday}`}
        actions={
          <Button variant="outline" onClick={() => navigate("/orders")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!addingCustomer ? (
                <div className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="pl-9 pr-9"
                        role="combobox"
                        aria-expanded={listOpen}
                        aria-autocomplete="list"
                        aria-label="Search customer by name or phone"
                        placeholder="Search customer by name or phone…"
                        value={customerQuery}
                        onFocus={() => setListOpen(true)}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCustomerQuery(v);
                          setListOpen(true);
                          // Typing over a chosen customer clears the choice, so the
                          // form can never submit the name that was typed but the id
                          // that was selected before.
                          if (customerId) setCustomerId("");
                        }}
                        onBlur={() => {
                          // Delayed so a click on a list row lands before the list closes.
                          blurTimer.current = window.setTimeout(() => setListOpen(false), 140);
                        }}
                        onKeyDown={(e) => {
                          // Keyboard selection. The rows are real buttons, so Tab
                          // works too, but a search box that ignores Enter and the
                          // arrow keys is not a combobox.
                          const rows = matches.length + (canCreate ? 1 : 0);
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setListOpen(true);
                            setActiveIndex((i) => (rows === 0 ? -1 : (i + 1) % rows));
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setListOpen(true);
                            setActiveIndex((i) => (rows === 0 ? -1 : (i - 1 + rows) % rows));
                          } else if (e.key === "Escape") {
                            setListOpen(false);
                            setActiveIndex(-1);
                          } else if (e.key === "Enter") {
                            if (!listOpen) return;
                            e.preventDefault();
                            if (activeIndex >= 0 && activeIndex < matches.length) {
                              const c = matches[activeIndex];
                              selectCustomer(c.id, c.name);
                            } else if (canCreate && (activeIndex === matches.length || activeIndex === -1)) {
                              createFromSearch();
                            }
                          }
                        }}
                        onPaste={(e) => {
                          // ONLY a paste is split here. Typing digits into a search
                          // box is someone searching by phone number, so consuming
                          // them would break the search it is meant to serve.
                          const text = e.clipboardData.getData("text");
                          const split = splitPastedContact(text, customerQuery);
                          if (!split.phone) return; // ordinary text: let the default paste land
                          e.preventDefault();
                          setCustomerQuery(split.query);
                          setListOpen(true);
                          setPastedPhone(split.phone);
                          if (split.query.toLowerCase() !== customerQuery.trim().toLowerCase()) setCustomerId("");
                        }}
                      />
                      {customerQuery && (
                        <button
                          type="button"
                          aria-label="Clear customer"
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={clearCustomer}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <Button variant="outline" onClick={() => setAddingCustomer(true)} className="shrink-0">
                      <UserPlus className="h-4 w-4" /> New customer
                    </Button>
                  </div>

                  {chosen && (
                    <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-sm">
                      <Check className="h-4 w-4 text-primary" />
                      <span className="font-medium">{chosen.name}</span>
                      {chosen.phone && <span className="text-xs text-muted-foreground">{chosen.phone}</span>}
                      <span className="ml-auto text-[11px] text-muted-foreground">Selected</span>
                    </div>
                  )}

                  {listOpen && (
                    <div
                      role="listbox"
                      className="max-h-64 overflow-y-auto rounded-lg border bg-card shadow-lg"
                      onMouseDown={() => {
                        if (blurTimer.current) window.clearTimeout(blurTimer.current);
                      }}
                    >
                      {customers.isLoading && (
                        <div className="px-3 py-3 text-sm text-muted-foreground">Loading customers…</div>
                      )}

                      {matches.map((c, idx) => (
                        <button
                          key={c.id}
                          type="button"
                          role="option"
                          aria-selected={c.id === customerId}
                          // SELECT ON MOUSEDOWN, and preventDefault so the input
                          // never blurs. The old code selected on click and relied
                          // on a 140ms timer to keep the list alive; a slow click
                          // (press, pause, release) outlived the timer, the list
                          // unmounted, and the click landed on nothing. That is
                          // exactly the "does not reliably select" report.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectCustomer(c.id, c.name);
                          }}
                          className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/60 ${
                            c.id === customerId ? "bg-primary/5" : ""
                          } ${idx === activeIndex ? "bg-muted" : ""}`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{c.name}</span>
                            {c.phone && <span className="text-[11px] text-muted-foreground">{c.phone}</span>}
                          </span>
                          {c.id === customerId && <Check className="h-4 w-4 shrink-0 text-primary" />}
                        </button>
                      ))}

                      {!customers.isLoading && matches.length === 0 && !canCreate && (
                        <div className="px-3 py-3 text-sm text-muted-foreground">
                          {customerQuery.trim()
                            ? "No customer matches that. Keep typing."
                            : "No customers yet — create the first one."}
                        </div>
                      )}

                      {/* Inline creation: the whole point is not leaving the form. */}
                      {canCreate && (
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          disabled={quickCreate.isPending}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            createFromSearch();
                          }}
                          className={`flex w-full items-center gap-2 border-t bg-emerald-50/60 px-3 py-2.5 text-left text-sm font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-60 dark:bg-emerald-950/30 dark:text-emerald-300 ${
                            activeIndex === matches.length ? "ring-2 ring-emerald-500/40" : ""
                          }`}
                        >
                          <UserPlus className="h-4 w-4 shrink-0" />
                          <span className="min-w-0">
                            {quickCreate.isPending
                              ? "Creating…"
                              : `Create new customer “${splitContactName(customerQuery.trim()).name || customerQuery.trim()}”`}
                            {(pastedPhone ?? splitContactName(customerQuery.trim()).phone) && !quickCreate.isPending && (
                              <span className="block text-[11px] font-normal text-emerald-700/80 dark:text-emerald-400/80">
                                Phone {pastedPhone ?? splitContactName(customerQuery.trim()).phone}
                              </span>
                            )}
                          </span>
                        </button>
                      )}
                    </div>
                  )}

                  {!chosen && !customerQuery && (
                    <p className="text-xs text-muted-foreground">
                      Start typing to search, or pick from the list.{" "}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                        onClick={() => setListOpen(true)}
                      >
                        <ChevronDown className="h-3 w-3" /> Show all {allCustomers.length}
                      </button>
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Add a new customer</p>
                    <Button variant="ghost" size="sm" onClick={() => setAddingCustomer(false)}>
                      Cancel
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Name *</Label>
                      <Input
                        value={newCustomer.name}
                        onChange={(e) => {
                          const typed = e.target.value;
                          setNewCustomer((c) => ({ ...c, ...typeIntoContact({ name: c.name, phone: c.phone }, typed) }));
                        }}
                        onPaste={(e) => {
                          const text = e.clipboardData.getData("text");
                          const split = splitContactName(text);
                          if (!split.phone) return;
                          e.preventDefault();
                          setNewCustomer((c) => ({ ...c, name: split.name, phone: split.phone ?? c.phone }));
                        }}
                        // Settle a typed "Name 9818755517" when the field is left.
                        onBlur={() =>
                          setNewCustomer((c) => ({ ...c, ...applyContactSplit({ name: c.name, phone: c.phone }, c.name) }))
                        }
                        placeholder="Customer name, or paste name and number"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Phone</Label>
                      <Input
                        value={newCustomer.phone}
                        onChange={(e) => setNewCustomer((c) => ({ ...c, phone: e.target.value }))}
                        placeholder="98…"
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>Address</Label>
                      <Input
                        value={newCustomer.address}
                        onChange={(e) => setNewCustomer((c) => ({ ...c, address: e.target.value }))}
                        placeholder="City / site"
                      />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={!newCustomer.name || createCustomer.isPending}
                    onClick={() => {
                      // Finalise the contact split at submit, so the customer is
                      // created with a real name and a real number even if the
                      // field was never blurred.
                      const c = applyContactSplit(newCustomer, newCustomer.name);
                      const dup = findDuplicateCustomer(allCustomers, { name: c.name, phone: c.phone });
                      if (dup) {
                        setError(duplicateCustomerMessage(dup));
                        return;
                      }
                      setError(null);
                      createCustomer.mutate({
                        name: c.name,
                        phone: c.phone || undefined,
                        address: newCustomer.address || undefined,
                      });
                    }}
                  >
                    {createCustomer.isPending ? "Saving…" : "Save customer"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Items</CardTitle>
              <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus className="h-4 w-4" /> Add line
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {equipment.isLoading ? (
                <Spinner />
              ) : (
                lines.map((l, idx) => {
                  const lineAmount = (Number(l.rate) || 0) * (Number(l.units) || 0) * (Number(l.billedQty) || 0);
                  return (
                    <div key={l.key} className="space-y-3 rounded-lg border p-3">
                      <div className="flex items-center justify-between">
                        <Badge tone="muted">Line {idx + 1}</Badge>
                        {lines.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                            aria-label="Remove line"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label>Equipment *</Label>
                          <Select value={l.equipmentId} onChange={(e) => update(l.key, { equipmentId: e.target.value })}>
                            <option value="">Select equipment…</option>
                            {(equipment.data ?? []).map((eq) => (
                              <option key={eq.id} value={eq.id}>
                                {eq.name}
                                {eq.code ? ` (${eq.code})` : ""} — {eq.unit}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Rental basis *</Label>
                          <Select value={l.basis} onChange={(e) => update(l.key, { basis: e.target.value as RentalBasis })}>
                            {RENTAL_BASES.map((b) => (
                              <option key={b} value={b}>
                                {BASIS_LABELS[b]}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Rate per {l.basis} (Rs) *</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.rate}
                            onChange={(e) => update(l.key, { rate: e.target.value })}
                            placeholder="0.00"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>{BASIS_UNIT_LABELS[l.basis]} (count)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.units}
                            onChange={(e) => update(l.key, { units: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Actual Qty (delivered)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.actualQty}
                            onChange={(e) => update(l.key, { actualQty: e.target.value })}
                          />
                          <p className="text-[11px] text-muted-foreground">Hits stock / inventory</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Billed Qty</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.billedQty}
                            onChange={(e) => update(l.key, { billedQty: e.target.value })}
                          />
                          <p className="text-[11px] text-muted-foreground">Hits the invoice amount</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between border-t pt-2 text-sm">
                        <span className="text-muted-foreground">
                          {formatMoney(Number(l.rate) || 0)} × {l.units || 0} {BASIS_UNIT_LABELS[l.basis].toLowerCase()} ×{" "}
                          {l.billedQty || 0} billed
                        </span>
                        <span className="font-semibold tabular-nums">{formatMoney(lineAmount)}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Site details, delivery instructions…"
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Lines</span>
                <span className="font-medium">{lines.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Actual qty (stock)</span>
                <span className="font-medium tabular-nums">{totals.actual}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Billed qty (invoice)</span>
                <span className="font-medium tabular-nums">{totals.billed}</span>
              </div>
              <div className="flex justify-between border-t pt-3 text-base">
                <span className="font-semibold">Order amount</span>
                <span className="font-bold tabular-nums">{formatMoney(totals.amount)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                The order goes to the owner for approval. Amount due is only shown in the owner app.
              </p>
              {error && (
                <div className="space-y-2">
                  <ErrorNote>{error}</ErrorNote>
                  {duplicateId && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        The live order is already on file, so nothing was created. Open it to continue, or change the
                        items or quantities to make this a different rental.
                      </span>
                    </div>
                  )}
                </div>
              )}
              <Button className="w-full" onClick={onSubmit} disabled={createOrder.isPending}>
                {createOrder.isPending ? "Submitting…" : "Submit for approval"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
