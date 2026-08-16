CREATE TABLE "blueprint_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text DEFAULT 'service' NOT NULL,
	"name" jsonb NOT NULL,
	"category" text,
	"duration_min" integer,
	"price_cents" integer,
	"price_is_from" boolean DEFAULT false NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence_bp" integer DEFAULT 10000 NOT NULL,
	"source_seq" integer,
	"bbox" jsonb,
	"decision" text DEFAULT 'pending' NOT NULL,
	"edited_at" timestamp with time zone,
	"applied_service_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blueprint_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"kind" text DEFAULT 'price_list_image' NOT NULL,
	"seq" integer NOT NULL,
	"storage_path" text,
	"width_px" integer,
	"height_px" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_blueprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"label" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"unresolved" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blueprint_items" ADD CONSTRAINT "blueprint_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_items" ADD CONSTRAINT "blueprint_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_items" ADD CONSTRAINT "blueprint_items_blueprint_id_shop_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."shop_blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_items" ADD CONSTRAINT "blueprint_items_applied_service_id_services_id_fk" FOREIGN KEY ("applied_service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_sources" ADD CONSTRAINT "blueprint_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_sources" ADD CONSTRAINT "blueprint_sources_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_sources" ADD CONSTRAINT "blueprint_sources_blueprint_id_shop_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."shop_blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_blueprints" ADD CONSTRAINT "shop_blueprints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_blueprints" ADD CONSTRAINT "shop_blueprints_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blueprint_items_seq_key" ON "blueprint_items" USING btree ("blueprint_id","seq");--> statement-breakpoint
CREATE INDEX "blueprint_items_review_idx" ON "blueprint_items" USING btree ("blueprint_id","decision","confidence_bp");--> statement-breakpoint
CREATE UNIQUE INDEX "blueprint_sources_seq_key" ON "blueprint_sources" USING btree ("blueprint_id","seq");--> statement-breakpoint
CREATE INDEX "shop_blueprints_loc_idx" ON "shop_blueprints" USING btree ("location_id","status","created_at");