import { createClerkClient, verifyToken } from "@clerk/backend";

export type AuthMode = "clerk" | "dev" | "none";

/**
 * Dev sign-in lets local testing work before Clerk is set up. It only turns on
 * when DEV_AUTH=true (set in .dev.vars, never in production), no Clerk key is
 * configured, and the request is to localhost.
 */
function devAuthAllowed(request: Request, env: Env) {
  if (env.DEV_AUTH !== "true" || env.CLERK_SECRET_KEY) return false;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

export function authMode(request: Request, env: Env): AuthMode {
  if (env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY) return "clerk";
  if (devAuthAllowed(request, env)) return "dev";
  return "none";
}

/** Returns the signed-in user's id, or null if the request isn't signed in. */
export async function getUserId(request: Request, env: Env): Promise<string | null> {
  const mode = authMode(request, env);

  if (mode === "clerk") {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return null;
    try {
      const payload = await verifyToken(token, {
        secretKey: env.CLERK_SECRET_KEY,
        // Only accept tokens minted for our own site(s), when configured.
        authorizedParties: env.CLERK_AUTHORIZED_PARTIES?.split(",").map((s) => s.trim()).filter(Boolean),
      });
      return typeof payload.sub === "string" ? payload.sub : null;
    } catch {
      return null;
    }
  }

  if (mode === "dev") {
    const id = request.headers.get("x-dev-user")?.trim() ?? "";
    return /^[\w.@-]{1,64}$/.test(id) ? `dev_${id}` : null;
  }

  return null;
}

/**
 * The user's main email address from Clerk, so Stripe receipts and invoices go
 * to it. Null with dev sign-in, or when Clerk can't be reached (Checkout then
 * asks for an email itself).
 */
export async function getUserEmail(userId: string, env: Env): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY || userId.startsWith("dev_")) return null;
  try {
    const user = await createClerkClient({ secretKey: env.CLERK_SECRET_KEY }).users.getUser(userId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
    return primary?.emailAddress ?? null;
  } catch (err) {
    console.error("couldn't read the user's email from Clerk", err);
    return null;
  }
}
