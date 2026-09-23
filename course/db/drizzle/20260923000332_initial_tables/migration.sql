CREATE TABLE "job" (
	"id" text PRIMARY KEY,
	"suite_id" text NOT NULL,
	"task_name" text NOT NULL,
	"runner" text NOT NULL,
	"driver_name" text NOT NULL,
	"target_name" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reasoning_effort" text,
	"count" integer NOT NULL,
	"concurrency" integer NOT NULL,
	"command" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"exit_code" integer,
	"jobs_dir" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_call" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "model_call_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"suite_id" text NOT NULL,
	"job_id" text NOT NULL,
	"trial_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"provider" text NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"wire" text NOT NULL,
	"purpose" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"service_tier" text,
	"cost_cents" double precision
);
--> statement-breakpoint
CREATE TABLE "suite" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"key_file" text NOT NULL,
	"driver_name" text NOT NULL,
	"target_name" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reasoning_effort" text,
	"count" integer NOT NULL,
	"git_sha" text,
	"harbor_env" text NOT NULL,
	"log_dir" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trial" (
	"id" text PRIMARY KEY,
	"suite_id" text NOT NULL,
	"job_id" text NOT NULL,
	"trial_name" text NOT NULL,
	"reward" double precision,
	"score_reason" text,
	"error" text,
	"stop_reason" text,
	"turns" integer,
	"env_tool_calls" integer,
	"duration_ms" integer,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_output_tokens" integer DEFAULT 0 NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"cost_cents" double precision,
	"trial_dir" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "job_suite_id_index" ON "job" ("suite_id");--> statement-breakpoint
CREATE INDEX "model_call_suite_id_index" ON "model_call" ("suite_id");--> statement-breakpoint
CREATE INDEX "model_call_job_id_index" ON "model_call" ("job_id");--> statement-breakpoint
CREATE INDEX "model_call_trial_id_index" ON "model_call" ("trial_id");--> statement-breakpoint
CREATE INDEX "trial_suite_id_index" ON "trial" ("suite_id");--> statement-breakpoint
CREATE INDEX "trial_job_id_index" ON "trial" ("job_id");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_suite_id_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "suite"("id");--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_suite_id_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "suite"("id");--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id");--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_trial_id_trial_id_fkey" FOREIGN KEY ("trial_id") REFERENCES "trial"("id");--> statement-breakpoint
ALTER TABLE "trial" ADD CONSTRAINT "trial_suite_id_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "suite"("id");--> statement-breakpoint
ALTER TABLE "trial" ADD CONSTRAINT "trial_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id");