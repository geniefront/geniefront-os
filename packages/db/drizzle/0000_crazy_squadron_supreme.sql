CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_roles" (
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "membership_roles_membership_id_role_id_pk" PRIMARY KEY("membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid,
	"user_id" uuid NOT NULL,
	"employment_type" text DEFAULT 'w2' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_on" date,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_overrides" (
	"membership_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"allow" boolean NOT NULL,
	CONSTRAINT "permission_overrides_membership_id_permission_pk" PRIMARY KEY("membership_id","permission")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"is_preset" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"price_modifier_bp" integer DEFAULT 10000 NOT NULL,
	"tip_weight_bp" integer DEFAULT 10000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"membership_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"display_name" jsonb NOT NULL,
	"level_id" uuid,
	"gender" text,
	"bio" jsonb,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"hire_date" date,
	"pin_hash" text,
	"photo_url" text,
	"is_bookable" boolean DEFAULT false NOT NULL,
	"max_concurrent_appointments" integer DEFAULT 1 NOT NULL,
	"bookable_online" boolean DEFAULT false NOT NULL,
	"color" text
);
--> statement-breakpoint
CREATE TABLE "staff_skills" (
	"membership_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"proficiency" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "staff_skills_membership_id_skill_id_pk" PRIMARY KEY("membership_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "user_last_location" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"full_name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_features" (
	"location_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"stripe_subscription_item_id" text,
	"ai_phone_pack_enabled" boolean DEFAULT false NOT NULL,
	"trial_ends_on" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"slug" text NOT NULL,
	"timezone" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"address" jsonb,
	"phone" text,
	"business_hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"holiday_calendar" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_day_cutoff" time DEFAULT '03:00' NOT NULL,
	"business_type" text NOT NULL,
	"public_key" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"billing_customer_id" text,
	"sharing" jsonb DEFAULT '{"customers":true,"gift_cards":false,"packages":false,"staff":true}'::jsonb NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"qty" integer NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_item_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"resource_id" uuid,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"addon_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"membership_id" uuid,
	"is_request" boolean DEFAULT false NOT NULL,
	"resource_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"price_cents_snapshot" integer NOT NULL,
	"duration_min" integer NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"overbooked" boolean DEFAULT false NOT NULL,
	"overbook_reason" text,
	"overbook_note" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid,
	"walk_in_name" text,
	"business_date" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"source" text DEFAULT 'desk' NOT NULL,
	"booking_channel_ref" text,
	"party_size" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancel_note" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid,
	"actor_id" uuid,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"command" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"undo_of_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_idempotency" (
	"key" text NOT NULL,
	"location_id" uuid NOT NULL,
	"command" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_idempotency_location_id_key_pk" PRIMARY KEY("location_id","key")
);
--> statement-breakpoint
CREATE TABLE "customer_preferences" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"preferred_staff_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"avoid_staff_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"preferred_gender" text,
	"allergies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"free_notes" text,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"primary_location_id" uuid,
	"display_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"phone_e164" text,
	"email" text,
	"locale" text,
	"gender" text,
	"birthday" date,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"vip_level" integer DEFAULT 0 NOT NULL,
	"marketing_sms_opt_in" boolean DEFAULT false NOT NULL,
	"marketing_email_opt_in" boolean DEFAULT false NOT NULL,
	"no_show_count" integer DEFAULT 0 NOT NULL,
	"late_cancel_count" integer DEFAULT 0 NOT NULL,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"source" text DEFAULT 'walkin' NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"resource_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"membership_id" uuid NOT NULL,
	"delta_bp" integer NOT NULL,
	"reason" text NOT NULL,
	"ticket_id" uuid,
	"appointment_item_id" uuid,
	"actor_id" uuid,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_participants" (
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"membership_id" uuid NOT NULL,
	"in_rotation" boolean DEFAULT true NOT NULL,
	"note" text,
	CONSTRAINT "rotation_participants_location_id_business_date_membership_id_pk" PRIMARY KEY("location_id","business_date","membership_id")
);
--> statement-breakpoint
CREATE TABLE "rotation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_option_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"hint" jsonb,
	"input" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sticky" boolean DEFAULT true NOT NULL,
	"to_staff" boolean DEFAULT true NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"category_id" uuid,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"duration_min" integer NOT NULL,
	"buffer_before_min" integer DEFAULT 0 NOT NULL,
	"buffer_after_min" integer DEFAULT 0 NOT NULL,
	"processing_gap" jsonb,
	"base_price_cents" integer NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"staff_count" integer DEFAULT 1 NOT NULL,
	"turn_value_bp" integer,
	"online_bookable" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_levels" ADD CONSTRAINT "staff_levels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_levels" ADD CONSTRAINT "staff_levels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_level_id_staff_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."staff_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_skills" ADD CONSTRAINT "staff_skills_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_skills" ADD CONSTRAINT "staff_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_last_location" ADD CONSTRAINT "user_last_location_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_last_location" ADD CONSTRAINT "user_last_location_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_features" ADD CONSTRAINT "location_features_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_features" ADD CONSTRAINT "location_features_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_subscriptions" ADD CONSTRAINT "location_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_subscriptions" ADD CONSTRAINT "location_subscriptions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_item_blocks" ADD CONSTRAINT "appointment_item_blocks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_item_blocks" ADD CONSTRAINT "appointment_item_blocks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_item_blocks" ADD CONSTRAINT "appointment_item_blocks_item_id_appointment_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."appointment_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_item_blocks" ADD CONSTRAINT "appointment_item_blocks_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_primary_location_id_locations_id_fk" FOREIGN KEY ("primary_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_types" ADD CONSTRAINT "resource_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_types" ADD CONSTRAINT "resource_types_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_resource_type_id_resource_types_id_fk" FOREIGN KEY ("resource_type_id") REFERENCES "public"."resource_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_events" ADD CONSTRAINT "rotation_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_events" ADD CONSTRAINT "rotation_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_events" ADD CONSTRAINT "rotation_events_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_participants" ADD CONSTRAINT "rotation_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_participants" ADD CONSTRAINT "rotation_participants_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_participants" ADD CONSTRAINT "rotation_participants_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_option_defs" ADD CONSTRAINT "service_option_defs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_option_defs" ADD CONSTRAINT "service_option_defs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_hash_idx" ON "device_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "memberships_location_idx" ON "memberships" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "staff_profiles_location_idx" ON "staff_profiles" USING btree ("location_id","is_bookable");--> statement-breakpoint
CREATE INDEX "locations_org_idx" ON "locations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "usage_events_billing_idx" ON "usage_events" USING btree ("location_id","kind","at");--> statement-breakpoint
CREATE INDEX "appointment_items_staff_idx" ON "appointment_items" USING btree ("location_id","membership_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_items_resource_idx" ON "appointment_items" USING btree ("location_id","resource_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_day_idx" ON "appointments" USING btree ("org_id","location_id","business_date","status");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("org_id","entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("location_id","actor_id","at");--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("org_id","phone_e164");--> statement-breakpoint
CREATE INDEX "resources_location_idx" ON "resources" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "rotation_events_day_idx" ON "rotation_events" USING btree ("location_id","business_date","at");--> statement-breakpoint
CREATE INDEX "service_option_defs_location_idx" ON "service_option_defs" USING btree ("location_id","active");--> statement-breakpoint
CREATE INDEX "services_location_idx" ON "services" USING btree ("location_id","active");