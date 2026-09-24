# Codex backend reference

How the ChatGPT-subscription login and the Codex Responses backend work, read from openai/codex and pi source on 2026-09-24. Not an official API. Diff against pi's `packages/ai/src/api/openai-codex-responses.ts` when it breaks.

## B1. OAuth constants

| Item | Value | Source |
|---|---|---|
| Issuer | `https://auth.openai.com` | codex `login/src/server.rs:76` (`DEFAULT_ISSUER`) |
| Authorize URL | `https://auth.openai.com/oauth/authorize` | `server.rs` `build_authorize_url` |
| Token URL | `https://auth.openai.com/oauth/token` (also used for refresh) | `auth/manager.rs:212` |
| Revoke URL | `https://auth.openai.com/oauth/revoke` | `auth/manager.rs:213` |
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann` (can be overridden with env `CODEX_APP_SERVER_LOGIN_CLIENT_ID`) | `auth/manager.rs:1717`, and the same in pi |
| Redirect URI | `http://localhost:1455/auth/callback` (codex binds port 1455 and falls back to the actual bound port. pi binds `127.0.0.1:1455` but sends `localhost` in the URI.) | `server.rs:77,193` |
| Scopes | codex: `openid profile email offline_access api.connectors.read api.connectors.invoke`. pi: `openid profile email offline_access` (enough for inference). | `server.rs:606`, pi `SCOPE` |
| Extra authorize params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<your originator>` (codex default `codex_cli_rs`, pi sends `pi`), plus an optional `allowed_workspace_id=<ids>` | `server.rs:595-600`, `auth/default_client.rs:42` |
| PKCE | S256. The verifier is 64 random bytes as base64url with no padding, and the challenge is base64url(sha256(verifier)). | `login/src/oauth/pkce.rs`, `oauth/authorization.rs:31` |
| Code exchange | Form-encoded POST: `grant_type=authorization_code, client_id, code, redirect_uri, code_verifier` | `oauth/client.rs:58-73` |
| Refresh | POST `grant_type=refresh_token, client_id, refresh_token`. **Codex sends it as JSON** (`TokenEncoding::Json`) and pi sends it form-encoded, so both work. The response has an optional `id_token`, `access_token` and `refresh_token`, and **refresh tokens rotate**. Error codes are `refresh_token_expired`, `refresh_token_reused` and `refresh_token_invalidated`, and each one means you have to log in again. | `auth/manager.rs:1625-1715` |
| When to refresh | codex refreshes when the access-token JWT `exp` is within 5 minutes, or, if `exp` isn't there, when `last_refresh` is older than 8 days | `auth/manager.rs:203-204, 3005-3026` |
| Device-code (headless) | POST `https://auth.openai.com/api/accounts/deviceauth/usercode` `{client_id}` returns `{device_auth_id,user_code,interval}`. The user visits `https://auth.openai.com/codex/device`. Poll POST `/api/accounts/deviceauth/token` `{device_auth_id,user_code}` until you get `{authorization_code, code_verifier}`, then exchange with `redirect_uri=https://auth.openai.com/deviceauth/callback` | pi `openai-codex.ts` |
| Optional API-key exchange | codex also swaps the id_token for an `openai-api-key` via RFC 8693 token-exchange (`requested_token=openai-api-key`). **This isn't needed** for the subscription path. | `server.rs:1013` `obtain_api_key` |

**Account id:** `chatgpt_account_id` is inside the JWT claim namespace `"https://api.openai.com/auth"`. Codex reads it from the **id_token** at login (`server.rs:847-853`) and persists it as `tokens.account_id`. pi reads the same claim from the **access_token** (`JWT_CLAIM_PATH`). Both tokens carry it. The same namespace also has `chatgpt_plan_type` (free/plus/pro/business/enterprise/edu), `chatgpt_user_id` and `chatgpt_account_is_fedramp`, and email is under `"https://api.openai.com/profile"` (`token_data.rs`).

### Minimal Bun OAuth (browser + PKCE)

```ts
// oauth-codex.ts  (Bun)
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const REDIRECT = "http://localhost:1455/auth/callback";
const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

export async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const u = new URL(`${ISSUER}/oauth/authorize`);
  Object.entries({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT,
    scope: "openid profile email offline_access",
    code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true",
    originator: "my_harness",
  }).forEach(([k, v]) => u.searchParams.set(k, v));

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port: 1455, hostname: "127.0.0.1",
      fetch(req) {
        const q = new URL(req.url);
        if (q.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
        if (q.searchParams.get("state") !== state) { reject(new Error("state mismatch")); return new Response("bad state", { status: 400 }); }
        resolve(q.searchParams.get("code")!); setTimeout(() => server.stop(), 100);
        return new Response("Logged in. You can close this tab.");
      },
    });
    Bun.spawn(["open", u.toString()]); // macOS; print URL as fallback
    console.log("Open:", u.toString());
  });

  const tok = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, redirect_uri: REDIRECT, code_verifier: verifier }),
  }).then(r => { if (!r.ok) throw new Error(`exchange ${r.status}`); return r.json() as any; });
  return persist(tok);
}

export async function refresh(refresh_token: string) {
  const r = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token }),
  });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`); // expired/reused/invalidated => re-login
  return persist(await r.json() as any, refresh_token);
}

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

async function persist(t: { id_token?: string; access_token: string; refresh_token?: string }, prevRefresh?: string) {
  const auth = claims(t.id_token ?? t.access_token)["https://api.openai.com/auth"] ?? {};
  const file = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: t.id_token, access_token: t.access_token,
      refresh_token: t.refresh_token ?? prevRefresh, // rotated on refresh
      account_id: auth.chatgpt_account_id,
    },
    last_refresh: new Date().toISOString(),
  };
  await Bun.write(`${process.env.HOME}/.my-harness/auth.json`, JSON.stringify(file, null, 2)); // chmod 600
  return file;
}
```

Store the file in **your own** directory rather than writing into `~/.codex/auth.json`. Refresh tokens rotate, and two clients sharing one file will hit `refresh_token_reused` and log each other out. Reading `~/.codex/auth.json` to bootstrap is fine as long as you copy it once.

## B2. `~/.codex/auth.json` format

The path is `$CODEX_HOME/auth.json` (default `~/.codex`). Codex may keep it in the OS keyring instead (`cli_auth_credentials_store = file | keyring | auto`) (https://learn.chatgpt.com/docs/auth, which `developers.openai.com/codex/auth` redirects to). The struct is `AuthDotJson` in `codex-rs/login/src/auth/storage.rs:41`:

```json
{
  "auth_mode": "chatgpt",              // lowercase enum: "apikey" | "chatgpt" | "chatgptAuthTokens" | "headers" | "agentIdentity"...
  "OPENAI_API_KEY": null,              // or the exchanged key
  "tokens": {
    "id_token": "<raw JWT string>",    // serialized back as the raw JWT (token_data.rs serialize_id_token)
    "access_token": "<JWT>",
    "refresh_token": "<opaque>",
    "account_id": "<chatgpt_account_id>"   // Option
  },
  "last_refresh": "2026-09-24T12:00:00Z"   // RFC3339 UTC
  // optional, skipped when None: agent_identity, personal_access_token, bedrock_api_key, bedrock_access_keys
}
```

`auth_mode` is `#[serde(rename_all="lowercase")]` in `codex-rs/protocol/src/auth.rs`.

## B3. Inference endpoint, headers, body

- **URL:** `POST https://chatgpt.com/backend-api/codex/responses` (`CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"` in `codex-rs/model-provider-info/src/lib.rs:77`, and `resolveCodexUrl` in pi). The model list is at `GET https://chatgpt.com/backend-api/codex/models` (`model-provider/src/models_endpoint.rs`). Codex and pi now prefer a **WebSocket** transport on the same path (`wss://`, `OpenAI-Beta: responses_websockets=2026-02-06`), but SSE still works and pi falls back to it.
- **Headers (SSE path, from pi's `buildSSEHeaders`, which matches codex):**
  - `Authorization: Bearer <access_token>`
  - `chatgpt-account-id: <account_id>` (codex spells it `ChatGPT-Account-ID`. Headers are case-insensitive.)
  - `OpenAI-Beta: responses=experimental`
  - `originator: <your id>` (codex `codex_cli_rs`, pi `pi`, the old opencode plugin spoofed `codex_cli_rs`. Use your own honest value.)
  - `accept: text/event-stream`, `content-type: application/json`
  - `session-id: <uuid>` plus `x-client-request-id: <uuid>` (the current codex/pi spelling is **hyphenated** `session-id`, with `thread-id` too in codex's `codex-api/src/requests/headers.rs`. The Jan-2026 opencode plugin used `session_id` and `conversation_id`. Send the hyphenated form.)
  - Optional: `User-Agent`. pi also zstd-compresses the body with `content-encoding: zstd`, but that's not required.
- **Body constraints** (codex `ResponsesApiRequest`, `codex-api/src/common.rs:278`, and pi `buildRequestBody`):
  - `store: false` (required on the ChatGPT backend. Codex, pi and the opencode plugin all force it.)
  - `stream: true`
  - `instructions`: required and non-empty. pi sends your own system prompt, or `"You are a helpful assistant."` as a fallback. So **you don't need a verbatim Codex prompt anymore.** The Jan-2026 opencode plugin still fetched Codex's prompt files from GitHub, which reflects older backend behavior.
  - `input`: Responses-API items. No `system` role in input, because the system prompt goes in `instructions`.
  - `include: ["reasoning.encrypted_content"]`. Needed for multi-turn reasoning when `store:false`: echo the encrypted reasoning items back in `input`.
  - `tool_choice: "auto"`, `parallel_tool_calls: true`, `tools: [...]` (function tools)
  - `reasoning: { effort, summary: "auto" }`, `text: { verbosity: "low"|"medium" }`, `prompt_cache_key: <session uuid>`
  - Drop `max_output_tokens` and `max_completion_tokens`. The opencode plugin explicitly unsets them.
- **Model names** (from codex's bundled `codex-rs/models-manager/models.json` at HEAD, all `supported_in_api: true`):
  - Listed models: `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`.
  - Hidden models: `gpt-5.4`, `gpt-daybreak-{blue,red}-latest`, `codex-auto-review`.
  - pi's tests still use `gpt-5.1-codex`, `gpt-5.3-codex`, `gpt-5.4` and `gpt-5.5`.
  - Send **bare** slugs with no `openai/` or `codex/` prefix (yc-software/qm#1250 hit exactly this bug). Plan gating is per model (`available_in_plans`), so call `/codex/models` at startup instead of hard-coding.
- **SSE events:** standard Responses events (`response.output_text.delta`, `response.output_item.done`, `response.completed`), plus Codex-specific `response.done` and `response.incomplete` (pi normalizes them to completed), and `error` / `response.failed`. A 429 carries `retry-after` / `retry-after-ms`. The `usage limit` text means you've hit the plan quota.

### Minimal streaming request (Bun, SSE)

```ts
const auth = await Bun.file(`${process.env.HOME}/.my-harness/auth.json`).json();
const sid = crypto.randomUUID();
const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "chatgpt-account-id": auth.tokens.account_id,
    "OpenAI-Beta": "responses=experimental",
    originator: "my_harness",
    "session-id": sid, "x-client-request-id": sid,
    accept: "text/event-stream", "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.5",
    instructions: "You are a coding agent. Use the bash tool.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "List files in cwd" }] }],
    tools: [{ type: "function", name: "bash", description: "Run a bash command",
              parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    tool_choice: "auto", parallel_tool_calls: true,
    reasoning: { effort: "medium", summary: "auto" },
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    store: false, stream: true, prompt_cache_key: sid,
  }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`); // 401 => refresh + retry once
const dec = new TextDecoder(); let buf = "";
for await (const chunk of res.body!) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    const ev = JSON.parse(data);
    if (ev.type === "response.output_text.delta") process.stdout.write(ev.delta);
    else if (ev.type === "response.output_item.done" && ev.item.type === "function_call") console.log("\nTOOL", ev.item.name, ev.item.arguments, ev.item.call_id);
    else if (ev.type === "error" || ev.type === "response.failed") throw new Error(JSON.stringify(ev));
    else if (["response.completed", "response.done", "response.incomplete"].includes(ev.type)) console.log("\n[done]", ev.response?.usage);
  }
}
// Next turn: append the output items (incl. reasoning items w/ encrypted_content) + {type:"function_call_output", call_id, output} to input.
```

## B4. Policy

- **OpenAI: explicitly tolerated and publicly endorsed for personal use in open-source harnesses. There's no contractual permission.**
  - Tibo Sottiaux (Codex lead) posted: "About 5% of our production traffic is on the Pi harness, about another 5% is on OpenCode. Reminder you can use your ChatGPT account in a flourishing set of other tools." https://x.com/thsottiaux/status/2058071172361998482 (X returned 402 to WebFetch, so the quote comes from the search-engine snippet.)
  - Sam Altman endorsement, as cited by manifest.build: https://x.com/sama/status/2050357911915028689 (not directly verified).
  - Codex for OSS page: "Developers should code in the tools they prefer, whether that's Codex, OpenCode, Cline, pi, OpenClaw, or something else." https://developers.openai.com/community/codex-for-oss (verified).
  - Aug 21 2026 (secondary source): Tibo called subscription-pooling proxies like **sub2api** "not supported." He said they get flagged by fraud prevention, and that the supported path is "Sign in With ChatGPT through official clients or open-source tools (Pi, OpenCode, and similar)." https://explainx.ai/blog/codex-usage-limits-sub2api-sign-in-chatgpt-august-2026
  - The terms themselves say nothing either way: https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/ and https://openai.com/policies/service-terms/.
  - Practical line: a harness where each user logs in with their own account is OK. Resale, pooling or serving other users is not. The pi and opencode-plugin READMEs both say "personal development use."
- **Anthropic: not allowed.** The Claude Code legal page says Free/Pro/Max OAuth "is intended exclusively for … ordinary use of Claude Code and other native Anthropic applications." It says developers, "including those using the Agent SDK, should use API key authentication," and that "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials." https://code.claude.com/docs/en/legal-and-compliance (verified 2026-09-24).
  - Docs updated 2026-02-19: https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
  - Server-side blocking of third-party tools followed in April 2026 (secondary): https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/
  - For Claude in your harness, use an API key or Bedrock/Vertex.
