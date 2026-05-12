# Moodle Biology Bot

> An LTI 1.3 tool that pairs a Socratic tutor with AI-generated practice questions for Human Anatomy & Physiology, grounded in the instructor's own materials.

**Status:** v1.5 deployed to Railway production. Awaiting TRU Moodle sandbox registration.

Built for [BIOL 1592 / 1692](https://human-anatomy-i.pressbooks.tru.ca/) at Thompson Rivers University.

---

## What it does

**For students** 👩‍🎓

| | |
|---|---|
| 💬 **Socratic tutor** | Asks rather than lectures, grounded in the unit's PPTs + textbook + terms |
| ✅ **MC quizzes** | 5 options, with meta-answers ("two of the above" / "None of the above") at higher difficulty |
| 🔘 **TF quizzes** | With explanations of why the false ones are false |
| 📝 **FITB quizzes** | Drawn from the unit's terms list, with synonym tolerance (singular/plural, hyphenated/unhyphenated) |
| ✍️ **Free-response** | Rubric-based LLM grading: per-mark score, what was right, what's missing, what wasn't needed, with a model answer |
| 📋 **Practice exam** | Mixed question types across selected units; optional "exam-realistic" mode hides feedback during the exam |
| 📊 **Progress tracking** | Per-unit-per-kind accuracy with weak-spot detection and "continue where you left off" |
| 🔍 **Per-question deep-dive** | "Want to know more?" on any result for a richer walkthrough with citations |
| 💡 **Tutor seeding** | Clicking "Discuss with tutor" after a quiz primes the chat with the student's actual gaps |

**For instructors** 👩‍🏫

| | |
|---|---|
| 📊 **Class dashboard** | Roster, per-student totals, weak spots across the cohort |
| 🧠 **Concept-gap analysis** | LLM reads wrong answers across the class and writes a study guide of what to revisit, with citations to specific slides / textbook sections |
| 👤 **Per-student drill-down** | Full progress view for any student in the course |

---

## Architecture

- **LTI 1.3** via [`ltijs`](https://github.com/Cvmcosta/ltijs) (Express-based)
- **Backend** — TypeScript + Node 20+, Postgres for app data (`student`, `session`, `quiz_attempt`, `progress_summary`, `tutor_turn`)
- **Frontend** — single HTML/CSS/JS file served by the launch handler; no build step
- **AI** — Anthropic Claude with [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) for per-unit content blocks (typical hit reduces input cost ~10× and latency ~3×)
- **Grounding** — instructor's PPTs (slides + speaker notes), course terms list, example exam DOCX (style anchor), and the TRU Pressbooks A&P I & II open textbooks (REST API)
- **Deployment** — Railway production / Docker Compose local dev (Moodle + MariaDB + Postgres)

## Repo layout

```
materials/           Source PPTs / XLSX / DOCX (gitignored — original copyrighted files)
content/             Per-unit content JSON (committed; deploys need these)
scripts/ingest/      One-shot Python extractors (PPTX, XLSX, DOCX, Pressbooks REST)
src/server/          LTI 1.3 + API server (TypeScript)
  ├ lti.ts           ltijs setup, launch handler, role detection
  ├ tutor.ts         Socratic tutor + SSE streaming
  ├ quiz.ts          MC/TF/FITB/FR generators (zod-validated) + graders
  ├ exam.ts          Practice exam orchestration (parallel generation, shuffle)
  ├ coach.ts         LLM-driven synthesis + per-question "Want to know more?"
  ├ teacher.ts       Class dashboard aggregation + concept-gap analysis
  ├ progress.ts      Per-student progress aggregation
  ├ routes.ts        /api/* HTTP endpoints
  ├ auth.ts          LTI role detection
  └ migrations/      SQL schema
src/web/launch.html  Single-page frontend served post-LTI handshake
docs/                Setup docs + public landing page
```

---

## Getting started

### Local development

Full walkthrough in [docs/dev-setup.md](docs/dev-setup.md). The condensed version (assumes Docker Desktop, Node 20+, Python 3.11+, an ngrok static domain):

```bash
pip3 install -r requirements.txt
npm install
cp .env.example .env
# Edit .env: set LTI_COOKIE_SECRET (openssl rand -hex 32) and ANTHROPIC_API_KEY

docker compose up -d            # Moodle + MariaDB + Postgres
npm run db:migrate              # apply schema once
npm run dev                     # window 1: TS server with hot reload
npm run tunnel                  # window 2: ngrok tunnel to your static domain
```

Register the tool in Moodle's *Manage tools* via Dynamic Registration with URL `<your-tunnel>/register`.

### Content ingestion

Re-extract the unit content if source materials change:

```bash
npm run ingest:all              # PPTs → speaker notes; XLSX → per-unit terms;
                                # DOCX → exam style anchor; Pressbooks → chapters
```

### Deploying to Railway

1. Connect this repo on Railway, add a Postgres service
2. Set env vars on the app service:
   - `ANTHROPIC_API_KEY` — Claude key
   - `LTI_COOKIE_SECRET` — fresh `openssl rand -hex 32`
   - `LTI_TOOL_URL` — your Railway domain
   - `NODE_ENV=production`
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference)
3. The included `railpack.json` forces the Node provider so Railway doesn't mis-detect as Python from `requirements.txt`

The compiled `dist/` build runs migrations on every start (idempotent via the `_migration` table).

---

## Roadmap

**Built (v1 + v1.5)**

- [x] Socratic tutor with prompt-cached unit grounding
- [x] MC / TF / FITB / FR question generation
- [x] FITB synonym tolerance, FR LLM rubric grading
- [x] Practice exam — mixed types, per-unit/per-kind scoring, exam-realistic mode
- [x] Per-student progress tracking with weak-spot detection
- [x] "Discuss with tutor" seeded from a student's quiz gaps
- [x] Per-question "Want to know more?" deep-dive
- [x] LLM concept synthesis on quiz summary
- [x] Class dashboard with concept-gap analysis
- [x] Source citations (Unit N, slide M / Unit N textbook)
- [x] Production deployment

**Next**

- [ ] Pre-production polish: structured error handling, mobile responsiveness, Anthropic token/cost tracking
- [ ] Markdown rendering in tutor + analysis text
- [ ] Printable practice exam + answer key (per the prof's spec)
- [ ] CSV export of class roster/progress
- [ ] Gradebook integration via LTI Assignment & Grade Services
- [ ] 1692 (A&P II) integration once those materials are in hand
- [ ] Drawings / image identification (eventual)

---

## Credits

Built by [Brian Lamb](https://github.com/blamb) (TRU) in collaboration with a biology colleague who provided the course materials and pedagogical guidance. Grounding includes the open [A&P I](https://human-anatomy-i.pressbooks.tru.ca/) and [A&P II](https://human-anatomy-ii.pressbooks.tru.ca/) Pressbooks textbooks from Thompson Rivers University (CC BY 4.0).

Borrows prompt patterns from Brian's earlier [open-margins](https://github.com/blamb/open-margins) project.

## License

To be decided when this repo goes public. Most likely CC BY 4.0 to match open-margins.
