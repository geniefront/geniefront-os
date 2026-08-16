CREATE TABLE "ticket_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"label" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"note" text,
	"tip_payout_id" uuid,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compensation_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"membership_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "day_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opening_float_cents" integer DEFAULT 0 NOT NULL,
	"closing_float_cents" integer DEFAULT 0 NOT NULL,
	"count_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counted_cash_cents" integer,
	"expected_cash_cents" integer,
	"cash_variance_cents" integer,
	"cash_variance_reason" text,
	"card_terminal_cents" integer,
	"card_expected_cents" integer,
	"card_variance_cents" integer,
	"card_variance_reason" text,
	"gross_cents" integer,
	"discount_cents" integer,
	"net_cents" integer,
	"tax_cents" integer,
	"tip_cash_cents" integer,
	"tip_card_cents" integer,
	"note" text,
	"counted_by" uuid,
	"counted_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"base_cents" integer DEFAULT 0 NOT NULL,
	"ticket_id" uuid,
	"basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan_version" integer,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tip_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"membership_id" uuid NOT NULL,
	"owed_cents" integer NOT NULL,
	"paid_cents" integer NOT NULL,
	"carry_in_cents" integer DEFAULT 0 NOT NULL,
	"carry_out_cents" integer DEFAULT 0 NOT NULL,
	"bills" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"note" text,
	"paid_by" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	"break_min" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	"break_min" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"off_reason" text,
	"note" text,
	"from_template" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "capacity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "max_staff" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tendered_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "change_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "keep_change" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "group_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payer_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_allocations" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tip_allocations" ADD COLUMN "reversed_by" uuid;--> statement-breakpoint
ALTER TABLE "ticket_groups" ADD CONSTRAINT "ticket_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_groups" ADD CONSTRAINT "ticket_groups_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_plans" ADD CONSTRAINT "compensation_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_plans" ADD CONSTRAINT "compensation_plans_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_plans" ADD CONSTRAINT "compensation_plans_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_groups_day_idx" ON "ticket_groups" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "cash_movements_day_idx" ON "cash_movements" USING btree ("location_id","business_date","at");--> statement-breakpoint
CREATE INDEX "comp_plans_lookup_idx" ON "compensation_plans" USING btree ("location_id","membership_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "day_closes_unique" ON "day_closes" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "earnings_day_idx" ON "earnings" USING btree ("location_id","business_date","membership_id");--> statement-breakpoint
CREATE INDEX "earnings_ticket_idx" ON "earnings" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_payouts_unique" ON "tip_payouts" USING btree ("location_id","business_date","membership_id");--> statement-breakpoint
CREATE INDEX "tip_payouts_staff_idx" ON "tip_payouts" USING btree ("location_id","membership_id","business_date");--> statement-breakpoint
CREATE INDEX "shift_templates_lookup_idx" ON "shift_templates" USING btree ("location_id","weekday","active");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_unique" ON "shifts" USING btree ("location_id","business_date","membership_id");--> statement-breakpoint
CREATE INDEX "shifts_day_idx" ON "shifts" USING btree ("location_id","business_date","status");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_group_id_ticket_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."ticket_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_day_idx" ON "payments" USING btree ("location_id","at");--> statement-breakpoint
CREATE INDEX "payments_group_idx" ON "payments" USING btree ("group_payment_id");