-- The trial table carries every fact about the trial (see schema.ts): add
-- the columns, fill existing rows from each trial's job and suite, then
-- require the ones those tables require.
ALTER TABLE "trial" ADD COLUMN "suite_name" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "task_name" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "runner" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "driver_name" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "target_name" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "pass" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "harbor_env" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "git_sha" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "harbor_sha" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "github_run_id" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "github_run_attempt" integer;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "github_repository" text;--> statement-breakpoint
UPDATE "trial" SET
  "suite_name" = "suite"."name",
  "task_name" = "job"."task_name",
  "runner" = "job"."runner",
  "driver_name" = "job"."driver_name",
  "target_name" = "job"."target_name",
  "provider" = "job"."provider",
  "model" = "job"."model",
  "reasoning_effort" = "job"."reasoning_effort",
  "pass" = "job"."pass",
  "harbor_env" = "suite"."harbor_env",
  "git_sha" = "suite"."git_sha",
  "harbor_sha" = "suite"."harbor_sha",
  "github_run_id" = "suite"."github_run_id",
  "github_run_attempt" = "suite"."github_run_attempt",
  "github_repository" = "suite"."github_repository"
FROM "job", "suite"
WHERE "job"."id" = "trial"."job_id" AND "suite"."id" = "trial"."suite_id";--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "suite_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "task_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "runner" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "driver_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "target_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "provider" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trial" ALTER COLUMN "harbor_env" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "trial_driver_name_index" ON "trial" ("driver_name");--> statement-breakpoint
CREATE INDEX "trial_task_name_index" ON "trial" ("task_name");
