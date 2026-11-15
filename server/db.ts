// ── AGENT-OWNED: business data-access ─────────────────────────────────────────
// All queries are scoped to the caller's ACCOUNT id (the owner account). A
// driver's account id resolves to the owner who created them, so a driver can
// only ever touch their owner's rows.
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { BatchItem } from "drizzle-orm/batch";
import { atomic, db } from "./_core/db";
import {
  auditLog,
  customers,
  drivers,
  equipment,
  invoices,
  messageSettings,
  orderItems,
  orders,
  passwordResetCodes,
  profiles,
  receipts,
  smsNotifications,
  stockMovements,
  tripLocations,
  users,
  vehicleAssignments,
  vehicles,
} from "../drizzle/schema";
import { adIsoToBs, bsIso, kathmanduToday } from "../shared/bs-calendar";
import { buildLedger, sliceLedger } from "../shared/ledger";
import { duplicateCustomerMessage, findDuplicateCustomer } from "../shared/customer-dedupe";
import {
  MESSAGE_MODES,
  isValidSmsPasalNumber,
  toSmsPasalNumber,
  type MessageMode,
} from "../shared/sms";

// ── account / profile ────────────────────────────────────────────────────────

export async function getProfile(userId: string) {
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return row ?? null;
}

/** The owner account a user belongs to. Falls back to the user's own id when no
 *  profile exists yet (bootstrap: the very first signup becomes the owner). */
export async function accountIdFor(userId: string): Promise<string> {
  const p = await getProfile(userId);
  return p?.ownerId ?? userId;
}

export async function countOwners(): Promise<number> {
  const rows = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.role, "owner"));
  return rows.length;
}

export async function ensureOwnerProfile(userId: string, displayName: string | null) {
  await db
    .insert(profiles)
    .values({ userId, ownerId: userId, role: "owner", displayName })
    .onConflictDoNothing();
}

export async function createDriverProfile(input: {
  userId: string;
  ownerId: string;
  displayName: string | null;
  phone: string | null;
  username?: string | null;
}) {
  await db.insert(profiles).values({
    userId: input.userId,
    ownerId: input.ownerId,
    role: "driver",
    displayName: input.displayName,
    phone: input.phone,
    username: input.username ?? null,
  });
}

export async function listProfiles(accountId: string) {
  return db.select().from(profiles).where(eq(profiles.ownerId, accountId)).orderBy(asc(profiles.createdAt));
}

/** Resolve a login identifier (email, username, or phone) to the account email
 *  the auth layer authenticates against. Returns null when nothing matches. */
export async function resolveLoginEmail(identifier: string): Promise<string | null> {
  const raw = identifier.trim();
  if (!raw) return null;
  const id = raw.toLowerCase();
  if (id.includes("@")) return id; // email path — the auth layer validates existence
  const [byUsername] = await db
    .select({ email: users.email })
    .from(profiles)
    .innerJoin(users, eq(profiles.userId, users.id))
    .where(eq(profiles.username, id))
    .limit(1);
  if (byUsername) return byUsername.email;
  const [byPhone] = await db
    .select({ email: users.email })
    .from(profiles)
    .innerJoin(users, eq(profiles.userId, users.id))
    .where(eq(profiles.phone, raw))
    .limit(1);
  return byPhone?.email ?? null;
}

/** True when a username is already used by any account (usernames are global). */
export async function isUsernameTaken(username: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.username, username.toLowerCase()))
    .limit(1);
  return Boolean(row);
}

// ── customers ────────────────────────────────────────────────────────────────

export async function listCustomers(accountId: string) {
  return db.select().from(customers).where(eq(customers.ownerId, accountId)).orderBy(asc(customers.name));
}

export async function getCustomer(accountId: string, customerId: string) {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function createCustomer(input: {
  ownerId: string;
  name: string;
  phone?: string | null;
  address?: string | null;
}) {
  // ── duplicate guard ──
  // Same name AND same phone (case-insensitive, formatting-insensitive) is the
  // same customer. Checked here rather than only in the browser so a direct API
  // call, the order form's inline create and the Customers page all hit the same
  // rule. Thrown as a plain Error with a message the router maps to CONFLICT.
  const existing = await listCustomers(input.ownerId);
  const dup = findDuplicateCustomer(existing, { name: input.name, phone: input.phone });
  if (dup) throw new DuplicateCustomerError(duplicateCustomerMessage(dup), dup.id, dup.name);

  const [row] = await db
    .insert(customers)
    .values({
      ownerId: input.ownerId,
      name: input.name,
      phone: input.phone ?? null,
      address: input.address ?? null,
    })
    .returning();
  return row;
}

/**
 * A customer that already exists with this name + phone.
 *
 * A dedicated class so the router can map it to a CONFLICT without string-
 * matching a message, and so the client can show the existing customer's name.
 */
export class DuplicateCustomerError extends Error {
  constructor(
    message: string,
    readonly existingId: string,
    readonly existingName: string,
  ) {
    super(message);
    this.name = "DuplicateCustomerError";
  }
}

/** Set a customer's opening (carried-in) due. Owner-only, validated by the router. */
export async function setCustomerOpeningBalance(accountId: string, customerId: string, openingBalance: number) {
  const [row] = await db
    .update(customers)
    .set({ openingBalance: round2(openingBalance) })
    .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
    .returning();
  return row ?? null;
}

// ── vehicles ─────────────────────────────────────────────────────────────────

export async function listVehicles(accountId: string) {
  return db.select().from(vehicles).where(eq(vehicles.ownerId, accountId)).orderBy(asc(vehicles.name));
}

/**
 * Only the trucks still in service — what every picker should offer.
 *
 * A retired vehicle keeps its row (so history still names it) but must not be
 * offered for a new order or a driver's daily assignment; the server checks the
 * same list when a vehicle id arrives, so a stale client cannot sneak one in.
 */
export async function listActiveVehicles(accountId: string) {
  return db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.ownerId, accountId), eq(vehicles.isActive, true)))
    .orderBy(asc(vehicles.name));
}

export async function createVehicle(input: {
  ownerId: string;
  name: string;
  number: string;
  type?: string | null;
}) {
  const [row] = await db
    .insert(vehicles)
    .values({ ownerId: input.ownerId, name: input.name, number: input.number, type: input.type ?? null })
    .returning();
  return row;
}

/** A plate/name clash inside one business, case-insensitively, excluding `exceptId`. */
export async function findVehicleByNumber(accountId: string, number: string, exceptId?: string) {
  const rows = await db
    .select({ id: vehicles.id, name: vehicles.name, number: vehicles.number })
    .from(vehicles)
    .where(and(eq(vehicles.ownerId, accountId), sql`lower(${vehicles.number}) = ${number.trim().toLowerCase()}`));
  return rows.find((r) => r.id !== exceptId) ?? null;
}

/**
 * Edit a vehicle in place. Every field is fair game — the plate is the identity
 * the owner reads off the truck, so a typo in it must be fixable.
 *
 * Returns `{ ok: false, reason: "duplicate" }` when another vehicle in the same
 * business already carries that number, rather than letting two rows diverge.
 */
export async function editVehicleRow(
  accountId: string,
  vehicleId: string,
  patch: { name?: string; number?: string; type?: string | null },
) {
  const before = await getVehicle(accountId, vehicleId);
  if (!before) return { ok: false as const, reason: "not_found" as const };

  if (patch.number !== undefined) {
    const clash = await findVehicleByNumber(accountId, patch.number, vehicleId);
    if (clash) return { ok: false as const, reason: "duplicate" as const, clash };
  }

  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.number !== undefined) set.number = patch.number.trim();
  if (patch.type !== undefined) set.type = patch.type?.trim() ? patch.type.trim() : null;

  if (Object.keys(set).length === 0) return { ok: true as const, before, after: before };

  const [after] = await db
    .update(vehicles)
    .set(set)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.ownerId, accountId)))
    .returning();
  if (!after) return { ok: false as const, reason: "not_found" as const };
  return { ok: true as const, before, after };
}

export async function getVehicle(accountId: string, vehicleId: string) {
  const [row] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.ownerId, accountId)))
    .limit(1);
  return row ?? null;
}

/** Put a retired vehicle back into service. */
export async function reactivateVehicle(accountId: string, vehicleId: string) {
  const [row] = await db
    .update(vehicles)
    .set({ isActive: true, archivedAt: null })
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.ownerId, accountId)))
    .returning();
  return row ?? null;
}

/** Retire a vehicle without deleting the row, so every past record still names it. */
export async function deactivateVehicle(accountId: string, vehicleId: string) {
  const [row] = await db
    .update(vehicles)
    .set({ isActive: false, archivedAt: new Date() })
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.ownerId, accountId)))
    .returning();
  return row ?? null;
}

// ── drivers ──────────────────────────────────────────────────────────────────

export async function listDrivers(accountId: string) {
  return db.select().from(drivers).where(eq(drivers.ownerId, accountId)).orderBy(asc(drivers.name));
}

/** Only the drivers still on the roster — what every picker should offer. */
export async function listActiveDrivers(accountId: string) {
  return db
    .select()
    .from(drivers)
    .where(and(eq(drivers.ownerId, accountId), eq(drivers.isActive, true)))
    .orderBy(asc(drivers.name));
}

/**
 * What removing a driver from the roster affects. Removing is a deactivation, so
 * NOTHING is deleted — this exists so the owner can be told, in plain numbers,
 * how much history still names the driver.
 */
export async function driverDeleteSummary(accountId: string, driverId: string) {
  const [d] = await db
    .select()
    .from(drivers)
    .where(and(eq(drivers.id, driverId), eq(drivers.ownerId, accountId)))
    .limit(1);
  if (!d) return null;

  const [ordersInvolved, pings, assignments, movements, audits] = await Promise.all([
    db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.ownerId, accountId),
          or(
            eq(orders.driverId, driverId),
            eq(orders.createdByDriverId, driverId),
            eq(orders.transitedByDriverId, driverId),
            eq(orders.dispatchedByDriverId, driverId),
            eq(orders.lockedByDriverId, driverId),
          )!,
        ),
      ),
    db
      .select({ id: tripLocations.id })
      .from(tripLocations)
      .where(and(eq(tripLocations.ownerId, accountId), eq(tripLocations.driverId, driverId))),
    db
      .select({ id: vehicleAssignments.id })
      .from(vehicleAssignments)
      .where(and(eq(vehicleAssignments.ownerId, accountId), eq(vehicleAssignments.driverId, driverId))),
    // Stock movements keep naming whoever carried the stock, so they are part of
    // what a delete would strand.
    db
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.ownerId, accountId), eq(stockMovements.driverId, driverId))),
    db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, accountId), eq(auditLog.entity, "driver"), eq(auditLog.targetId, driverId))),
  ]);

  // A driver still holding an order cannot be removed: either they have it locked
  // for dispatch (nobody else can dispatch it, and their location is what the map
  // follows) or they are carrying it right now. Both must be resolved first.
  const [activeTrip] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(
      and(
        eq(orders.ownerId, accountId),
        or(eq(orders.lockedByDriverId, driverId), eq(orders.transitedByDriverId, driverId))!,
        inArray(orders.status, [...ACTIVE_TRIP_STATUSES]),
      ),
    )
    .limit(1);

  const references =
    ordersInvolved.length + pings.length + assignments.length + movements.length + audits.length;

  return {
    driverName: d.name,
    phone: d.phone,
    hasLogin: Boolean(d.userId),
    alreadyInactive: !d.isActive,
    ordersInvolved: ordersInvolved.length,
    trackingPings: pings.length,
    assignments: assignments.length,
    stockMovements: movements.length,
    auditEntries: audits.length,
    references,
    /** Nothing names them, so the row can actually go. */
    canHardDelete: references === 0,
    activeTripStatus: activeTrip ? (activeTrip.status as string) : null,
    onActiveTrip: Boolean(activeTrip),
  };
}

/**
 * Remove a driver from the roster.
 *
 * This is a DEACTIVATION, not a row delete. A driver who has taken orders is part
 * of the business's history — deleting the row would blank their name off past
 * orders and routes, and `onDelete: set null` would silently turn "carried by
 * Kabiraj" into "carried by nobody". Deactivating keeps every record true while
 * removing them from the roster, the pickers and the login-gated workflows.
 *
 * Refused while the driver is on an active trip, so the owner's map is never
 * following somebody the system has just hidden.
 */
export async function deactivateDriver(accountId: string, driverId: string) {
  const summary = await driverDeleteSummary(accountId, driverId);
  if (!summary) return { ok: false as const, reason: "not_found" as const };
  if (summary.alreadyInactive) return { ok: false as const, reason: "already_inactive" as const };
  if (summary.onActiveTrip) return { ok: false as const, reason: "on_active_trip" as const, summary };

  // Nothing has ever named them — a driver added by mistake can simply go, so the
  // roster is not left accumulating rows nobody ever worked with.
  if (summary.canHardDelete) {
    await db.delete(drivers).where(and(eq(drivers.id, driverId), eq(drivers.ownerId, accountId)));
    return { ok: true as const, mode: "deleted" as const, summary };
  }

  const [row] = await db
    .update(drivers)
    .set({ isActive: false })
    .where(and(eq(drivers.id, driverId), eq(drivers.ownerId, accountId)))
    .returning();
  if (!row) return { ok: false as const, reason: "not_found" as const };
  return { ok: true as const, mode: "deactivated" as const, summary, driver: row };
}

/** Put a deactivated driver back on the roster. */
export async function reactivateDriver(accountId: string, driverId: string) {
  const [row] = await db
    .update(drivers)
    .set({ isActive: true })
    .where(and(eq(drivers.id, driverId), eq(drivers.ownerId, accountId)))
    .returning();
  return row ?? null;
}

/**
 * Rename / re-number a driver on the roster, and set the vehicle they are
 * driving today.
 *
 * Only the driver row is touched by the name/number fields: it is what orders,
 * routes and the live map name. A driver with no login is a normal roster entry,
 * so this must work without a user account behind it.
 *
 * Two things are checked before anything is written, because both are how a
 * roster goes wrong: a phone number already used by another driver (the phone is
 * also a login handle, so a duplicate is ambiguous at the login screen), and an
 * unknown vehicle. Both come back as a reason rather than a thrown error, so the
 * router can turn them into a message the owner can act on.
 */
export async function editDriverRow(
  accountId: string,
  driverId: string,
  patch: {
    name?: string;
    phone?: string | null;
    licenseNo?: string | null;
    /** undefined = leave alone, null = clear today's vehicle. */
    vehicleId?: string | null;
  },
) {
  const before = await getDriver(accountId, driverId);
  if (!before) return { ok: false as const, reason: "not_found" as const };

  const phone = patch.phone === undefined ? undefined : patch.phone?.trim() ? patch.phone.trim() : null;
  if (phone) {
    const clash = await findDriverByPhone(accountId, phone, driverId);
    if (clash) return { ok: false as const, reason: "duplicate_phone" as const, clash };
  }

  if (patch.vehicleId) {
    const v = await getVehicle(accountId, patch.vehicleId);
    if (!v) return { ok: false as const, reason: "unknown_vehicle" as const };
    if (!v.isActive) return { ok: false as const, reason: "retired_vehicle" as const };
  }

  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.phone !== undefined) set.phone = phone;
  if (patch.licenseNo !== undefined) set.licenseNo = patch.licenseNo?.trim() ? patch.licenseNo.trim() : null;

  let after = before;
  if (Object.keys(set).length > 0) {
    const [row] = await db
      .update(drivers)
      .set(set)
      .where(and(eq(drivers.id, driverId), eq(drivers.ownerId, accountId)))
      .returning();
    if (!row) return { ok: false as const, reason: "not_found" as const };
    after = row;
  }

  // The vehicle a driver has today is its own row (one per driver per day), so
  // clearing it is a delete and setting it is an upsert — the same table the
  // driver's own home screen writes.
  if (patch.vehicleId !== undefined) {
    const today = kathmanduToday();
    if (patch.vehicleId === null) {
      await db
        .delete(vehicleAssignments)
        .where(
          and(
            eq(vehicleAssignments.ownerId, accountId),
            eq(vehicleAssignments.driverId, driverId),
            eq(vehicleAssignments.dateAd, today.ad),
          ),
        );
    } else {
      await upsertAssignment({
        ownerId: accountId,
        driverId,
        vehicleId: patch.vehicleId,
        dateAd: today.ad,
        dateBs: today.bsIso,
      });
    }
  }

  // The login handle lives on the profile, not the driver row. Keep the display
  // name in step so the two never disagree about who this is.
  //
  // A driver WITHOUT a login is a perfectly normal roster entry (they take orders
  // on paper), and `before.userId` is then null. There is no profile row to keep
  // in step, and passing "" into a uuid column throws
  // `invalid input syntax for type uuid: ""` AFTER the driver row has already
  // been updated — a half-success that reads as a total failure. So the profile
  // write is skipped entirely when there is no login to write to.
  if (before.userId && (patch.name !== undefined || phone !== undefined)) {
    const setProfile: Record<string, unknown> = {};
    if (patch.name !== undefined) setProfile.displayName = patch.name.trim();
    if (phone !== undefined) setProfile.phone = phone;
    await db
      .update(profiles)
      .set(setProfile)
      .where(and(eq(profiles.ownerId, accountId), eq(profiles.userId, before.userId)));
  }

  return { ok: true as const, before, after };
}

export async function getDriver(accountId: string, driverId: string) {
  const [row] = await db
    .select()
    .from(drivers)
    .where(and(eq(drivers.id, driverId), eq(drivers.ownerId, accountId)))
    .limit(1);
  return row ?? null;
}

/** A phone number already on the roster, excluding `exceptId`. */
export async function findDriverByPhone(accountId: string, phone: string, exceptId?: string) {
  const rows = await db
    .select({ id: drivers.id, name: drivers.name, phone: drivers.phone })
    .from(drivers)
    .where(and(eq(drivers.ownerId, accountId), eq(drivers.phone, phone.trim())));
  return rows.find((r) => r.id !== exceptId) ?? null;
}

export async function createDriverRow(input: {
  ownerId: string;
  name: string;
  phone?: string | null;
  licenseNo?: string | null;
  userId?: string | null;
}) {
  const [row] = await db
    .insert(drivers)
    .values({
      ownerId: input.ownerId,
      name: input.name,
      phone: input.phone ?? null,
      licenseNo: input.licenseNo ?? null,
      userId: input.userId ?? null,
    })
    .returning();
  return row;
}

export async function linkDriverUser(accountId: string, driverId: string, userId: string) {
  const [row] = await db
    .update(drivers)
    .set({ userId })
    .where(and(eq(drivers.id, driverId), eq(drivers.ownerId, accountId)))
    .returning();
  return row ?? null;
}

export async function getDriverByUserId(accountId: string, userId: string) {
  const [row] = await db
    .select()
    .from(drivers)
    .where(and(eq(drivers.ownerId, accountId), eq(drivers.userId, userId)))
    .limit(1);
  return row ?? null;
}

// ── vehicle assignments ──────────────────────────────────────────────────────

export async function getAssignment(accountId: string, driverId: string, dateAd: string) {
  const [row] = await db
    .select()
    .from(vehicleAssignments)
    .where(
      and(
        eq(vehicleAssignments.ownerId, accountId),
        eq(vehicleAssignments.driverId, driverId),
        eq(vehicleAssignments.dateAd, dateAd),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertAssignment(input: {
  ownerId: string;
  driverId: string;
  vehicleId: string;
  dateAd: string;
  dateBs: string;
}) {
  const [row] = await db
    .insert(vehicleAssignments)
    .values(input)
    .onConflictDoUpdate({
      target: [vehicleAssignments.driverId, vehicleAssignments.dateAd],
      set: { vehicleId: input.vehicleId, dateBs: input.dateBs },
    })
    .returning();
  return row;
}

export async function listAssignmentsForDate(accountId: string, dateAd: string) {
  return db
    .select({
      id: vehicleAssignments.id,
      driverId: vehicleAssignments.driverId,
      vehicleId: vehicleAssignments.vehicleId,
      dateAd: vehicleAssignments.dateAd,
      dateBs: vehicleAssignments.dateBs,
      driverName: drivers.name,
      vehicleName: vehicles.name,
      vehicleNumber: vehicles.number,
    })
    .from(vehicleAssignments)
    .leftJoin(drivers, eq(vehicleAssignments.driverId, drivers.id))
    .leftJoin(vehicles, eq(vehicleAssignments.vehicleId, vehicles.id))
    .where(and(eq(vehicleAssignments.ownerId, accountId), eq(vehicleAssignments.dateAd, dateAd)))
    .orderBy(asc(drivers.name));
}

export async function listRecentAssignments(accountId: string, limit = 30) {
  return db
    .select({
      id: vehicleAssignments.id,
      driverId: vehicleAssignments.driverId,
      vehicleId: vehicleAssignments.vehicleId,
      dateAd: vehicleAssignments.dateAd,
      dateBs: vehicleAssignments.dateBs,
      driverName: drivers.name,
      vehicleName: vehicles.name,
      vehicleNumber: vehicles.number,
    })
    .from(vehicleAssignments)
    .leftJoin(drivers, eq(vehicleAssignments.driverId, drivers.id))
    .leftJoin(vehicles, eq(vehicleAssignments.vehicleId, vehicles.id))
    .where(eq(vehicleAssignments.ownerId, accountId))
    .orderBy(desc(vehicleAssignments.dateAd))
    .limit(limit);
}

// ── equipment / stock ────────────────────────────────────────────────────────

export async function listEquipment(accountId: string) {
  return db.select().from(equipment).where(eq(equipment.ownerId, accountId)).orderBy(asc(equipment.name));
}

export async function createEquipment(input: {
  ownerId: string;
  name: string;
  code?: string | null;
  unit?: string;
  totalQty?: number;
}) {
  const [row] = await db
    .insert(equipment)
    .values({
      ownerId: input.ownerId,
      name: input.name,
      code: input.code ?? null,
      unit: input.unit ?? "pcs",
      totalQty: input.totalQty ?? 0,
    })
    .returning();
  return row;
}

export async function updateEquipment(
  accountId: string,
  id: string,
  patch: { name?: string; code?: string | null; unit?: string; totalQty?: number },
) {
  const [row] = await db
    .update(equipment)
    .set(patch)
    .where(and(eq(equipment.id, id), eq(equipment.ownerId, accountId)))
    .returning();
  return row ?? null;
}

export async function listStockMovements(accountId: string, equipmentId?: string) {
  const where = equipmentId
    ? and(eq(stockMovements.ownerId, accountId), eq(stockMovements.equipmentId, equipmentId))
    : eq(stockMovements.ownerId, accountId);
  return db
    .select({
      id: stockMovements.id,
      equipmentId: stockMovements.equipmentId,
      type: stockMovements.type,
      qty: stockMovements.qty,
      dateAd: stockMovements.dateAd,
      dateBs: stockMovements.dateBs,
      createdAt: stockMovements.createdAt,
      equipmentName: equipment.name,
      orderId: stockMovements.orderId,
    })
    .from(stockMovements)
    .leftJoin(equipment, eq(stockMovements.equipmentId, equipment.id))
    .where(where)
    .orderBy(desc(stockMovements.createdAt))
    .limit(200);
}

/**
 * All-time delivered-out / returned-in totals per item, aggregated in SQL.
 *
 * The Stock report used to roll these up in the browser from `listStockMovements`,
 * which is capped at 200 rows. That cap is invisible until an account passes 200
 * movements, and then the columns silently under-count while the closing figure
 * (computed from `on_rent_qty`) stays right — the same class of mismatch as the
 * range bug, just further away. Summing in the database has no cap and no
 * rounding drift, so the Stock report's columns are the true all-time figures
 * the movement log shows.
 */
export async function stockMovementTotals(accountId: string) {
  const rows = await db
    .select({
      equipmentId: stockMovements.equipmentId,
      totalIn: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'in' THEN ${stockMovements.qty} ELSE 0 END), 0)`,
      totalOut: sql<number>`COALESCE(SUM(CASE WHEN ${stockMovements.type} = 'out' THEN ${stockMovements.qty} ELSE 0 END), 0)`,
      movementCount: sql<number>`COUNT(*)`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.ownerId, accountId))
    .groupBy(stockMovements.equipmentId);

  return rows.map((r) => ({
    equipmentId: r.equipmentId,
    totalIn: round2(Number(r.totalIn)),
    totalOut: round2(Number(r.totalOut)),
    movementCount: Number(r.movementCount),
  }));
}

// ── stock movement report (per item) ─────────────────────────────────────────

/**
 * Everything behind the Stock report's per-item movement drill-down.
 *
 * Returns the item's own totals plus EVERY movement it ever had, oldest first.
 * The date-range slicing and the running balance are done by the shared, pure
 * `buildMovementReport` — deliberately, because a balance that depends on a
 * range must roll everything before the range into the opening figure, and that
 * arithmetic deserves a unit test rather than a place in a SQL string.
 *
 * Attribution: an `out` movement names whoever dispatched the trip (the locker
 * — the person it actually left with), an `in` movement names whoever handed it
 * back. Both come from the snapshot column when present, falling back to the
 * order's actors for movements recorded before the snapshot existed.
 */
export async function stockMovementReport(accountId: string, equipmentId: string) {
  const [item] = await db
    .select({
      id: equipment.id,
      name: equipment.name,
      code: equipment.code,
      unit: equipment.unit,
      totalQty: equipment.totalQty,
      onRentQty: equipment.onRentQty,
    })
    .from(equipment)
    .where(and(eq(equipment.id, equipmentId), eq(equipment.ownerId, accountId)))
    .limit(1);
  if (!item) return null;

  const creator = alias(drivers, "mv_creator");
  const transiter = alias(drivers, "mv_transiter");
  const dispatcher = alias(drivers, "mv_dispatcher");
  const namedDriver = alias(drivers, "mv_named");
  // The customer the stock was picked FROM, when it was not the godown. Distinct
  // from `customers`, which is the order's own customer.
  const sourceCustomer = alias(customers, "mv_source_customer");

  const rows = await db
    .select({
      id: stockMovements.id,
      type: stockMovements.type,
      qty: stockMovements.qty,
      dateAd: stockMovements.dateAd,
      dateBs: stockMovements.dateBs,
      createdAt: stockMovements.createdAt,
      orderId: stockMovements.orderId,
      customerName: customers.name,
      invoiceNo: invoices.invoiceNo,
      snapshotName: stockMovements.actorName,
      reversalOfId: stockMovements.reversalOfId,
      note: stockMovements.note,
      autoReturn: stockMovements.autoReturn,
      sourceCustomerName: sourceCustomer.name,
      namedDriverName: namedDriver.name,
      creatorName: creator.name,
      transiterName: transiter.name,
      dispatcherName: dispatcher.name,
    })
    .from(stockMovements)
    .leftJoin(orders, eq(stockMovements.orderId, orders.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(invoices, eq(invoices.orderId, orders.id))
    .leftJoin(namedDriver, eq(stockMovements.driverId, namedDriver.id))
    .leftJoin(creator, eq(orders.createdByDriverId, creator.id))
    .leftJoin(transiter, eq(orders.transitedByDriverId, transiter.id))
    .leftJoin(dispatcher, eq(orders.dispatchedByDriverId, dispatcher.id))
    .leftJoin(sourceCustomer, eq(stockMovements.sourceCustomerId, sourceCustomer.id))
    .where(and(eq(stockMovements.ownerId, accountId), eq(stockMovements.equipmentId, equipmentId)))
    .orderBy(asc(stockMovements.dateAd), asc(stockMovements.createdAt));

  // Order numbers are derived, not stored: an order is identified by the day it
  // was raised plus its position that day, which is stable and human-readable
  // (ORD-2026-10-26-2). Recomputed here from the account's own orders so the
  // label always matches what the Orders screen shows.
  const dayOrders = await db
    .select({ id: orders.id, dateAd: orders.orderDateAd, createdAt: orders.createdAt })
    .from(orders)
    .where(eq(orders.ownerId, accountId))
    .orderBy(asc(orders.orderDateAd), asc(orders.createdAt));
  const orderNoById = new Map<string, string>();
  const perDay = new Map<string, number>();
  for (const o of dayOrders) {
    const n = (perDay.get(o.dateAd) ?? 0) + 1;
    perDay.set(o.dateAd, n);
    orderNoById.set(o.id, `ORD-${o.dateAd}-${n}`);
  }

  const movements = rows.map((r) => {
    // Which name belongs on THIS movement:
    //   out → who dispatched it (the driver it left with)
    //   in  → who handed it back
    // The snapshot wins because it is what was true at the time; the order's
    // actors are the fallback for movements recorded before it existed.
    const driverName =
      r.type === "out"
        ? (r.snapshotName ?? r.namedDriverName ?? r.dispatcherName ?? r.transiterName ?? null)
        : (r.snapshotName ?? r.namedDriverName ?? r.transiterName ?? r.creatorName ?? null);
    return {
      id: r.id,
      dateAd: r.dateAd,
      dateBs: r.dateBs,
      type: (r.type === "in" ? "in" : "out") as "in" | "out",
      qty: Number(r.qty),
      orderNo: r.orderId ? (orderNoById.get(r.orderId) ?? null) : null,
      invoiceNo: r.invoiceNo ?? null,
      customerName: r.customerName ?? null,
      personName: driverName,
      personRole: driverName ? ("driver" as const) : null,
      // A reversal is its own row in the ledger, so the history keeps both the
      // mistake and the correction. The report labels it and shows the reason.
      reversalOfId: r.reversalOfId ?? null,
      note: r.note ?? null,
      // "Pick From": the customer this stock came back from, when it was not the
      // godown. `autoReturn` marks the movement a lock wrote automatically.
      sourceCustomerName: r.sourceCustomerName ?? null,
      autoReturn: Boolean(r.autoReturn),
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    };
  });

  return {
    equipment: {
      id: item.id,
      name: item.name,
      code: item.code,
      unit: item.unit,
      totalQty: Number(item.totalQty),
      onRentQty: Number(item.onRentQty),
      closingOnHand: Number(item.totalQty) - Number(item.onRentQty),
    },
    movements,
  };
}

// ── orders ───────────────────────────────────────────────────────────────────

// ── "Pick From" ──────────────────────────────────────────────────────────────
//
// Stock is not always in the godown. Some of it is out on rent at a customer's
// site, and a new order can be filled from there instead of from the yard — the
// truck collects it from that customer on the way. This is the query behind the
// source picker on the Lock for Dispatch screen.
//
// The customer list is FILTERED to the items actually on the order: only a
// customer who currently holds one of those items is offered, because offering
// every customer would be a list of places the stock is not. A customer's
// available quantity is what they still hold — `actualQty - returnedQty` summed
// over their on-rent lines — so a customer who has already sent half of it back
// is offered only the half they still have.
export interface PickFromOption {
  orderItemId: string;
  equipmentId: string;
  equipmentName: string;
  /** How much this line needs. */
  qty: number;
  /** Free stock in the central godown (totalQty − onRentQty). */
  godownQty: number;
  /** Customers currently holding this item, with what they still hold. */
  customers: Array<{ customerId: string; customerName: string; qty: number }>;
}

export async function getPickFromOptions(accountId: string, orderId: string): Promise<PickFromOption[] | null> {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return null;

  const equipmentIds = [...new Set(detail.items.map((it) => it.equipmentId))];
  if (equipmentIds.length === 0) return [];

  // What each customer still holds, per item. `on_rent` only: an order that is
  // merely on transit has not reached the customer yet, so its stock is not
  // sitting at their site to be collected.
  const held = await db
    .select({
      equipmentId: orderItems.equipmentId,
      customerId: orders.customerId,
      customerName: customers.name,
      qty: sql<number>`SUM(${orderItems.actualQty} - ${orderItems.returnedQty})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(
      and(
        eq(orders.ownerId, accountId),
        eq(orders.status, "on_rent"),
        inArray(orderItems.equipmentId, equipmentIds),
      ),
    )
    .groupBy(orderItems.equipmentId, orders.customerId, customers.name);

  const stock = await db
    .select({ id: equipment.id, totalQty: equipment.totalQty, onRentQty: equipment.onRentQty })
    .from(equipment)
    .where(and(eq(equipment.ownerId, accountId), inArray(equipment.id, equipmentIds)));
  const godownById = new Map(
    stock.map((s) => [s.id, round2(Number(s.totalQty) - Number(s.onRentQty))]),
  );

  return detail.items.map((it) => ({
    orderItemId: it.id,
    equipmentId: it.equipmentId,
    equipmentName: it.equipmentName ?? "Item",
    qty: Number(it.actualQty),
    godownQty: godownById.get(it.equipmentId) ?? 0,
    customers: held
      .filter((h) => h.equipmentId === it.equipmentId && Number(h.qty) > 0)
      .map((h) => ({
        customerId: h.customerId,
        customerName: h.customerName,
        qty: round2(Number(h.qty)),
      }))
      .sort((a, b) => a.customerName.localeCompare(b.customerName)),
  }));
}

export interface OrderItemInput {
  equipmentId: string;
  basis: "day" | "hour" | "pillar";
  rate: number;
  actualQty: number;
  billedQty: number;
  units: number;
}

// ── duplicate entry prevention ───────────────────────────────────────────────
//
// Two people (or the same person twice, on a flaky connection) can end up
// submitting the same order. The check has to be here rather than in a form,
// because a form is not the only way in — the API is.
//
// SCOPE, and why: an order only makes a new submission a DUPLICATE while it is
// still live. Once it is RETURNED or REJECTED the equipment has come home, and
// renting it to the same customer again is ordinary business — refusing that
// would block the shop from working. So:
//
//   pending_approval / approved / on_transit / on_rent  → a repeat is a duplicate
//   returned / rejected                                → a repeat is a new rental
//
// "Identical" means the same customer and the same items in the same quantities.
// Rates are deliberately NOT part of the identity: re-quoting the same gear at a
// new price while the first order is still live is still a double entry. Actual
// Qty and Billed Qty ARE included, because they are the quantities that hit
// stock and the invoice respectively.

export const ACTIVE_ORDER_STATUSES = ["pending_approval", "approved", "on_transit", "on_rent"] as const;

export const DUPLICATE_ORDER_MESSAGE =
  "Duplicate entry: An identical order for this customer with the same items already exists.";

export interface FingerprintItem {
  equipmentId: string;
  actualQty: number;
  billedQty: number;
}

/** Order-insensitive identity of a line set, so the same items entered in a
 *  different order still compare equal. */
export function orderFingerprint(items: FingerprintItem[]): string {
  return items
    .map((i) => `${i.equipmentId}:${round2(Number(i.actualQty) || 0)}:${round2(Number(i.billedQty) || 0)}`)
    .sort()
    .join("|");
}

/** The id of a live order for this customer with identical contents, or null. */
export async function findDuplicateOrder(
  accountId: string,
  customerId: string,
  items: FingerprintItem[],
): Promise<{ id: string; status: string; orderDateAd: string } | null> {
  if (items.length === 0) return null;

  const rows = await db
    .select({
      orderId: orderItems.orderId,
      status: orders.status,
      orderDateAd: orders.orderDateAd,
      equipmentId: orderItems.equipmentId,
      actualQty: orderItems.actualQty,
      billedQty: orderItems.billedQty,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.ownerId, accountId),
        eq(orders.customerId, customerId),
        inArray(orders.status, [...ACTIVE_ORDER_STATUSES]),
      ),
    );

  const byOrder = new Map<string, { status: string; orderDateAd: string; items: FingerprintItem[] }>();
  for (const r of rows) {
    const entry = byOrder.get(r.orderId) ?? { status: r.status, orderDateAd: r.orderDateAd, items: [] };
    entry.items.push({
      equipmentId: r.equipmentId,
      actualQty: Number(r.actualQty),
      billedQty: Number(r.billedQty),
    });
    byOrder.set(r.orderId, entry);
  }

  const want = orderFingerprint(items);
  for (const [id, entry] of byOrder) {
    if (orderFingerprint(entry.items) === want) {
      return { id, status: entry.status, orderDateAd: entry.orderDateAd };
    }
  }
  return null;
}

export async function createOrder(input: {
  ownerId: string;
  customerId: string;
  driverId: string | null;
  vehicleId: string | null;
  notes?: string | null;
  items: OrderItemInput[];
}) {
  const today = kathmanduToday();
  const orderId = crypto.randomUUID();
  const rows = input.items.map((it) => ({
    id: crypto.randomUUID(),
    orderId,
    equipmentId: it.equipmentId,
    basis: it.basis,
    rate: it.rate,
    actualQty: it.actualQty,
    billedQty: it.billedQty,
    units: it.units,
    lineAmount: round2(it.rate * it.units * it.billedQty),
  }));

  // `atomic` resolves to an ARRAY of result sets, one per statement — so the
  // inserted order is the first row of the first result set.
  const [orderRows] = await atomic((d) => {
    const stmts = [
      d
        .insert(orders)
        .values({
          id: orderId,
          ownerId: input.ownerId,
          customerId: input.customerId,
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          status: "pending_approval",
          orderDateAd: today.ad,
          orderDateBs: today.bsIso,
          notes: input.notes ?? null,
          // Who TOOK the order. Null when the owner entered it themselves.
          createdByDriverId: input.driverId,
        })
        .returning(),
      d.insert(orderItems).values(rows).returning(),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });
  return orderRows[0];
}

export async function listOrders(accountId: string, opts: { driverId?: string | null; status?: string }) {
  const conds = [eq(orders.ownerId, accountId)];
  if (opts.driverId) {
    // A driver sees:
    //   1. every order assigned to them (any status), and
    //   2. every order THEY locked for dispatch — the locking driver keeps it
    //      visible so they can actually dispatch it, even when the order was
    //      assigned to a different driver, and
    //   3. any unlocked approved order, which is available for any driver to
    //      pick up and dispatch.
    // A locked order stays hidden from every OTHER driver (rule 2 is scoped to
    // the locker), which is what keeps two drivers from working the same order.
    conds.push(
      or(
        eq(orders.driverId, opts.driverId),
        eq(orders.lockedByDriverId, opts.driverId),
        and(isNull(orders.lockedByDriverId), eq(orders.status, "approved")),
      )!,
    );
  }
  if (opts.status) conds.push(eq(orders.status, opts.status));

  // Three different drivers can be on one order, so the name/vehicle shown has to
  // be resolved per step rather than taken from the single `driverId` join:
  //   · Transited by  → the LOCKER, and the locker's own vehicle (the trip)
  //   · Dispatched by → whoever completed the dispatch
  //   · otherwise     → whoever the order is assigned to, on its own vehicle
  const transiter = alias(drivers, "list_transiter");
  const dispatcher = alias(drivers, "list_dispatcher");
  const tripVehicle = alias(vehicles, "list_trip_vehicle");

  return db
    .select({
      id: orders.id,
      status: orders.status,
      orderDateAd: orders.orderDateAd,
      orderDateBs: orders.orderDateBs,
      notes: orders.notes,
      lockedByDriverId: orders.lockedByDriverId,
      driverId: orders.driverId,
      vehicleId: orders.vehicleId,
      transitVehicleId: orders.transitVehicleId,
      customerId: orders.customerId,
      createdAt: orders.createdAt,
      customerName: customers.name,
      // Kept for whichever page just wants "the driver on this order".
      driverName: drivers.name,
      creatorName: drivers.name,
      transiterName: transiter.name,
      dispatcherName: dispatcher.name,
      vehicleName: vehicles.name,
      vehicleNumber: vehicles.number,
      // The vehicle actually on the road. Once ANY driver locks the order, the
      // trip is theirs, so only their vehicle counts — with none set this is null
      // rather than the CREATING driver's truck. An order that was never locked
      // has no trip, so it falls back to its own vehicle.
      transitVehicleName: sql<string | null>`CASE WHEN ${orders.lockedByDriverId} IS NOT NULL THEN ${tripVehicle.name} ELSE ${vehicles.name} END`,
      transitVehicleNumber: sql<string | null>`CASE WHEN ${orders.lockedByDriverId} IS NOT NULL THEN ${tripVehicle.number} ELSE ${vehicles.number} END`,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(drivers, eq(orders.driverId, drivers.id))
    .leftJoin(transiter, eq(orders.lockedByDriverId, transiter.id))
    .leftJoin(dispatcher, eq(orders.dispatchedByDriverId, dispatcher.id))
    .leftJoin(vehicles, eq(orders.vehicleId, vehicles.id))
    .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
    .where(and(...conds))
    .orderBy(desc(orders.createdAt));
}

/**
 * The equipment lines for MANY orders at once, for the Orders list.
 *
 * The list used to call `getOrder` once per row, which is an N+1: 40 orders meant
 * 40 round trips (each of which also fetched the invoice and the whole order
 * header) just to print a few equipment names. This is one query for the whole
 * page.
 *
 * Returns a Map keyed by order id so the caller can attach lines in O(1) per row.
 * Orders with no lines are simply absent from the map — the caller treats a miss
 * as "no equipment", which is also what an order with zero lines should show.
 *
 * `deliveredQty` is `actual_qty` (what physically left the godown) and
 * `invoicedQty` is `billed_qty` (what the invoice charges for). They are
 * deliberately NOT the same column: the whole point of showing both is to expose
 * the case where 10 went out and 8 were billed.
 */
export async function listOrderLinesForOrders(
  accountId: string,
  orderIds: string[],
): Promise> {
  const out = new Map<string, { equipmentName: string; deliveredQty: number; invoicedQty: number }[]>();
  if (orderIds.length === 0) return out;

  const rows = await db
    .select({
      orderId: orderItems.orderId,
      equipmentName: equipment.name,
      deliveredQty: orderItems.actualQty,
      invoicedQty: orderItems.billedQty,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(equipment, eq(orderItems.equipmentId, equipment.id))
    .where(and(eq(orders.ownerId, accountId), inArray(orderItems.orderId, orderIds)))
    .orderBy(asc(orderItems.createdAt));

  for (const r of rows) {
    const list = out.get(r.orderId) ?? [];
    list.push({
      equipmentName: r.equipmentName ?? "Unnamed item",
      deliveredQty: Number(r.deliveredQty ?? 0),
      invoicedQty: Number(r.invoicedQty ?? 0),
    });
    out.set(r.orderId, list);
  }
  return out;
}

export async function getOrder(accountId: string, orderId: string) {
  // The three actors are separate drivers, so each needs its own join — this is
  // what lets a driver B lock (and be tracked for) an order driver A created.
  const creator = alias(drivers, "creator");
  const transiter = alias(drivers, "transiter");
  const dispatcher = alias(drivers, "dispatcher");
  // The vehicle driven by whoever locked the order — the truck actually on the
  // road, as distinct from `vehicleId`/`vehicles`, which is the one the order was
  // created with.
  const tripVehicle = alias(vehicles, "trip_vehicle");
  // The customer a line's stock was picked from ("Pick From"), for the order
  // detail page. A separate alias because `customers` is already the order's own
  // customer — the source is a DIFFERENT customer.
  const pickFromCustomer = alias(customers, "pick_from_customer");

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      orderDateAd: orders.orderDateAd,
      orderDateBs: orders.orderDateBs,
      notes: orders.notes,
      lockedByDriverId: orders.lockedByDriverId,
      createdByDriverId: orders.createdByDriverId,
      transitedByDriverId: orders.transitedByDriverId,
      dispatchedByDriverId: orders.dispatchedByDriverId,
      driverId: orders.driverId,
      vehicleId: orders.vehicleId,
      transitVehicleId: orders.transitVehicleId,
      customerId: orders.customerId,
      approvedAt: orders.approvedAt,
      dispatchedAt: orders.dispatchedAt,
      createdAt: orders.createdAt,
      // The delivery point captured at dispatch, distinct from the customer's
      // saved site below. Null on orders dispatched before this existed.
      deliveryAddress: orders.deliveryAddress,
      deliveryLatitude: orders.deliveryLatitude,
      deliveryLongitude: orders.deliveryLongitude,
      deliveryAccuracy: orders.deliveryAccuracy,
      deliveryCapturedAt: orders.deliveryCapturedAt,
      deliveryLocationStatus: orders.deliveryLocationStatus,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerAddress: customers.address,
      customerLatitude: customers.latitude,
      customerLongitude: customers.longitude,
      driverName: drivers.name,
      createdByName: creator.name,
      transitedByName: transiter.name,
      dispatchedByName: dispatcher.name,
      vehicleName: vehicles.name,
      vehicleNumber: vehicles.number,
      // The trip's vehicle: the locker's. No fallback to the creating driver's.
      transitVehicleName: tripVehicle.name,
      transitVehicleNumber: tripVehicle.number,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(drivers, eq(orders.driverId, drivers.id))
    .leftJoin(creator, eq(orders.createdByDriverId, creator.id))
    .leftJoin(transiter, eq(orders.transitedByDriverId, transiter.id))
    .leftJoin(dispatcher, eq(orders.dispatchedByDriverId, dispatcher.id))
    .leftJoin(vehicles, eq(orders.vehicleId, vehicles.id))
    .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
    .where(and(eq(orders.id, orderId), eq(orders.ownerId, accountId)))
    .limit(1);
  if (!order) return null;

  const items = await db
    .select({
      id: orderItems.id,
      equipmentId: orderItems.equipmentId,
      basis: orderItems.basis,
      rate: orderItems.rate,
      actualQty: orderItems.actualQty,
      billedQty: orderItems.billedQty,
      units: orderItems.units,
      lineAmount: orderItems.lineAmount,
      // Where this line's stock was picked from. Null = the godown.
      pickFromCustomerId: orderItems.pickFromCustomerId,
      pickFromCustomerName: pickFromCustomer.name,
      equipmentName: equipment.name,
      equipmentCode: equipment.code,
      unit: equipment.unit,
    })
    .from(orderItems)
    .leftJoin(equipment, eq(orderItems.equipmentId, equipment.id))
    .leftJoin(pickFromCustomer, eq(orderItems.pickFromCustomerId, pickFromCustomer.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt));

  const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, orderId)).limit(1);

  return { order, items, invoice: invoice ?? null };
}

export async function setOrderStatus(
  accountId: string,
  orderId: string,
  from: string[],
  to: string,
  extra: Partial<{ approvedAt: Date; dispatchedAt: Date; lockedByDriverId: string | null }> = {},
) {
  const [row] = await db
    .update(orders)
    .set({ status: to, ...extra })
    .where(and(eq(orders.id, orderId), eq(orders.ownerId, accountId), inArray(orders.status, from)))
    .returning();
  if (row) return row;

  // The update matched nothing. That is only an error if the order is NOT
  // already where this caller wanted it. Replaying a queued action (the offline
  // outbox, or a double click) arrives here with the transition already done —
  // and reporting that as a failure is what made the banner claim work had been
  // lost when it had in fact been applied.
  const current = await getOrder(accountId, orderId);
  if (current && current.order.status === to) {
    return { ...current.order, alreadyApplied: true as const };
  }
  return null;
}

/**
 * Lock an approved order for dispatch by a driver → status becomes on_transit.
 *
 * The locker becomes the order's TRANSITER and the one whose location is
 * tracked and the only one allowed to dispatch it. Recording it here (rather
 * than relying on `driverId`) is what lets a driver B lock an order that driver
 * A created: `driverId` stays A (the creator), `transitedByDriverId` is B.
 *
 * The locker's own vehicle is snapshotted onto the order here
 * (`transitVehicleId`). That is the whole point of the column: an order taken by
 * one driver and locked by another must show the LOCKER's truck on the road,
 * while `vehicleId` keeps the vehicle it was originally created with.
 *
 * `vehicleId` is optional — when the locker has no vehicle assigned today this
 * stays null, and the UI honestly shows no vehicle rather than inheriting the
 * creating driver's.
 */
export async function lockOrderForDispatch(
  accountId: string,
  orderId: string,
  driverId: string,
  vehicleId: string | null = null,
  sources: Array<{ orderItemId: string; sourceCustomerId: string | null }> = [],
) {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return { ok: false as const, reason: "not_found" as const };

  // ── "Pick From": work out what has to come back from a customer ────────────
  //
  // Everything is READ and ALLOCATED here, before the transaction, because
  // `atomic` sends every statement at once and cannot branch on a result. Each
  // allocation carries a SQL guard that re-checks the quantity it was computed
  // from, so a concurrent pick cannot take the same units twice.
  const today = kathmanduToday();
  const byItem = new Map(sources.map((s) => [s.orderItemId, s.sourceCustomerId ?? null]));

  const picks: Array<{
    newItemId: string;
    equipmentId: string;
    customerId: string;
    customerName: string;
    qty: number;
    sourceOrderId: string;
    sourceItemId: string;
    sourceReturnedQty: number;
  }> = [];

  for (const it of detail.items) {
    const customerId = byItem.get(it.id) ?? null;
    if (!customerId) continue; // godown — nothing to bring back

    const want = Number(it.actualQty);
    if (want <= 0) continue;

    // The lines at that customer still holding this item, oldest first, so the
    // stock that has been out longest is the stock that comes back.
    const held = await db
      .select({
        itemId: orderItems.id,
        orderId: orderItems.orderId,
        actualQty: orderItems.actualQty,
        returnedQty: orderItems.returnedQty,
        customerName: customers.name,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .where(
        and(
          eq(orders.ownerId, accountId),
          eq(orders.status, "on_rent"),
          eq(orders.customerId, customerId),
          eq(orderItems.equipmentId, it.equipmentId),
          sql`${orderItems.actualQty} - ${orderItems.returnedQty} > 0`,
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orderItems.createdAt));

    const available = round2(held.reduce((s, h) => s + (Number(h.actualQty) - Number(h.returnedQty)), 0));
    if (available < want) {
      return {
        ok: false as const,
        reason: "insufficient_source" as const,
        equipmentName: it.equipmentName ?? "Item",
        customerName: held[0]?.customerName ?? "that customer",
        available,
        requested: want,
      };
    }

    let left = want;
    for (const h of held) {
      if (left <= 0) break;
      const free = round2(Number(h.actualQty) - Number(h.returnedQty));
      const take = Math.min(free, left);
      if (take <= 0) continue;
      picks.push({
        newItemId: it.id,
        equipmentId: it.equipmentId,
        customerId,
        customerName: h.customerName,
        qty: take,
        sourceOrderId: h.orderId,
        sourceItemId: h.itemId,
        sourceReturnedQty: Number(h.returnedQty),
      });
      left = round2(left - take);
    }
  }

  // Which source orders end up fully picked, so they can be closed as returned.
  const sourceOrderIds = [...new Set(picks.map((p) => p.sourceOrderId))];

  const [row] = await atomic((d) => {
    const stmts: BatchItem<"pg">[] = [
      d
        .update(orders)
        .set({
          status: "on_transit",
          lockedByDriverId: driverId,
          transitedByDriverId: driverId,
          transitVehicleId: vehicleId,
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.ownerId, accountId),
            eq(orders.status, "approved"),
            isNull(orders.lockedByDriverId),
          ),
        )
        .returning(),
    ];

    // Persist the chosen source on each line, so the order detail page can say
    // where the stock came from long after the lock.
    for (const it of detail.items) {
      const customerId = byItem.get(it.id) ?? null;
      if (!customerId) continue;
      stmts.push(
        d
          .update(orderItems)
          .set({ pickFromCustomerId: customerId })
          .where(and(eq(orderItems.id, it.id), eq(orderItems.orderId, orderId))),
      );
    }

    // The automatic "Return from <customer>" movements. Each one:
    //   * belongs to the SOURCE order (that is the customer it came back from),
    //     so that order's own ledger and closing figures stay true;
    //   * is flagged `autoReturn` and linked to the order being locked, which is
    //     how the owner's undo-lock finds exactly these and nothing else;
    //   * takes the quantity off `onRentQty` — the stock has left the customer.
    //     The dispatch that follows puts it straight back on rent, so the net
    //     effect on stock on hand is zero, which is correct: the item is still
    //     out on rent, just with a different customer.
    for (const p of picks) {
      stmts.push(
        d
          .update(orderItems)
          .set({ returnedQty: sql`${orderItems.returnedQty} + ${p.qty}` })
          .where(
            and(
              eq(orderItems.id, p.sourceItemId),
              // Guard: only if nobody else has moved this line since we read it.
              sql`${orderItems.returnedQty} = ${p.sourceReturnedQty}`,
            ),
          ),
      );
      stmts.push(
        d.insert(stockMovements).values({
          ownerId: accountId,
          equipmentId: p.equipmentId,
          orderId: p.sourceOrderId,
          type: "in",
          qty: p.qty,
          dateAd: today.ad,
          dateBs: today.bsIso,
          driverId,
          actorName: null,
          sourceCustomerId: p.customerId,
          autoReturn: true,
          autoReturnForOrderId: orderId,
          note: `Stock received from ${p.customerName} — picked for the new order`,
        }),
      );
      stmts.push(
        d
          .update(equipment)
          .set({ onRentQty: sql`GREATEST(${equipment.onRentQty} - ${p.qty}, 0)` })
          .where(and(eq(equipment.id, p.equipmentId), eq(equipment.ownerId, accountId))),
      );
    }

    // A source order whose every line has now been picked from is finished: it
    // has nothing left at the customer, so it is closed as returned rather than
    // sitting on the On Rent list claiming stock it no longer has.
    for (const sourceOrderId of sourceOrderIds) {
      stmts.push(
        d
          .update(orders)
          .set({ status: "returned", returnedAt: sql`now()` })
          .where(
            and(
              eq(orders.id, sourceOrderId),
              eq(orders.ownerId, accountId),
              eq(orders.status, "on_rent"),
              sql`NOT EXISTS (
                SELECT 1 FROM ${orderItems}
                WHERE ${orderItems.orderId} = ${sourceOrderId}
                  AND ${orderItems.actualQty} - ${orderItems.returnedQty} > 0
              )`,
            ),
          ),
      );
    }

    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  if (row) return { ...row, autoReturns: picks.length };

  // Already locked? Only the SAME driver replaying their own lock is a success;
  // another driver finding it locked is a genuine refusal and stays null.
  const current = await getOrder(accountId, orderId);
  if (current && current.order.lockedByDriverId === driverId && current.order.status !== "approved") {
    return { ...current.order, alreadyApplied: true as const };
  }
  return null;
}

/** Dispatch: issue the sales invoice, move Actual Qty onto rent, log stock out.
 *
 * `driverId` is the driver making the call (null when the owner does it). Only
 * the driver who LOCKED the order may dispatch it, and the restriction is
 * enforced in SQL (the `locked_by_driver_id = ...` guard on the status update),
 * not just in the UI — so a second driver racing the same order gets a clean
 * refusal rather than a double dispatch.
 */
/**
 * The delivery point captured on the dispatching driver's device.
 *
 * `status` is the honest record of what happened, and it is what decides whether
 * coordinates are stored at all:
 *   'captured'    — a real fix; lat/lng are required and stored
 *   'unavailable' — permission denied or no fix; NOTHING is stored but the status
 * A dispatch is never blocked by a missing fix, so this is always optional.
 */
export interface DeliveryCapture {
  status: "captured" | "unavailable";
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  address?: string | null;
  capturedAt?: Date | null;
}

export async function dispatchOrder(
  accountId: string,
  orderId: string,
  driverId: string | null = null,
  actorName: string | null = null,
  delivery: DeliveryCapture | null = null,
) {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return { ok: false as const, reason: "not_found" as const };

  // Replay of a dispatch that already happened. The order is past `on_transit`,
  // so there is nothing to do — but that is SUCCESS, not a refusal: the trip is
  // on the road, the invoice exists. Only the owner, the locker or whoever
  // actually dispatched it may claim that; anyone else is still refused.
  if (detail.order.status === "on_rent" || detail.order.status === "returned") {
    const allowed =
      driverId === null ||
      driverId === detail.order.lockedByDriverId ||
      driverId === detail.order.dispatchedByDriverId;
    if (!allowed) return { ok: false as const, reason: "not_locker" as const };
    const existing = await db.select().from(invoices).where(eq(invoices.orderId, orderId)).limit(1);
    return { ok: true as const, alreadyApplied: true as const, invoice: existing[0] ?? null, order: detail.order };
  }

  if (detail.order.status !== "on_transit") return { ok: false as const, reason: "bad_status" as const };

  // Only the driver who locked it may dispatch. The owner may always dispatch.
  const locker = detail.order.lockedByDriverId;
  if (driverId && locker && locker !== driverId) {
    return { ok: false as const, reason: "not_locker" as const };
  }

  const today = kathmanduToday();
  const subtotal = round2(detail.items.reduce((s, it) => s + it.lineAmount, 0));
  const seq =
    (await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.ownerId, accountId))).length + 1;
  const invoiceNo = `INV-${today.bs.year}-${String(seq).padStart(4, "0")}`;
  const invoiceId = crypto.randomUUID();

  const [inv, ord] = await atomic((d) => {
    const stmts = [
      d
        .insert(invoices)
        .values({
          id: invoiceId,
          ownerId: accountId,
          orderId,
          invoiceNo,
          invoiceDateAd: today.ad,
          invoiceDateBs: today.bsIso,
          subtotal,
          total: subtotal,
          amountDue: subtotal,
        })
        .returning(),
      d
        .update(orders)
        .set({
          status: "on_rent",
          dispatchedAt: new Date(),
          dispatchedByDriverId: driverId ?? locker ?? null,
          // The delivery point, captured on the dispatching device. Written in
          // the SAME statement as the status change, so an order can never be
          // on rent with a half-recorded location. `unavailable` stores the
          // status and nothing else — no fake coordinates.
          deliveryLocationStatus: delivery?.status ?? null,
          deliveryLatitude: delivery?.status === "captured" ? (delivery.latitude ?? null) : null,
          deliveryLongitude: delivery?.status === "captured" ? (delivery.longitude ?? null) : null,
          deliveryAccuracy: delivery?.status === "captured" ? (delivery.accuracy ?? null) : null,
          deliveryAddress: delivery?.address?.trim() ? delivery.address.trim() : null,
          deliveryCapturedAt: delivery?.capturedAt ?? (delivery ? new Date() : null),
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.ownerId, accountId),
            eq(orders.status, "on_transit"),
            // The SQL guard for "only the locker may dispatch". `locked_by_driver_id
            // IS NULL` covers an owner-created order that was approved without a
            // driver ever locking it.
            driverId ? eq(orders.lockedByDriverId, driverId) : sql`TRUE`,
          ),
        )
        .returning(),
      ...detail.items.map((it) =>
        d
          .update(equipment)
          .set({ onRentQty: sql`${equipment.onRentQty} + ${it.actualQty}` })
          .where(and(eq(equipment.id, it.equipmentId), eq(equipment.ownerId, accountId))),
      ),
      ...detail.items.map((it) =>
        d.insert(stockMovements).values({
          ownerId: accountId,
          equipmentId: it.equipmentId,
          orderId,
          type: "out",
          qty: it.actualQty,
          dateAd: today.ad,
          dateBs: today.bsIso,
          // The stock left with the driver who dispatched it — which is the
          // locker, not necessarily the driver who took the order.
          driverId: driverId ?? locker ?? null,
          actorName: actorName ?? null,
        }),
      ),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  if (!ord || (ord as unknown[]).length === 0) return { ok: false as const, reason: "bad_status" as const };
  return { ok: true as const, invoice: inv };
}

/** Pickup: rented products come back → off the On Rent list, back into Stock. */
export async function returnOrder(
  accountId: string,
  orderId: string,
  actor: { driverId: string | null; actorName: string | null } = { driverId: null, actorName: null },
) {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return { ok: false as const, reason: "not_found" as const };

  // Already picked up. Replaying the pickup must not restock the equipment a
  // second time — and must not be reported as a failure either.
  if (detail.order.status === "returned") {
    return { ok: true as const, alreadyApplied: true as const, order: detail.order };
  }
  if (detail.order.status !== "on_rent") return { ok: false as const, reason: "bad_status" as const };

  const today = kathmanduToday();
  const [ord] = await atomic((d) => {
    const stmts = [
      d
        .update(orders)
        .set({ status: "returned", returnedAt: sql`now()` })
        .where(and(eq(orders.id, orderId), eq(orders.ownerId, accountId), eq(orders.status, "on_rent")))
        .returning(),
      ...detail.items.map((it) =>
        d
          .update(equipment)
          .set({ onRentQty: sql`GREATEST(${equipment.onRentQty} - ${it.actualQty}, 0)` })
          .where(and(eq(equipment.id, it.equipmentId), eq(equipment.ownerId, accountId))),
      ),
      // The whole line has come back, so nothing is left at the customer. This is
      // what the "Pick From" availability query reads: a returned order must stop
      // offering stock it no longer holds.
      ...detail.items.map((it) =>
        d
          .update(orderItems)
          .set({ returnedQty: it.actualQty })
          .where(eq(orderItems.id, it.id)),
      ),
      ...detail.items.map((it) =>
        d.insert(stockMovements).values({
          ownerId: accountId,
          equipmentId: it.equipmentId,
          orderId,
          type: "in",
          qty: it.actualQty,
          dateAd: today.ad,
          dateBs: today.bsIso,
          // Whoever handed the stock back. A driver picking up on the road
          // names themselves; an owner-received return falls back to the
          // driver the order was running under, so the report never says
          // "returned by nobody" for a trip that had a driver on it.
          driverId: actor.driverId ?? detail.order.lockedByDriverId ?? null,
          actorName: actor.actorName ?? null,
        }),
      ),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });
  if (!ord || (ord as unknown[]).length === 0) return { ok: false as const, reason: "bad_status" as const };
  return { ok: true as const };
}

// ── owner "undo" ─────────────────────────────────────────────────────────────
//
// Two mistakes the owner can make that used to be permanent: locking an order
// for the wrong driver, and recording a return that never happened. Both are
// reversed here, and both are written so that a second attempt cannot reverse
// anything twice.
//
// The shape of every undo is the same:
//   * a GUARDED update (the WHERE clause names the exact state being undone), so
//     if anything moved on since, nothing is written and the caller is told;
//   * the reversal is recorded as its own row rather than by editing history —
//     for stock that is a `stock_movements` row pointing at the movement it
//     reverses, which the UNIQUE index makes impossible to duplicate;
//   * the before/after state is returned, so the router can put it in the audit
//     trail with the owner's reason.

/**
 * Undo a lock for dispatch: release the order back to `approved` so another
 * driver can take it.
 *
 * Refused once the order has been dispatched — a lock cannot be undone on its
 * own after the truck has left, because the dispatch, the invoice and the stock
 * movement all hang off it. The owner has to undo the dispatch first, and the
 * message says exactly that instead of failing vaguely.
 *
 * The creator is untouched: `createdByDriverId` and `driverId` still name
 * whoever took the order, so the history of who created it survives the undo.
 */
export async function undoLockForDispatch(accountId: string, orderId: string) {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return { ok: false as const, reason: "not_found" as const };

  const o = detail.order;

  // Already dispatched (or further): the lock is no longer a standalone fact.
  if (o.status === "on_rent" || o.status === "returned") {
    return { ok: false as const, reason: "already_dispatched" as const, order: o };
  }

  // Nothing to undo. Replaying the same undo is success, not a conflict — the
  // order is already back where the owner wanted it.
  if (!o.lockedByDriverId && o.status !== "on_transit") {
    return { ok: true as const, alreadyApplied: true as const, before: o, after: o };
  }

  if (o.status !== "on_transit" || !o.lockedByDriverId) {
    return { ok: false as const, reason: "not_locked" as const, order: o };
  }

  // The guarded update: only an order that is STILL on transit and STILL locked
  // by the driver we just read is released. A dispatch that lands between the
  // read and the write therefore wins, and this returns null.
  //
  // ── reversing the automatic "picked from a customer" returns ──
  //
  // If this lock was made with a "Pick from <customer>" source, it wrote `in`
  // movements against the SOURCE orders and took that quantity off `onRentQty`.
  // Releasing the lock has to put all of that back, or the stock would be
  // stranded: the customer would still be holding it, but the app would think it
  // had come home.
  //
  // Found by `autoReturnForOrderId` — the link the lock wrote — so this reverses
  // exactly the movements THIS lock created and never a driver's real return.
  // Each reversal is its own `out` row pointing at the `in` it undoes, and the
  // UNIQUE index on `reversal_of_id` makes a second undo impossible.
  const autoReturns = await db
    .select({
      id: stockMovements.id,
      equipmentId: stockMovements.equipmentId,
      orderId: stockMovements.orderId,
      qty: stockMovements.qty,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.ownerId, accountId),
        eq(stockMovements.autoReturnForOrderId, orderId),
        eq(stockMovements.autoReturn, true),
      ),
    );

  const alreadyReversed = new Set(
    (
      await db
        .select({ reversalOfId: stockMovements.reversalOfId })
        .from(stockMovements)
        .where(and(eq(stockMovements.ownerId, accountId), isNotNull(stockMovements.reversalOfId)))
    )
      .map((r) => r.reversalOfId)
      .filter(Boolean) as string[],
  );
  const toReverse = autoReturns.filter((m) => !alreadyReversed.has(m.id) && m.orderId !== null) as Array<{
    id: string;
    equipmentId: string;
    orderId: string;
    qty: number;
  }>;

  // Narrowed once, so the guarded update below compares against a real id rather
  // than a nullable column value.
  const lockedBy = o.lockedByDriverId;
  if (!lockedBy) return { ok: false as const, reason: "not_locked" as const, order: o };

  const today = kathmanduToday();

  const [row] = await atomic((d) => {
    const stmts: BatchItem<"pg">[] = [
      d
        .update(orders)
        .set({
          status: "approved",
          lockedByDriverId: null,
          transitedByDriverId: null,
          transitVehicleId: null,
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.ownerId, accountId),
            eq(orders.status, "on_transit"),
            eq(orders.lockedByDriverId, lockedBy),
          ),
        )
        .returning(),
    ];

    // The chosen source is no longer in force, so the order stops claiming it.
    for (const it of detail.items) {
      if (!it.pickFromCustomerId) continue;
      stmts.push(
        d
          .update(orderItems)
          .set({ pickFromCustomerId: null })
          .where(and(eq(orderItems.id, it.id), eq(orderItems.orderId, orderId))),
      );
    }

    for (const m of toReverse) {
      // The stock goes back to the customer it was picked from: the `in` is
      // undone by an `out`, and `onRentQty` goes back up.
      stmts.push(
        d.insert(stockMovements).values({
          ownerId: accountId,
          equipmentId: m.equipmentId,
          orderId: m.orderId,
          type: "out",
          qty: m.qty,
          dateAd: today.ad,
          dateBs: today.bsIso,
          driverId: null,
          actorName: null,
          reversalOfId: m.id,
          note: "Undo lock — the pick from this customer was cancelled",
        }),
      );
      stmts.push(
        d
          .update(equipment)
          .set({ onRentQty: sql`${equipment.onRentQty} + ${m.qty}` })
          .where(and(eq(equipment.id, m.equipmentId), eq(equipment.ownerId, accountId))),
      );
      // The source line is holding that quantity again.
      stmts.push(
        d
          .update(orderItems)
          .set({ returnedQty: sql`GREATEST(${orderItems.returnedQty} - ${m.qty}, 0)` })
          .where(
            and(
              eq(orderItems.orderId, m.orderId),
              eq(orderItems.equipmentId, m.equipmentId),
              sql`${orderItems.returnedQty} >= ${m.qty}`,
            ),
          ),
      );
      // A source order that the pick had closed is on rent again.
      stmts.push(
        d
          .update(orders)
          .set({ status: "on_rent", returnedAt: null })
          .where(
            and(
              eq(orders.id, m.orderId),
              eq(orders.ownerId, accountId),
              eq(orders.status, "returned"),
            ),
          ),
      );
    }

    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  if (!row) {
    // Lost the race. Re-read to say which way it went.
    const now = await getOrder(accountId, orderId);
    if (now && (now.order.status === "on_rent" || now.order.status === "returned")) {
      return { ok: false as const, reason: "already_dispatched" as const, order: now.order };
    }
    if (now && !now.order.lockedByDriverId) {
      return { ok: true as const, alreadyApplied: true as const, before: o, after: now.order };
    }
    return { ok: false as const, reason: "not_locked" as const, order: now?.order ?? o };
  }

  return { ok: true as const, before: o, after: row, reversedAutoReturns: toReverse.length };
}

/**
 * Undo a return: put the order back on rent and take the restocked quantity off
 * the shelf again.
 *
 * What is reversed, precisely:
 *   * the order goes `returned` → `on_rent`, so it is returnable again;
 *   * every `in` movement this order wrote gets a matching `out` reversal row
 *     (`reversalOfId` = the movement it reverses, `note` = the owner's reason),
 *     so the ledger keeps both the mistake and the correction and the running
 *     balance stays true;
 *   * `equipment.onRentQty` goes back UP by the same quantity, which is what
 *     makes the Stock report's closing figure agree with the ledger again.
 *
 * The invoice is NOT deleted or renumbered: a return never closed it in this
 * app (there is no "closed" state on an invoice — it is a record of what was
 * billed, and the money side is driven by receipts). Undoing a return therefore
 * leaves the invoice exactly as it was, which is the correct outcome: the
 * customer was billed for a rental that is, once again, still running.
 *
 * Idempotent by construction: the reversal rows carry a UNIQUE `reversal_of_id`,
 * so a second undo cannot insert a second set. It reports `alreadyApplied`
 * instead of double-restocking.
 */
export async function undoReturnFromCustomer(accountId: string, orderId: string, reason: string | null = null) {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return { ok: false as const, reason: "not_found" as const };

  const o = detail.order;

  // The `in` movements this order wrote, and whether each is already reversed.
  //
  // `autoReturn` rows are EXCLUDED: those are the "picked from this customer"
  // returns that ANOTHER order's lock wrote. They are reversed by undoing that
  // lock, not by undoing this order's return — reversing them here would take
  // stock off the shelf for a pick that is still in force.
  const inMoves = await db
    .select({ id: stockMovements.id, equipmentId: stockMovements.equipmentId, qty: stockMovements.qty })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.ownerId, accountId),
        eq(stockMovements.orderId, orderId),
        eq(stockMovements.type, "in"),
        eq(stockMovements.autoReturn, false),
      ),
    )
    .orderBy(asc(stockMovements.createdAt));

  const reversals = await db
    .select({ reversalOfId: stockMovements.reversalOfId })
    .from(stockMovements)
    .where(and(eq(stockMovements.ownerId, accountId), eq(stockMovements.orderId, orderId)));
  const reversed = new Set(reversals.map((r) => r.reversalOfId).filter(Boolean) as string[]);

  const pending = inMoves.filter((m) => !reversed.has(m.id));

  // Already undone: the order is back on rent and every return has a reversal.
  // Success, not a conflict — nothing is written twice.
  if (o.status === "on_rent" && pending.length === 0) {
    return { ok: true as const, alreadyApplied: true as const, before: o, after: o, reversedMovements: 0 };
  }

  // The state moved on since the return (e.g. it was dispatched again, or the
  // order was edited into another status). Refuse rather than guess.
  if (o.status !== "returned") {
    return { ok: false as const, reason: "not_returned" as const, order: o };
  }
  if (pending.length === 0) {
    // Status says returned but the ledger has no un-reversed return to undo.
    return { ok: false as const, reason: "nothing_to_reverse" as const, order: o };
  }

  const today = kathmanduToday();

  const [ord] = await atomic((d) => {
    const stmts = [
      // Guarded: only an order that is STILL `returned` goes back on rent.
      d
        .update(orders)
        .set({ status: "on_rent", returnedAt: null })
        .where(and(eq(orders.id, orderId), eq(orders.ownerId, accountId), eq(orders.status, "returned")))
        .returning(),
      // Put the stock back on rent — the exact inverse of what the return did.
      ...pending.map((m) =>
        d
          .update(equipment)
          .set({ onRentQty: sql`${equipment.onRentQty} + ${m.qty}` })
          .where(and(eq(equipment.id, m.equipmentId), eq(equipment.ownerId, accountId))),
      ),
      // The order is on rent again, so its lines are once more fully at the
      // customer. Without this the "Pick From" list would keep offering stock
      // that this order has just taken back.
      ...detail.items.map((it) =>
        d.update(orderItems).set({ returnedQty: 0 }).where(eq(orderItems.id, it.id)),
      ),
      // The reversal rows. `reversalOfId` is UNIQUE, so a duplicate insert here
      // fails the whole transaction rather than double-counting stock.
      ...pending.map((m) =>
        d.insert(stockMovements).values({
          ownerId: accountId,
          equipmentId: m.equipmentId,
          orderId,
          type: "out",
          qty: m.qty,
          dateAd: today.ad,
          dateBs: today.bsIso,
          driverId: o.lockedByDriverId ?? null,
          actorName: null,
          reversalOfId: m.id,
          // The owner's reason, so the ledger row explains itself.
          note: reason,
        }),
      ),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  if (!ord || (ord as unknown[]).length === 0) {
    const now = await getOrder(accountId, orderId);
    if (now && now.order.status === "on_rent") {
      return { ok: true as const, alreadyApplied: true as const, before: o, after: now.order, reversedMovements: 0 };
    }
    return { ok: false as const, reason: "not_returned" as const, order: now?.order ?? o };
  }

  return {
    ok: true as const,
    before: o,
    after: (ord as unknown[])[0] as typeof o,
    reversedMovements: pending.length,
  };
}

export async function listOnRent(accountId: string) {
  // On rent IS the trip, so the driver and vehicle shown are the LOCKER's — an
  // order taken by one driver and dispatched by another must name the driver
  // who actually carried it.
  const transiter = alias(drivers, "rent_transiter");
  const tripVehicle = alias(vehicles, "rent_trip_vehicle");
  return db
    .select({
      id: orders.id,
      status: orders.status,
      orderDateBs: orders.orderDateBs,
      dispatchedAt: orders.dispatchedAt,
      customerName: customers.name,
      driverName: transiter.name,
      creatorName: drivers.name,
      vehicleName: tripVehicle.name,
      vehicleNumber: tripVehicle.number,
      invoiceNo: invoices.invoiceNo,
      // The deployed equipment's actual location: captured at dispatch, with the
      // customer's saved site as the fallback for older orders.
      deliveryAddress: orders.deliveryAddress,
      deliveryLatitude: orders.deliveryLatitude,
      deliveryLongitude: orders.deliveryLongitude,
      deliveryCapturedAt: orders.deliveryCapturedAt,
      deliveryLocationStatus: orders.deliveryLocationStatus,
      customerAddress: customers.address,
      customerLatitude: customers.latitude,
      customerLongitude: customers.longitude,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(drivers, eq(orders.driverId, drivers.id))
    .leftJoin(transiter, eq(orders.lockedByDriverId, transiter.id))
    .leftJoin(vehicles, eq(orders.vehicleId, vehicles.id))
    .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
    .leftJoin(invoices, eq(invoices.orderId, orders.id))
    .where(and(eq(orders.ownerId, accountId), eq(orders.status, "on_rent")))
    .orderBy(desc(orders.dispatchedAt));
}

// ── invoices ─────────────────────────────────────────────────────────────────

export async function listInvoices(accountId: string) {
  return db
    .select({
      id: invoices.id,
      invoiceNo: invoices.invoiceNo,
      invoiceDateAd: invoices.invoiceDateAd,
      invoiceDateBs: invoices.invoiceDateBs,
      subtotal: invoices.subtotal,
      total: invoices.total,
      amountDue: invoices.amountDue,
      orderId: invoices.orderId,
      orderStatus: orders.status,
      customerName: customers.name,
      driverName: drivers.name,
    })
    .from(invoices)
    .leftJoin(orders, eq(invoices.orderId, orders.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(drivers, eq(orders.driverId, drivers.id))
    .where(eq(invoices.ownerId, accountId))
    .orderBy(desc(invoices.createdAt));
}

// ── dashboard ────────────────────────────────────────────────────────────────

export async function dashboardSummary(accountId: string) {
  const [orderRows, invRows, equipRows, custRows, vehRows, drvRows] = await Promise.all([
    db.select({ status: orders.status }).from(orders).where(eq(orders.ownerId, accountId)),
    db
      .select({ total: invoices.total, amountDue: invoices.amountDue })
      .from(invoices)
      .where(eq(invoices.ownerId, accountId)),
    db
      .select({ totalQty: equipment.totalQty, onRentQty: equipment.onRentQty })
      .from(equipment)
      .where(eq(equipment.ownerId, accountId)),
    db.select({ id: customers.id }).from(customers).where(eq(customers.ownerId, accountId)),
    db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.ownerId, accountId)),
    db.select({ id: drivers.id }).from(drivers).where(eq(drivers.ownerId, accountId)),
  ]);

  const byStatus: Record<string, number> = {};
  for (const r of orderRows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const totalQty = equipRows.reduce((s, r) => s + Number(r.totalQty), 0);
  const onRentQty = equipRows.reduce((s, r) => s + Number(r.onRentQty), 0);

  return {
    orders: {
      total: orderRows.length,
      pending: byStatus.pending_approval ?? 0,
      approved: byStatus.approved ?? 0,
      onTransit: byStatus.on_transit ?? 0,
      onRent: byStatus.on_rent ?? 0,
      returned: byStatus.returned ?? 0,
      rejected: byStatus.rejected ?? 0,
    },
    invoices: {
      count: invRows.length,
      total: round2(invRows.reduce((s, r) => s + Number(r.total), 0)),
      amountDue: round2(invRows.reduce((s, r) => s + Number(r.amountDue), 0)),
    },
    stock: {
      totalQty,
      onRentQty,
      availableQty: round2(totalQty - onRentQty),
      items: equipRows.length,
    },
    customers: custRows.length,
    vehicles: vehRows.length,
    drivers: drvRows.length,
  };
}

// ── seed ─────────────────────────────────────────────────────────────────────

export async function seedDemoData(accountId: string) {
  const existing = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.ownerId, accountId));
  if (existing.length > 0) return { seeded: false as const };

  const vehicleSeed = [
    { name: "Truck 1", number: "BA 1 KHA 1234", type: "Truck" },
    { name: "Truck 2", number: "BA 2 KHA 2345", type: "Truck" },
    { name: "Tipper 1", number: "BA 3 KHA 3456", type: "Tipper" },
    { name: "Tipper 2", number: "BA 4 KHA 4567", type: "Tipper" },
    { name: "Pickup 1", number: "BA 5 KHA 5678", type: "Pickup" },
    { name: "Pickup 2", number: "BA 6 KHA 6789", type: "Pickup" },
    { name: "Crane Truck", number: "BA 7 KHA 7890", type: "Crane" },
  ];
  const driverSeed = [
    { name: "Ram Bahadur", phone: "9800000001", licenseNo: "DL-1001" },
    { name: "Shyam Thapa", phone: "9800000002", licenseNo: "DL-1002" },
    { name: "Hari Gurung", phone: "9800000003", licenseNo: "DL-1003" },
    { name: "Bikash Lama", phone: "9800000004", licenseNo: "DL-1004" },
    { name: "Suresh Rai", phone: "9800000005", licenseNo: "DL-1005" },
    { name: "Dipesh Magar", phone: "9800000006", licenseNo: "DL-1006" },
    { name: "Kiran Shrestha", phone: "9800000007", licenseNo: "DL-1007" },
  ];
  const equipmentSeed = [
    { name: "Concrete Mixer", code: "EQ-MIX", unit: "pcs", totalQty: 12 },
    { name: "Scaffolding Set", code: "EQ-SCF", unit: "set", totalQty: 40 },
    { name: "Vibrator Machine", code: "EQ-VIB", unit: "pcs", totalQty: 8 },
    { name: "Water Pump", code: "EQ-PMP", unit: "pcs", totalQty: 10 },
    { name: "Generator 5KVA", code: "EQ-GEN", unit: "pcs", totalQty: 6 },
    { name: "Jack Hammer", code: "EQ-JHK", unit: "pcs", totalQty: 9 },
    { name: "Steel Pillar (Shoring)", code: "EQ-PLR", unit: "pillar", totalQty: 120 },
    { name: "Centering Plate", code: "EQ-CTP", unit: "pcs", totalQty: 200 },
  ];
  const customerSeed = [
    { name: "Himalaya Builders", phone: "9811111111", address: "Kathmandu" },
    { name: "Everest Construction", phone: "9822222222", address: "Lalitpur" },
    { name: "Annapurna Infra", phone: "9833333333", address: "Bhaktapur" },
  ];

  await atomic((d) => {
    const stmts = [
      d.insert(vehicles).values(vehicleSeed.map((v) => ({ ownerId: accountId, ...v }))).returning(),
      d.insert(drivers).values(driverSeed.map((v) => ({ ownerId: accountId, ...v }))).returning(),
      d.insert(equipment).values(equipmentSeed.map((v) => ({ ownerId: accountId, ...v }))).returning(),
      d.insert(customers).values(customerSeed.map((v) => ({ ownerId: accountId, ...v }))).returning(),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });
  return { seeded: true as const };
}

// ── owner review & edit of a pending order ────────────────────────────────────

export interface OrderEdit {
  customerId: string;
  driverId: string | null;
  vehicleId: string | null;
  notes: string | null;
  /** "YYYY-MM-DD" in AD, or null to leave the order's date untouched. */
  orderDateAd: string | null;
}

/**
 * Owner edits every field of an order that is still awaiting approval, INCLUDING
 * replacing its line items wholesale. This is the single place an approved
 * order's money/stock inputs can be corrected before they are frozen.
 *
 * Written as ONE statement (a CTE), not an `atomic([...])` batch, because the
 * whole edit is a single unit of work with a single guard. It is atomic for
 * free — one statement is one implicit transaction — and the guard
 * (`status = 'pending_approval'`) is evaluated once and reused by the DELETE and
 * the INSERT, so a concurrent approve cannot leave the order with HALF-edited
 * lines:
 *
 *   * `ok`   — the guarded header update. Empty when the order is no longer
 *              pending, which is the "somebody got there first" signal.
 *   * `del`  — drops the old lines, gated on `ok`.
 *   * INSERT — writes the new lines, gated on `ok`. Per the Postgres rules on
 *              data-modifying CTEs, the sub-statements share one snapshot and
 *              cannot see each other's writes, so `del` can never delete the
 *              rows this INSERT adds regardless of execution order.
 *
 * Returns false (zero rows) when the order was not pending_approval — the caller
 * turns that into a CONFLICT rather than silently reporting success.
 */
export async function updatePendingOrder(
  accountId: string,
  orderId: string,
  edit: OrderEdit,
  items: OrderItemInput[],
): Promise<boolean> {
  const orderDateBs = edit.orderDateAd ? bsIso(adIsoToBs(edit.orderDateAd)) : null;

  const itemsJson = JSON.stringify(
    items.map((it) => ({
      equipment_id: it.equipmentId,
      basis: it.basis,
      rate: it.rate,
      actual_qty: it.actualQty,
      billed_qty: it.billedQty,
      units: it.units,
    })),
  );

  const result = await db.execute(sql`
    WITH ok AS (
      UPDATE orders SET
        customer_id   = ${edit.customerId}::uuid,
        driver_id     = ${edit.driverId}::uuid,
        vehicle_id    = ${edit.vehicleId}::uuid,
        notes         = ${edit.notes}::text,
        order_date_ad = COALESCE(${edit.orderDateAd}::text, order_date_ad),
        order_date_bs = COALESCE(${orderDateBs}::text, order_date_bs)
      WHERE id = ${orderId}::uuid
        AND owner_id = ${accountId}::uuid
        AND status = 'pending_approval'
      RETURNING id
    ),
    del AS (
      DELETE FROM order_items
       WHERE order_id = ${orderId}::uuid AND EXISTS (SELECT 1 FROM ok)
    ),
    ins AS (
      INSERT INTO order_items
        (id, order_id, equipment_id, basis, rate, actual_qty, billed_qty, units, line_amount)
      SELECT gen_random_uuid(), ${orderId}::uuid, v.equipment_id, v.basis, v.rate,
             v.actual_qty, v.billed_qty, v.units,
             round((v.rate * v.units * v.billed_qty)::numeric, 2)
        FROM jsonb_to_recordset(${itemsJson}::jsonb)
          AS v(equipment_id uuid, basis text, rate float8, actual_qty float8, billed_qty float8, units float8)
       WHERE EXISTS (SELECT 1 FROM ok)
      RETURNING id
    )
    SELECT (SELECT count(*) FROM ok)::int AS updated
  `);

  const rows = Array.isArray(result)
    ? (result as Array<{ updated: number }>)
    : (((result as unknown as { rows?: Array<{ updated: number }> }).rows) ?? []);
  return (rows[0]?.updated ?? 0) > 0;
}

// ── password reset (forgot-password OTP) ──────────────────────────────────────

/** Find an account by email (case-insensitive). */
export async function findUserByEmail(email: string) {
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row ?? null;
}

/** Reset requests for one account since `since` — the per-user rate limit. */
export async function countResetRequestsForUser(userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: passwordResetCodes.id })
    .from(passwordResetCodes)
    .where(and(eq(passwordResetCodes.userId, userId), gte(passwordResetCodes.createdAt, since)));
  return rows.length;
}

/** Reset requests from one IP since `since` — the per-IP rate limit. */
export async function countResetRequestsForIp(ip: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: passwordResetCodes.id })
    .from(passwordResetCodes)
    .where(and(eq(passwordResetCodes.requestIp, ip), gte(passwordResetCodes.createdAt, since)));
  return rows.length;
}

/** The newest request from this IP — drives the "wait N seconds" resend cooldown. */
export async function latestResetRequestForIp(ip: string): Promise<{ createdAt: Date } | null> {
  const [row] = await db
    .select({ createdAt: passwordResetCodes.createdAt })
    .from(passwordResetCodes)
    .where(eq(passwordResetCodes.requestIp, ip))
    .orderBy(desc(passwordResetCodes.createdAt))
    .limit(1);
  return row ?? null;
}

/** Issue a code, invalidating any earlier unconsumed one for the same account. */
export async function createResetCode(input: {
  userId: string;
  codeHash: string;
  expiresAt: Date;
  requestIp: string | null;
}): Promise<void> {
  await atomic((d) => {
    const stmts = [
      d
        .update(passwordResetCodes)
        .set({ consumedAt: new Date() })
        .where(
          and(eq(passwordResetCodes.userId, input.userId), isNull(passwordResetCodes.consumedAt)),
        ),
      d.insert(passwordResetCodes).values({
        userId: input.userId,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        requestIp: input.requestIp,
      }),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });
}

/** The account's current (unconsumed) code row. */
export async function activeResetCode(userId: string) {
  const [row] = await db
    .select()
    .from(passwordResetCodes)
    .where(and(eq(passwordResetCodes.userId, userId), isNull(passwordResetCodes.consumedAt)))
    .orderBy(desc(passwordResetCodes.createdAt))
    .limit(1);
  return row ?? null;
}

/** Count one failed attempt against a code so it cannot be brute-forced. */
export async function bumpResetAttempts(id: string): Promise<void> {
  await db
    .update(passwordResetCodes)
    .set({ attempts: sql`${passwordResetCodes.attempts} + 1` })
    .where(eq(passwordResetCodes.id, id));
}

/** Single-use: mark the code used. Zero rows means another call already used it. */
export async function consumeResetCode(id: string): Promise<boolean> {
  const rows = await db
    .update(passwordResetCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(passwordResetCodes.id, id), isNull(passwordResetCodes.consumedAt)))
    .returning({ id: passwordResetCodes.id });
  return rows.length > 0;
}

/** Write a new password hash for the account. */
export async function setUserPassword(userId: string, passwordHash: string): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

// ── customer ledger & receipts ────────────────────────────────────────────────
//
// A customer's ledger is DERIVED, never stored:
//
//     due = openingBalance + Σ sales invoices − Σ receipts
//
// Invoices are reached through the order they belong to (invoices has no
// customerId of its own), so the join goes invoices → orders → customers, which
// also keeps every row account-scoped by `orders.ownerId`.

/**
 * Due balance for every customer in the account, as a Map keyed by customer id.
 * Used to show the current due on the Customers list in one round trip.
 */
export async function customerDueMap(accountId: string): Promise> {
  const [custRows, invRows, recRows] = await Promise.all([
    db
      .select({ id: customers.id, opening: customers.openingBalance })
      .from(customers)
      .where(eq(customers.ownerId, accountId)),
    db
      .select({ customerId: orders.customerId, total: invoices.total })
      .from(invoices)
      .innerJoin(orders, eq(invoices.orderId, orders.id))
      .where(eq(invoices.ownerId, accountId)),
    db
      .select({ customerId: receipts.customerId, amount: receipts.amount })
      .from(receipts)
      .where(eq(receipts.ownerId, accountId)),
  ]);

  const map = new Map<string, number>();
  for (const c of custRows) map.set(c.id, Number(c.opening) || 0);
  for (const i of invRows) map.set(i.customerId, (map.get(i.customerId) ?? 0) + (Number(i.total) || 0));
  for (const r of recRows) map.set(r.customerId, (map.get(r.customerId) ?? 0) - (Number(r.amount) || 0));
  for (const [k, v] of map) map.set(k, round2(v));
  return map;
}

/**
 * One customer's full ledger: opening balance, every sales invoice (debit), every
 * receipt (credit) and the running/closing due. Entries are merged into a single
 * date-ordered series with a running balance, which is exactly what the ledger
 * page renders.
 */
export async function getCustomerLedger(
  accountId: string,
  customerId: string,
  range?: { fromAd: string | null; toAd: string | null },
) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
    .limit(1);
  if (!customer) return null;

  const [invRows, recRows] = await Promise.all([
    db
      .select({
        id: invoices.id,
        invoiceNo: invoices.invoiceNo,
        dateAd: invoices.invoiceDateAd,
        dateBs: invoices.invoiceDateBs,
        total: invoices.total,
        orderId: invoices.orderId,
        orderStatus: orders.status,
      })
      .from(invoices)
      .innerJoin(orders, eq(invoices.orderId, orders.id))
      .where(and(eq(invoices.ownerId, accountId), eq(orders.customerId, customerId))),
    db
      .select({
        id: receipts.id,
        amount: receipts.amount,
        mode: receipts.mode,
        referenceNo: receipts.referenceNo,
        notes: receipts.notes,
        dateAd: receipts.dateAd,
        dateBs: receipts.dateBs,
        createdAt: receipts.createdAt,
      })
      .from(receipts)
      .where(and(eq(receipts.ownerId, accountId), eq(receipts.customerId, customerId)))
      .orderBy(desc(receipts.createdAt)),
  ]);

  const itemsByInvoice = new Map<string, { name: string; qty: number }[]>();
  if (invRows.length > 0) {
    const lineRows = await db
      .select({
        invoiceId: invoices.id,
        equipmentName: equipment.name,
        qty: sql<number>`sum(coalesce(nullif(${orderItems.billedQty}, 0), ${orderItems.actualQty}))::float8`,
      })
      .from(invoices)
      .innerJoin(orderItems, eq(orderItems.orderId, invoices.orderId))
      .innerJoin(equipment, eq(orderItems.equipmentId, equipment.id))
      .where(
        and(
          eq(invoices.ownerId, accountId),
          inArray(
            invoices.id,
            invRows.map((i) => i.id),
          ),
        ),
      )
      .groupBy(invoices.id, equipment.name)
      .orderBy(asc(equipment.name));

    for (const l of lineRows) {
      const list = itemsByInvoice.get(l.invoiceId) ?? [];
      list.push({ name: l.equipmentName, qty: Number(l.qty) || 0 });
      itemsByInvoice.set(l.invoiceId, list);
    }
  }

  const opening = Number(customer.openingBalance) || 0;
  const built = buildLedger(
    opening,
    invRows.map((i) => ({
      id: i.id,
      number: i.invoiceNo,
      dateAd: i.dateAd,
      dateBs: i.dateBs,
      total: Number(i.total) || 0,
      items: itemsByInvoice.get(i.id) ?? [],
    })),
    recRows.map((r) => ({
      id: r.id,
      amount: Number(r.amount) || 0,
      dateAd: r.dateAd,
      dateBs: r.dateBs,
      description: `Receipt${r.referenceNo ? ` — ${r.referenceNo}` : ""} (${r.mode})`,
    })),
  );

  const { rows, totals } = sliceLedger(
    built.rows,
    opening,
    range?.fromAd ?? null,
    range?.toAd ?? null,
  );

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      openingBalance: round2(opening),
    },
    rows,
    totals,
    closingDueAll: built.totals.closingDue,
  };
}

/** Record money received from a customer. Returns the created receipt. */
export async function createReceipt(input: {
  ownerId: string;
  customerId: string;
  amount: number;
  mode: string;
  referenceNo?: string | null;
  notes?: string | null;
  dateAd?: string | null;
}) {
  const today = kathmanduToday();
  const dateAd = input.dateAd && /^\d{4}-\d{2}-\d{2}$/.test(input.dateAd) ? input.dateAd : today.ad;
  const dateBs = dateAd === today.ad ? today.bsIso : bsIso(adIsoToBs(dateAd));

  const [row] = await db
    .insert(receipts)
    .values({
      ownerId: input.ownerId,
      customerId: input.customerId,
      amount: round2(input.amount),
      mode: input.mode,
      referenceNo: input.referenceNo?.trim() ? input.referenceNo.trim() : null,
      notes: input.notes?.trim() ? input.notes.trim() : null,
      dateAd,
      dateBs,
    })
    .returning();
  return row;
}

/** All receipts in the account, newest first, with the customer name. */
export async function listReceipts(accountId: string) {
  return db
    .select({
      id: receipts.id,
      amount: receipts.amount,
      mode: receipts.mode,
      referenceNo: receipts.referenceNo,
      notes: receipts.notes,
      dateAd: receipts.dateAd,
      dateBs: receipts.dateBs,
      createdAt: receipts.createdAt,
      customerId: receipts.customerId,
      customerName: customers.name,
    })
    .from(receipts)
    .leftJoin(customers, eq(receipts.customerId, customers.id))
    .where(eq(receipts.ownerId, accountId))
    .orderBy(desc(receipts.createdAt));
}

export async function deleteReceipt(accountId: string, id: string) {
  const rows = await db
    .delete(receipts)
    .where(and(eq(receipts.id, id), eq(receipts.ownerId, accountId)))
    .returning({ id: receipts.id });
  return rows.length > 0;
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ── live GPS vehicle tracking ─────────────────────────────────────────────────

export const ACTIVE_TRIP_STATUSES = ["on_transit", "on_rent"] as const;

export async function recordTripLocation(input: {
  ownerId: string;
  driverId: string;
  orderId: string | null;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  recordedAt?: Date | null;
}) {
  const [row] = await db
    .insert(tripLocations)
    .values({
      ownerId: input.ownerId,
      driverId: input.driverId,
      orderId: input.orderId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy ?? null,
      speed: input.speed ?? null,
      heading: input.heading ?? null,
      recordedAt: input.recordedAt ?? new Date(),
    })
    .returning();
  return row;
}

export async function latestDriverLocations(accountId: string) {
  const tripVehicle = alias(vehicles, "loc_trip_vehicle");
  const currentCustomer = alias(customers, "loc_current_customer");
  const liveTrip = db
    .selectDistinctOn([orders.lockedByDriverId], {
      id: orders.id,
      driverId: orders.lockedByDriverId,
      status: orders.status,
      customerId: orders.customerId,
    })
    .from(orders)
    .where(inArray(orders.status, [...ACTIVE_TRIP_STATUSES]))
    .orderBy(orders.lockedByDriverId, desc(orders.createdAt))
    .as("loc_live_trip");
  const latest = db
    .selectDistinctOn([tripLocations.driverId], {
      id: tripLocations.id,
      driverId: tripLocations.driverId,
      orderId: tripLocations.orderId,
      latitude: tripLocations.latitude,
      longitude: tripLocations.longitude,
      accuracy: tripLocations.accuracy,
      speed: tripLocations.speed,
      heading: tripLocations.heading,
      recordedAt: tripLocations.recordedAt,
    })
    .from(tripLocations)
    .where(eq(tripLocations.ownerId, accountId))
    .orderBy(tripLocations.driverId, desc(tripLocations.recordedAt))
    .as("latest");

  return db
    .select({
      id: latest.id,
      driverId: latest.driverId,
      orderId: latest.orderId,
      latitude: latest.latitude,
      longitude: latest.longitude,
      accuracy: latest.accuracy,
      speed: latest.speed,
      heading: latest.heading,
      recordedAt: latest.recordedAt,
      driverName: drivers.name,
      driverPhone: drivers.phone,
      vehicleName: tripVehicle.name,
      vehicleNumber: tripVehicle.number,
      orderStatus: orders.status,
      customerName: customers.name,
      currentOrderId: liveTrip.id,
      currentOrderStatus: liveTrip.status,
      currentCustomerName: currentCustomer.name,
    })
    .from(latest)
    .leftJoin(drivers, eq(latest.driverId, drivers.id))
    .leftJoin(orders, eq(latest.orderId, orders.id))
    .leftJoin(vehicles, eq(orders.vehicleId, vehicles.id))
    .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(liveTrip, eq(liveTrip.driverId, latest.driverId))
    .leftJoin(currentCustomer, eq(liveTrip.customerId, currentCustomer.id))
    .where(inArray(orders.status, [...ACTIVE_TRIP_STATUSES]))
    .orderBy(asc(drivers.name));
}

export async function activeTrips(accountId: string) {
  const transiter = alias(drivers, "trip_transiter");
  const tripVehicle = alias(vehicles, "trip_vehicle");
  return db
    .select({
      orderId: orders.id,
      status: orders.status,
      orderDateAd: orders.orderDateAd,
      orderDateBs: orders.orderDateBs,
      driverId: orders.lockedByDriverId,
      driverName: transiter.name,
      createdByName: drivers.name,
      vehicleName: tripVehicle.name,
      vehicleNumber: tripVehicle.number,
      customerId: orders.customerId,
      customerName: customers.name,
      customerAddress: customers.address,
      latitude: customers.latitude,
      longitude: customers.longitude,
      deliveryAddress: orders.deliveryAddress,
      deliveryLatitude: orders.deliveryLatitude,
      deliveryLongitude: orders.deliveryLongitude,
      deliveryCapturedAt: orders.deliveryCapturedAt,
      deliveryLocationStatus: orders.deliveryLocationStatus,
      dispatchedAt: orders.dispatchedAt,
    })
    .from(orders)
    .leftJoin(drivers, eq(orders.driverId, drivers.id))
    .leftJoin(transiter, eq(orders.lockedByDriverId, transiter.id))
    .leftJoin(vehicles, eq(orders.vehicleId, vehicles.id))
    .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(and(eq(orders.ownerId, accountId), inArray(orders.status, [...ACTIVE_TRIP_STATUSES])))
    .orderBy(desc(orders.createdAt));
}

export async function trackingBoard(accountId: string) {
  const transiter = alias(drivers, "board_transiter");
  const tripVehicle = alias(vehicles, "board_trip_vehicle");

  const [active, locked, recentRows] = await Promise.all([
    db
      .select({
        orderId: orders.id,
        status: orders.status,
        driverId: orders.lockedByDriverId,
        driverName: transiter.name,
        driverPhone: transiter.phone,
        vehicleName: tripVehicle.name,
        vehicleNumber: tripVehicle.number,
        customerId: orders.customerId,
        customerName: customers.name,
        customerAddress: customers.address,
        customerPhone: customers.phone,
        latitude: customers.latitude,
        longitude: customers.longitude,
        deliveryAddress: orders.deliveryAddress,
        deliveryLatitude: orders.deliveryLatitude,
        deliveryLongitude: orders.deliveryLongitude,
        deliveryCapturedAt: orders.deliveryCapturedAt,
        deliveryLocationStatus: orders.deliveryLocationStatus,
        dispatchedAt: orders.dispatchedAt,
        orderDateAd: orders.orderDateAd,
        orderDateBs: orders.orderDateBs,
      })
      .from(orders)
      .leftJoin(transiter, eq(orders.lockedByDriverId, transiter.id))
      .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .where(and(eq(orders.ownerId, accountId), eq(orders.status, "on_rent")))
      .orderBy(desc(orders.createdAt)),

    db
      .select({
        orderId: orders.id,
        status: orders.status,
        driverId: orders.lockedByDriverId,
        driverName: transiter.name,
        driverPhone: transiter.phone,
        vehicleName: tripVehicle.name,
        vehicleNumber: tripVehicle.number,
        orderDateAd: orders.orderDateAd,
        orderDateBs: orders.orderDateBs,
        approvedAt: orders.approvedAt,
      })
      .from(orders)
      .leftJoin(transiter, eq(orders.lockedByDriverId, transiter.id))
      .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
      .where(and(eq(orders.ownerId, accountId), eq(orders.status, "on_transit")))
      .orderBy(desc(orders.createdAt)),

    db
      .select({
        orderId: orders.id,
        status: orders.status,
        driverName: transiter.name,
        vehicleName: tripVehicle.name,
        vehicleNumber: tripVehicle.number,
        customerName: customers.name,
        orderDateBs: orders.orderDateBs,
        dispatchedAt: orders.dispatchedAt,
        returnedAt: orders.returnedAt,
      })
      .from(orders)
      .leftJoin(transiter, eq(orders.lockedByDriverId, transiter.id))
      .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .where(
        and(
          eq(orders.ownerId, accountId),
          eq(orders.status, "returned"),
          isNotNull(orders.returnedAt),
          gte(orders.returnedAt, sql`now() - interval '24 hours'`),
        ),
      )
      .orderBy(desc(orders.returnedAt))
      .limit(1),
  ]);

  let recentItems: { name: string; qty: number }[] = [];
  const recent = recentRows[0] ?? null;
  if (recent) {
    const lines = await db
      .select({
        name: equipment.name,
        qty: sql<number>`sum(${orderItems.actualQty})::float8`,
      })
      .from(orderItems)
      .innerJoin(equipment, eq(orderItems.equipmentId, equipment.id))
      .where(eq(orderItems.orderId, recent.orderId))
      .groupBy(equipment.name)
      .orderBy(asc(equipment.name));
    recentItems = lines.map((l) => ({ name: l.name, qty: Number(l.qty) || 0 }));
  }

  return {
    active,
    locked,
    recent: recent ? { ...recent, items: recentItems } : null,
    at: new Date().toISOString(),
  };
}

export async function tripHistory(accountId: string, orderId: string) {
  return db
    .select({
      id: tripLocations.id,
      latitude: tripLocations.latitude,
      longitude: tripLocations.longitude,
      accuracy: tripLocations.accuracy,
      speed: tripLocations.speed,
      heading: tripLocations.heading,
      recordedAt: tripLocations.recordedAt,
    })
    .from(tripLocations)
    .where(and(eq(tripLocations.ownerId, accountId), eq(tripLocations.orderId, orderId)))
    .orderBy(asc(tripLocations.recordedAt));
}

export async function driverActiveTrip(accountId: string, driverId: string) {
  const tripVehicle = alias(vehicles, "active_trip_vehicle");
  const [row] = await db
    .select({
      orderId: orders.id,
      status: orders.status,
      customerName: customers.name,
      customerAddress: customers.address,
      latitude: customers.latitude,
      longitude: customers.longitude,
      vehicleName: tripVehicle.name,
      vehicleNumber: tripVehicle.number,
      orderDateBs: orders.orderDateBs,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(vehicles, eq(orders.vehicleId, vehicles.id))
    .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
    .where(
      and(
        eq(orders.ownerId, accountId),
        eq(orders.lockedByDriverId, driverId),
        inArray(orders.status, [...ACTIVE_TRIP_STATUSES]),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(1);
  return row ?? null;
}

export async function lastPingAt(accountId: string, driverId: string) {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${tripLocations.recordedAt})` })
    .from(tripLocations)
    .where(and(eq(tripLocations.ownerId, accountId), eq(tripLocations.driverId, driverId)));
  return row?.at ?? null;
}

export async function tripsWithHistory(accountId: string, limit = 50) {
  const transiter = alias(drivers, "hist_transiter");
  const tripVehicle = alias(vehicles, "hist_trip_vehicle");
  const agg = db
    .select({
      orderId: tripLocations.orderId,
      points: sql<number>`count(*)::int`.as("points"),
      lastAt: sql<Date>`max(${tripLocations.recordedAt})`.as("last_at"),
    })
    .from(tripLocations)
    .where(and(eq(tripLocations.ownerId, accountId), isNotNull(tripLocations.orderId)))
    .groupBy(tripLocations.orderId)
    .as("agg");

  return db
    .select({
      orderId: agg.orderId,
      points: agg.points,
      lastAt: agg.lastAt,
      status: orders.status,
      orderDateAd: orders.orderDateAd,
      orderDateBs: orders.orderDateBs,
      driverName: transiter.name,
      vehicleName: tripVehicle.name,
      vehicleNumber: tripVehicle.number,
      customerName: customers.name,
    })
    .from(agg)
    .leftJoin(orders, eq(agg.orderId, orders.id))
    .leftJoin(drivers, eq(orders.driverId, drivers.id))
    .leftJoin(transiter, eq(orders.lockedByDriverId, transiter.id))
    .leftJoin(vehicles, eq(orders.vehicleId, vehicles.id))
    .leftJoin(tripVehicle, eq(orders.transitVehicleId, tripVehicle.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .orderBy(desc(agg.lastAt))
    .limit(limit);
}

export async function setCustomerLocation(
  accountId: string,
  customerId: string,
  latitude: number | null,
  longitude: number | null,
) {
  const [row] = await db
    .update(customers)
    .set({ latitude, longitude })
    .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
    .returning();
  return row ?? null;
}

export { adIsoToBs, bsIso };

// ── audit trail ─────────────────────────────────────────────────────────────

export type AuditAction = "create" | "update" | "delete";
export type AuditEntity =
  | "order"
  | "customer"
  | "equipment"
  | "vehicle"
  | "receipt"
  | "invoice"
  | "user"
  | "driver";

export async function writeAuditLog(entry: {
  ownerId: string;
  actorUserId: string;
  actorName?: string | null;
  actorRole?: string;
  action: AuditAction;
  entity: AuditEntity;
  targetId?: string | null;
  targetLabel?: string | null;
  summary?: string | null;
  detail?: unknown;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      ownerId: entry.ownerId,
      actorUserId: entry.actorUserId,
      actorName: entry.actorName ?? null,
      actorRole: entry.actorRole ?? "owner",
      action: entry.action,
      entity: entry.entity,
      targetId: entry.targetId ?? null,
      targetLabel: entry.targetLabel ?? null,
      summary: entry.summary ?? null,
      detail:
        entry.detail === undefined || entry.detail === null
          ? null
          : JSON.stringify(entry.detail),
    });
  } catch (err) {
    console.error("[audit] failed to write entry", entry.entity, entry.action, err);
  }
}

export async function listAuditLog(accountId: string, opts: { entity?: string; limit?: number } = {}) {
  const conds = [eq(auditLog.ownerId, accountId)];
  if (opts.entity) conds.push(eq(auditLog.entity, opts.entity));
  return db
    .select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(opts.limit ?? 200, 500));
}

// ── cascade summaries ───────────────────────────────────────────────────────

export async function orderCascadeSummary(accountId: string, orderId: string) {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return null;
  const inv = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.ownerId, accountId)));
  const receiptsForCustomer = detail.order.customerId
    ? await db
        .select({ id: receipts.id })
        .from(receipts)
        .where(and(eq(receipts.customerId, detail.order.customerId), eq(receipts.ownerId, accountId)))
    : [];
  const pings = await db
    .select({ id: tripLocations.id })
    .from(tripLocations)
    .where(and(eq(tripLocations.orderId, orderId), eq(tripLocations.ownerId, accountId)));
  const moves = await db
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(and(eq(stockMovements.orderId, orderId), eq(stockMovements.ownerId, accountId)));

  const holdsStock = detail.order.status === "on_rent" || detail.order.status === "on_transit";
  return {
    orderNumber: orderId.slice(0, 8).toUpperCase(),
    customerName: detail.order.customerName ?? "—",
    status: detail.order.status,
    lineItems: detail.items.length,
    invoices: inv.length,
    customerReceiptsKept: receiptsForCustomer.length,
    trackingPings: pings.length,
    stockMovements: moves.length,
    releasesStock: holdsStock
      ? detail.items.map((it) => ({ name: it.equipmentName ?? "—", qty: Number(it.actualQty) }))
      : [],
  };
}

async function releaseOrderStock(
  accountId: string,
  orderId: string,
  items: Array<{ equipmentId: string; actualQty: unknown }>,
) {
  const today = kathmanduToday();
  const held = items.filter((it) => Number(it.actualQty) > 0);
  if (held.length === 0) return;
  await atomic((d) => {
    const stmts = [
      ...held.map((it) =>
        d
          .update(equipment)
          .set({ onRentQty: sql`GREATEST(${equipment.onRentQty} - ${Number(it.actualQty)}, 0)` })
          .where(and(eq(equipment.id, it.equipmentId), eq(equipment.ownerId, accountId))),
      ),
      ...held.map((it) =>
        d.insert(stockMovements).values({
          ownerId: accountId,
          equipmentId: it.equipmentId,
          orderId,
          type: "in",
          qty: Number(it.actualQty),
          dateAd: today.ad,
          dateBs: today.bsIso,
        }),
      ),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });
}

export async function deleteOrder(accountId: string, orderId: string) {
  const detail = await getOrder(accountId, orderId);
  if (!detail) return null;

  if (detail.order.status === "on_rent" || detail.order.status === "on_transit") {
    await releaseOrderStock(accountId, orderId, detail.items);
  }

  const scope = and(eq(orders.ownerId, accountId), eq(orders.id, orderId));

  await atomic((d) => {
    const stmts = [
      d.delete(tripLocations).where(and(eq(tripLocations.ownerId, accountId), eq(tripLocations.orderId, orderId))),
      d.delete(stockMovements).where(and(eq(stockMovements.ownerId, accountId), eq(stockMovements.orderId, orderId))),
      d.delete(invoices).where(and(eq(invoices.ownerId, accountId), eq(invoices.orderId, orderId))),
      d.delete(orderItems).where(eq(orderItems.orderId, orderId)),
      d.delete(orders).where(scope),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  return detail.order;
}

export async function editOrderAnyStage(
  accountId: string,
  orderId: string,
  edit: {
    customerId?: string;
    driverId?: string | null;
    vehicleId?: string | null;
    notes?: string | null;
    status?: string;
    orderDateAd?: string | null;
  },
  items?: OrderItemInput[],
) {
  const before = await getOrder(accountId, orderId);
  if (!before) return null;

  const oldItems = before.items;
  const orderDateBs = edit.orderDateAd ? bsIso(adIsoToBs(edit.orderDateAd)) : null;
  const holdsStock = before.order.status === "on_rent";

  const itemsJson = items
    ? JSON.stringify(
        items.map((it) => ({
          equipment_id: it.equipmentId,
          basis: it.basis,
          rate: it.rate,
          actual_qty: it.actualQty,
          billed_qty: it.billedQty,
          units: it.units,
        })),
      )
    : null;

  await db.execute(sql`
    WITH upd AS (
      UPDATE orders SET
        customer_id   = COALESCE(${edit.customerId ?? null}::uuid, customer_id),
        driver_id     = ${edit.driverId === undefined ? sql`driver_id` : sql`${edit.driverId}::uuid`},
        vehicle_id    = ${edit.vehicleId === undefined ? sql`vehicle_id` : sql`${edit.vehicleId}::uuid`},
        notes         = ${edit.notes === undefined ? sql`notes` : sql`${edit.notes}::text`},
        status        = COALESCE(${edit.status ?? null}::text, status),
        order_date_ad = COALESCE(${edit.orderDateAd ?? null}::text, order_date_ad),
        order_date_bs = COALESCE(${orderDateBs}::text, order_date_bs)
      WHERE id = ${orderId}::uuid AND owner_id = ${accountId}::uuid
      RETURNING id
    ),
    del AS (
      DELETE FROM order_items
       WHERE order_id = ${orderId}::uuid
         AND ${itemsJson === null}::boolean IS FALSE
         AND EXISTS (SELECT 1 FROM upd)
    ),
    ins AS (
      INSERT INTO order_items
        (id, order_id, equipment_id, basis, rate, actual_qty, billed_qty, units, line_amount)
      SELECT gen_random_uuid(), ${orderId}::uuid, v.equipment_id, v.basis, v.rate,
             v.actual_qty, v.billed_qty, v.units,
             round((v.rate * v.units * v.billed_qty)::numeric, 2)
        FROM jsonb_to_recordset(COALESCE(${itemsJson}::jsonb, '[]'::jsonb))
          AS v(equipment_id uuid, basis text, rate float8, actual_qty float8, billed_qty float8, units float8)
       WHERE ${itemsJson === null}::boolean IS FALSE
         AND EXISTS (SELECT 1 FROM upd)
      RETURNING id
    )
    SELECT (SELECT count(*) FROM upd)::int AS updated
  `);

  const after = await getOrder(accountId, orderId);
  if (!after) return null;

  if (holdsStock && items) {
    const oldByEquip = new Map<string, number>();
    for (const it of oldItems) {
      oldByEquip.set(it.equipmentId, (oldByEquip.get(it.equipmentId) ?? 0) + Number(it.actualQty));
    }
    const newByEquip = new Map<string, number>();
    for (const it of after.items) {
      newByEquip.set(it.equipmentId, (newByEquip.get(it.equipmentId) ?? 0) + Number(it.actualQty));
    }

    const deltas = new Map<string, number>();
    for (const id of new Set([...oldByEquip.keys(), ...newByEquip.keys()])) {
      const d = (newByEquip.get(id) ?? 0) - (oldByEquip.get(id) ?? 0);
      if (d !== 0) deltas.set(id, d);
    }

    if (deltas.size > 0) {
      await atomic((d) => {
        const stmts = [...deltas.entries()].map(([equipId, delta]) =>
          d
            .update(equipment)
            .set({ onRentQty: sql`GREATEST(${equipment.onRentQty} + ${delta}, 0)` })
            .where(and(eq(equipment.id, equipId), eq(equipment.ownerId, accountId))),
        );
        return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
      });
    }
  }

  const subtotal = round2(after.items.reduce((s, it) => s + Number(it.lineAmount), 0));
  if (after.invoice) {
    const paid = round2(Number(after.invoice.total) - Number(after.invoice.amountDue));
    await db
      .update(invoices)
      .set({ subtotal, total: subtotal, amountDue: round2(Math.max(subtotal - paid, 0)) })
      .where(and(eq(invoices.orderId, orderId), eq(invoices.ownerId, accountId)));
  }

  return { before, after };
}

// ── customers ───────────────────────────────────────────────────────────────

export async function customerCascadeSummary(accountId: string, customerId: string) {
  const [c] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
    .limit(1);
  if (!c) return null;

  const ords = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.ownerId, accountId)));
  const invs = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.ownerId, accountId),
        sql`${invoices.orderId} IN (SELECT id FROM orders WHERE customer_id = ${customerId}::uuid)`,
      ),
    );
  const recs = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.ownerId, accountId), eq(receipts.customerId, c.id)));

  return {
    customerName: c.name,
    orders: ords.length,
    openOrders: ords.filter((o) => o.status === "on_rent" || o.status === "on_transit").length,
    invoices: invs.length,
    receipts: recs.length,
    orderIds: ords.map((o) => o.id),
  };
}

export async function deleteCustomer(accountId: string, customerId: string) {
  const summary = await customerCascadeSummary(accountId, customerId);
  if (!summary) return null;

  for (const orderId of summary.orderIds) {
    const detail = await getOrder(accountId, orderId);
    if (detail && (detail.order.status === "on_rent" || detail.order.status === "on_transit")) {
      await releaseOrderStock(accountId, orderId, detail.items);
    }
  }

  await atomic((d) => {
    const stmts = [
      d.delete(tripLocations).where(
        and(
          eq(tripLocations.ownerId, accountId),
          sql`${tripLocations.orderId} IN (SELECT id FROM orders WHERE customer_id = ${customerId}::uuid)`,
        ),
      ),
      d.delete(receipts).where(and(eq(receipts.ownerId, accountId), eq(receipts.customerId, customerId))),
      d.delete(invoices).where(
        and(
          eq(invoices.ownerId, accountId),
          sql`${invoices.orderId} IN (SELECT id FROM orders WHERE customer_id = ${customerId}::uuid)`,
        ),
      ),
      d.delete(orderItems).where(
        sql`${orderItems.orderId} IN (SELECT id FROM orders WHERE customer_id = ${customerId}::uuid AND owner_id = ${accountId}::uuid)`,
      ),
      d.delete(orders).where(and(eq(orders.ownerId, accountId), eq(orders.customerId, customerId))),
      d.delete(customers).where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId))),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  return summary;
}

export async function editCustomer(
  accountId: string,
  customerId: string,
  patch: {
    name?: string;
    phone?: string | null;
    address?: string | null;
    openingBalance?: number;
    latitude?: number | null;
    longitude?: number | null;
  },
) {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.address !== undefined) set.address = patch.address;
  if (patch.openingBalance !== undefined) set.openingBalance = round2(patch.openingBalance);
  if (patch.latitude !== undefined) set.latitude = patch.latitude;
  if (patch.longitude !== undefined) set.longitude = patch.longitude;
  if (Object.keys(set).length === 0) {
    const [row] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
      .limit(1);
    return row ?? null;
  }

  const [current] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
    .limit(1);
  if (!current) return null;
  const nextName = patch.name !== undefined ? patch.name : current.name;
  const nextPhone = patch.phone !== undefined ? patch.phone : current.phone;
  const existing = await listCustomers(accountId);
  const dup = findDuplicateCustomer(existing, { name: nextName, phone: nextPhone }, customerId);
  if (dup) throw new DuplicateCustomerError(duplicateCustomerMessage(dup), dup.id, dup.name);

  const [row] = await db
    .update(customers)
    .set(set)
    .where(and(eq(customers.id, customerId), eq(customers.ownerId, accountId)))
    .returning();
  return row ?? null;
}

// ── equipment / vehicles ────────────────────────────────────────────────────

export async function equipmentCascadeSummary(accountId: string, equipmentId: string) {
  const [e] = await db
    .select()
    .from(equipment)
    .where(and(eq(equipment.id, equipmentId), eq(equipment.ownerId, accountId)))
    .limit(1);
  if (!e) return null;

  const lines = await db
    .select({ orderId: orderItems.orderId, qty: orderItems.actualQty })
    .from(orderItems)
    .where(eq(orderItems.equipmentId, equipmentId));
  const moves = await db
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(and(eq(stockMovements.equipmentId, equipmentId), eq(stockMovements.ownerId, accountId)));

  return {
    equipmentName: e.name,
    code: e.code,
    onRentQty: Number(e.onRentQty),
    orderLines: lines.length,
    affectedOrders: new Set(lines.map((l) => l.orderId)).size,
    stockMovements: moves.length,
  };
}

export async function deleteEquipment(accountId: string, equipmentId: string) {
  const summary = await equipmentCascadeSummary(accountId, equipmentId);
  if (!summary) return null;

  const touched = await db
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(eq(orderItems.equipmentId, equipmentId));
  const touchedIds = [...new Set(touched.map((t) => t.orderId))];

  await atomic((d) => {
    const stmts = [
      d.delete(orderItems).where(eq(orderItems.equipmentId, equipmentId)),
      d.delete(stockMovements).where(and(eq(stockMovements.equipmentId, equipmentId), eq(stockMovements.ownerId, accountId))),
      d.delete(equipment).where(and(eq(equipment.id, equipmentId), eq(equipment.ownerId, accountId))),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  for (const orderId of touchedIds) {
    const detail = await getOrder(accountId, orderId);
    if (!detail) continue;
    if (detail.items.length === 0) {
      await atomic((d) => {
        const stmts = [
          d.delete(tripLocations).where(and(eq(tripLocations.ownerId, accountId), eq(tripLocations.orderId, orderId))),
          d.delete(receipts).where(and(eq(receipts.ownerId, accountId), eq(receipts.customerId, detail.order.customerId))),
          d.delete(invoices).where(and(eq(invoices.ownerId, accountId), eq(invoices.orderId, orderId))),
          d.delete(orders).where(and(eq(orders.id, orderId), eq(orders.ownerId, accountId))),
        ];
        return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
      });
      continue;
    }
    const subtotal = round2(detail.items.reduce((s, it) => s + Number(it.lineAmount), 0));
    if (detail.invoice) {
      const paid = round2(Number(detail.invoice.total) - Number(detail.invoice.amountDue));
      await db
        .update(invoices)
        .set({ subtotal, total: subtotal, amountDue: round2(Math.max(subtotal - paid, 0)) })
        .where(and(eq(invoices.orderId, orderId), eq(invoices.ownerId, accountId)));
    }
  }

  return summary;
}

export async function editEquipmentAnyStage(
  accountId: string,
  equipmentId: string,
  patch: { name?: string; code?: string | null; unit?: string; totalQty?: number },
) {
  if (patch.totalQty !== undefined) {
    const [e] = await db
      .select({ onRentQty: equipment.onRentQty, name: equipment.name })
      .from(equipment)
      .where(and(eq(equipment.id, equipmentId), eq(equipment.ownerId, accountId)))
      .limit(1);
    if (e && patch.totalQty < Number(e.onRentQty)) {
      return { ok: false as const, reason: "below_on_rent" as const, onRentQty: Number(e.onRentQty) };
    }
  }
  const [row] = await db
    .update(equipment)
    .set(patch)
    .where(and(eq(equipment.id, equipmentId), eq(equipment.ownerId, accountId)))
    .returning();
  return row ? ({ ok: true as const, row } as const) : null;
}

export async function vehicleCascadeSummary(accountId: string, vehicleId: string) {
  const [v] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.ownerId, accountId)))
    .limit(1);
  if (!v) return null;

  const [ords, assigns, audits, activeTrip] = await Promise.all([
    db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.ownerId, accountId),
          or(eq(orders.vehicleId, vehicleId), eq(orders.transitVehicleId, vehicleId))!,
        ),
      ),
    db
      .select({ id: vehicleAssignments.id })
      .from(vehicleAssignments)
      .where(and(eq(vehicleAssignments.vehicleId, vehicleId), eq(vehicleAssignments.ownerId, accountId))),
    db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, accountId), eq(auditLog.entity, "vehicle"), eq(auditLog.targetId, vehicleId))),
    db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.ownerId, accountId),
          or(eq(orders.transitVehicleId, vehicleId), eq(orders.vehicleId, vehicleId))!,
          inArray(orders.status, [...ACTIVE_TRIP_STATUSES]),
        ),
      )
      .limit(1),
  ]);

  const references = ords.length + assigns.length + audits.length;
  return {
    vehicleName: v.name,
    number: v.number,
    alreadyRetired: !v.isActive,
    ordersAssigned: ords.length,
    assignments: assigns.length,
    auditEntries: audits.length,
    references,
    onActiveTrip: activeTrip.length > 0,
    canHardDelete: references === 0 && activeTrip.length === 0,
    orderIds: ords.map((o) => o.id),
  };
}

export async function deleteVehicle(accountId: string, vehicleId: string) {
  const summary = await vehicleCascadeSummary(accountId, vehicleId);
  if (!summary) return { ok: false as const, reason: "not_found" as const };

  if (summary.onActiveTrip) return { ok: false as const, reason: "on_active_trip" as const, summary };
  if (summary.alreadyRetired) return { ok: false as const, reason: "already_retired" as const, summary };

  if (!summary.canHardDelete) {
    const row = await deactivateVehicle(accountId, vehicleId);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    return { ok: true as const, mode: "retired" as const, summary, vehicle: row };
  }

  await db.delete(vehicles).where(and(eq(vehicles.id, vehicleId), eq(vehicles.ownerId, accountId)));
  return { ok: true as const, mode: "deleted" as const, summary };
}

// ── receipts / invoices ─────────────────────────────────────────────────────

export async function editReceipt(
  accountId: string,
  id: string,
  patch: {
    amount?: number;
    mode?: string;
    referenceNo?: string | null;
    dateAd?: string | null;
  },
) {
  const set: Record<string, unknown> = {};
  if (patch.amount !== undefined) set.amount = round2(patch.amount);
  if (patch.mode !== undefined) set.mode = patch.mode;
  if (patch.referenceNo !== undefined) set.referenceNo = patch.referenceNo;
  if (patch.dateAd !== undefined) {
    set.dateAd = patch.dateAd;
    set.dateBs = patch.dateAd ? bsIso(adIsoToBs(patch.dateAd)) : null;
  }
  if (Object.keys(set).length === 0) return null;
  const [row] = await db
    .update(receipts)
    .set(set)
    .where(and(eq(receipts.id, id), eq(receipts.ownerId, accountId)))
    .returning();
  return row ?? null;
}

export async function editInvoice(
  accountId: string,
  id: string,
  patch: { subtotal?: number; total?: number; amountDue?: number; invoiceDateAd?: string | null },
) {
  const set: Record<string, unknown> = {};
  if (patch.subtotal !== undefined) set.subtotal = round2(patch.subtotal);
  if (patch.total !== undefined) set.total = round2(patch.total);
  if (patch.amountDue !== undefined) set.amountDue = round2(patch.amountDue);
  if (patch.invoiceDateAd !== undefined) {
    set.invoiceDateAd = patch.invoiceDateAd;
    set.invoiceDateBs = patch.invoiceDateAd ? bsIso(adIsoToBs(patch.invoiceDateAd)) : null;
  }
  if (Object.keys(set).length === 0) return null;
  const [row] = await db
    .update(invoices)
    .set(set)
    .where(and(eq(invoices.id, id), eq(invoices.ownerId, accountId)))
    .returning();
  return row ?? null;
}

export async function invoiceCascadeSummary(accountId: string, id: string) {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.ownerId, accountId)))
    .limit(1);
  if (!inv) return null;
  const [ord] = await db
    .select({ customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.id, inv.orderId))
    .limit(1);
  const recs = ord
    ? await db
        .select({ id: receipts.id })
        .from(receipts)
        .where(and(eq(receipts.customerId, ord.customerId), eq(receipts.ownerId, accountId)))
    : [];
  return {
    invoiceNo: inv.invoiceNo,
    total: Number(inv.total),
    linkedReceipts: recs.length,
  };
}

export async function deleteInvoice(accountId: string, id: string) {
  const summary = await invoiceCascadeSummary(accountId, id);
  if (!summary) return null;
  await db.delete(invoices).where(and(eq(invoices.id, id), eq(invoices.ownerId, accountId)));
  return summary;
}

// ── users / drivers ─────────────────────────────────────────────────────────

export async function userCascadeSummary(accountId: string, userId: string) {
  const [u] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return null;

  const [d] = await db
    .select({ id: drivers.id, name: drivers.name })
    .from(drivers)
    .where(and(eq(drivers.userId, userId), eq(drivers.ownerId, accountId)))
    .limit(1);

  const ords = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.ownerId, accountId),
        d
          ? or(
              eq(orders.driverId, d.id),
              eq(orders.createdByDriverId, d.id),
              eq(orders.transitedByDriverId, d.id),
              eq(orders.dispatchedByDriverId, d.id),
            )!
          : sql`FALSE`,
      ),
    );

  return {
    userName: u.name ?? u.email ?? "user",
    email: u.email,
    isDriver: Boolean(d),
    driverName: d?.name ?? null,
    ordersInvolved: ords.length,
    driverId: d?.id ?? null,
  };
}

export async function deleteUser(accountId: string, userId: string) {
  const summary = await userCascadeSummary(accountId, userId);
  if (!summary) return { ok: false as const, reason: "not_found" as const };
  if (userId === accountId) return { ok: false as const, reason: "is_owner" as const };

  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return { ok: false as const, reason: "not_found" as const };
  const profile = await getProfile(userId);
  if (profile && profile.ownerId !== accountId) return { ok: false as const, reason: "not_found" as const };

  await atomic((d) => {
    const stmts = [
      d.update(orders).set({ lockedByDriverId: null }).where(sql`${orders.lockedByDriverId} IN (SELECT id FROM drivers WHERE user_id = ${userId}::uuid)`),
      d.delete(drivers).where(and(eq(drivers.userId, userId), eq(drivers.ownerId, accountId))),
      d.delete(profiles).where(eq(profiles.userId, userId)),
      d.delete(users).where(eq(users.id, userId)),
    ];
    return stmts as unknown as [BatchItem<"pg">, ...BatchItem<"pg">[]];
  });

  return { ok: true as const, summary };
}

export async function editUser(
  accountId: string,
  userId: string,
  patch: { name?: string; email?: string; driverName?: string; driverPhone?: string | null },
) {
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return null;
  const profile = await getProfile(userId);
  if (profile && profile.ownerId !== accountId) return null;

  const userSet: Record<string, unknown> = {};
  if (patch.name !== undefined) userSet.name = patch.name;
  if (patch.email !== undefined) userSet.email = patch.email.trim().toLowerCase();

  if (Object.keys(userSet).length > 0) {
    await db.update(users).set(userSet).where(eq(users.id, userId));
  }
  if (patch.driverName !== undefined || patch.driverPhone !== undefined) {
    const driverSet: Record<string, unknown> = {};
    if (patch.driverName !== undefined) driverSet.name = patch.driverName;
    if (patch.driverPhone !== undefined) driverSet.phone = patch.driverPhone;
    await db
      .update(drivers)
      .set(driverSet)
      .where(and(eq(drivers.userId, userId), eq(drivers.ownerId, accountId)));
  }
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

// ── SMS notification log ──────────────────────────────────────────────────────

export async function orderRefFor(accountId: string, orderId: string): Promise<string | null> {
  const [target] = await db
    .select({ id: orders.id, dateAd: orders.orderDateAd, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.ownerId, accountId)))
    .limit(1);
  if (!target) return null;

  const sameDay = await db
    .select({ id: orders.id, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.ownerId, accountId), eq(orders.orderDateAd, target.dateAd)))
    .orderBy(asc(orders.createdAt));
  const idx = sameDay.findIndex((o) => o.id === target.id);
  return `ORD-${target.dateAd}-${idx + 1}`;
}

export async function getOrderSmsContext(accountId: string, orderId: string) {
  const [row] = await db
    .select({
      orderId: orders.id,
      status: orders.status,
      customerId: orders.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .where(and(eq(orders.id, orderId), eq(orders.ownerId, accountId)))
    .limit(1);
  if (!row) return null;

  const items = await db
    .select({
      equipmentName: equipment.name,
      qty: orderItems.actualQty,
    })
    .from(orderItems)
    .leftJoin(equipment, eq(orderItems.equipmentId, equipment.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt));

  return {
    orderId: row.orderId,
    status: row.status,
    customerId: row.customerId,
    customerName: row.customerName ?? null,
    customerPhone: row.customerPhone ?? null,
    orderRef: await orderRefFor(accountId, orderId),
    items: items.map((i) => ({ equipmentName: i.equipmentName ?? "Item", qty: Number(i.qty ?? 0) })),
  };
}

export async function logSmsNotification(input: {
  ownerId: string;
  orderId?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  orderRef?: string | null;
  event: string;
  toNumber?: string | null;
  body: string;
  status: string;
  providerSid?: string | null;
  error?: string | null;
}) {
  try {
    const [row] = await db
      .insert(smsNotifications)
      .values({
        ownerId: input.ownerId,
        orderId: input.orderId ?? null,
        customerId: input.customerId ?? null,
        customerName: input.customerName ?? null,
        orderRef: input.orderRef ?? null,
        event: input.event,
        toNumber: input.toNumber ?? null,
        body: input.body,
        status: input.status,
        providerSid: input.providerSid ?? null,
        error: input.error ?? null,
      })
      .returning();
    return row ?? null;
  } catch (e) {
    console.error("[sms] failed to write notification log", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function listSmsNotifications(accountId: string, limit = 100) {
  return db
    .select()
    .from(smsNotifications)
    .where(eq(smsNotifications.ownerId, accountId))
    .orderBy(desc(smsNotifications.createdAt))
    .limit(Math.min(Math.max(1, limit), 500));
}

export async function smsNotificationSummary(accountId: string) {
  const rows = await db
    .select({ status: smsNotifications.status, n: sql<number>`count(*)::int` })
    .from(smsNotifications)
    .where(eq(smsNotifications.ownerId, accountId))
    .groupBy(smsNotifications.status);
  const out = { sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    const n = Number(r.n ?? 0);
    if (r.status === "sent") out.sent += n;
    else if (r.status === "failed") out.failed += n;
    else if (r.status === "skipped") out.skipped += n;
    out.total += n;
  }
  return out;
}

// ── message-sending settings ────────────────────────────────────────────────

export async function getMessageMode(accountId: string): Promise<MessageMode> {
  const [row] = await db
    .select({ mode: messageSettings.messageMode })
    .from(messageSettings)
    .where(eq(messageSettings.ownerId, accountId))
    .limit(1);
  const mode = row?.mode;
  return MESSAGE_MODES.includes(mode as MessageMode) ? (mode as MessageMode) : "off";
}

export async function setMessageMode(accountId: string, mode: MessageMode): Promise<MessageMode> {
  await db
    .insert(messageSettings)
    .values({ ownerId: accountId, messageMode: mode, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: messageSettings.ownerId,
      set: { messageMode: mode, updatedAt: new Date() },
    });
  return getMessageMode(accountId);
}

export async function listCustomersForMessaging(accountId: string) {
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      address: customers.address,
    })
    .from(customers)
    .where(eq(customers.ownerId, accountId))
    .orderBy(asc(customers.name));

  return rows.map((c) => {
    const dialable = toSmsPasalNumber(c.phone);
    return {
      id: c.id,
      name: c.name,
      phone: c.phone ?? null,
      address: c.address ?? null,
      normalised: dialable,
      dialable: dialable !== null && isValidSmsPasalNumber(dialable),
    };
  });
}

export async function getCustomersForMessaging(accountId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
    })
    .from(customers)
    .where(and(eq(customers.ownerId, accountId), inArray(customers.id, ids)));
}