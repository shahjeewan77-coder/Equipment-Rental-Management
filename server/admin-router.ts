// ── AGENT-OWNED: owner administration — edit / delete anywhere, with audit ─────
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import * as q from "./db";
import { listCustomers } from "./db";
import { sendSms } from "./services/sms-pasal";

async function requireOwner(userId: string) {
  const profile = await q.getProfile(userId);
  if (!profile || profile.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can do this." });
  }
  return profile;
}

async function actorNameFor(userId: string, fallback?: string | null) {
  try {
    const p = await q.getProfile(userId);
    return p?.displayName ?? fallback ?? "Owner";
  } catch {
    return fallback ?? "Owner";
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

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

export const adminRouter = router({
  auditLog: protectedProcedure
    .input(
      z.object({
        entity: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      return q.listAuditLog(accountId, { entity: input.entity, limit: input.limit });
    }),

  orderDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.orderCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    return summary;
  }),

  deleteOrder: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.orderCascadeSummary(accountId, input.id);
    const deleted = await q.deleteOrder(accountId, input.id);
    if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
    await q.writeAuditLog({
      ownerId: accountId,
      actorUserId: ctx.user.id,
      actorName: await actorNameFor(ctx.user.id, accountId),
      action: "delete",
      entity: "order",
      targetId: input.id,
      targetLabel: `Order ${summary?.orderNumber ?? ""} · ${summary?.customerName ?? ""}`,
      summary: `Deleted order ${summary?.orderNumber ?? ""}`,
      detail: summary,
    });
    return summary;
  }),

  editOrder: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        customerId: z.uuid().optional(),
        driverId: z.uuid().nullish(),
        vehicleId: z.uuid().nullish(),
        notes: z.string().max(2000).nullish(),
        status: z
          .enum(["pending_approval", "approved", "on_transit", "on_rent", "returned", "rejected"])
          .optional(),
        orderDateAd: dateString.nullish(),
        items: z.array(orderItemSchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);

      if (input.customerId) {
        const cs = await listCustomers(accountId);
        if (!cs.some((c) => c.id === input.customerId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a customer from this business." });
        }
      }
      if (input.driverId) {
        const ds = await q.listActiveDrivers(accountId);
        if (!ds.some((d) => d.id === input.driverId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a driver who is still on the roster." });
        }
      }
      if (input.vehicleId) {
        const vs = await q.listActiveVehicles(accountId);
        if (!vs.some((v) => v.id === input.vehicleId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a vehicle that is still in service." });
        }
      }
      if (input.items) {
        const eqs = await q.listEquipment(accountId);
        for (const it of input.items) {
          if (!eqs.some((e) => e.id === it.equipmentId)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Pick equipment from this business." });
          }
        }
      }

      const res = await q.editOrderAnyStage(
        accountId,
        input.id,
        {
          customerId: input.customerId,
          driverId: input.driverId === undefined ? undefined : input.driverId,
          vehicleId: input.vehicleId === undefined ? undefined : input.vehicleId,
          notes: input.notes === undefined ? undefined : input.notes,
          status: input.status,
          orderDateAd: input.orderDateAd === undefined ? undefined : input.orderDateAd,
        },
        input.items,
      );
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });

      const statusChanged = Boolean(input.status && input.status !== res.before.order.status);

      // ── SMS Pasal Notification Trigger (केवल Lock for dispatch र Dispatched मा मात्र) ──
      if (statusChanged && input.status) {
        try {
          const customer = await q.getCustomer(accountId, res.after.order.customerId);
          if (customer && customer.phone) {
            let message = '';

            // १. अर्डर लोड / लक हुँदा
            if (input.status === 'on_transit' || input.status === 'locked_dispatch') {
              message = 'तपाईंको अर्डर लोड भएको छ - बडिमालिका शटरिङ';
            } 
            // २. अर्डर आइपुग्दा (Dispatched)
            else if (input.status === 'dispatched' || input.status === 'on_rent') {
              message = 'तपाईंको अर्डर आइपुग्यो - बडिमालिका शटरिङ';
            }

            if (message) {
              sendSms({ to: customer.phone, body: message })
                .then((result) => {
                  if (result.status === 'sent') {
                    console.log(`[SMS Pasal] Successfully sent notification to ${customer.phone}`);
                  } else {
                    console.error(`[SMS Pasal] Failed to send: ${result.error}`);
                  }
                })
                .catch((err) => console.error('[SMS Pasal Error]:', err));
            }
          }
        } catch (smsErr) {
          console.error('[SMS Pasal Error] Failed to trigger notification workflow:', smsErr);
        }
      }
      // ───────────────────────────────────────────────────────────────────────────────────

      await q.writeAuditLog({
        ownerId: accountId,
        actorUserId: ctx.user.id,
        actorName: await actorNameFor(ctx.user.id, accountId),
        action: "update",
        entity: "order",
        targetId: input.id,
        targetLabel: `Order · ${res.after.order.customerName ?? ""}`,
        summary: `Edited order for ${res.after.order.customerName ?? "a customer"}`,
        detail: { changed: Object.keys(input).filter((k) => k !== "id") },
      });
      return res.after;
    }),

  customerDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.customerCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
    return summary;
  }),

  deleteCustomer: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.deleteCustomer(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
    return summary;
  }),

  editCustomer: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(200).optional(),
        phone: z.string().max(50).nullish(),
        address: z.string().max(500).nullish(),
        openingBalance: z.number().optional(),
        latitude: z.number().min(-90).max(90).nullish(),
        longitude: z.number().min(-180).max(180).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      let row;
      try {
        row = await q.editCustomer(accountId, id, patch);
      } catch (e) {
        if (e instanceof q.DuplicateCustomerError) {
          throw new TRPCError({ code: "CONFLICT", message: e.message });
        }
        throw e;
      }
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      return row;
    }),

  equipmentDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.equipmentCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
    return summary;
  }),

  deleteEquipment: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.deleteEquipment(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
    return summary;
  }),

  editEquipment: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(200).optional(),
        code: z.string().max(50).nullish(),
        unit: z.string().min(1).max(30).optional(),
        totalQty: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const res = await q.editEquipmentAnyStage(accountId, id, patch);
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found." });
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Total quantity cannot be less than the ${res.onRentQty} currently on rent.`,
        });
      }
      return res.row;
    }),

  vehicleDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.vehicleCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
    return summary;
  }),

  deleteVehicle: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const res = await q.deleteVehicle(accountId, input.id);
    if (!res.ok) {
      if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Vehicle not found." });
      if (res.reason === "already_retired") {
        throw new TRPCError({ code: "CONFLICT", message: "That vehicle has already been retired." });
      }
      throw new TRPCError({ code: "CONFLICT", message: "That vehicle is on an active trip." });
    }
    return { ...res.summary, mode: res.mode };
  }),

  editReceipt: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        amount: z.number().min(0).optional(),
        mode: z.enum(["cash", "bank", "cheque", "mobile"]).optional(),
        referenceNo: z.string().max(200).nullish(),
        dateAd: dateString.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.editReceipt(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found." });
      return row;
    }),

  invoiceDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.invoiceCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
    return summary;
  }),

  editInvoice: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        subtotal: z.number().min(0).optional(),
        total: z.number().min(0).optional(),
        amountDue: z.number().min(0).optional(),
        invoiceDateAd: dateString.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.editInvoice(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
      return row;
    }),

  deleteInvoice: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.deleteInvoice(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
    return summary;
  }),

  userDeletePreview: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.userCascadeSummary(accountId, input.id);
    if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
    return { ...summary, isSelf: input.id === accountId };
  }),

  deleteUser: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await requireOwner(ctx.user.id);
    const accountId = await q.accountIdFor(ctx.user.id);
    const summary = await q.userCascadeSummary(accountId, input.id);
    const res = await q.deleteUser(accountId, input.id);
    if (!res.ok) {
      if (res.reason === "is_owner") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own owner account." });
      }
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found in this business." });
    }
    return res.summary;
  }),

  editUser: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(200).optional(),
        email: z.email().optional(),
        driverName: z.string().min(1).max(200).optional(),
        driverPhone: z.string().max(50).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx.user.id);
      const accountId = await q.accountIdFor(ctx.user.id);
      const { id, ...patch } = input;
      const row = await q.editUser(accountId, id, patch);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "User not found in this business." });
      return row;
    }),
});