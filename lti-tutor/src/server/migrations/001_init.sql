-- LTI Tutor schema.
--
-- ltijs-sequelize manages its own tables (platforms, keys, tokens); these are
-- the app's. Everything course-scoped carries (lti_iss, lti_context_id), the
-- platform issuer and the LTI course id, so one deployment serves many courses.

create table if not exists student (
  id              bigserial   primary key,
  lti_sub         text        not null,
  lti_iss         text        not null,
  lti_context_id  text        not null,
  display_name    text        not null,
  created_at      timestamptz not null default now(),
  unique (lti_sub, lti_iss, lti_context_id)
);

-- Instructor-provided grounding: lecture notes, transcripts, readings. Pasted
-- as text; attached to tutorials and used for personalised debriefs.
create table if not exists material (
  id              bigserial   primary key,
  lti_iss         text        not null,
  lti_context_id  text        not null,
  title           text        not null,
  body            text        not null,
  created_by      bigint      references student(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists material_context_idx on material (lti_iss, lti_context_id, created_at);

-- What the tutor knows about the learner (the "student-profile variables").
create table if not exists student_profile (
  student_id    bigint      primary key references student(id) on delete cascade,
  program       text        not null default '',
  goal          text        not null default '',
  background    text        not null default '',
  struggles     text        not null default '',
  interests     text        not null default '',
  updated_at    timestamptz not null default now()
);

-- An instructor-authored tutorial brief: how they'd run this conversation with
-- their best teaching assistant.
create table if not exists tutorial (
  id                bigserial   primary key,
  lti_iss           text        not null,
  lti_context_id    text        not null,
  title             text        not null,
  learning_goal     text        not null,
  opening_question  text        not null,
  ta_brief          text        not null default '',
  misconceptions    text        not null default '',
  success_criteria  text        not null default '',
  material_ids      bigint[]    not null default '{}',
  target_minutes    int         not null default 15,
  gradebook         boolean     not null default false,
  status            text        not null default 'draft'
                    check (status in ('draft', 'published', 'archived')),
  created_by        bigint      references student(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists tutorial_context_idx on tutorial (lti_iss, lti_context_id, status);

-- A conversation container; turns live in tutor_turn.
create table if not exists session (
  id              bigserial   primary key,
  student_id      bigint      not null references student(id) on delete cascade,
  kind            text        not null,          -- 'tutorial'
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  summary         jsonb       not null default '{}'::jsonb
);
create index if not exists session_student_idx on session (student_id, started_at desc);

create table if not exists tutor_turn (
  id              bigserial   primary key,
  session_id      bigint      not null references session(id) on delete cascade,
  role            text        not null check (role in ('user', 'assistant')),
  content         text        not null,
  ts              timestamptz not null default now()
);
create index if not exists tutor_turn_session_idx on tutor_turn (session_id, ts);

-- One student's run through a tutorial.
create table if not exists tutorial_session (
  id                bigserial   primary key,
  tutorial_id       bigint      not null references tutorial(id) on delete cascade,
  student_id        bigint      not null references student(id) on delete cascade,
  session_id        bigint      not null references session(id) on delete cascade,
  status            text        not null default 'in_progress'
                    check (status in ('in_progress', 'completed')),
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  summary           jsonb,                       -- TutorialSummary (tutorials.ts)
  nps_score         smallint    check (nps_score between 0 and 10),
  nps_comment       text,
  grade_posted_at   timestamptz,
  grade_error       text
);
create index if not exists tutorial_session_tutorial_idx on tutorial_session (tutorial_id, started_at desc);
create index if not exists tutorial_session_student_idx on tutorial_session (student_id, tutorial_id, started_at desc);

-- Personalised lecture debrief: one per student per material, regenerable.
create table if not exists debrief (
  id              bigserial   primary key,
  student_id      bigint      not null references student(id) on delete cascade,
  material_id     bigint      not null references material(id) on delete cascade,
  markdown        text        not null,
  generated_at    timestamptz not null default now(),
  unique (student_id, material_id)
);

-- Per-call Anthropic usage and cost.
create table if not exists api_call (
  id                       bigserial primary key,
  student_id               bigint      references student(id) on delete set null,
  session_id               bigint      references session(id) on delete set null,
  lti_iss                  text,
  lti_context_id           text,
  endpoint                 text        not null,
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
create index if not exists api_call_endpoint_idx on api_call (endpoint, ts desc);

create table if not exists _migration (
  name        text        primary key,
  applied_at  timestamptz not null default now()
);
