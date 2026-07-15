import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Why this exists:
// `pi-claude-oauth-adapter` makes Claude Pro/Max OAuth requests look like
// first-party Claude Code by injecting an `x-anthropic-billing-header:` system
// block in its `before_provider_request` hook. Extension hooks only run for the
// MAIN session. `pi-long-task` (and other tools) spin up isolated worker/planner
// sub-sessions with extensions DISABLED, so their Anthropic calls ship without
// that header and Anthropic rejects them with HTTP 400:
//   "Third-party apps now draw from your extra usage, not your plan limits."
// which surfaces upstream as the useless "TODO planner did not return assistant
// text."
//
// Those sub-sessions run in the SAME node process and go through global fetch,
// so we patch fetch once and re-apply the adapter's own transform to any OAuth
// Anthropic request that is still missing the billing header. Main-session
// requests already carry it and are left untouched.

const ADAPTER_ENTRY =
  "/home/user/.pi/agent/npm/node_modules/pi-claude-oauth-adapter/extensions/index.ts";
const BILLING_PREFIX = "x-anthropic-billing-header:";
const PATCH_FLAG = "__claudeOauthWorkerFixInstalled";

type ProviderRequestHandler = (
  event: { payload: unknown },
  ctx: unknown,
) => { system?: unknown } | undefined | void;

let cachedHandler: ProviderRequestHandler | null = null;

async function getAdapterHandler(): Promise<ProviderRequestHandler | null> {
  if (cachedHandler) return cachedHandler;
  try {
    const mod = await import(ADAPTER_ENTRY);
    const register = mod.default as ((pi: unknown) => void) | undefined;
    if (typeof register !== "function") return null;
    const handlers: Record<string, unknown> = {};
    register({ on: (evt: string, fn: unknown) => { handlers[evt] = fn; } });
    const handler = handlers["before_provider_request"];
    if (typeof handler === "function") {
      cachedHandler = handler as ProviderRequestHandler;
      return cachedHandler;
    }
  } catch {
    // Adapter not installed / unreadable: leave fetch untouched.
  }
  return null;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === lower) {
        return String(pair[1]);
      }
    }
    return undefined;
  }
  const obj = headers as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lower) return String(obj[key]);
  }
  return undefined;
}

function systemHasBilling(payload: unknown): boolean {
  const system = (payload as { system?: unknown })?.system;
  if (!Array.isArray(system)) return false;
  return system.some(
    (block) =>
      block &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.startsWith(BILLING_PREFIX),
  );
}

function makeCtx(payload: { model?: unknown; system?: unknown }): unknown {
  return {
    model: { provider: "anthropic", id: payload.model },
    modelRegistry: { isUsingOAuth: () => true },
    getSystemPrompt: () =>
      Array.isArray(payload.system)
        ? payload.system
            .map((b) => (b && typeof b.text === "string" ? b.text : ""))
            .join("\n\n")
        : typeof payload.system === "string"
          ? payload.system
          : "",
    ui: { setStatus: () => {}, theme: { fg: (_role: string, text: string) => text } },
  };
}

function installFetchPatch(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[PATCH_FLAG]) return;
  const original = globalThis.fetch;
  if (typeof original !== "function") return;
  g[PATCH_FLAG] = true;

  const patched: typeof fetch = async (input: any, init: any = {}) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
            ? input.url
            : String(input ?? "");
      const method = String(init?.method ?? (input && input.method) ?? "GET").toUpperCase();
      const body = init?.body;

      if (
        method === "POST" &&
        typeof body === "string" &&
        url.includes("api.anthropic.com") &&
        url.includes("/v1/messages")
      ) {
        const auth = readHeader(init?.headers, "authorization");
        const token = auth?.replace(/^Bearer\s+/i, "");
        // Only touch Claude OAuth (Pro/Max) requests; never API-key traffic.
        if (token && token.startsWith("sk-ant-oat") && body.includes("\"system\"")) {
          const payload = JSON.parse(body);
          if (!systemHasBilling(payload)) {
            const handler = await getAdapterHandler();
            if (handler) {
              const result = handler({ payload }, makeCtx(payload));
              const next = result && typeof result === "object" ? result : payload;
              if (next && systemHasBilling(next)) {
                init = { ...init, body: JSON.stringify(next) };
              }
            }
          }
        }
      }
    } catch {
      // Any failure here must not break the request: fall through unchanged.
    }
    return original(input as any, init);
  };

  globalThis.fetch = patched;
}

export default function claudeOauthWorkerFix(pi: ExtensionAPI) {
  // Install as early as possible so it is active before any worker sub-session
  // makes its first Anthropic request.
  installFetchPatch();
  for (const ev of ["session_start", "model_select", "before_agent_start"] as const) {
    pi.on(ev, () => installFetchPatch());
  }
}
