# humanual
A web app helping neurodivergent adults deal with social situations without overloading.

This is **Coach mode**: Heather's `social-coach` skill turned into a web app, with Junie and Otis as coaches and a Direct / Gentle setting.

## What's here

| Path | What it is |
|---|---|
| `prompts/coach-system-prompt.md` | The coaching instructions (the skill, generalized for any user). Edit this to change how the coach behaves. |
| `prompts/coaches/junie.md`, `otis.md` | Coach personas, from `junie-otis-character-profiles.md`. |
| `src/worker.ts` | Cloudflare Worker: `/api/chat` streams replies from Claude; serves the UI. |
| `src/prompt.ts` | Assembles the system prompt: coaching rules → persona + style → user profile + mode. |
| `src/crisis.ts` | Crisis pre-check that runs on every message before the model sees it. |
| `src/script.ts` | Scripts tool: the script card's fields (`/api/script` returns one as structured JSON). |
| `src/auth.ts` | Sign-in check: verifies the Clerk session token on each request (or the localhost-only dev sign-in). |
| `src/storage.ts` | Sync: `/api/sync` stores each user's profile, conversations, and scripts in D1. |
| `migrations/` | D1 database schema. |
| `public/` | The UI (plain HTML/CSS/JS, no build step). |
| `tests/e2e-sync.mjs` | Browser test: sign-in and sync between two devices. |
| `tests/e2e-demo.mjs` | Browser test: the public demo never calls the API or saves anything. |
| `tools/demo-spec.mjs`, `tools/record-demo.mjs` | What the demo shows, and the tool that records the real coach's replies for it. |
| `public/demo/samples.json` | The recorded demo replies and scripts. |

**Storage.** Each device keeps a full copy in the browser, so the app opens instantly and works offline. With accounts set up, every change is also queued and sent to `/api/sync`, which returns what other devices changed. Per item, the newest edit wins; deletes are kept as markers so other devices remove the item too. Without Clerk keys the app runs as before: no sign-in, data only in the browser.

## Run it locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and put your Anthropic API key in it.
3. `npx wrangler d1 migrations apply humanual --local` (creates the local database)
4. `npm run dev`, then open http://127.0.0.1:8787

With `DEV_AUTH=true` and no Clerk keys in `.dev.vars`, you get a test sign-in (any name; each name is a separate account). It only works on localhost.

Run the browser test with the dev server running: `npm run test:e2e`.

## Public demo

`/demo` (live at https://coach.elitetestautomation.com/demo, linked from the elitetestautomation.com portfolio) runs the same app on recorded replies: no sign-in, no API calls, nothing saved, and a reload resets it. Visitors tap sample conversations and example scripts; anything else gets a note that the live app answers it.

After changing the prompts, re-record so the demo matches (costs about 30 API requests): `npm run dev`, then `npm run demo:record`, then `npm run test:demo`.

## Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ACCESS_CODE   # strongly recommended: anyone with the URL could otherwise spend your API credit
npm run deploy
```

Testers enter the access code under **Profile & settings**.

### Turning on accounts (one time)

1. Create a free application at [clerk.com](https://clerk.com). Turn on the sign-in methods you want (email code is a good default).
2. Create the production database and apply the schema:
   ```sh
   npx wrangler d1 create humanual          # copy the database_id it prints into wrangler.jsonc
   npx wrangler d1 migrations apply humanual --remote
   ```
3. Add the Clerk keys (from Clerk dashboard → API keys) and lock tokens to your site:
   ```sh
   npx wrangler secret put CLERK_PUBLISHABLE_KEY
   npx wrangler secret put CLERK_SECRET_KEY
   npx wrangler secret put CLERK_AUTHORIZED_PARTIES   # e.g. https://humanual.heathermnobles.workers.dev
   ```
4. In Clerk, add your site's URL to the allowed origins, then `npm run deploy`.

Existing testers' browser data moves into their account the first time they sign in.

## Notes

- Model: Claude Opus 5.5 at `medium` effort, with server-side refusal fallback and prompt caching.
- Not yet built: payments, per-user rate limiting, Buddy mode (`buddy-system-prompt.md`), real avatar art (placeholders use each coach's colors).
