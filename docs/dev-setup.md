# Dev setup

End-to-end instructions to bring the Moodle Biology Bot up locally and launch it from a local Moodle.

Time budget: 15–20 minutes for the first run (Moodle takes a few minutes to initialize on first boot).

## Prereqs (already installed on Brian's Mac)

- Docker Desktop
- Node.js 20+
- Python 3.13
- ngrok (at `~/Downloads/ngrok`)
- An ngrok static domain (`flashcard-rebuilt-junction.ngrok-free.dev`)
- An Anthropic API key

## One-time setup

### 1. Create your `.env`

Copy the template, then fill it in:

```bash
cp .env.example .env
```

Open `.env` in a text editor and set:
- `LTI_COOKIE_SECRET` — paste a random hex string. To generate one in Terminal:
  ```bash
  openssl rand -hex 32
  ```
- `ANTHROPIC_API_KEY` — your Anthropic key (`sk-ant-...`).

Everything else (`LTI_TOOL_URL`, `PORT`, `DATABASE_URL`) is already set for local dev.

### 2. Install dependencies

```bash
npm install
pip3 install -r requirements.txt
```

### 3. Run ingestion (once, to populate `content/`)

```bash
npm run ingest:all
```

This extracts the PPTs, terms, exam, and Pressbooks chapters into `content/`. Re-run any time the source materials change.

## Every dev session

You'll have **three Terminal windows** open simultaneously:

### Window 1 — Docker (Moodle + Postgres)

```bash
docker compose up -d
```

Wait for all services to be healthy. Check with:

```bash
docker compose ps
```

On the first run, Moodle takes 3–5 minutes to install itself. You'll know it's done when `http://localhost:8080` shows a login page. The admin login is `user` / `bitnami`.

Then run database migrations (once per fresh DB):

```bash
npm run db:migrate
```

### Window 2 — Node app

```bash
npm run dev
```

Should print:
```
Moodle Biology Bot is live
  Local:   http://localhost:3000
  Public:  https://flashcard-rebuilt-junction.ngrok-free.dev
  Login:   https://flashcard-rebuilt-junction.ngrok-free.dev/login
  Keyset:  https://flashcard-rebuilt-junction.ngrok-free.dev/keys
```

If Postgres isn't up yet, the server fails fast with a clear error.

### Window 3 — ngrok tunnel

```bash
npm run tunnel
```

Or directly:
```bash
~/Downloads/ngrok http --domain=flashcard-rebuilt-junction.ngrok-free.dev 3000
```

Confirm it's working by visiting `https://flashcard-rebuilt-junction.ngrok-free.dev` in a browser — you should see ltijs's default page or a redirect (since no LTI launch token, it won't show the tool itself).

## Registering the tool in Moodle (one-time per Moodle install)

1. Log in to Moodle at `http://localhost:8080` as `user` / `bitnami`.
2. Top-left menu → **Site administration** → **Plugins** → **External tool** → **Manage tools**.
3. In the "Tool URL" field, paste:
   ```
   https://flashcard-rebuilt-junction.ngrok-free.dev/register
   ```
   And click **Add LTI Advantage**. This uses **Dynamic Registration** — Moodle and our tool exchange config automatically. If it succeeds you'll see "Biology Bot" appear as a registered tool.

4. If dynamic registration doesn't work (older Moodle versions or network quirks), use manual registration instead — click "Configure a tool manually" and fill in:
   - **Tool name:** Biology Bot
   - **Tool URL:** `https://flashcard-rebuilt-junction.ngrok-free.dev/`
   - **LTI version:** LTI 1.3
   - **Public key type:** Keyset URL
   - **Public keyset:** `https://flashcard-rebuilt-junction.ngrok-free.dev/keys`
   - **Initiate login URL:** `https://flashcard-rebuilt-junction.ngrok-free.dev/login`
   - **Redirection URI(s):** `https://flashcard-rebuilt-junction.ngrok-free.dev/`
   - Save.

5. After registration, Moodle shows three pieces of info for the tool — **Client ID**, **Deployment ID**, and **Platform ID** — and a Public keyset URL. We'll need to feed Client ID and Deployment ID back into our tool to complete the platform registration. (See "Registering the platform on the tool side" below.)

## Registering the platform on the tool side

ltijs needs to know about each Moodle instance that's allowed to launch us. For dev, we register the local Moodle once. There's a helper script (TODO: not yet written — for now use the `lti.registerPlatform` API directly from a Node REPL or a quick one-shot script).

Manual approach with the Moodle-provided values:

```bash
node -e "
import('./dist/server/lti.js').then(async ({ lti }) => {
  await lti.registerPlatform({
    url: 'http://localhost:8080',
    name: 'Local Moodle (dev)',
    clientId: 'PASTE-FROM-MOODLE',
    authenticationEndpoint: 'http://localhost:8080/mod/lti/auth.php',
    accesstokenEndpoint: 'http://localhost:8080/mod/lti/token.php',
    authConfig: {
      method: 'JWK_SET',
      key: 'http://localhost:8080/mod/lti/certs.php'
    }
  });
  console.log('Platform registered.');
  process.exit(0);
});
"
```

> ⚠️ This needs a built dist/ — run `npm run build` once. We'll replace this with a CLI helper soon.

## Adding the tool to a course (per course)

1. From Moodle's front page, create a test course: **Site administration** → **Courses** → **Add a new course**.
2. Inside the course: **Turn editing on** → **Add an activity or resource** → **External tool**.
3. Select **Biology Bot** from the preconfigured tool dropdown.
4. Save.
5. Click the activity to launch. You should see the landing page with your name and the unit list.

## Common pitfalls

- **"It says offline" when I visit the ngrok URL** — that's normal when the tunnel isn't running. Start window 3 (the tunnel).
- **Moodle "External tool" can't reach the tool** — check that ngrok is running and the URL in the registration matches the static domain exactly.
- **Cookies blocked / launch silently fails** — Chrome / Safari sometimes block third-party cookies for the launch iframe. In dev, click the "shield" icon in the URL bar and allow cookies for the Moodle origin. Long-term we'd configure the cookie policy explicitly.
- **`npm run dev` complains about Postgres** — `docker compose ps` and confirm `postgres` is `running (healthy)`.

## Shutdown

```bash
# Stop everything (preserves data)
docker compose down

# Reset Moodle + app DBs (DESTRUCTIVE)
docker compose down -v
```
