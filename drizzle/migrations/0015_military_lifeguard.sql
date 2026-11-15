CREATE TABLE "sms_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"order_id" uuid,
	"customer_id" uuid,
	"customer_name" text,
	"order_ref" text,
	"event" text NOT NULL,
	"to_number" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"provider_sid" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_notifications" ADD CONSTRAINT "sms_notifications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_notifications" ADD CONSTRAINT "sms_notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_notifications" ADD CONSTRAINT "sms_notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_owner_idx" ON "sms_notifications" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sms_created_idx" ON "sms_notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sms_order_idx" ON "sms_notifications" USING btree ("order_id");