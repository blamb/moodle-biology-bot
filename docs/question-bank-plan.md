# Question Bank — build plan

Moving from **live, per-student question generation** to a **pre-generated,
served question bank**, per the instructor's plan (see conversation, this
branch). Live generation is retained only as an instructor tool.

## Goals

- **Quality:** questions generated once by the top model (Opus) + an automated
  accuracy pass — fixes the factual errors a cheaper on-demand model produced.
- **Cost:** generation cost stops scaling with student count (one-time per
  question, not per student). Grading stays on Haiku; tutor stays on a strong model.
- **UX:** students pick a specific question from a list; per-question tutor after
  a wrong answer; keep the existing immediate answer key.

## Scope (agreed with instructor)

- Per unit, per level: **30 MC, 30 TF, 30 FITB, 10 FR** (targets; tune per unit —
  ship fewer than pad a thin unit).
- **Two levels only.** Drop the hardest internal tier. Map:
  - display **Basic** → internal `introductory`
  - display **Advanced** → internal `intermediate`
- 17 units × 2 levels × ~100 = ~3,400 questions. One-time; Batch API can halve cost.

## Phases

### Phase 1 — Generation + storage  ✅ scaffolded (this commit)
- `src/server/questionBank.ts` — storage format + reader (stable ids, per
  unit/level/type, cached). Serving code reads from here.
- `scripts/build_question_bank.ts` — generates the bank with the existing tuned
  generators (slide anchoring, FR rubric-alignment) on the top model, deduping
  by stem for distinctness. `npm run bank:build` (see header for flags).
- Output: `content/question-bank/unit-NN.json` (committed like unit content).

### Phase 1.5 — Automated accuracy pass  ✅ implemented
Since the instructor can't hand-check ~3,400 questions, a second strong-model
pass cross-checks each question against that unit's lecture/textbook grounding
and sets `verified: 'pass' | 'flagged' | 'unchecked'` (+ note).
- `src/server/questionVerify.ts` — `verifyQuestion()`; defers to the course
  material for classifications/definitions, and flags factual errors, wrong
  "correct" answers, and ambiguous MC (two defensible options). Fail-safe:
  returns `unchecked` (never a false `pass`) on error.
- Wired into `build_question_bank.ts` (bounded concurrency, cached grounding).
  Verified questions carry their verdict; flagged ones are collected into
  `content/question-bank/_flagged-report.md` for a quick human glance.
- `--no-verify` skips the pass for cheap test runs.

Remaining option (not yet built): auto-regenerate `flagged` items in a loop
until they pass, instead of only reporting them.

### Phase 2 — Storage + serving + student UI
- DB: table mapping attempts/completion to bank question `id` (extend the
  existing `quiz_attempt` model; add stable-id column).
- Endpoints: list a (unit, level, type)'s questions; fetch one by id; record an
  attempt; report completion.
- UI (`launch.html`): keep the MC/TF/FITB/FR tabs; add a **Basic/Advanced**
  toggle; replace "how many to generate" with a numbered tile grid (1–30 / 1–10);
  click a tile to answer that question. Tiles show done/correct/incorrect.
- Keep the current immediate answer key (MC option rationales, FR rubric).

### Phase 3 — Per-question tutor + completion tracking
- After a wrong answer, engage the (strong-model) tutor seeded with that
  specific question + the student's answer — replaces "answer the whole set first".
- Track section completion; know when a student clears a section (so we can add more).

### Phase 4 — Instructor self-generation
- Retain the live generator as an instructor tool (generate in her own style),
  with an option to append generated questions into the bank.

## Cross-cutting: deploy safety
- All work on `feature/question-banks`; `main`/pilot untouched until merged.
- Recommend a **staging Railway environment** on this branch with its **own
  Postgres**, so the new DB migrations + UI can be tested without risking pilot data.
- Interim: the live pilot's quality can be made safe today via env vars
  (`GEN_MODEL`, `TUTOR_MODEL` → stronger model) — independent of this build.
