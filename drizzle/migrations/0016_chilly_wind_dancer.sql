CREATE TABLE "message_settings" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"message_mode" text DEFAULT 'off' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_settings" ADD CONSTRAINT "message_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_settings_mode_idx" ON "message_settings" USING btree ("message_mode");