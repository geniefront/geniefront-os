CREATE TABLE "call_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"call_id" uuid,
	"from_e164" text,
	"service_name_heard" text,
	"service_id" uuid,
	"staff_name_heard" text,
	"staff_membership_id" uuid,
	"time_heard" text,
	"slot_starts_at" timestamp with time zone,
	"duration_min" integer,
	"customer_id" uuid,
	"customer_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"caller_name_heard" text,
	"confidence_bp" integer DEFAULT 10000 NOT NULL,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"appointment_id" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"dismiss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider_call_id" text NOT NULL,
	"from_e164" text,
	"to_e164" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"provider" text DEFAULT 'telnyx' NOT NULL,
	"purpose" text DEFAULT 'ai_voice' NOT NULL,
	"assistant_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_call_id_phone_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."phone_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_staff_membership_id_memberships_id_fk" FOREIGN KEY ("staff_membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_drafts" ADD CONSTRAINT "call_drafts_reviewed_by_memberships_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_lines" ADD CONSTRAINT "phone_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_lines" ADD CONSTRAINT "phone_lines_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_drafts_queue_idx" ON "call_drafts" USING btree ("location_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_provider_key" ON "phone_calls" USING btree ("provider_call_id");--> statement-breakpoint
CREATE INDEX "phone_calls_loc_idx" ON "phone_calls" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_lines_e164_key" ON "phone_lines" USING btree ("e164");--> statement-breakpoint
CREATE INDEX "phone_lines_loc_idx" ON "phone_lines" USING btree ("location_id","purpose");