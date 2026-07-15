# Railway staging environment (for the question-bank build)

Goal: run the `feature/question-banks` branch on its own Railway deploy, with
its **own Postgres**, so the new DB migrations and UI can be tested without
touching the production pilot (which stays on `main`).

## Recommended: a second Environment in the same project

Railway "Environments" let one project hold `production` and `staging` side by
side, each with isolated services, variables, and database.

1. **Create the environment.** In the Railway project, open the environment
   switcher (top of the project canvas) → **New Environment** → fork from
   `production`. This duplicates the app service + Postgres and copies variables.
   Name it `staging`.

2. **Point the app service at the branch.** In the `staging` environment, open
   the **app service → Settings → Source** and set the deploy **branch** to
   `feature/question-banks` (production stays on `main`). Leave auto-deploy on so
   pushes to the branch redeploy staging automatically.

3. **Confirm staging has its own Postgres.** The forked environment gets a
   separate Postgres instance. As long as the app's `DATABASE_URL` stays the
   reference `${{Postgres.DATABASE_URL}}`, it resolves to the **staging** database
   inside this environment — not production's. Verify in the service's Variables
   tab. This is the whole point: migrations run against a throwaway DB.

4. **Set staging variables** (app service → Variables). Most copy from
   production; change these:
   - `LTI_TOOL_URL` → the staging domain (see step 5).
   - `LTI_COOKIE_SECRET`, `ADMIN_TOKEN` → fresh values (`openssl rand -hex 32`).
   - `ANTHROPIC_API_KEY` → fine to reuse; consider a dev key with a low spend cap.
   - Model overrides as needed for testing, e.g. `GEN_MODEL=claude-opus-4-8`,
     `TUTOR_MODEL=claude-opus-4-8` (independent of production).
   - Keep `NODE_ENV=production` and the `?sslmode=require` on the DB URL, matching prod.

5. **Give the staging app a domain.** app service → Settings → **Networking →
   Generate Domain**. Use that HTTPS URL as `LTI_TOOL_URL` and for health checks.

6. **Deploy & verify.** Staging builds from the branch. Confirm with the health
   probe — the commit should match the branch head:
   ```bash
   curl -s https://<staging-domain>/healthz | jq .
   ```
   Migrations run automatically on start (`npm start` → `migrate.js`) against the
   staging Postgres.

## Testing the LTI launch on staging

The `/healthz` probe and the bank-build script don't need LTI, but to exercise
the actual student flow you need a Moodle that has the **staging** tool
registered — it's a different URL from production. Register it via Dynamic
Registration at `https://<staging-domain>/register` from your dev/test Moodle
(the local Docker Moodle works — it just needs to reach the HTTPS staging URL).
Production's Moodle registration is untouched.

## Fallback: a separate Railway project

If multiple Environments aren't available on the plan, create a **new Railway
project** from the same GitHub repo instead: set its service branch to
`feature/question-banks`, add a Postgres service, set the same variables, and
generate a domain. Functionally equivalent; just lives in its own project.

## Housekeeping

- Staging runs a second app + Postgres, so it adds Railway usage. **Pause or
  delete the staging environment when you're not actively testing.**
- Staging's Postgres starts empty (no student data) — safe to wipe/reset anytime.
- **Tear down** the staging environment once `feature/question-banks` merges to
  `main`.
