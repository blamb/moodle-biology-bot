# LTI Tutor

> An LTI 1.3 tool for Moodle (and other LTI Advantage platforms) that runs instructor-designed one-on-one AI tutorials, the "Paski" pattern: faculty-written briefs, a staged Socratic conversation held by voice, placement in the course sequence via deep linking, gradebook passback, and debriefs for both the student and the instructor.

Subject-agnostic: instructors paste their own course materials (lecture notes, transcripts, readings) and the tutor grounds itself in those.

---

## The idea

Sam Paddock's write-up of [Paski](http://www.sampaddock.com/blog/2025/10/27/1-week-five-faculty-130-students-ai-tutor-paski-nps-78-live-faculty-meets-generative-ai), Next Gen Learning's AI tutor, argues that most AI tutors fail because they're bolted on: they sit outside the learning sequence and know nothing about the student. Paski's answer: faculty co-design each tutorial as they'd brief their best TA, the tutorial sits in the core sequence (live lecture → 1-on-1 AI tutorial → group debrief), students hold it by voice, it's personalised from a profile, and results feed back to faculty. Half of students' learning time went to it; NPS +78.

| Paski | LTI Tutor |
|---|---|
| Faculty co-design each tutorial "as they'd guide their best TA" | **Instructor view → Tutorials.** A brief: learning goal, opening question, TA notes (probes in order, what to do when stuck), misconceptions to listen for, success criteria, target length. **Draft it with AI** writes a first pass grounded in your materials. |
| Grounded in course materials | **Course materials.** Paste lecture notes, transcripts or readings (up to ~200k characters each) and attach them to tutorials. They're prompt-cached, so repeated turns cost a fraction. |
| Built into the core sequence | **Deep linking.** In Moodle, add an *External tool* activity, pick this tool, click **Select content**: each tutorial becomes its own activity you place right after its lecture. Launching it opens that tutorial directly. |
| Voice, student decides when to speak | **Push-to-talk** via the browser's Web Speech API (Chrome, Edge, Safari), replies read aloud via speech synthesis. No extra service, no extra cost. |
| Student profile personalises 5–10% | **About you** (optional, invisible to the instructor) feeds the tutorial prompt and the lecture debrief's "Consider this in your context, *name*" section. |
| Pask's conversation theory: understanding confirmed by teaching it back | Staged dialogue: **orient → explore → teach-back → wrap-up**. In teach-back the student explains the idea as if to a classmate; the tutor plays it back and checks. |
| Personalised lecture debriefs | **Lecture debriefs.** Per material, a short written recap: shared big ideas, common slips, a personal section, three self-test questions. Read-aloud button. |
| Group debrief with faculty | Each run ends in a structured summary (mastery, understood, sticking points, teach-back quality). The instructor's **report** aggregates them; **Generate debrief brief** turns them into discussion prompts and a one-minute re-teach for the live follow-up. |
| NPS | Students rate each tutorial 0–10 after finishing; the report shows NPS and comments. |
| Gradebook | Optional completion passback (1/1) via LTI Assignment & Grade Services. |

Not replicated: a realtime voice model (browser speech APIs instead), faculty digital-twin videos, NotebookLM audio podcasts (debriefs are text with read-aloud).

---

## Architecture

- **LTI 1.3** via [`ltijs`](https://github.com/Cvmcosta/ltijs) (Express-based), Postgres-backed. Dynamic registration, deep linking, Assignment & Grade Services.
- **Backend** TypeScript + Node 20+, Postgres for app data. Migrations in `src/server/migrations`.
- **Frontend** one HTML file served by the launch handler; no build step. Markdown via marked + DOMPurify from a CDN.
- **AI** Anthropic Claude through the official SDK. Models per function from env. System prompt order is rules → materials (cached) → brief + profile (cached) → progress note, so a turn mid-tutorial re-reads the materials from cache.
- **Cost tracking** every call writes model, tokens and USD to `api_call`; `/admin/costs?token=…` returns a JSON summary.

```
src/server/
  index.ts        entry: env → LTI → routes → deploy
  lti.ts          ltijs setup, launch, deep-linking picker, /healthz, /fullscreen, /admin/costs
  routes.ts       /api/* (student + instructor + deep-link response)
  tutorials.ts    materials, briefs, profiles, the staged dialogue, summaries, debriefs, AI draft
  grades.ts       AGS completion passback
  reqctx.ts       token / student / attribution / instructor gate helpers
  auth.ts         role detection from LTI claims
  anthropic.ts    SDK client + model selection
  costs.ts        price table + api_call recording + summary
  db.ts, migrate.ts, students.ts
  migrations/001_init.sql
src/web/launch.html
```

---

## Getting started

### Local development

```bash
npm install
cp .env.example .env     # set LTI_COOKIE_SECRET (openssl rand -hex 32), ANTHROPIC_API_KEY, LTI_TOOL_URL
docker compose up -d     # Moodle (localhost:8080, user/bitnami) + Postgres
npm run db:migrate
npm run dev              # the tool, on PORT (default 3000)
ngrok http --domain=<your-static-domain> 3000   # or any HTTPS tunnel; LTI_TOOL_URL must match
```

Register the tool in Moodle: *Site administration → Plugins → External tool → Manage tools → Dynamic registration* with URL `<LTI_TOOL_URL>/register`, then activate it. Check the tool's configuration has:

- **Supports Deep Linking (Content-Item Message)** enabled (ltijs requests it at registration).
- **IMS LTI Assignment and Grade Services**: "Use this service for grade sync and column management" if you want gradebook passback.
- **Default launch container**: "New window" or "Existing window" if you want voice to work without the Full screen step (Moodle's embed iframe doesn't grant microphone access).

### First run as an instructor

1. Launch the tool from the course → **Instructor view → Course materials** → paste a lecture's notes or transcript.
2. **Tutorials → New tutorial** → tick the material → type the topic → **Draft** → edit → set status **Published** → **Save**. **Try it as a student** previews it.
3. Optionally place it in the course: *Add an activity → External tool → (this tool) → Select content*.
4. After students run it: **Report** → **Generate debrief brief** for the live follow-up.

### Deploying

Any Node host with Postgres works. A `railpack.json` is included for Railway. Set `LTI_TOOL_URL`, `DATABASE_URL`, `LTI_COOKIE_SECRET`, `ANTHROPIC_API_KEY`, `NODE_ENV=production` and optionally `ADMIN_TOKEN`, `TOOL_NAME`, `TUTOR_MODEL`, `GEN_MODEL`. `npm start` runs migrations then the server; `GET /healthz` is an unauthenticated liveness probe.

### Models and cost

Defaults are `claude-haiku-4-5` for both functions, the cheapest option that works well at class scale; set `TUTOR_MODEL=claude-sonnet-5-5` or `claude-opus-5-5` for a stronger tutor. Prices for current models are in `src/server/costs.ts`. Materials are prompt-cached, so the marginal cost of a turn is dominated by the transcript, not the course content.

---

## Notes and limits

- **Voice privacy.** Chrome's speech recognition sends audio to Google's speech service; Safari uses Apple's. Firefox has no speech recognition, so the Speak button is disabled there. Typing always works.
- **Voice in the LMS.** Inside Moodle's iframe the microphone is blocked; the page points students to **⛶ Full screen**, which re-issues the session first-party and opens the tool in the full window.
- **Materials are text.** Paste from slides, notes or a transcript. File upload and URL import are the obvious next step.
- **One deployment, many courses.** Everything is scoped by platform issuer + course id. Instructors only see their own course's materials, tutorials and reports.

## Moving this folder into its own repository

The folder is self-contained. From the repository that holds it:

```bash
git subtree split --prefix=lti-tutor -b lti-tutor-standalone
mkdir ../lti-tutor && cd ../lti-tutor && git init
git pull ../<this-repo> lti-tutor-standalone
```

Then add your remote and push.

## License

To be decided.
