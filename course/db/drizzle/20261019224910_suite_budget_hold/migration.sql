CREATE TABLE "suite_budget_hold" (
	"budget_key" text,
	"invocation_id" text,
	"job_id" text,
	"holder" text NOT NULL,
	"weight" integer NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suite_budget_hold_pkey" PRIMARY KEY("budget_key","invocation_id","job_id")
);
