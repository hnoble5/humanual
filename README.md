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
| `src/journal.ts` | Journal: the reply card's fields (`/api/journal` returns encouragement, what went well, one thing to try, a reality check). |
| `src/memory.ts` | Memory: after each chat reply, journal entry, or script, `/api/remember` updates the list of facts the coach keeps about the user. |
| `src/auth.ts` | Sign-in check: verifies the Clerk session token on each request (or the localhost-only dev sign-in). |
| `src/storage.ts` | Sync: `/api/sync` stores each user's profile, conversations, scripts, and journal entries in D1. |
| `migrations/` | D1 database schema. |
| `public/` | The UI (plain HTML/CSS/JS, no build step). |
| `tests/unit/` | Unit tests (`npm run test:unit`, no server or API calls): sync against the real schema in SQLite, the crisis pre-check, and request handling. |
| `tests/e2e-sync.mjs` | Browser test: sign-in, sync between devices, delete-all, and moving pre-account data into an account. |
| `tests/e2e-demo.mjs` | Browser test: the public demo never calls the API or saves anything. |
| `tests/e2e-live.mjs` | Browser test with the real coach (a few API calls): journal reply, memory, and a new chat that remembers. |
| `tools/demo-spec.mjs`, `tools/record-demo.mjs` | What the demo shows, and the tool that records the real coach's replies for it. |
| `public/demo/samples.json` | The recorded demo replies and scripts. |

**Layout.** Tabs across the top (Coach chat, Scripts, Journal), with the form on the left and the result card on the right, following the earlier Plainspoken prototype.

**Memory.** The coach remembers what the user tells it, except anything about a crisis (those exchanges are never sent for memory, and the memory prompt refuses them too). After each chat reply, journal entry, or script request, `/api/remember` updates a short list of facts (people, situations, plans, preferences, wins). The list is stored in the profile, so it syncs, and it's sent with every request. Users can see it and delete any item, or everything, under Profile & settings. Memory updates use Claude Sonnet 5.5 to keep costs down.

**Storage.** Each device keeps a full copy in the browser (profile and memory, conversations, scripts, journal entries), so the app opens instantly and works offline. With accounts set up, every change is also queued and sent to `/api/sync`, which returns what other devices changed. Per item, the newest edit wins; edit times more than a minute ahead of the server are pulled back, so a device with a wrong clock can't win every conflict. Deletes are kept as markers so other devices remove the item too; "Delete all my data" turns every item into a marker, and other devices clear themselves when they see it. Each account can store up to about 50 MB; past that, new changes stay on the device until the user deletes something. Without Clerk keys the app runs as before: no sign-in, data only in the browser.

## Run it locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and put your Anthropic API key in it.
3. `npx wrangler d1 migrations apply humanual --local` (creates the local database)
4. `npm run dev`, then open http://127.0.0.1:8787

With `DEV_AUTH=true` and no Clerk keys in `.dev.vars`, you get a test sign-in (any name; each name is a separate account). It only works on localhost.

Run the unit tests any time: `npm run test:unit`. Run the browser test with the dev server running: `npm run test:e2e`.

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

## Private app (Cloudflare Access)

The Worker answers on two addresses (see `routes` in `wrangler.jsonc`):

| Address | Who can reach it | What it's for |
|---|---|---|
| `coach.elitetestautomation.com` | Anyone | The portfolio demo at `/demo`. The full app here needs the access code, so strangers can't spend API credit. |
| `app.elitetestautomation.com` | Only people on the Access list | The real app. |

The `*.workers.dev` address is turned off (`"workers_dev": false`), because it would skip Access.

### Setting it up (one time)

1. `npm run deploy`. Wrangler adds `app.elitetestautomation.com` as a custom domain and creates its DNS record and certificate. It can take a few minutes to start answering.
2. In the Cloudflare dashboard, open **Zero Trust**. The first time, pick a team name; the free plan covers a small team.
3. Under **Settings → Authentication**, make sure **One-time PIN** is on (Access emails a login code; no passwords to manage).
4. Under **Access → Applications**, choose **Add an application → Self-hosted**:
   - Domain: `app.elitetestautomation.com`, path left blank (the whole site, including `/api`).
   - Session duration: something long, like 1 month, so the installed app doesn't keep asking you to log in.
   - Policy: action **Allow**, include **Emails**, and list the addresses allowed in.
5. Open `https://app.elitetestautomation.com` in a private window. You should get the Cloudflare login page first, and the app only after entering the emailed code.
6. Accounts (Clerk) are still what sync your data between devices. Add the new address to both lists:
   - `npx wrangler secret put CLERK_AUTHORIZED_PARTIES`, with both origins, comma-separated: `https://app.elitetestautomation.com,https://coach.elitetestautomation.com`
   - In Clerk, add `https://app.elitetestautomation.com` to the allowed origins.

When the Access session runs out, the app's requests fail with "Couldn't reach Humanual" until you reload the page and log in again.

## Notes

- Model: Claude Opus 5.5 at `medium` effort, with server-side refusal fallback and prompt caching. Memory updates use Claude Sonnet 5.5.
- Cost backstop: on any address other than localhost, AI requests are refused unless `ACCESS_CODE` or Clerk sign-in is set up, so a missing secret can't leave the API open.
- Not yet built: payments, per-user rate limiting, Buddy mode (`buddy-system-prompt.md`), real avatar art (placeholders use each coach's colors).
