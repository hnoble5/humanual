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
| `public/` | The UI (plain HTML/CSS/JS, no build step). |

Profiles and conversations live in the user's browser (localStorage). The server stores nothing.

## Run it locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and put your Anthropic API key in it.
3. `npm run dev`, then open http://127.0.0.1:8787

## Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ACCESS_CODE   # strongly recommended: anyone with the URL could otherwise spend your API credit
npm run deploy
```

Testers enter the access code under **Profile & settings**.

## Notes

- Model: Claude Opus 5.5 at `medium` effort, with server-side refusal fallback and prompt caching.
- Not yet built: user accounts / sync across devices, per-user rate limiting, Buddy mode (`buddy-system-prompt.md`), real avatar art (placeholders use each coach's colors).
