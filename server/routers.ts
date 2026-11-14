// ── AGENT-OWNED: tRPC API surface ─────────────────────────────────────────────
// Thin procedures: validate with zod, call server/db.ts, map expected failures to
// TRPCErrors. Auth is provided by _core — never reimplemented here.
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Context as HonoContext } from "hono";
import { hash as bcryptHash, compare as bcryptCompare } from "bcryptjs";
import { router, publicProcedure, protectedProcedure } from "./_core/trpc";
import { authProvider, registerLocalUser, AuthError, EmailTakenError } from "./_core/auth";
import { storageCommit, storageDeleteOwned, storageListByOwner, storagePutUrl, StorageError } from "./_core/storage";
import * as q from "./db";
import { kathmanduToday } from "../shared/bs-calendar";
import { resolveBsRange } from "../shared/bs-range";
import { sendMail, otpEmail } from "./services/smtp-mail";
import { notifyOrderStatus, sendTestSms } from "./services/order-sms";
import { sendCustomMessageToCustomers, sendDeliveryMessageForOrder } from "./services/bulk-sms";
import { missingSmsPasalVars, smsPasalConfigured } from "./services/sms-pasal";
import { MESSAGE_MODES, MAX_CUSTOM_MESSAGE_LENGTH, SMS_EVENTS } from "../shared/sms";
import { adminRouter } from "./admin-router";

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Reduce a caller-supplied filename to a safe basename.
 *
 * The storage key is `${uuid}-${sanitizeBasename(name)}`. The uuid prefix only
 * makes the key unguessable if the REST of the key is not attacker-controlled,
 * so this strips any directory component (`../../etc/passwd` → `passwd`) and
 * every character that is not a letter, digit, dot, dash or underscore.
 *
 * Two rules that are easy to get wrong, and both were observed in production:
 *
 *  · **The extension survives a non-ASCII stem.** The allowlist is ASCII-only,
 *    so a name written entirely in CJK (`风景.png`) loses its whole stem. If the
 *    leading-dot strip then ran over the result, it would eat the only dot left
 *    — the extension separator — and store `<uuid>-png`. So the extension is
 *    split off FIRST, the stem is sanitized, and a stem that sanitizes to
 *    nothing falls back to `upload` rather than to empty.
 *  · **A dotfile has no extension.** `.gitignore` is a stem, not a bare
 *    extension, so it becomes `gitignore` — not `upload.gitignore`.
 *
 * Exported for its unit test: it is a security boundary, so it is tested
 * directly rather than only through the upload procedure.
 */
export function sanitizeBasename(name: string): string {
  // Last path segment only — a surviving "/" or "\" would steer key segments.
  const base = name.split(/[/\\]/).pop() ?? "";

  // A dot at index 0 marks a dotfile, so it is not an extension separator:
  // `.png` is a stem, not a bare extension. Any dot AFTER index 0 is the
  // separator — including one preceded only by dots, which is why `...hidden`
  // reads as stem `..` + extension `hidden` and lands on `upload.hidden`.
  const dotAt = base.lastIndexOf(".");
  const hasExtension = dotAt > 0;

  const rawStem = hasExtension ? base.slice(0, dotAt) : base;
  const rawExt = hasExtension ? base.slice(dotAt + 1) : "";

  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "");
  const stem = clean(rawStem).replace(/^\.+/, "");
  // An over-long extension pads the key for no gain.
  const ext = clean(rawExt).replace(/^\.+/, "").slice(0, 10);

  const safeStem = stem || "upload";
  return ext ? `${safeStem}.${ext}` : safeStem;
}

const RESET_TTL_MS = 10 * 60_000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_COOLDOWN_MS = 60_000;
const RESET_MAX_PER_WINDOW = 5;
const RESET_WINDOW_MS = 60 * 60_000;

function clientIp(c: HonoContext): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const IP_SALT = randomInt(0, 2 ** 31).toString(36) + Date.now().toString(36);

function hashIp(ip: string): string {
  return createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex").slice(0, 32);
}

async function requireOwner(userId: string) {
  const profile = await q.getProfile(userId);
  if (!profile || profile.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can do this." });
  }
  return profile;
}

async function resolveDriver(accountId: string, userId: string) {
  return q.getDriverByUserId(accountId, userId);
}

async function actorNameFor(userId: string, accountId: string): Promise<string | null> {
  const d = await q.getDriverByUserId(accountId, userId);
  if (d?.name) return d.name;
  const p = await q.getProfile(userId);
  return p?.displayName ?? null;
}

/**
 * Run the automatic notification for an order transition, honouring the owner's
 * chosen message mode.
 *
 * The mode affects ONE event only — the dispatch. Everything else is exactly the
 * behaviour that existed before this feature, so no existing notification is
 * lost:
 *
 *   approved / on_transit / returned
 *       always send their status message, unconditionally.
 *
 *   delivered (the driver clicked Dispatch)
 *       when the mode is 'delivery', the delivery message is sent instead of the
 *       generic `delivered` status message — one clear "it has arrived" text
 *       rather than two about the same moment. In every other mode the normal
 *       `delivered` status message is sent, so the customer is still told.
 *
 * The order is already committed by the time this runs, so every branch is
 * best-effort and none of them can throw.
 */
async function notifyModeAware(
  accountId: string,
  orderId: string,
  event: "approved" | "on_transit" | "delivered" | "returned",
) {
  try {
    if (event === "delivered") {
      const mode = await q.getMessageMode(accountId);
      if (mode === "delivery") {
        await sendDeliveryMessageForOrder(accountId, orderId);
        return;
      }
    }
    await notifyOrderStatus(accountId, orderId, event);
  } catch (e) {
    console.error(`[sms] notification for ${event} on order ${orderId} threw`, e instanceof Error ? e.message : e);
  }
}

const basisEnum = z.enum(["day", "hour", "pillar"]);

const orderItemSchema = z.object({
  equipmentId: z.uuid(),
  basis: basisEnum,
  rate: z.number().min(0),
  actualQty: z.number().min(0),
  billedQty: z.number().min(0),
  units: z.number().min(0),
});

const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  signup: publicProcedure
    .input(z.object({ email: z.email(), password: z.string().min(8), name: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const owners = await q.countOwners();
      if (owners > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An owner account already exists. Ask your owner to create your login.",
        });
      }
      try {
        const user = await registerLocalUser(input.email, input.password, input.name);
        await q.ensureOwnerProfile(user.id, input.name ?? null);
        await q.seedDemoData(user.id);
        await authProvider().login(ctx.c, input.email, input.password);
        return user;
      } catch (e: unknown) {
        if (e instanceof EmailTakenError) throw new TRPCError({ code: "CONFLICT", message: e.message });
        throw e;
      }
    }),

  login: publicProcedure
    .input(z.object({ email: z.string().min(1), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const email = await q.resolveLoginEmail(input.email);
        if (!email) throw new AuthError("Invalid username or password");
        return await authProvider().login(ctx.c, email, input.password);
      } catch (e) {
        if (e instanceof AuthError) throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
        throw e;
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await authProvider().logout(ctx.c);
    return { ok: true };
  }),

  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().min(3) }))
    .mutation(async ({ ctx, input }) => {
      const ip = hashIp(clientIp(ctx.c));
      const windowStart = new Date(Date.now() - RESET_WINDOW_MS);

      if ((await q.countResetRequestsForIp(ip, windowStart)) >= RESET_MAX_PER_WINDOW) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many reset requests from this device. Please try again in an hour.",
        });
      }
      const last = await q.latestResetRequestForIp(ip);
      if (last) {
        const elapsed = Date.now() - new Date(last.createdAt).getTime();
        if (elapsed < RESET_COOLDOWN_MS) {
          const wait = Math.ceil((RESET_COOLDOWN_MS - elapsed) / 1000);
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `Please wait ${wait}s before requesting another code.`,
          });
        }
      }

      const user = await q.findUserByEmail(input.email);
      if (!user) return { ok: true, sent: false, status: "unknown" as const };

      if ((await q.countResetRequestsForUser(user.id, windowStart)) >= RESET_MAX_PER_WINDOW) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many reset requests for this account. Please try again in an hour.",
        });
      }

      const otp = generateOtp();
      await q.createResetCode({
        userId: user.id,
        codeHash: await bcryptHash(otp, 10),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
        requestIp: ip,
      });

      const { text, html } = otpEmail(otp, Math.round(RESET_TTL_MS / 60_000));
      const mail = await sendMail({
        to: user.email,
        subject: "Your password reset code",
        text,
        html,
      });

      const unwired = !mail.sent;
      if (unwired) console.warn(`[otp] ${user.email} code=${otp} (SMTP ${mail.status})`);

      return {
        ok: true,
        sent: mail.sent,
        status: mail.status,
        devCode: unwired && !IS_PROD ? otp : null,
        expiresInMinutes: Math.round(RESET_TTL_MS / 60_000),
      };
    }),

  verifyResetCode: publicProcedure
    .input(z.object({ email: z.string().min(3), code: z.string().min(4) }))
    .mutation(async ({ input }) => {
      await assertResetCode(input.email, input.code);
      return { ok: true };
    }),

  resetPassword: publicProcedure
    .input(z.object({ email: z.string().min(3), code: z.string().min(4), password: z.string().min(8) }))
    .mutation(async ({ input }) => {
      const row = await assertResetCode(input.email, input.code);
      if (!(await q.consumeResetCode(row.id))) {
        throw new TRPCError({ code: "CONFLICT", message: "That code has already been used." });
      }
      await q.setUserPassword(row.userId, await bcryptHash(input.password, 10));
      return { ok: true };
    }),
});

async function assertResetCode(email: string, code: string) {
  const invalid = new TRPCError({ code: "UNAUTHORIZED", message: "That code is not valid or has expired." });

  const user = await q.findUserByEmail(email);
  if (!user) throw invalid;

  const row = await q.activeResetCode(user.id);
  if (!row) throw invalid;
  if (new Date(row.expiresAt).getTime() < Date.now()) throw invalid;
  if (row.attempts >= RESET_MAX_ATTEMPTS) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many wrong attempts. Please request a new code.",
    });
  }
  if (!(await bcryptCompare(code.trim(), row.codeHash))) {
    await q.bumpResetAttempts(row.id);
    throw invalid;
  }
  return row;
}

const accountRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const profile = await q.getProfile(ctx.user.id);
    const accountId = profile?.ownerId ?? ctx.user.id;
    const driver = profile?.role === "driver" ? await resolveDriver(accountId, ctx.user.id) : null;
    return {
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      role: profile?.role ?? "owner",
      displayName: profile?.displayName ?? ctx.user.name,
      phone: profile?.phone ?? null,
      accountId,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
    };
  }),

  seed: protectedProcedure.mutation(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    return q.seedDemoData(accountId);
  }),
});

const customersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const rows = await q.listCustomers(accountId);
    const profile = await q.getProfile(ctx.user.id);
    if (profile?.role !== "owner") return rows.map((c) => ({ ...c, openingBalance: 0, due: 0, moneyHidden: true }));
    const dues = await q.customerDueMap(accountId);
    return rows.map((c) => ({ ...c, due: dues.get(c.id) ?? 0, moneyHidden: false }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        address: z.string().optional(),
        openingBalance: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      let created;
      try {
        created = await q.createCustomer({ ownerId: accountId, ...input });
      } catch (e) {
        if (e instanceof q.DuplicateCustomerError) {
          throw new TRPCError({ code: "CONFLICT", message: e.message });
        }
        throw e;
      }
      const opening = profile?.role === "owner" ? (input.openingBalance ?? 0) : 0;
      if (opening > 0) await q.setCustomerOpeningBalance(accountId, created.id, opening);
      return created;
    }),

  ledger: protectedProcedure
    .input(
      z.object({
        customerId: z.uuid(),
        startDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        endDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const range = resolveBsRange({
        startDateBS: input.startDateBS ?? null,
        endDateBS: input.endDateBS ?? null,
      });
      const ledger = await q.getCustomerLedger(accountId, input.customerId, {
        fromAd: range.fromAd,
        toAd: range.toAd,
      });
      if (!ledger) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      return { ...ledger, range };
    }),

  setOpeningBalance: protectedProcedure
    .input(z.object({ customerId: z.uuid(), openingBalance: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const row = await q.setCustomerOpeningBalance(accountId, input.customerId, input.openingBalance);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      return row;
    }),
});

const RECEIPT_MODES = ["cash", "bank", "cheque", "mobile"] as const;

const receiptsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    return q.listReceipts(await q.accountIdFor(ctx.user.id));
  }),

  create: protectedProcedure
    .input(
      z.object({
        customerId: z.uuid(),
        amount: z.number().positive("Enter the amount received."),
        mode: z.enum(RECEIPT_MODES),
        referenceNo: z.string().max(120).optional(),
        notes: z.string().max(2000).optional(),
        dateAd: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const customers = await q.listCustomers(accountId);
      if (!customers.some((c) => c.id === input.customerId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer from this business." });
      }
      return q.createReceipt({ ownerId: accountId, ...input });
    }),

  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    if (!(await q.deleteReceipt(accountId, input.id))) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found." });
    }
    return { ok: true };
  }),
});

const vehiclesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => q.listVehicles(await q.accountIdFor(ctx.user.id))),
  active: protectedProcedure.query(async ({ ctx }) => q.listActiveVehicles(await q.accountIdFor(ctx.user.id))),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Give the vehicle a name."),
        number: z.string().min(1, "Give the vehicle a number plate."),
        type: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const clash = await q.findVehicleByNumber(accountId, input.number);
      if (clash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `That number plate is already used by ${clash.name}.`,
        });
      }
      const row = await q.createVehicle({ ownerId: accountId, ...input });
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "create",
        entity: "vehicle",
        targetId: row.id,
        targetLabel: `${row.name} (${row.number})`,
        summary: `Added vehicle ${row.name} (${row.number}).`,
        detail: { name: row.name, number: row.number, type: row.type },
      });
      return row;
    }),

  deletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.vehicleCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
    return summary;
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1, "Give the vehicle a name.").max(200).optional(),
        number: z.string().min(1, "Give the vehicle a number plate.").max(50).optional(),
        type: z.string().max(100).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const res = await q.editVehicleRow(accountId, id, patch);
      if (!res.ok) {
        if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
        throw new TRPCError({
          code: "CONFLICT",
          message: `That number plate is already used by ${res.clash.name}.`,
        });
      }
      const changed = Object.keys(patch).filter((k) => k in (res.after as Record<string, unknown>));
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "vehicle",
        targetId: id,
        targetLabel: `${res.after.name} (${res.after.number})`,
        summary: `Edited vehicle ${res.before.name} (${res.before.number}).`,
        detail: {
          changed,
          before: { name: res.before.name, number: res.before.number, type: res.before.type },
          after: { name: res.after.name, number: res.after.number, type: res.after.type },
        },
      });
      return res.after;
    }),

  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const res = await q.deleteVehicle(accountId, input.id);
    if (!res.ok) {
      if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
      if (res.reason === "already_retired") {
        throw new TRPCError({ code: "CONFLICT", message: "That vehicle has already been retired." });
      }
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "That vehicle is on an active trip. Mark the trip returned (or undo the lock) before removing it.",
      });
    }
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "vehicle",
      targetId: input.id,
      targetLabel: `${res.summary.vehicleName} (${res.summary.number})`,
      summary:
        res.mode === "retired"
          ? `Retired vehicle ${res.summary.vehicleName} (${res.summary.number})`
          : `Deleted vehicle ${res.summary.vehicleName} (${res.summary.number})`,
      detail: { mode: res.mode, ...res.summary, orderIds: undefined },
    });
    return { ok: true, mode: res.mode, summary: res.summary };
  }),

  restore: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.reactivateVehicle(accountId, input.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
    return row;
  }),
});

const driversRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => q.listDrivers(await q.accountIdFor(ctx.user.id))),
  active: protectedProcedure.query(async ({ ctx }) => q.listActiveDrivers(await q.accountIdFor(ctx.user.id))),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        licenseNo: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.createDriverRow({ ownerId: accountId, ...input });
    }),

  deletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.driverDeleteSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
    return summary;
  }),

  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const res = await q.deactivateDriver(accountId, input.id);
    if (!res.ok) {
      if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
      if (res.reason === "already_inactive") {
        throw new TRPCError({ code: "CONFLICT", message: "That driver has already been removed." });
      }
      // A driver holding a live trip cannot be removed: the trip is theirs, and
      // deactivating them would strand it. Say which case it is, because the fix
      // differs — an on-transit lock is released by undoing the lock, an on-rent
      // trip by marking it returned.
      if (res.summary?.activeTripStatus === "on_transit") {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "That driver has locked an order for dispatch. Only the driver who locked it can dispatch it, so undo the lock (or let them dispatch) before removing them.",
        });
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: "That driver is on an active trip. Mark the trip returned before removing them.",
      });
    }
    // History is never deleted — the driver is deactivated — so the audit entry
    // is what records who removed whom and why the record was kept.
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "driver",
      targetId: input.id,
      targetLabel: res.summary?.driverName ?? "driver",
      summary: `Removed driver ${res.summary?.driverName ?? ""} (deactivated, history kept).`,
      detail: { mode: res.mode, summary: res.summary },
    });
    return { ok: true, mode: res.mode, summary: res.summary };
  }),

  restore: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.reactivateDriver(accountId, input.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
    return row;
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1, "Give the driver a name.").max(200).optional(),
        phone: z.string().max(50).nullish(),
        licenseNo: z.string().max(50).nullish(),
        vehicleId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const res = await q.editDriverRow(accountId, id, patch);
      if (!res.ok) {
        if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
        if (res.reason === "duplicate_phone") {
          throw new TRPCError({ code: "CONFLICT", message: `That phone number is already used by ${res.clash.name}.` });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid vehicle selection." });
      }
      // The driver ROW is renamed, not the login profile, so an order's history
      // renames with it — and the audit entry records the before/after.
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "driver",
        targetId: id,
        targetLabel: res.after.name,
        summary: `Edited driver ${res.before.name}${res.before.name !== res.after.name ? ` → ${res.after.name}` : ""}.`,
        detail: { before: res.before, after: res.after },
      });
      return res.after;
    }),
});

const assignmentsRouter = router({
  mine: protectedProcedure
    .input(z.object({ dateAd: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const driver = await resolveDriver(accountId, ctx.user.id);
      if (!driver) return null;
      const dateAd = input?.dateAd ?? kathmanduToday().ad;
      const a = await q.getAssignment(accountId, driver.id, dateAd);
      if (!a) return null;
      const vehicles = await q.listVehicles(accountId);
      const v = vehicles.find((x) => x.id === a.vehicleId) ?? null;
      return { ...a, vehicleName: v?.name ?? null, vehicleNumber: v?.number ?? null };
    }),

  setMine: protectedProcedure
    .input(z.object({ vehicleId: z.uuid(), dateAd: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const driver = await resolveDriver(accountId, ctx.user.id);
      if (!driver) throw new TRPCError({ code: "FORBIDDEN", message: "No driver profile linked." });
      const vehicles = await q.listActiveVehicles(accountId);
      if (!vehicles.some((v) => v.id === input.vehicleId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick an active vehicle." });
      }
      const today = kathmanduToday();
      const dateAd = input.dateAd ?? today.ad;
      const dateBs = dateAd === today.ad ? today.bsIso : q.bsIso(q.adIsoToBs(dateAd));
      return q.upsertAssignment({ ownerId: accountId, driverId: driver.id, vehicleId: input.vehicleId, dateAd, dateBs });
    }),

  forDate: protectedProcedure
    .input(z.object({ dateAd: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.listAssignmentsForDate(accountId, input?.dateAd ?? kathmanduToday().ad);
    }),

  recent: protectedProcedure.query(async ({ ctx }) => q.listRecentAssignments(await q.accountIdFor(ctx.user.id))),
});

const equipmentRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => q.listEquipment(await q.accountIdFor(ctx.user.id))),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        code: z.string().optional(),
        unit: z.string().optional(),
        totalQty: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.createEquipment({ ownerId: accountId, ...input });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).optional(),
        code: z.string().optional(),
        unit: z.string().optional(),
        totalQty: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.updateEquipment(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
      return row;
    }),

  movements: protectedProcedure
    .input(z.object({ equipmentId: z.uuid().optional() }).optional())
    .query(async ({ ctx, input }) => q.listStockMovements(await q.accountIdFor(ctx.user.id), input?.equipmentId)),

  movementTotals: protectedProcedure.query(async ({ ctx }) => q.stockMovementTotals(await q.accountIdFor(ctx.user.id))),

  movementReport: protectedProcedure
    .input(
      z.object({
        equipmentId: z.uuid(),
        startDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        endDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const report = await q.stockMovementReport(accountId, input.equipmentId);
      if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
      const hasFilter = !!(input.startDateBS || input.endDateBS);
      const range = hasFilter
        ? resolveBsRange({ startDateBS: input.startDateBS ?? null, endDateBS: input.endDateBS ?? null })
        : null;
      return { ...report, range };
    }),
});

const ordersRouter = router({
  checkDuplicate: protectedProcedure
    .input(z.object({ customerId: z.uuid(), items: z.array(orderItemSchema).min(1) }))
    .query(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const dup = await q.findDuplicateOrder(accountId, input.customerId, input.items);
      return {
        duplicate: dup !== null,
        orderId: dup?.id ?? null,
        status: dup?.status ?? null,
        orderDateAd: dup?.orderDateAd ?? null,
        message: dup ? q.DUPLICATE_ORDER_MESSAGE : null,
      };
    }),

  list: protectedProcedure
    .input(z.object({ status: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      const driver = profile?.role === "driver" ? await resolveDriver(accountId, ctx.user.id) : null;
      const baseOrders = await q.listOrders(accountId, { driverId: driver?.id ?? null, status: input?.status });
      // One query for every row's equipment lines, not one per row. The list
      // renders "Concrete Mixer 2/2" under the customer name, so it needs the
      // lines — but fetching them per order made this an N+1 that also pulled
      // each order's invoice and header for nothing.
      const linesByOrder = await q.listOrderLinesForOrders(
        accountId,
        baseOrders.map((o) => o.id),
      );
      return baseOrders.map((o) => {
        const lines = linesByOrder.get(o.id) ?? [];
        return { ...o, lines, items: lines };
      });
    }),

  get: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const detail = await q.getOrder(accountId, input.id);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    const profile = await q.getProfile(ctx.user.id);
    if (profile?.role !== "owner" && detail.invoice) {
      return { ...detail, invoice: { ...detail.invoice, subtotal: 0, total: 0, amountDue: 0, hidden: true } };
    }
    return detail;
  }),

  create: protectedProcedure
    .input(
      z.object({
        customerId: z.uuid().optional(),
        newCustomer: z
          .object({ name: z.string().min(1), phone: z.string().optional(), address: z.string().optional() })
          .optional(),
        items: z.array(orderItemSchema).min(1),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      const driver = profile?.role === "driver" ? await resolveDriver(accountId, ctx.user.id) : null;

      let customerId = input.customerId ?? null;
      if (!customerId) {
        if (!input.newCustomer) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer or add a new one." });
        }
        const c = await q.createCustomer({ ownerId: accountId, ...input.newCustomer });
        customerId = c.id;
      }

      const duplicate = await q.findDuplicateOrder(accountId, customerId, input.items);
      if (duplicate) {
        throw new TRPCError({ code: "CONFLICT", message: q.DUPLICATE_ORDER_MESSAGE });
      }

      let vehicleId: string | null = null;
      if (driver) {
        const a = await q.getAssignment(accountId, driver.id, kathmanduToday().ad);
        vehicleId = a?.vehicleId ?? null;
      }

      return q.createOrder({
        ownerId: accountId,
        customerId,
        driverId: driver?.id ?? null,
        vehicleId,
        notes: input.notes ?? null,
        items: input.items,
      });
    }),

  approve: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.setOrderStatus(accountId, input.id, ["pending_approval"], "approved", { approvedAt: new Date() });
    if (!row) throw new TRPCError({ code: "CONFLICT", message: "Order is not awaiting approval." });
    // Tell the customer — AFTER the transition is committed, and never able to
    // fail it. A replayed approval (alreadyApplied) must not text twice.
    if (!("alreadyApplied" in row && row.alreadyApplied)) {
      await notifyModeAware(accountId, input.id, "approved");
    }
    return row;
  }),

  reject: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const row = await q.setOrderStatus(accountId, input.id, ["pending_approval"], "rejected");
    if (!row) throw new TRPCError({ code: "CONFLICT", message: "Order is not awaiting approval." });
    return row;
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        customerId: z.uuid(),
        driverId: z.uuid().nullish(),
        vehicleId: z.uuid().nullish(),
        notes: z.string().max(2000).nullish(),
        orderDateAd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        items: z.array(orderItemSchema).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      // The customer must belong to THIS business. Checked before the write so a
      // cross-tenant id is a plain BAD_REQUEST rather than a conflict with the
      // order's state, which is what the guarded UPDATE would otherwise report.
      const customers = await q.listCustomers(accountId);
      if (!customers.some((c) => c.id === input.customerId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer from this business." });
      }
      const applied = await q.updatePendingOrder(
        accountId,
        input.id,
        {
          customerId: input.customerId,
          driverId: input.driverId ?? null,
          vehicleId: input.vehicleId ?? null,
          notes: input.notes?.trim() ? input.notes.trim() : null,
          orderDateAd: input.orderDateAd ?? null,
        },
        input.items,
      );
      if (!applied) {
        throw new TRPCError({ code: "CONFLICT", message: "Order is no longer awaiting approval." });
      }
      return { ok: true };
    }),

  lock: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        sources: z.array(z.object({ orderItemId: z.uuid(), sourceCustomerId: z.uuid().nullable() })).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const driver = await resolveDriver(accountId, ctx.user.id);
      if (!driver) throw new TRPCError({ code: "FORBIDDEN", message: "Only a driver can lock an order." });
      const assignment = await q.getAssignment(accountId, driver.id, kathmanduToday().ad);
      const row = await q.lockOrderForDispatch(accountId, input.id, driver.id, assignment?.vehicleId ?? null, input.sources ?? []);
      if (!row || (row as any).ok === false) {
        throw new TRPCError({ code: "CONFLICT", message: "Order not available to dispatch." });
      }
      // Locking is the moment the truck is committed to this customer, so the
      // customer is told the equipment is on the way. A replayed lock is silent.
      if (!("alreadyApplied" in row && row.alreadyApplied)) {
        await notifyModeAware(accountId, input.id, "on_transit");
      }
      return row;
    }),

  pickFromOptions: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const options = await q.getPickFromOptions(accountId, input.id);
    if (!options) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    return options;
  }),

  reverseGeocode: protectedProcedure
    .input(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }))
    .query(async ({ input }) => {
      const { reverseGeocode } = await import("./services/geocode");
      return reverseGeocode(input.latitude, input.longitude);
    }),

  dispatch: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        delivery: z
          .object({
            status: z.enum(["captured", "unavailable"]),
            latitude: z.number().min(-90).max(90).nullable().optional(),
            longitude: z.number().min(-180).max(180).nullable().optional(),
            accuracy: z.number().nonnegative().nullable().optional(),
            address: z.string().max(500).nullable().optional(),
            capturedAt: z.coerce.date().nullable().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const me = await resolveDriver(accountId, ctx.user.id);
      const res = await q.dispatchOrder(accountId, input.id, me?.id ?? null, await actorNameFor(ctx.user.id, accountId), input.delivery ?? null);
      if (!res.ok) {
        // The locker rule is a permission, not a state problem: only the driver
        // who locked the order may dispatch it, so that is FORBIDDEN. Everything
        // else (wrong status, order gone) is a conflict with the order's state.
        if (res.reason === "not_locker") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the driver who locked this order can dispatch it.",
          });
        }
        if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
        throw new TRPCError({ code: "CONFLICT", message: "Order cannot be dispatched." });
      }
      // The equipment has physically arrived, which is the event the customer
      // cares about — so the customer-facing event is `delivered`, not the raw
      // `on_rent` status. A replayed dispatch is silent.
      if (!("alreadyApplied" in res && res.alreadyApplied)) {
        await notifyModeAware(accountId, input.id, "delivered");
      }
      return res;
    }),

  return: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const me = await resolveDriver(accountId, ctx.user.id);
    const res = await q.returnOrder(accountId, input.id, { driverId: me?.id ?? null, actorName: await actorNameFor(ctx.user.id, accountId) });
    if (!res.ok) {
      if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      throw new TRPCError({ code: "CONFLICT", message: "Order is not On Rent." });
    }
    // The equipment is back with us. A replayed return is silent.
    if (!("alreadyApplied" in res && res.alreadyApplied)) {
      await notifyModeAware(accountId, input.id, "returned");
    }
    return res;
  }),

  undoLock: protectedProcedure
    .input(z.object({ id: z.uuid(), reason: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const res = await q.undoLockForDispatch(accountId, input.id);
      if (!res.ok) {
        if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
        if (res.reason === "already_dispatched") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This order has already been dispatched. Undo the dispatch first, then undo the lock.",
          });
        }
        throw new TRPCError({ code: "CONFLICT", message: "This order is not locked for dispatch." });
      }
      // A replayed undo is success, not a conflict — the order is already back
      // where the owner wanted it — and it must NOT write a second audit entry,
      // or the trail would claim the same mistake was corrected twice.
      if (res.alreadyApplied) {
        return { ok: true as const, alreadyApplied: true as const, status: res.after.status };
      }
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "order",
        targetId: input.id,
        targetLabel: res.before.customerName ?? "order",
        summary: `Undid the lock on ${res.before.customerName ?? "the order"} (locked by ${res.before.transitedByName ?? "a driver"}). Reason: ${input.reason}`,
        detail: {
          undo: "lock",
          reason: input.reason,
          before: { status: res.before.status, lockedByDriverId: res.before.lockedByDriverId },
          after: { status: res.after.status, lockedByDriverId: res.after.lockedByDriverId },
        },
      });
      return { ok: true as const, alreadyApplied: false as const, status: res.after.status };
    }),

  undoReturn: protectedProcedure
    .input(z.object({ id: z.uuid(), reason: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const res = await q.undoReturnFromCustomer(accountId, input.id, input.reason);
      if (!res.ok) {
        if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
        throw new TRPCError({
          code: "CONFLICT",
          message: "This order is not marked returned, so there is no return to undo.",
        });
      }
      if (res.alreadyApplied) {
        return { ok: true as const, alreadyApplied: true as const, status: res.after.status, reversedMovements: 0 };
      }
      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "order",
        targetId: input.id,
        targetLabel: res.before.customerName ?? "order",
        summary: `Undid the return on ${res.before.customerName ?? "the order"}. Reason: ${input.reason}. ${res.reversedMovements} stock movement(s) were reversed.`,
        detail: {
          undo: "return",
          reason: input.reason,
          reversedMovements: res.reversedMovements,
          before: { status: res.before.status },
          after: { status: res.after.status },
        },
      });
      return {
        ok: true as const,
        alreadyApplied: false as const,
        status: res.after.status,
        reversedMovements: res.reversedMovements,
      };
    }),
});

const invoicesRouter = router({
  list: protectedProcedure
    .input(z.object({ startDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), endDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).optional())
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const rows = await q.listInvoices(accountId);
      const hasRange = !!(input?.startDateBS || input?.endDateBS);
      if (!hasRange) return { rows, range: null };
      const range = resolveBsRange({ startDateBS: input?.startDateBS ?? null, endDateBS: input?.endDateBS ?? null });
      return {
        rows: rows.filter((r) => r.invoiceDateAd >= range.fromAd && r.invoiceDateAd <= range.toAd),
        range,
      };
    }),

  get: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const all = await q.listInvoices(accountId);
    const inv = all.find((i) => i.id === input.id);
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
    const detail = await q.getOrder(accountId, inv.orderId);
    return { invoice: inv, detail };
  }),
});

const rentalsRouter = router({
  onRent: protectedProcedure.query(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const rows = await q.listOnRent(accountId);
    // One query for every row's equipment lines, not one per row — the same
    // batched helper the Orders list uses. The On Rent table shows, under the
    // customer name, what went out and what was billed, so it needs the lines;
    // fetching them per order would be an N+1 that also pulled each order's
    // invoice and header for nothing.
    const linesByOrder = await q.listOrderLinesForOrders(
      accountId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({ ...r, lines: linesByOrder.get(r.id) ?? [] }));
  }),
});

const dashboardRouter = router({
  summary: protectedProcedure.query(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const profile = await q.getProfile(ctx.user.id);
    const summary = await q.dashboardSummary(accountId);
    if (profile?.role !== "owner") {
      return {
        ...summary,
        invoices: { count: summary.invoices.count, total: 0, amountDue: 0, hidden: true },
        dues: { total: 0, hidden: true },
      };
    }
    const dues = await q.customerDueMap(accountId);
    let total = 0;
    for (const v of dues.values()) total += v;
    return { ...summary, dues: { total: Math.round((total + Number.EPSILON) * 100) / 100, hidden: false } };
  }),
});

const usersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const profiles = await q.listProfiles(accountId);
    const drivers = await q.listDrivers(accountId);
    return profiles.map((p) => ({
      userId: p.userId,
      role: p.role,
      displayName: p.displayName,
      phone: p.phone,
      username: p.username,
      driverId: drivers.find((d) => d.userId === p.userId)?.id ?? null,
    }));
  }),

  createDriver: protectedProcedure
    .input(
      z.object({
        email: z.string().optional(),
        username: z.string().optional(),
        password: z.string().min(8),
        name: z.string().min(1),
        phone: z.string().optional(),
        licenseNo: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const email = input.email?.trim() || null;
      const username = input.username?.trim().toLowerCase() || null;
      const phone = input.phone?.trim() || null;

      // A driver logs in with a username, a phone number or an email. With none
      // of the three there is no handle to log in with, so the account would be
      // created unreachable — refuse it here rather than at the login screen.
      if (!email && !username && !phone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Give the driver a username, phone number or email so they can log in.",
        });
      }

      // Usernames are the login handle, so they must be unique across the
      // platform — two drivers sharing one would make the login ambiguous.
      if (username && (await q.isUsernameTaken(username))) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `The username "${username}" is already taken. Choose another.`,
        });
      }

      const loginEmail = email ?? `${username ?? phone}@driver.local`;
      const user = await registerLocalUser(loginEmail, input.password, input.name);
      await q.createDriverProfile({ userId: user.id, ownerId: accountId, displayName: input.name, phone, username });
      const driver = await q.createDriverRow({ ownerId: accountId, name: input.name, phone, licenseNo: input.licenseNo ?? null, userId: user.id });
      // `loginId` is what the operator actually types at the login screen: the
      // username when they gave one, otherwise the email. The internal
      // `@driver.local` placeholder is never a login handle, so it is never
      // returned as one.
      return { userId: user.id, driverId: driver.id, email: user.email, username, loginId: username ?? user.email };
    }),
});

const filesRouter = router({
  uploadUrl: protectedProcedure
    .input(z.object({ name: z.string().min(1), contentType: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const key = `${crypto.randomUUID()}-${sanitizeBasename(input.name)}`;
      const { uploadUrl, publicPath } = await storagePutUrl(key, input.contentType, { ownerId: ctx.user.id });
      return { key, uploadUrl, publicPath };
    }),

  commit: protectedProcedure
    .input(z.object({ key: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return storageCommit(input.key, { ownerId: ctx.user.id, name: input.name });
    }),

  list: protectedProcedure.query(({ ctx }) => storageListByOwner(ctx.user.id)),

  remove: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // `storageDeleteOwned` runs the key through `canonicalKey`, which throws
      // `StorageError("forbidden")` for a malformed key (e.g. a "../" segment)
      // BEFORE any db or network access. Left unmapped that escapes as a raw
      // throw, which tRPC reports as an opaque 500 for what is plainly bad
      // client input — so a malformed key is answered as BAD_REQUEST.
      try {
        return await storageDeleteOwned(ctx.user.id, input.key);
      } catch (e) {
        if (e instanceof StorageError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        }
        throw e;
      }
    }),
});

const trackingRouter = router({
  ping: protectedProcedure
    .input(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().min(0).nullable().optional(),
        speed: z.number().nullable().optional(),
        heading: z.number().nullable().optional(),
        recordedAt: z.string().datetime().nullable().optional(),
        orderId: z.uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const accountId = await q.accountIdFor(ctx.user.id);
      const profile = await q.getProfile(ctx.user.id);
      if (profile?.role !== "driver") throw new TRPCError({ code: "FORBIDDEN" });
      const driver = await resolveDriver(accountId, ctx.user.id);
      if (!driver) throw new TRPCError({ code: "FORBIDDEN" });

      const trip = await q.driverActiveTrip(accountId, driver.id);
      if (!trip) throw new TRPCError({ code: "CONFLICT" });
      const orderId = input.orderId && input.orderId === trip.orderId ? input.orderId : trip.orderId;

      const row = await q.recordTripLocation({
        ownerId: accountId,
        driverId: driver.id,
        orderId,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy ?? null,
        speed: input.speed ?? null,
        heading: input.heading ?? null,
        recordedAt: input.recordedAt ? new Date(input.recordedAt) : null,
      });
      return { ok: true, id: row?.id ?? null, orderId };
    }),

  live: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const [markers, trips] = await Promise.all([q.latestDriverLocations(accountId), q.activeTrips(accountId)]);
    return { markers, trips, at: new Date().toISOString() };
  }),

  board: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    return q.trackingBoard(await q.accountIdFor(ctx.user.id));
  }),

  history: protectedProcedure.input(z.object({ orderId: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const detail = await q.getOrder(accountId, input.orderId);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND" });
    const points = await q.tripHistory(accountId, input.orderId);
    return { points, order: detail.order };
  }),

  trips: protectedProcedure
    .input(z.object({ startDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), endDateBS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).optional())
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const rows = await q.tripsWithHistory(await q.accountIdFor(ctx.user.id));
      const hasRange = !!(input?.startDateBS || input?.endDateBS);
      if (!hasRange) return { rows, range: null };
      const range = resolveBsRange({ startDateBS: input?.startDateBS ?? null, endDateBS: input?.endDateBS ?? null });
      return {
        rows: rows.filter((r) => {
          const ad = r.orderDateAd;
          return ad != null && ad >= range.fromAd && ad <= range.toAd;
        }),
        range,
      };
    }),

  myTrip: protectedProcedure.query(async ({ ctx }) => {
    const accountId = await q.accountIdFor(ctx.user.id);
    const profile = await q.getProfile(ctx.user.id);
    if (profile?.role !== "driver") return { trip: null, lastPingAt: null };
    const driver = await resolveDriver(accountId, ctx.user.id);
    if (!driver) return { trip: null, lastPingAt: null };
    const trip = await q.driverActiveTrip(accountId, driver.id);
    const lastPingAt = await q.lastPingAt(accountId, driver.id);
    return { trip, lastPingAt };
  }),

  setCustomerLocation: protectedProcedure
    .input(z.object({ customerId: z.uuid(), latitude: z.number().min(-90).max(90).nullable(), longitude: z.number().min(-180).max(180).nullable() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.setCustomerLocation(accountId, input.customerId, input.latitude, input.longitude);
    }),
});

// ── SMS notifications (owner-facing) ─────────────────────────────────────────
//
// The owner's window into the SMS Pasal integration: whether it is configured,
// a safe way to prove it works, and the log of every attempt. Owner-only — the
// log names customers and their phone numbers.
const smsRouter = router({
  /**
   * Is SMS configured, and how have the attempts gone?
   *
   * `missing` names the exact variables that are unset, so the settings page can
   * tell the owner what to add rather than just "not configured". The app works
   * normally with SMS off — this is a status read, never a gate.
   */
  status: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.smsNotificationSummary(accountId);
    return {
      configured: smsPasalConfigured(),
      missing: missingSmsPasalVars(),
      summary,
    };
  }),

  /**
   * Send a test SMS to a number the owner types.
   *
   * This is the SAFE path: the number comes from the caller, nothing is read
   * from the customer table, and the attempt is logged as `test` (or `festive`).
   * It is how the owner proves the credentials work without texting a real
   * customer, and `kind` lets them send the exact festive greeting too.
   */
  test: protectedProcedure
    .input(
      z.object({
        to: z.string().trim().min(1).max(40),
        kind: z.enum(["test", "festive"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const res = await sendTestSms(accountId, input.to, input.kind ?? "test");
      return res;
    }),

  /** The most recent attempts, newest first. */
  log: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.listSmsNotifications(accountId, input?.limit ?? 100);
    }),

  /** The events that can trigger a message, for the settings page's legend. */
  events: protectedProcedure.query(() => SMS_EVENTS),

  /**
   * The message-sending options: the current mode, the modes to choose from, and
   * the customer pick-list with each number already normalised.
   *
   * One read for the whole "Send Message" section, so the page never has to make
   * a second request to render the recipient list.
   */
  messageOptions: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const [mode, customers] = await Promise.all([
      q.getMessageMode(accountId),
      q.listCustomersForMessaging(accountId),
    ]);
    return {
      mode,
      modes: MESSAGE_MODES,
      customers,
      dialableCount: customers.filter((c) => c.dialable).length,
    };
  }),

  /** Choose the mode: 'off' | 'delivery' | 'custom'. */
  setMessageMode: protectedProcedure
    .input(z.object({ mode: z.enum(MESSAGE_MODES) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const mode = await q.setMessageMode(accountId, input.mode);
      return { mode };
    }),

  /**
   * Send a hand-typed message to the selected customers.
   *
   * The caller passes customer IDS, never numbers — the number is read from each
   * customer's own record inside the service, which is what "contact numbers must
   * be picked from the customer details" requires. Every attempt is logged, and
   * the result reports how many were sent, failed and skipped.
   */
  sendCustom: protectedProcedure
    .input(
      z.object({
        customerIds: z.array(z.uuid()).min(1).max(500),
        message: z.string().trim().min(1).max(MAX_CUSTOM_MESSAGE_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return sendCustomMessageToCustomers(accountId, input.customerIds, input.message);
    }),
});

export const appRouter = router({
  auth: authRouter,
  account: accountRouter,
  customers: customersRouter,
  receipts: receiptsRouter,
  vehicles: vehiclesRouter,
  drivers: driversRouter,
  assignments: assignmentsRouter,
  equipment: equipmentRouter,
  orders: ordersRouter,
  invoices: invoicesRouter,
  rentals: rentalsRouter,
  dashboard: dashboardRouter,
  users: usersRouter,
  tracking: trackingRouter,
  files: filesRouter,
  sms: smsRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;