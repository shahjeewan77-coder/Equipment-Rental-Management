// ── Tracking (owner only) ─────────────────────────────────────────────────────
//
// The owner's live view of the fleet, as a STATE MACHINE driven by the data:
//
//   1. pre-dispatch — an order is approved and locked but not dispatched. Show
//      the assigned driver and vehicle ONLY. The customer's destination is
//      deliberately withheld: the truck has not left, and showing a drop-off
//      before dispatch reads as "on the way".
//   2. active — something is on transit / on rent. Show the customer's delivery
//      details (name, drop-off, contact) beside the driver and vehicle.
//   3. completed — nothing active, but a delivery finished in the last 24h. Show
//      the driver and vehicle plus a "Recent delivery to" badge, so the operator
//      keeps context until the next lock.
//
// Two failure modes are handled explicitly, because a tracking screen that lies
// is worse than one that admits it is stale:
//
//   • SIGNAL DROP — the device is online and GPS is on, but the data has stopped
//     arriving. A soft reconnect runs (refetch with backoff) and a non-intrusive
//     banner says so, while the last known coordinates stay on the map.
//   • GPS OFF — location services are disabled on the device. The screen is
//     blocked by a full-screen overlay with a Retry that re-checks, because
//     "live tracking" with no location is not a degraded view, it is a false one.
//
// Owner-only, enforced twice: the route is behind the owner guard in App.tsx and
// every procedure it calls is `requireOwner` on the server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Navigation,
  RefreshCw,
  Route as RouteIcon,
  Truck,
  MapPin,
  Clock,
  Phone,
  WifiOff,
  LocateFixed,
  CheckCircle2,
  AlertTriangle,
  PackageCheck,
} from "lucide-react";
import { trpc } from "@/_core/trpc";
import { AppLayout } from "@/components/AppLayout";
import { PageHeader, Spinner, EmptyState, Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui/primitives";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OwnerTrackingMap, MapLegend } from "@/components/OwnerTrackingMap";
import { BsDateRangeFilter } from "@/components/BsDateRangeFilter";
import { freshnessLabel, isMarkerLive } from "@/lib/offline/registry";
import { destinationTense } from "@/lib/destination-label";
import { bsDisplay, relativeTime } from "@/lib/format";
import { HOT_POLL_MS, LIVE_POLL_MS, pollWhileOnline } from "@/lib/live";
import type { BsRange } from "@shared/bs-range";

/** How long without a fresh board before the screen calls the signal dropped. */
const STALL_MS = 45_000;

type GpsState = "checking" | "on" | "off" | "unsupported";

/**
 * Is device location actually available?
 *
 * `navigator.geolocation` existing is not the same as location services being
 * ON: on a device with GPS switched off, the API is present and every call fails
 * with PERMISSION_DENIED. So this asks for a real fix with a short timeout and
 * treats a denial as "off" — which is what the operator needs to be told.
 */
function useGpsStatus() {
  const [state, setState] = useState<GpsState>("checking");
  const [detail, setDetail] = useState<string | null>(null);
  // Sticky: once GPS has been found off, the screen stays blocked until a fix
  // actually succeeds. Without this, pressing Retry would flip the state to
  // "checking" and briefly reveal the tracking screen — which is exactly the
  // false "live" view the block exists to prevent.
  const [blocked, setBlocked] = useState(false);

  const check = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState("unsupported");
      setDetail("This browser does not expose a location API.");
      setBlocked(true);
      return;
    }
    setState("checking");
    setDetail(null);
    navigator.geolocation.getCurrentPosition(
      () => {
        setState("on");
        setDetail(null);
        setBlocked(false);
      },
      (err) => {
        // 1 = PERMISSION_DENIED. That covers both "the user said no" and "location
        // services are switched off at the OS level" — from the page they are
        // indistinguishable, and both mean tracking cannot work.
        if (err.code === err.PERMISSION_DENIED) {
          setState("off");
          setDetail("Location permission was denied, or location services are switched off on this device.");
          setBlocked(true);
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setState("off");
          setDetail("The device could not get a position fix. Check that GPS is switched on.");
          setBlocked(true);
        } else {
          // A timeout is not proof that GPS is off — the device may simply be
          // indoors. Do not block the screen on it.
          setState("on");
          setDetail("No fix yet (timed out) — GPS appears to be on but has not locked.");
          setBlocked(false);
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  return { state, detail, blocked, recheck: check };
}

export default function Tracking() {
  const [, navigate] = useLocation();
  const [selectedTrip, setSelectedTrip] = useState<string | null>(null);
  const [range, setRange] = useState<BsRange>({ startDateBS: null, endDateBS: null });

  const gps = useGpsStatus();

  // The board is the state machine's input. 5s keeps a driver's marker honest
  // without flooding the server.
  const board = trpc.tracking.board.useQuery(undefined, {
    refetchInterval: pollWhileOnline(HOT_POLL_MS),
    refetchOnWindowFocus: true,
  });
  const live = trpc.tracking.live.useQuery(undefined, { refetchInterval: pollWhileOnline(HOT_POLL_MS) });
  const trips = trpc.tracking.trips.useQuery(
    { startDateBS: range.startDateBS, endDateBS: range.endDateBS },
    { refetchInterval: pollWhileOnline(LIVE_POLL_MS) },
  );
  const history = trpc.tracking.history.useQuery(
    { orderId: selectedTrip ?? "" },
    { enabled: !!selectedTrip, refetchInterval: pollWhileOnline(LIVE_POLL_MS) },
  );

  // ── signal-drop detection + soft reconnect ──
  // A stall is "the last successful read is older than STALL_MS while the device
  // is online and GPS is on". That is the only case where the data is wrong
  // through no fault of the device's connectivity, so it is the only case that
  // gets the banner.
  const [stalled, setStalled] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const lastOkAt = useRef<number>(Date.now());
  const attempts = useRef(0);

  useEffect(() => {
    if (board.dataUpdatedAt) lastOkAt.current = board.dataUpdatedAt;
  }, [board.dataUpdatedAt]);

  const online = typeof navigator === "undefined" ? true : navigator.onLine;

  useEffect(() => {
    const id = setInterval(() => {
      const age = Date.now() - lastOkAt.current;
      setStalled(online && gps.state === "on" && age > STALL_MS);
    }, 5_000);
    return () => clearInterval(id);
  }, [online, gps.state]);

  // Soft reconnect: refetch with a short backoff, capped, and stop as soon as a
  // read lands. Deliberately gentle — a hard reload would lose the map state and
  // the selected route, and the operator is usually mid-look.
  useEffect(() => {
    if (!stalled) {
      attempts.current = 0;
      setReconnecting(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (cancelled) return;
      setReconnecting(true);
      attempts.current += 1;
      try {
        await Promise.all([board.refetch(), live.refetch()]);
      } catch {
        // Swallowed on purpose: the banner already says the signal is down, and a
        // thrown error here would only add a second, noisier message.
      }
      if (cancelled) return;
      timer = setTimeout(tick, Math.min(2_000 * attempts.current, 10_000));
    };

    timer = setTimeout(tick, 1_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stalled]);

  const markers = live.data?.markers ?? [];
  const active = board.data?.active ?? [];
  const locked = board.data?.locked ?? [];
  const recent = board.data?.recent ?? null;

  // The three states are ADDITIVE, not exclusive. A shop with ten trucks out and
  // one order locked is in all three at once, and hiding the locked order (or the
  // just-completed badge) because something else is on the road would be a lie of
  // omission. So each section renders when its data exists, and the banner names
  // the most urgent one: active > pre-dispatch > completed > idle.
  const phase: "pre_dispatch" | "active" | "completed" | "idle" =
    active.length > 0 ? "active" : locked.length > 0 ? "pre_dispatch" : recent ? "completed" : "idle";

  // The delivery marker prefers the point CAPTURED at dispatch — that is where
  // the equipment actually went. The customer's saved site is only a fallback for
  // orders dispatched before capture existed, and it is drawn hollow so the two
  // are never mistaken for each other.
  const sites = useMemo(
    () =>
      active
        .map((t) => {
          const captured =
            t.deliveryLocationStatus === "captured" && t.deliveryLatitude != null && t.deliveryLongitude != null;
          const latitude = captured ? (t.deliveryLatitude as number) : t.latitude;
          const longitude = captured ? (t.deliveryLongitude as number) : t.longitude;
          if (latitude == null || longitude == null) return null;
          return {
            orderId: t.orderId,
            customerName: t.customerName,
            customerAddress: captured ? (t.deliveryAddress ?? t.customerAddress) : t.customerAddress,
            driverName: t.driverName,
            vehicleName: t.vehicleName,
            vehicleNumber: t.vehicleNumber,
            status: t.status,
            latitude,
            longitude,
            captured,
            capturedAt: captured ? t.deliveryCapturedAt : null,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null),
    [active],
  );

  const route = (history.data?.points ?? []).map((p) => ({
    latitude: p.latitude,
    longitude: p.longitude,
    recordedAt: p.recordedAt,
  }));

  const now = Date.now();
  const tripRows = trips.data?.rows ?? [];

  // ── GPS off: block the screen ──
  // Rendered INSTEAD of the tracking content, not over it, so nothing behind the
  // overlay can be read as live data.
  if (gps.blocked) {
    return (
      <AppLayout>
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="gps-off-title"
          data-testid="gps-off-overlay"
        >
          <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center shadow-lg">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
              <LocateFixed className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <h2 id="gps-off-title" className="text-lg font-semibold">
              Location services (GPS) are turned off
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">Please enable GPS to continue using live tracking.</p>
            {gps.detail && <p className="mt-2 text-xs text-muted-foreground">{gps.detail}</p>}
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={gps.recheck} disabled={gps.state === "checking"} data-testid="gps-retry">
                <RefreshCw className={gps.state === "checking" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                {gps.state === "checking" ? "Checking…" : "Retry"}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/dashboard")}>
                Back to dashboard
              </Button>
            </div>
            <p className="mt-4 text-[11px] text-muted-foreground">
              Live tracking is blocked while GPS is off, because a map with no position would be misleading.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <PageHeader
        title="Live tracking"
        subtitle="Where every driver is right now, and the route each trip took."
        actions={
          <Button variant="outline" onClick={() => board.refetch()} disabled={board.isFetching}>
            <RefreshCw className={board.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh
          </Button>
        }
      />

      {/* ── signal-drop banner: non-intrusive, keeps the last known coordinates ── */}
      {stalled && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
          role="status"
          data-testid="signal-drop-banner"
        >
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Live tracking signal interrupted. Reconnecting…</p>
            <p className="text-xs opacity-80">
              Showing the last known positions from {relativeTime(new Date(lastOkAt.current).toISOString())}.
              {reconnecting && ` Reconnect attempt ${attempts.current}.`}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              lastOkAt.current = Date.now();
              setStalled(false);
              board.refetch();
              live.refetch();
            }}
          >
            Retry now
          </Button>
        </div>
      )}

      {/* ── the state banner: says which of the three states the screen is in ── */}
      <StateBanner phase={phase} recent={recent} lockedCount={locked.length} activeCount={active.length} />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Navigation className="h-4 w-4 text-primary" /> Fleet map
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {board.data?.at ? `updated ${relativeTime(board.data.at)}` : "loading…"}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {live.isLoading ? (
            <Spinner />
          ) : (
            <>
              <OwnerTrackingMap
                markers={markers}
                sites={sites}
                route={selectedTrip ? route : undefined}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <MapLegend />
                {selectedTrip && (
                  <Button variant="ghost" size="sm" onClick={() => setSelectedTrip(null)}>
                    Clear route
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── state 1: pre-dispatch — driver + vehicle ONLY, no destination ── */}
      {locked.length > 0 && (
        <Card data-testid="state-pre-dispatch">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4 text-primary" /> Ready to leave ({locked.length})
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Locked for dispatch, not yet on the road. The drop-off appears once the driver dispatches.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {locked.map((l) => (
                <div key={l.orderId} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{l.driverName ?? "Unassigned driver"}</p>
                    <Badge tone="info">Locked</Badge>
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Truck className="h-3.5 w-3.5" />
                    {l.vehicleName ? `${l.vehicleName} (${l.vehicleNumber})` : "No vehicle recorded"}
                  </p>
                  {l.driverPhone && (
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" /> {l.driverPhone}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Order {bsDisplay(l.orderDateAd)} · destination withheld until dispatch
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── state 2: active — customer delivery details beside driver + vehicle ── */}
      {active.length > 0 && (
        <Card data-testid="state-active">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="h-4 w-4 text-primary" /> On the road ({active.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {active.map((t) => {
              const captured =
                t.deliveryLocationStatus === "captured" && t.deliveryLatitude != null && t.deliveryLongitude != null;
              const lat = captured ? t.deliveryLatitude : t.latitude;
              const lng = captured ? t.deliveryLongitude : t.longitude;
              return (
                <div key={t.orderId} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{t.customerName ?? "—"}</p>
                      <p className="text-sm text-muted-foreground">
                        {captured ? (t.deliveryAddress ?? t.customerAddress) : (t.customerAddress ?? "No address on file")}
                      </p>
                      {t.customerPhone && (
                        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Phone className="h-3.5 w-3.5" /> {t.customerPhone}
                        </p>
                      )}
                    </div>
                    <Badge tone={t.status === "on_rent" ? "accent" : "info"}>
                      {t.status === "on_rent" ? "On rent" : "On transit"}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-2 border-t pt-3 text-sm sm:grid-cols-2">
                    <p className="flex items-center gap-1.5">
                      <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                      {t.driverName ?? "Unassigned"}
                      {t.driverPhone && <span className="text-muted-foreground">· {t.driverPhone}</span>}
                    </p>
                    <p className="flex items-center gap-1.5 text-muted-foreground">
                      <Navigation className="h-3.5 w-3.5" />
                      {t.vehicleName ? `${t.vehicleName} (${t.vehicleNumber})` : "No vehicle recorded"}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {lat != null && lng != null ? (
                      <a
                        href={`https://www.google.com/maps?q=${lat},${lng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="tabular-nums underline decoration-dotted hover:text-foreground"
                      >
                        {Number(lat).toFixed(5)}, {Number(lng).toFixed(5)}
                      </a>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">no coordinates</span>
                    )}
                    <span>·</span>
                    <span>{captured ? "delivery point captured at dispatch" : "customer's saved site"}</span>
                    {captured && t.deliveryCapturedAt && (
                      <>
                        <span>·</span>
                        <span>captured {relativeTime(t.deliveryCapturedAt)}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* ── state 3: completed — driver + vehicle + "Recent delivery to" badge ── */}
      {recent && (
        <Card data-testid="state-completed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <PackageCheck className="h-4 w-4 text-primary" /> Delivery complete
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 dark:border-emerald-800 dark:bg-emerald-950/40">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200" data-testid="recent-delivery-badge">
                Recent delivery to: {recent.customerName ?? "—"}
                {recent.items.length > 0 && (
                  <span className="font-normal"> / {recent.items.map((i) => `${i.qty}x ${i.name}`).join(", ")}</span>
                )}
              </p>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p className="flex items-center gap-1.5">
                <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                {recent.driverName ?? "—"}
              </p>
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Navigation className="h-3.5 w-3.5" />
                {recent.vehicleName ? `${recent.vehicleName} (${recent.vehicleNumber})` : "—"}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Returned {recent.returnedAt ? relativeTime(recent.returnedAt) : "recently"}. The active destination is
              cleared — it reappears when the next order is locked.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Live drivers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4 text-primary" /> Drivers ({markers.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {markers.length === 0 ? (
              <EmptyState
                icon={<Truck className="h-5 w-5" />}
                title="No driver positions yet"
                description="A driver's position appears here once they are on an active trip and their device shares its location."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Driver</TH>
                    <TH>Vehicle</TH>
                    <TH>Last update</TH>
                  </TR>
                </THead>
                <TBody>
                  {markers.map((m) => {
                    const at = new Date(m.recordedAt).getTime();
                    const isLive = isMarkerLive(at, now);
                    return (
                      <TR key={m.driverId}>
                        <TD className="font-medium">
                          {m.driverName ?? "—"}
                          {(() => {
                            // Same rule as the map popup: the arrow means "heading
                            // to" only while the trip is live. A finished trip reads
                            // "delivered" — and does so for an offline driver too,
                            // because the status comes from the order, not the ping.
                            // The driver's CURRENT live order beats their last ping's.
                            const status = m.currentOrderStatus ?? m.orderStatus;
                            const name = m.currentCustomerName ?? m.customerName;
                            const tense = destinationTense(status);
                            if (!name || tense === "none") return null;
                            return (
                              <span className="block text-xs text-muted-foreground">
                                {tense === "delivering" ? `→ ${name}` : `✓ delivered to ${name}`}
                              </span>
                            );
                          })()}
                        </TD>
                        <TD className="text-muted-foreground">
                          {m.vehicleName ? `${m.vehicleName} (${m.vehicleNumber})` : "—"}
                        </TD>
                        <TD>
                          <Badge tone={isLive ? "success" : "muted"}>{freshnessLabel(at, now)}</Badge>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Active deliveries */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="h-4 w-4 text-primary" /> Active deliveries ({active.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {active.length === 0 ? (
              <EmptyState
                icon={<MapPin className="h-5 w-5" />}
                title="Nothing on the road"
                description="Orders that are on transit or on rent appear here with their delivery site."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Customer</TH>
                    <TH>Driver</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {active.map((t) => (
                    <TR key={t.orderId} className="cursor-pointer" onClick={() => navigate(`/orders/${t.orderId}`)}>
                      <TD className="font-medium">
                        {t.customerName ?? "—"}
                        {t.latitude == null && t.deliveryLatitude == null && (
                          <span className="block text-xs text-amber-600 dark:text-amber-400">no site coordinates</span>
                        )}
                      </TD>
                      <TD className="text-muted-foreground">{t.driverName ?? "Unassigned"}</TD>
                      <TD>
                        <Badge tone={t.status === "on_rent" ? "accent" : "info"}>
                          {t.status === "on_rent" ? "On rent" : "On transit"}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trip route history, with a BS range filter */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RouteIcon className="h-4 w-4 text-primary" /> Trip history
          </CardTitle>
          <p className="text-sm text-muted-foreground">Pick a trip to draw the route it took on the map above.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <BsDateRangeFilter value={range} onChange={setRange} />
          {trips.isLoading ? (
            <Spinner />
          ) : tripRows.length === 0 ? (
            <EmptyState
              icon={<RouteIcon className="h-5 w-5" />}
              title="No routes recorded in this range"
              description="Once a driver shares their location on a trip, the route is kept here so you can see where the vehicle went."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Customer</TH>
                  <TH>Driver</TH>
                  <TH>Vehicle</TH>
                  <TH>Date (BS)</TH>
                  <TH className="text-right">Points</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {tripRows.map((t) => (
                  <TR key={t.orderId ?? "unknown"}>
                    <TD className="font-medium">{t.customerName ?? "—"}</TD>
                    <TD className="text-muted-foreground">{t.driverName ?? "—"}</TD>
                    <TD className="text-muted-foreground">{t.vehicleName ? `${t.vehicleName} (${t.vehicleNumber})` : "—"}</TD>
                    <TD className="text-muted-foreground">{t.orderDateBs ? `BS ${t.orderDateBs}` : bsDisplay(null)}</TD>
                    <TD className="text-right tabular-nums">{t.points}</TD>
                    <TD className="text-right">
                      <Button
                        variant={selectedTrip === t.orderId ? "default" : "outline"}
                        size="sm"
                        disabled={!t.orderId}
                        onClick={() => setSelectedTrip(t.orderId ?? null)}
                      >
                        <RouteIcon className="h-4 w-4" /> {selectedTrip === t.orderId ? "Showing" : "Show route"}
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}

/** One line naming the current state, so the operator never has to infer it. */
function StateBanner({
  phase,
  recent,
  lockedCount,
  activeCount,
}: {
  phase: "pre_dispatch" | "active" | "completed" | "idle";
  recent: { customerName: string | null } | null;
  lockedCount: number;
  activeCount: number;
}) {
  if (phase === "active") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
        <Navigation className="h-4 w-4 shrink-0" />
        <span>
          <strong>{activeCount}</strong> {activeCount === 1 ? "delivery is" : "deliveries are"} on the road — customer
          drop-off details are shown below.
        </span>
      </div>
    );
  }
  if (phase === "pre_dispatch") {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <Truck className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>
          <strong>{lockedCount}</strong> {lockedCount === 1 ? "order is" : "orders are"} locked and waiting to leave.
          Driver and vehicle only — the destination appears at dispatch.
        </span>
      </div>
    );
  }
  if (phase === "completed") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          Last delivery to <strong>{recent?.customerName ?? "—"}</strong> is complete. No active destination until the
          next order is locked.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>Nothing is locked or on the road right now.</span>
    </div>
  );
}
