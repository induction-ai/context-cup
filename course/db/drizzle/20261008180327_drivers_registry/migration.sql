CREATE TABLE "competition_suite" (
	"suite_name" text PRIMARY KEY,
	"target_name" text NOT NULL,
	"provider" text NOT NULL,
	"min_done" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_task" (
	"suite_name" text,
	"task_name" text,
	CONSTRAINT "competition_task_pkey" PRIMARY KEY("suite_name","task_name")
);
--> statement-breakpoint
CREATE TABLE "driver" (
	"name" text PRIMARY KEY,
	"kind" text NOT NULL,
	"extends" text,
	"providers" text[] NOT NULL,
	"description" text,
	"fingerprint" text NOT NULL,
	"git_sha" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone,
	"synced_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "suite" ADD COLUMN "driver_fingerprint" text;--> statement-breakpoint
ALTER TABLE "trial" ADD COLUMN "driver_fingerprint" text;--> statement-breakpoint
ALTER TABLE "competition_task" ADD CONSTRAINT "competition_task_suite_name_competition_suite_suite_name_fkey" FOREIGN KEY ("suite_name") REFERENCES "competition_suite"("suite_name") ON DELETE CASCADE;--> statement-breakpoint
CREATE VIEW "driver_status" AS (
  with eligible_run as (
    select s.id, s.name as suite_name, s.driver_name, s.driver_fingerprint,
      s.started_at
    from suite s
    join competition_suite c
      on c.suite_name = s.name and c.target_name = s.target_name
    where s.finished_at is not null
      and not exists (
        select 1 from competition_task ct
        where ct.suite_name = s.name
          and not exists (
            select 1 from job j
            where j.suite_id = s.id and j.task_name = ct.task_name
          )
      )
      and coalesce((
        select min(task_done.done) from (
          select count(t.id) filter (
            where t.reward is not null and t.error is null
          ) as done
          from job j left join trial t on t.job_id = j.id
          where j.suite_id = s.id
          group by j.task_name
        ) as task_done
      ), 0) >= c.min_done
  ),
  standing as (
    select distinct on (driver_name, suite_name) *
    from eligible_run
    order by driver_name, suite_name, started_at desc, id desc
  )
  select d.name as driver_name, c.suite_name, c.target_name,
    case
      when st.id is not null and (
        st.driver_fingerprint = d.fingerprint
        or (st.driver_fingerprint is null
          and (d.changed_at is null or d.changed_at <= st.started_at))
      ) then 'current'
      when r.id is not null then 'running'
      when st.id is not null then 'stale'
      else 'missing'
    end as status,
    d.fingerprint as driver_fingerprint,
    st.id as standing_suite_id,
    st.driver_fingerprint as standing_fingerprint,
    st.started_at as standing_started_at,
    r.id as running_suite_id
  from driver d
  join competition_suite c on c.provider = any(d.providers)
  left join standing st
    on st.driver_name = d.name and st.suite_name = c.suite_name
  left join lateral (
    select s.id from suite s
    where s.driver_name = d.name
      and s.name = c.suite_name
      and s.target_name = c.target_name
      and s.finished_at is null
      and s.started_at > now() - interval '7 hours'
      and s.driver_fingerprint = d.fingerprint
    order by s.started_at desc, s.id desc
    limit 1
  ) r on true
  where d.removed_at is null
);