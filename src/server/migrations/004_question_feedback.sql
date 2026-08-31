-- Crowd-sourced question quality signal.
--
-- After answering a bank question a student can rate it 👍/👎; a 👎 optionally
-- carries a reason category and a short note. The instructor scans the
-- aggregate at the end of term to find the questions worth reviewing, rather
-- than reading all of them.
--
-- One row per (student, bank_question_id) — re-rating updates in place, so a
-- student who retries a question five times can't skew its score.
--
-- was_correct records whether the student had the question RIGHT at the moment
-- they rated it. That column is what makes the report trustworthy: a 👎 from a
-- student who answered correctly is rarely frustration and often a real defect,
-- so the report weights it double.
--
-- Course scoping is by join to student (which is already per lti_iss +
-- lti_context_id); nothing is denormalised onto this table.

create table if not exists question_feedback (
  id                bigserial   primary key,
  student_id        bigint      not null references student(id) on delete cascade,
  bank_question_id  text        not null,
  unit_no           int         not null,
  level             text        not null,   -- 'basic' | 'advanced'
  kind              text        not null,   -- 'mc' | 'tf' | 'fitb' | 'fr'
  rating            smallint    not null check (rating in (-1, 1)),
  reason            text        check (reason in ('wrong_answer','confusing','off_syllabus','too_hard')),
  note              text,
  was_correct       boolean,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (student_id, bank_question_id)
);

create index if not exists question_feedback_question_idx
  on question_feedback (bank_question_id);
create index if not exists question_feedback_student_idx
  on question_feedback (student_id);
