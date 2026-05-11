# Moodle Biology Bot

LTI 1.3 tool for BIOL 1592 / 1692 (Human A&P I and II) at Thompson Rivers University. Provides a Socratic tutor and AI-generated practice questions (MC, TF, FITB) grounded in the course's PPTs, terms list, example exam, and the TRU Pressbooks open textbooks. Tracks per-student progress across units.

## Status

Pre-release. Building the content-ingestion pipeline.

## Layout

```
materials/         Source PPTs / XLSX / DOCX (gitignored — copyrighted course content)
content/           Extracted per-unit content JSON (gitignored)
scripts/ingest/    One-shot extractors that produce content/ from materials/ + Pressbooks
src/server/        LTI 1.3 + API server (TypeScript, Node)
src/web/           Frontend (TypeScript, Vite)
```

## Source materials (BIOL 1592)

- 17 unit PPTs (Units 1–17)
- Key terms XLSX (one column per unit)
- Example exam DOCX + answer key
- Two open textbooks on Pressbooks: `human-anatomy-i.pressbooks.tru.ca`, `human-anatomy-ii.pressbooks.tru.ca`

## Ingestion

```
python3 scripts/ingest/extract_pptx.py
python3 scripts/ingest/extract_xlsx_terms.py
python3 scripts/ingest/extract_exam_docx.py
python3 scripts/ingest/fetch_pressbooks.py
python3 scripts/ingest/build_units.py
```

Outputs land in `content/`.

## Setup

See [docs/dev-setup.md](docs/dev-setup.md) for the full local-dev walkthrough (Docker, migrations, Moodle tool registration, etc.).

Quick version:
```
pip3 install -r requirements.txt
npm install
cp .env.example .env       # then edit and set LTI_COOKIE_SECRET + ANTHROPIC_API_KEY
docker compose up -d
npm run db:migrate
npm run dev                # window 1
npm run tunnel             # window 2 (ngrok)
```
