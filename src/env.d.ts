declare module "*.md" {
  const text: string;
  export default text;
}

interface Env {
  ANTHROPIC_API_KEY: string;
  ACCESS_CODE?: string;
  ASSETS: Fetcher;
}
