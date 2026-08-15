CREATE TABLE "location_review_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"on_date" date NOT NULL,
	"rating_bp" integer,
	"review_count" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"rating" integer,
	"author_name" text,
	"content" text,
	"is_excerpt" boolean DEFAULT false NOT NULL,
	"url" text,
	"posted_at" timestamp with time zone,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"coverage" jsonb NOT NULL,
	"latest_review_id" text,
	"summary_content" jsonb NOT NULL,
	"excerpt_ratio_bp" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_cost_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "yelp_business_id" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "google_place_id" text;--> statement-breakpoint
ALTER TABLE "location_review_stats" ADD CONSTRAINT "location_review_stats_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_review_stats" ADD CONSTRAINT "location_review_stats_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_reviews" ADD CONSTRAINT "location_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_reviews" ADD CONSTRAINT "location_reviews_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_summaries" ADD CONSTRAINT "review_summaries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_summaries" ADD CONSTRAINT "review_summaries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "location_review_stats_daily" ON "location_review_stats" USING btree ("location_id","platform","on_date");--> statement-breakpoint
CREATE UNIQUE INDEX "location_reviews_dedup" ON "location_reviews" USING btree ("location_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "location_reviews_recent" ON "location_reviews" USING btree ("location_id","platform","posted_at");--> statement-breakpoint
CREATE INDEX "review_summaries_recent" ON "review_summaries" USING btree ("location_id","generated_at");