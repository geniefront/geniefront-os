CREATE TABLE "form_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"membership_id" uuid,
	"reason" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"answers_encrypted" "bytea",
	"enc_alg" text,
	"signature_url" text,
	"signed_at" timestamp with time zone,
	"signer_name" text,
	"signer_relation" text DEFAULT 'self' NOT NULL,
	"ip" text,
	"user_agent" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"source" text DEFAULT 'kiosk' NOT NULL,
	"on_behalf_by" uuid,
	"expires_on" date,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"title" jsonb NOT NULL,
	"schema" jsonb NOT NULL,
	"requires_signature" boolean DEFAULT true NOT NULL,
	"valid_days" integer,
	"service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "walkin_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"ticket_number" integer NOT NULL,
	"customer_id" uuid,
	"walk_in_name" text,
	"requested_service_id" uuid,
	"requested_staff_id" uuid,
	"party_size" integer DEFAULT 1 NOT NULL,
	"appointment_id" uuid,
	"quoted_wait_min" integer,
	"status" text DEFAULT 'waiting' NOT NULL,
	"source" text DEFAULT 'kiosk' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"called_at" timestamp with time zone,
	"seated_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"left_reason" text
);
--> statement-breakpoint
ALTER TABLE "form_access_log" ADD CONSTRAINT "form_access_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_access_log" ADD CONSTRAINT "form_access_log_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_access_log" ADD CONSTRAINT "form_access_log_submission_id_form_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_access_log" ADD CONSTRAINT "form_access_log_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_template_id_form_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_on_behalf_by_memberships_id_fk" FOREIGN KEY ("on_behalf_by") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkin_queue" ADD CONSTRAINT "walkin_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkin_queue" ADD CONSTRAINT "walkin_queue_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkin_queue" ADD CONSTRAINT "walkin_queue_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkin_queue" ADD CONSTRAINT "walkin_queue_requested_service_id_services_id_fk" FOREIGN KEY ("requested_service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkin_queue" ADD CONSTRAINT "walkin_queue_requested_staff_id_memberships_id_fk" FOREIGN KEY ("requested_staff_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walkin_queue" ADD CONSTRAINT "walkin_queue_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_access_log_submission_idx" ON "form_access_log" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX "form_submissions_customer_idx" ON "form_submissions" USING btree ("location_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "form_submissions_expiry_idx" ON "form_submissions" USING btree ("location_id","expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX "form_templates_version_key" ON "form_templates" USING btree ("location_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "walkin_queue_number_key" ON "walkin_queue" USING btree ("location_id","business_date","ticket_number");--> statement-breakpoint
CREATE INDEX "walkin_queue_board_idx" ON "walkin_queue" USING btree ("location_id","business_date","status","created_at");