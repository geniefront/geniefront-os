ALTER TABLE "form_access_log" RENAME COLUMN "created_at" TO "at";--> statement-breakpoint
ALTER TABLE "walkin_queue" RENAME COLUMN "created_at" TO "joined_at";--> statement-breakpoint
DROP INDEX "form_access_log_submission_idx";--> statement-breakpoint
DROP INDEX "walkin_queue_board_idx";--> statement-breakpoint
CREATE INDEX "form_access_log_submission_idx" ON "form_access_log" USING btree ("submission_id","at");--> statement-breakpoint
CREATE INDEX "walkin_queue_board_idx" ON "walkin_queue" USING btree ("location_id","business_date","status","joined_at");