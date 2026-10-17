declare module "*.md" {
  const text: string;
  export default text;
}

interface Env {
  ANTHROPIC_API_KEY: string;
  /**
   * Comma-separated hostnames that serve the full app (behind Cloudflare
   * Access), e.g. "humanual.app". Set in wrangler.jsonc.
   * Other hosts get the demo only and no AI. Localhost always counts.
   */
  APP_HOSTS?: string;
  ASSETS: Fetcher;
  DB: D1Database;
  /** Clerk sign-in. Both keys are needed; until then the app runs without accounts. */
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  /** Optional comma-separated origins allowed to mint sign-in tokens, e.g. https://humanual.example.com */
  CLERK_AUTHORIZED_PARTIES?: string;
  /** "true" enables the localhost-only dev sign-in (local testing before Clerk is set up). */
  DEV_AUTH?: string;
  /**
   * Each signed-in user's monthly AI allowance in US dollars (estimated from
   * token counts; see src/usage.ts). Defaults to 5. "0" turns the coach off.
   */
  USER_MONTHLY_LIMIT_USD?: string;
}
