declare module "*.md" {
  const text: string;
  export default text;
}

interface Env {
  ANTHROPIC_API_KEY: string;
  ACCESS_CODE?: string;
  ASSETS: Fetcher;
  DB: D1Database;
  /** Clerk sign-in. Both keys are needed; until then the app runs without accounts. */
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  /** Optional comma-separated origins allowed to mint sign-in tokens, e.g. https://humanual.example.com */
  CLERK_AUTHORIZED_PARTIES?: string;
  /** "true" enables the localhost-only dev sign-in (local testing before Clerk is set up). */
  DEV_AUTH?: string;
}
