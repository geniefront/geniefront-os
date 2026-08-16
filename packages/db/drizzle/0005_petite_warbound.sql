CREATE TABLE "time_punches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text DEFAULT 'pin' NOT NULL,
	"on_behalf_by" uuid,
	"note" text,
	"edited_by" uuid,
	"edit_reason" text,
	"ip" text
);
--> statement-breakpoint
ALTER TABLE "ticket_items" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket_items" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_punches_day_idx" ON "time_punches" USING btree ("location_id","business_date","membership_id");--> statement-breakpoint
CREATE INDEX "time_punches_staff_idx" ON "time_punches" USING btree ("membership_id","at");