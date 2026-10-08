DROP VIEW "driver_status";--> statement-breakpoint
CREATE VIEW "suite_score" AS (
  with task as (
    select j.suite_id, j.task_name,
      count(t.id)::int as trials,
      count(t.id) filter (
        where t.reward is not null and t.error is null
      )::int as done,
      count(t.id) filter (where t.error is not null)::int as errors,
      avg(t.reward) filter (
        where t.reward is not null and t.error is null
      ) as task_reward,
      avg(t.cost_cents) filter (
        where t.reward is not null and t.error is null
      ) as task_cost
    from job j left join trial t on t.job_id = j.id
    group by j.suite_id, j.task_name
  )
  select s.id as suite_id,
    count(task.task_name)::int as tasks,
    coalesce(sum(task.trials), 0)::int as trials,
    coalesce(sum(task.done), 0)::int as scored,
    coalesce(sum(task.errors), 0)::int as errors,
    count(task.task_reward)::int as tasks_scored,
    avg(task.task_reward) as mean_reward,
    avg(task.task_cost) as mean_cost_cents,
    min(task.done) as min_task_done
  from suite s left join task on task.suite_id = s.id
  group by s.id
);--> statement-breakpoint
CREATE VIEW "run_eligibility" AS (
  with judged as (
    select s.id as suite_id, s.name as suite_name, s.driver_name,
      s.target_name, s.driver_fingerprint, s.started_at, s.finished_at,
      c.target_name as competition_target,
      c.min_done,
      coalesce(req.required, 0) as required_tasks,
      coalesce(req.missing, 0) as missing_tasks,
      sc.min_task_done,
      coalesce(
        c.target_name = s.target_name
        and s.finished_at is not null
        and coalesce(req.missing, 0) = 0
        and coalesce(sc.min_task_done, 0) >= c.min_done,
        false
      ) as eligible
    from suite s
    join suite_score sc on sc.suite_id = s.id
    left join competition_suite c on c.suite_name = s.name
    left join lateral (
      select count(*)::int as required,
        count(*) filter (
          where not exists (
            select 1 from job j
            where j.suite_id = s.id and j.task_name = ct.task_name
          )
        )::int as missing
      from competition_task ct
      where ct.suite_name = s.name
    ) req on true
  )
  select judged.*,
    eligible and row_number() over (
      partition by driver_name, suite_name, target_name, eligible
      order by started_at desc, suite_id desc
    ) = 1 as on_board
  from judged
);--> statement-breakpoint
CREATE VIEW "driver_status" AS (
  select d.name as driver_name, c.suite_name, c.target_name,
    case
      when st.suite_id is not null and (
        st.driver_fingerprint = d.fingerprint
        or (st.driver_fingerprint is null
          and (d.changed_at is null or d.changed_at <= st.started_at))
      ) then 'current'
      when r.suite_id is not null then 'running'
      when st.suite_id is not null then 'stale'
      else 'missing'
    end as status,
    d.fingerprint as driver_fingerprint,
    (select count(*)::int from competition_task ct
      where ct.suite_name = c.suite_name) as required_tasks,
    c.min_done,
    st.suite_id as standing_suite_id,
    st.driver_fingerprint as standing_fingerprint,
    st.started_at as standing_started_at,
    sc.mean_reward,
    sc.mean_cost_cents * (select count(*) from competition_task ct
      where ct.suite_name = c.suite_name) as run_cents,
    r.suite_id as running_suite_id,
    lt.suite_id as latest_suite_id,
    lt.started_at as latest_started_at,
    lt.finished_at as latest_finished_at,
    lt.eligible as latest_eligible,
    lt.missing_tasks as latest_missing_tasks,
    lt.min_task_done as latest_min_task_done
  from driver d
  join competition_suite c on c.provider = any(d.providers)
  left join run_eligibility st
    on st.driver_name = d.name
    and st.suite_name = c.suite_name
    and st.target_name = c.target_name
    and st.on_board
  left join suite_score sc on sc.suite_id = st.suite_id
  left join lateral (
    select e.* from run_eligibility e
    where e.driver_name = d.name
      and e.suite_name = c.suite_name
      and e.target_name = c.target_name
    order by e.started_at desc, e.suite_id desc
    limit 1
  ) lt on true
  left join lateral (
    select e.suite_id from run_eligibility e
    where e.driver_name = d.name
      and e.suite_name = c.suite_name
      and e.target_name = c.target_name
      and e.finished_at is null
      and e.started_at > now() - interval '7 hours'
      and e.driver_fingerprint = d.fingerprint
    order by e.started_at desc, e.suite_id desc
    limit 1
  ) r on true
  where d.removed_at is null
);