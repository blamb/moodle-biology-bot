-- Per-call Anthropic API usage, billed at Anthropic's published rates.
-- Lets the instructor (and TRU) see exactly what a cohort costs and where
-- the spend is going (tutor vs question generation vs grading).

create table if not exists api_call (
  id                       bigserial primary key,
  student_id               bigint      references student(id) on delete set null,
  session_id               bigint      references session(id) on delete set null,
  lti_iss                  text,
  lti_context_id           text,
  endpoint                 text        not null,
    -- which feature triggered this call:
    --   'tutor.turn', 'quiz.generate.mc' | 'tf' | 'fitb' | 'fr',
    --   'quiz.grade.fr', 'coach.synthesize', 'coach.explain',
    --   'teacher.concepts'
  model                    text        not null,
  input_tokens             int         not null default 0,
  output_tokens            int         not null default 0,
  cache_creation_tokens    int         not null default 0,
  cache_read_tokens        int         not null default 0,
  cost_usd                 numeric(10, 6) not null default 0,
  duration_ms              int,
  ts                       timestamptz not null default now()
);

create index if not exists api_call_context_idx on api_call (lti_iss, lti_context_id, ts desc);
create index if not exists api_call_student_idx on api_call (student_id, ts desc);
create index if not exists api_call_endpoint_idx on api_call (endpoint, ts desc);
