-- Moodle Biology Bot — initial schema.
-- ltijs-sequelize manages its own tables (Platform, IdToken, etc.); ours live alongside.

create table if not exists student (
  id              bigserial primary key,
  lti_sub         text        not null,
  lti_iss         text        not null,
  lti_context_id  text        not null,
  display_name    text        not null,
  created_at      timestamptz not null default now(),
  unique (lti_sub, lti_iss, lti_context_id)
);

create index if not exists student_iss_idx on student (lti_iss);

create table if not exists session (
  id              bigserial primary key,
  student_id      bigint      not null references student(id) on delete cascade,
  kind            text        not null,
    -- kind ∈ {'tutor','quiz_mc','quiz_tf','quiz_fitb','quiz_fr','practice_exam'}
  unit_no         int,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  summary         jsonb       not null default '{}'::jsonb
);

create index if not exists session_student_idx on session (student_id, started_at desc);

create table if not exists tutor_turn (
  id              bigserial primary key,
  session_id      bigint      not null references session(id) on delete cascade,
  role            text        not null check (role in ('user','assistant')),
  content         text        not null,
  ts              timestamptz not null default now()
);

create index if not exists tutor_turn_session_idx on tutor_turn (session_id, ts);

create table if not exists quiz_attempt (
  id              bigserial primary key,
  session_id      bigint      not null references session(id) on delete cascade,
  unit_no         int         not null,
  kind            text        not null,
    -- kind ∈ {'mc','tf','fitb','fr'}
  question        jsonb       not null,
  response        text,
  scored_correct  boolean,
  scored_score    int,         -- 0-100 for fr; null for objective questions
  feedback        text,
  ts              timestamptz not null default now()
);

create index if not exists quiz_attempt_session_idx on quiz_attempt (session_id, ts);
create index if not exists quiz_attempt_unit_kind_idx on quiz_attempt (unit_no, kind);

-- Materialized rollup for the menu page. Refreshed on quiz_attempt insert.
create table if not exists progress_summary (
  student_id      bigint      not null references student(id) on delete cascade,
  unit_no         int         not null,
  kind            text        not null,
  attempts        int         not null default 0,
  correct         int         not null default 0,
  last_at         timestamptz,
  primary key (student_id, unit_no, kind)
);

-- Bookkeeping for which migrations have run.
create table if not exists _migration (
  name        text        primary key,
  applied_at  timestamptz not null default now()
);
