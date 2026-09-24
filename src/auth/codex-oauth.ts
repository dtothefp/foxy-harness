import { existsSync, renameSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// "Sign in with ChatGPT" via loopback PKCE, same flow as the open-source Codex CLI.
// Tokens live in our own file, never ~/.codex/auth.json: refresh tokens rotate,
// so sharing a file with Codex would log one of us out. See docs/codex-backend.md.

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const PORT = 1455;
const REDIRECT = `http://localhost:${PORT}/auth/callback`;
export const ORIGINATOR = "foxy_harness";

export const HARNESS_HOME = process.env.HARNESS_HOME ?? join(homedir(), ".foxy-harness");

// One-time move from the pre-rename home, so an existing login and sessions carry over.
const OLD_HOME = join(homedir(), ".fox-harness");
if (!process.env.HARNESS_HOME && !existsSync(HARNESS_HOME) && existsSync(OLD_HOME)) renameSync(OLD_HOME, HARNESS_HOME);
const AUTH_FILE = join(HARNESS_HOME, "auth.json");

type TokenResponse = { id_token?: string; access_token: string; refresh_token?: string };
type AuthFile = {
  auth_mode: "chatgpt";
  tokens: { id_token?: string; access_token: string; refresh_token: string; account_id: string };
  last_refresh: string;
};

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

function jwtClaims(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
}

export async function login(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const url = new URL(`${ISSUER}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: ORIGINATOR,
  })) {
    url.searchParams.set(k, v);
  }

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch(req) {
        const q = new URL(req.url);
        if (q.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
        setTimeout(() => server.stop(), 100);
        if (q.searchParams.get("state") !== state) {
          reject(new Error("OAuth state mismatch"));
          return new Response("State mismatch. Try again.", { status: 400 });
        }
        const c = q.searchParams.get("code");
        if (!c) {
          reject(new Error(`OAuth error: ${q.searchParams.get("error_description") ?? "no code"}`));
          return new Response("Login failed.", { status: 400 });
        }
        resolve(c);
        return new Response("Logged in to foxy-harness. You can close this tab.");
      },
    });
    console.log(`Opening browser. If it doesn't open, visit:\n${url}\n`);
    Bun.spawn(["open", url.toString()]);
  });

  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const file = await persist((await res.json()) as TokenResponse);
  const plan = jwtClaims(file.tokens.access_token)["https://api.openai.com/auth"]?.chatgpt_plan_type;
  console.log(`Logged in (plan: ${plan ?? "unknown"}). Tokens saved to ${AUTH_FILE}`);
}

async function refresh(file: AuthFile): Promise<AuthFile> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: file.tokens.refresh_token,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}). Run \`foxy-harness login\` again.\n${await res.text()}`);
  }
  return persist((await res.json()) as TokenResponse, file.tokens.refresh_token);
}

async function persist(t: TokenResponse, prevRefresh?: string): Promise<AuthFile> {
  const claims = jwtClaims(t.id_token ?? t.access_token)["https://api.openai.com/auth"] ?? {};
  const file: AuthFile = {
    auth_mode: "chatgpt",
    tokens: {
      id_token: t.id_token,
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? prevRefresh ?? "",
      account_id: claims.chatgpt_account_id,
    },
    last_refresh: new Date().toISOString(),
  };
  await mkdir(HARNESS_HOME, { recursive: true });
  await Bun.write(AUTH_FILE, JSON.stringify(file, null, 2));
  await chmod(AUTH_FILE, 0o600);
  return file;
}

// Returns a valid access token, refreshing when it expires within 5 minutes.
export async function getAuth(opts: { forceRefresh?: boolean } = {}) {
  const f = Bun.file(AUTH_FILE);
  if (!(await f.exists())) throw new Error("Not logged in. Run `foxy-harness login`.");
  let file = (await f.json()) as AuthFile;
  const exp = jwtClaims(file.tokens.access_token).exp as number | undefined;
  if (opts.forceRefresh || !exp || exp * 1000 - Date.now() < 5 * 60_000) file = await refresh(file);
  return { accessToken: file.tokens.access_token, accountId: file.tokens.account_id };
}
