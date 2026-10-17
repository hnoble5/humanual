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

**Memory.** The coach remembers what the user tells it, except anything about a crisis (those exchanges are never sent for memory, and the memory prompt refuses them too). After each chat reply, journal entry, or script request, `/api/remember` updates a short list of facts (people, situations, plans, preferences, wins). The list is stored in the profile, so it syncs, and it's sent with every request. Users can see it and delete any item, or everything, under Profile & settings.

**Storage.** Each device keeps a full copy in the browser (profile and memory, conversations, scripts, journal entries), so the app opens instantly and works offline. With accounts set up, every change is also queued and sent to `/api/sync`, which returns what other devices changed. Per item, the newest edit wins; edit times more than a minute ahead of the server are pulled back, so a device with a wrong clock can't win every conflict. Deletes are kept as markers so other devices remove the item too; "Delete all my data" turns every item into a marker, and other devices clear themselves when they see it. Each account can store up to about 50 MB; past that, new changes stay on the device until the user deletes something. Without Clerk keys the app runs as before: no sign-in, data only in the browser.

## Run it locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and put your Anthropic API key in it.
3. `npx wrangler d1 migrations apply humanual --local` (creates the local database)
4. `npm run dev`, then open http://127.0.0.1:8787

With `DEV_AUTH=true` and no Clerk keys in `.dev.vars`, you get a test sign-in (any name; each name is a separate account). It only works on localhost.

Run the unit tests any time: `npm run test:unit`. Run the browser test with the dev server running: `npm run test:e2e`.

## Public demo

`/demo` (live at https://demo.humanual.app/demo, linked from the elitetestautomation.com portfolio) runs the same app on recorded replies: no sign-in, no API calls, nothing saved, and a reload resets it. Visitors tap sample conversations and example scripts; anything else gets a note that the live app answers it.

After changing the prompts, re-record so the demo matches (costs about 30 API requests): `npm run dev`, then `npm run demo:record`, then `npm run test:demo`.

## Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Who can use the coach is decided in two steps: only the hosts in `APP_HOSTS` (in `wrangler.jsonc`) answer AI requests, and on those hosts the coach needs a signed-in account, except for the guest trial's few free chat messages (see "Guest trial" below). Every AI call belongs to one user or one guest, so it can be tracked and capped (see "AI billing and usage limits" below).

### AI billing and usage limits

The API key belongs to the business, not a person. Use a key from the **Elite Test Automation** organization in the [Claude Console](https://platform.claude.com), from a workspace kept just for Humanual with a monthly spend limit set. That limit is the hard ceiling on the whole bill.

Inside that ceiling, each signed-in user gets a monthly allowance, `USER_MONTHLY_LIMIT_USD` in `wrangler.jsonc` (default `5`). The Worker estimates each response's cost from its token counts (prices in `src/usage.ts`), adds it to the `usage` table in D1 per user per month (UTC), and refuses further AI calls with a 429 once a user reaches the allowance. Anthropic gets a SHA-256 hash of each user's id as `metadata.user_id`, never the id or email.

### Guest trial

People who continue as a guest get `GUEST_MESSAGE_LIMIT` free coach chat messages (default `5`), then the app asks them to create a free account. Scripts, Journal and memory still need an account. The code is in `src/guest.ts`.

- **Counted on the server**, in the `guest_usage` table (migration `0004`), keyed by a random id in an `hm_guest` cookie (HttpOnly, one year). Clearing the page's saved data doesn't reset it.
- **Backstops**, for guests who also clear cookies: at most `GUEST_IP_DAILY_MESSAGES` guest messages per network per UTC day (default `15`; the IP address is stored only as a hash), and at most `GUEST_DAILY_LIMIT_USD` of AI cost per day across all guests together (default `2`). When either is hit, guests see "The free trial is full right now" and are offered an account.
- **Size limits** keep one guest message cheap: at most 12 messages and 12,000 characters per conversation, and a 6,000-token reply budget (`GUEST_MAX_*` in `src/guest.ts`). Each message's worst-case cost is held against the daily cap before the AI runs and swapped for the real cost afterwards, so many messages at once can't slip past it.
- **Only from the app**: guest requests must be JSON from the same address, so another website can't spend the trial through its visitors' browsers.
- **Crisis messages** are still answered after a guest's own free messages run out, and a guest turned away by a backstop still sees the crisis banner.
- A message the coach fails to answer (an error or refusal before any text) is given back to the guest, but still counts toward the network's daily cap.
- `GUEST_MESSAGE_LIMIT` `"0"` turns the trial off. If the `guest_usage` table is missing (migration not applied), the app behaves as before: guests are asked to sign in.

Guest costs go in `guest_usage`, not `usage`:

```sh
npx wrangler d1 execute humanual --remote --command "SELECT key, messages, cost_micros / 1e6 AS usd FROM guest_usage WHERE key LIKE 'day:%' ORDER BY key DESC LIMIT 14"
```

To see who's using what:

```sh
npx wrangler d1 execute humanual --remote --command \
  "SELECT user_id, requests, cost_micros / 1e6 AS usd FROM usage WHERE month = strftime('%Y-%m','now') ORDER BY cost_micros DESC"
```

### Turning on accounts (one time)

1. Create a free application at [clerk.com](https://clerk.com). Turn on the sign-in methods you want (email code is a good default).
2. Create the production database and apply the schema:
   ```sh
   npx wrangler d1 create humanual          # copy the database_id it prints into wrangler.jsonc
   npx wrangler d1 migrations apply humanual --remote   # run again after pulling new migrations
   ```
3. Add the Clerk keys (from Clerk dashboard → API keys) and lock tokens to your site:
   ```sh
   npx wrangler secret put CLERK_PUBLISHABLE_KEY
   npx wrangler secret put CLERK_SECRET_KEY
   npx wrangler secret put CLERK_AUTHORIZED_PARTIES   # https://humanual.app,https://demo.humanual.app
   ```
4. In Clerk, add your site's URL to the allowed origins, then `npm run deploy`.

Existing testers' browser data moves into their account the first time they sign in.

## Addresses

Humanual has its own domain, `humanual.app`, registered with Cloudflare. One Worker answers on every address (see `routes` in `wrangler.jsonc`):

| Address | Who can reach it | What it's for |
|---|---|---|
| `humanual.app` | Only people on the Access list (until launch) | The real app. |
| `demo.humanual.app` | Anyone | The public demo at `/demo`. Any other page sends visitors to the demo, and the coach and sync refuse to run here, so strangers can't spend API credit. |
| `www.humanual.app` | Anyone | Redirects to `humanual.app`. |
| `humanual.elitetestautomation.com`, `coach.elitetestautomation.com` | Anyone | Old addresses. Redirect (301, same path) to `humanual.app` and `demo.humanual.app` (`MOVED_HOSTS` in `src/worker.ts`). |

The `*.workers.dev` address is turned off (`"workers_dev": false`), because it would skip Access.

Linking from elitetestautomation.com: point at `https://humanual.app` and `https://demo.humanual.app/demo?ref=eta`. The demo shows its "back to elitetestautomation.com" link only to visitors who arrive with `?ref=eta` or from that site.

### Private app (Cloudflare Access)

Until the guest trial and payments launch, `humanual.app` stays private. Set this up **before** the first deploy that adds the domain, so the app is never briefly public:

1. In the Cloudflare dashboard, open **Zero Trust**. Under **Settings → Authentication**, make sure **One-time PIN** is on (Access emails a login code; no passwords to manage).
2. Under **Access → Applications**, choose **Add an application → Self-hosted**:
   - Domain: `humanual.app`, path left blank (the whole site, including `/api`).
   - Session duration: something long, like 1 month, so the installed app doesn't keep asking you to log in.
   - Policy: action **Allow**, include **Emails**, and list the addresses allowed in.
3. `npm run deploy`. Wrangler adds the custom domains and creates their DNS records and certificates. It can take a few minutes to start answering.
4. Open `https://humanual.app` in a private window. You should get the Cloudflare login page first, and the app only after entering the emailed code.
5. Accounts (Clerk) are still what sync your data between devices; see "Moving sign-in to humanual.app" below.

When the Access session runs out, the app's requests fail with "Couldn't reach Humanual" until you reload the page and log in again.

### Moving sign-in to humanual.app

- **Production Clerk instance** (publishable key starts `pk_live_`): Clerk dashboard → **Domains** → **Configure** next to the primary domain → **Danger zone → Change domain** → `humanual.app`. Add the DNS records Clerk lists in Cloudflare (DNS records for `humanual.app`, proxy **off**), and wait for Clerk to show them verified. The change creates a **new publishable key**: run `npx wrangler secret put CLERK_PUBLISHABLE_KEY` with it, then deploy, or sign-in breaks. If Google sign-in is on, update its redirect URI in Google Cloud too. People sign in again once; their data is kept.
- **Development instance** (`pk_test_`): no domain to change. Add `https://humanual.app` and `https://demo.humanual.app` to the allowed origins. Switch to a production instance on `humanual.app` before taking payments.
- Either way: `npx wrangler secret put CLERK_AUTHORIZED_PARTIES` with `https://humanual.app,https://demo.humanual.app`.

## Notes

- Model: Claude Opus 5.5 at `medium` effort (memory updates at `low`), with server-side refusal fallback and prompt caching. Rule: anything that works with the user's personal details uses Opus; only features that never see personal details may use Sonnet. Today that's every AI call.
- Cost backstop: AI requests are answered only on the hosts in `APP_HOSTS` and on localhost, only for signed-in users (plus the capped guest trial), and only up to each user's monthly allowance. With no sign-in set up, the coach runs only on localhost (as a single "local" user).
- Guests: with accounts set up, people can continue as a guest and try the coach (see "Guest trial"). Guest data stays in that browser; signing in later moves it into the account.
- Not yet built: payments, per-user rate limiting, Buddy mode (`buddy-system-prompt.md`), real avatar art (placeholders use each coach's colors).
