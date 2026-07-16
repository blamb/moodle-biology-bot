-- Phase 2: serve the pre-generated question bank.
--
-- Bank questions have stable ids (e.g. "u17-basic-mc-01"). To track which bank
-- questions a student has attempted (completion + tile state), we tag each
-- attempt with its bank id. NULL for the legacy live-generated quiz path.
alter table quiz_attempt add column if not exists bank_question_id text;

-- Fast lookup of a student's attempts by bank id (completion queries).
create index if not exists quiz_attempt_bank_idx
  on quiz_attempt (bank_question_id);
