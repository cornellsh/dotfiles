import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
	AccountManager,
	type AccountConfig,
	type PersistedState,
	type RejectedBucket,
} from "./manager.js";
import { isTokenExpiringSoon, type Tokens } from "./oauth.js";
import { parseRequestModel } from "./parse.js";

// Multi-account Claude OAuth rotation for pi — teamclaude's core, inline.
//
// pi injects a single account's OAuth token (from ~/.pi/agent/auth.json). This
// patches global fetch so every api.anthropic.com/v1/messages request is routed
// to the best of N configured accounts: it swaps the Authorization bearer, learns
// each account's 5h/weekly/Fable quota from response rate-limit headers, rotates
// at a threshold (default 98%), transparently fails over on a quota-reject 429,
// and absorbs a per-minute rate-limit 429 on the same account (no rotation).
//
// Verified against pi's source: the Anthropic SDK client (and thus the fetch it
// binds) is constructed PER REQUEST via getDefaultFetch(), so this once-installed
// patch applies to every request including worker/subagent sessions (which run
// with extensions disabled — the reason a fetch patch, not an event hook, is
// required). Coexists with claude-oauth-worker-fix.ts (billing header) — the two
// fetch wrappers stack and are independent regardless of load order.

const PI_DIR = join(homedir(), ".pi", "agent");
const ACCOUNTS_FILE =
	process.env.PI_CLAUDE_ACCOUNTS_FILE || join(PI_DIR, "claude-accounts.json");
const STATE_FILE =
	process.env.PI_CLAUDE_ACCOUNTS_STATE_FILE ||
	join(PI_DIR, "claude-accounts-state.json");
const AUTH_FILE = join(PI_DIR, "auth.json");
const LOG_FILE = process.env.PI_CLAUDE_ROTATOR_LOG || null;

// Inline-absorb a rate-limit (non-quota) 429 up to this long by waiting on the
// SAME account, rather than rotating (rotation just moves the burst and throws
// away the account's prompt cache). Longer waits surface the 429 to pi.
const RL_ABSORB_MAX_SECONDS = Number(process.env.PI_CLAUDE_RL_ABSORB_MAX) || 15;
const RL_MAX_WAITS = 2;

interface AccountsConfig {
	switchThreshold?: number;
	probeOnStart?: boolean;
	cacheAffinity?: boolean;
	pinTtlMs?: number;
	accounts: AccountConfig[];
}

// Everything that must survive a /reload (which re-imports this module but keeps
// the already-patched globalThis.fetch) lives on globalThis, so a reload reuses
// the one manager instead of spawning a second one that double-writes state.
interface GlobalState {
	manager?: AccountManager | null;
	installed?: boolean;
	original?: typeof fetch;
	handle?: (input: any, init: any) => Promise<Response>;
	writeChain?: Promise<void>;
	stateTimer?: ReturnType<typeof setTimeout> | null;
	refreshTimer?: ReturnType<typeof setInterval> | null;
	exitHooked?: boolean;
}
const G = globalThis as unknown as { __claudeMA?: GlobalState };
function gstate(): GlobalState {
	if (!G.__claudeMA) G.__claudeMA = {};
	return G.__claudeMA;
}

function log(msg: string): void {
	const line = `[claude-rotator] ${msg}`;
	if (LOG_FILE) {
		try {
			mkdirSync(dirname(LOG_FILE), { recursive: true });
			writeFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, {
				flag: "a",
			});
		} catch {
			/* ignore */
		}
	}
	if (process.env.PI_CLAUDE_ROTATOR_DEBUG) console.error(line);
}

function readJson<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (err: any) {
		log(`failed to read ${path}: ${err?.message}`);
		return null;
	}
}

function writeJsonAtomic(path: string, data: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, path);
	} catch (err: any) {
		log(`failed to write ${path}: ${err?.message}`);
	}
}

interface AuthAnthropic {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
}
function readAuthAnthropic(): AuthAnthropic | null {
	const auth = readJson<{ anthropic?: AuthAnthropic }>(AUTH_FILE);
	return auth?.anthropic?.type === "oauth" && auth.anthropic.access
		? auth.anthropic
		: null;
}

/**
 * Load accounts config; seed a one-account file from auth.json on first run.
 * Marks the auth.json-backed account `external` (pi owns its OAuth rotation) and
 * migrates a pre-existing seeded account whose refresh token still matches
 * auth.json so it stops being refreshed by us (which would rotate it out from
 * under pi and kill it).
 */
function loadConfig(): AccountsConfig {
	const auth = readAuthAnthropic();
	const cfg = readJson<AccountsConfig>(ACCOUNTS_FILE);
	if (cfg && Array.isArray(cfg.accounts)) {
		cfg.accounts = cfg.accounts.filter(
			(a) => a && a.name && (a.accessToken || a.refreshToken || a.external),
		);
		// Migrate: an un-flagged account whose refresh token matches auth.json is
		// really pi's account — flag it external so we never fight pi over rotation.
		let migrated = false;
		if (auth?.refresh) {
			for (const a of cfg.accounts) {
				if (!a.external && a.refreshToken && a.refreshToken === auth.refresh) {
					a.external = true;
					migrated = true;
				}
			}
		}
		if (cfg.accounts.length) {
			if (migrated) {
				writeJsonAtomic(ACCOUNTS_FILE, cfg);
				log(
					"migrated auth.json-backed account to external (pi owns its refresh)",
				);
			}
			return cfg;
		}
	}
	const seeded: AccountsConfig = {
		switchThreshold: 0.98,
		probeOnStart: true,
		accounts: auth
			? [
					{
						name: "default",
						external: true,
						accessToken: auth.access,
						expiresAt: auth.expires,
					},
				]
			: [],
	};
	if (seeded.accounts.length) {
		writeJsonAtomic(ACCOUNTS_FILE, seeded);
		log(`seeded ${ACCOUNTS_FILE} from auth.json (1 external account)`);
	}
	return seeded;
}

/** Sync external (auth.json-backed) accounts' live token from auth.json. */
function syncExternalAccounts(mgr: AccountManager): void {
	const ext = mgr.externalIndices();
	if (!ext.length) return;
	const auth = readAuthAnthropic();
	if (!auth?.access) return;
	for (const idx of ext)
		mgr.setExternalCredential(idx, auth.access, auth.expires ?? null);
}

/** Re-read a dedicated account's refresh token from disk (another owner may have
 * rotated it). Returns true if it changed the in-memory manager. */
function reloadRefreshToken(mgr: AccountManager, name: string): boolean {
	const cfg = readJson<AccountsConfig>(ACCOUNTS_FILE);
	const onDisk = cfg?.accounts?.find((a) => a.name === name);
	if (!onDisk?.refreshToken) return false;
	const acc = mgr.accounts.find((a) => a.name === name);
	if (!acc || acc.refreshToken === onDisk.refreshToken) return false;
	acc.refreshToken = onDisk.refreshToken;
	if (onDisk.accessToken) acc.credential = onDisk.accessToken;
	if (onDisk.expiresAt != null) acc.expiresAt = onDisk.expiresAt;
	return true;
}

/**
 * Persist refreshed tokens back into the accounts file. Serialized through a
 * promise chain that re-reads and merges before each write, so concurrent
 * account refreshes (e.g. several expiring together at startup) can't clobber
 * each other's new tokens (last-writer-wins on a stale read).
 */
function persistToken(name: string, tokens: Tokens): void {
	const g = gstate();
	g.writeChain = (g.writeChain ?? Promise.resolve())
		.then(() => {
			const cfg = readJson<AccountsConfig>(ACCOUNTS_FILE);
			if (!cfg?.accounts) return;
			const acc = cfg.accounts.find((x) => x.name === name);
			if (!acc) return;
			acc.accessToken = tokens.accessToken;
			acc.refreshToken = tokens.refreshToken;
			acc.expiresAt = tokens.expiresAt;
			writeJsonAtomic(ACCOUNTS_FILE, cfg);
		})
		.catch((err) => log(`persistToken failed: ${err?.message}`));
}

function scheduleStatePersist(): void {
	const g = gstate();
	if (g.stateTimer) return;
	g.stateTimer = setTimeout(() => {
		g.stateTimer = null;
		flushState();
	}, 3000);
	g.stateTimer.unref?.();
}

function flushState(): void {
	const g = gstate();
	if (g.manager) writeJsonAtomic(STATE_FILE, g.manager.exportState());
}

function hookExitFlush(): void {
	const g = gstate();
	if (g.exitHooked) return;
	g.exitHooked = true;
	const flush = () => {
		try {
			flushState();
		} catch {
			/* ignore */
		}
	};
	process.once("exit", flush);
	process.once("beforeExit", flush);
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		try {
			process.once(sig, () => {
				flush();
			});
		} catch {
			/* some sandboxes disallow signal handlers */
		}
	}
}

function ensureManager(): AccountManager | null {
	const g = gstate();
	if (g.manager) return g.manager;
	const cfg = loadConfig();
	if (!cfg.accounts.length) {
		log("no accounts configured — rotator idle (run `claude-accounts import`)");
		return null;
	}
	const mgr = new AccountManager(cfg.accounts, {
		switchThreshold: cfg.switchThreshold ?? 0.98,
		cacheAffinity: cfg.cacheAffinity ?? true,
		pinTtlMs: cfg.pinTtlMs,
		log,
		onChange: scheduleStatePersist,
	});
	mgr.onTokenRefresh = (name, tokens) => persistToken(name, tokens);
	mgr.reloadRefreshToken = (name) => reloadRefreshToken(mgr, name);
	const state = readJson<PersistedState>(STATE_FILE);
	if (state) mgr.restoreState(state);
	syncExternalAccounts(mgr); // give external accounts pi's live token before use
	mgr.selectStart();
	g.manager = mgr;
	hookExitFlush();
	startRefreshTimer();
	log(`loaded ${cfg.accounts.length} account(s)`);
	// Keep dedicated tokens ahead of expiry from the start.
	void mgr.refreshExpiring().catch(() => {});
	if (cfg.probeOnStart !== false) {
		syncExternalAccounts(mgr);
		mgr
			.probeAll()
			.then(() => {
				mgr.selectStart();
				scheduleStatePersist();
				log("startup quota probe complete");
			})
			.catch((err) => log(`startup probe failed: ${err?.message}`));
	}
	return mgr;
}

// Proactively keep dedicated tokens fresh (and external tokens synced from
// auth.json) on an interval, so a token is never caught expired at request time
// and the refresh token is exercised regularly. Singleton + unref'd so it never
// keeps the process alive or duplicates across a /reload.
function startRefreshTimer(): void {
	const g = gstate();
	if (g.refreshTimer) return;
	const everyMs = Number(process.env.PI_CLAUDE_REFRESH_INTERVAL_MS) || 60_000;
	g.refreshTimer = setInterval(() => {
		const mgr = g.manager;
		if (!mgr) return;
		syncExternalAccounts(mgr);
		void mgr
			.refreshExpiring()
			.catch((err) => log(`proactive refresh failed: ${err?.message}`));
	}, everyMs);
	g.refreshTimer.unref?.();
}

// ---- fetch header helpers ------------------------------------------------

function extractUrl(input: any): string {
	if (typeof input === "string") return input;
	if (input && typeof input.url === "string") return input.url;
	return String(input ?? "");
}

function copyHeadersInto(target: Headers, src: unknown): void {
	if (!src) return;
	if (
		typeof (src as Headers).forEach === "function" &&
		typeof (src as Headers).get === "function"
	) {
		(src as Headers).forEach((v, k) => target.set(k, v));
		return;
	}
	if (Array.isArray(src)) {
		for (const pair of src)
			if (Array.isArray(pair)) target.set(String(pair[0]), String(pair[1]));
		return;
	}
	for (const [k, v] of Object.entries(src as Record<string, unknown>))
		target.set(k, String(v));
}

function collectHeaders(input: any, init: any): Headers {
	const h = new Headers();
	if (input && typeof input === "object" && "headers" in input)
		copyHeadersInto(h, (input as any).headers);
	copyHeadersInto(h, init?.headers);
	return h;
}

function readAuthToken(input: any, init: any): string | undefined {
	const auth = collectHeaders(input, init).get("authorization");
	return auth?.replace(/^Bearer\s+/i, "");
}

/** Build a new init with Authorization replaced by the given token. */
function withAuth(input: any, init: any, token: string): any {
	const h = collectHeaders(input, init);
	h.set("authorization", `Bearer ${token}`);
	return { ...init, headers: h };
}

// Stable per-session key for cache-affinity routing. Anthropic prompt caching
// is keyed on content: a session's cached prefix (system + tools) is emitted at
// the END of pi's request body, while `messages` (which grows each turn) sits at
// the front with the stable first user message near its start. Hashing a small
// window from each end yields a key that is constant across a session's turns
// and distinct between sessions, at O(1) cost. Worst case (a hash collision)
// merely co-locates two sessions on one account — never a correctness issue.
function sessionKeyOf(body: unknown): string | null {
	if (typeof body !== "string" || body.length === 0) return null;
	const head = body.slice(0, 2048);
	const tail = body.length > 2048 ? body.slice(-4096) : "";
	return `${fnv1a(head)}:${fnv1a(tail)}:${body.length >> 12}`;
}

function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function parseRetryAfter(res: Response): number {
	const ra = parseInt(res.headers.get("retry-after") || "", 10);
	if (!isNaN(ra) && ra >= 0) return ra;
	const reset = parseInt(
		res.headers.get("anthropic-ratelimit-unified-5h-reset") || "",
		10,
	);
	if (!isNaN(reset)) return Math.max(1, reset - Math.floor(Date.now() / 1000));
	return 60;
}

/**
 * Which quota bucket a 429 rejected, or null when it is an ordinary per-minute
 * rate-limit (no bucket rejected). Reads the per-bucket `-status: rejected`
 * headers, falling back to the aggregate status scoped to the request's model.
 */
function classifyRejection(
	res: Response,
	model: string | null,
): RejectedBucket | null {
	const s = (name: string) =>
		res.headers.get(`anthropic-ratelimit-unified-${name}-status`) ===
		"rejected";
	if (s("5h")) return "5h";
	if (s("7d")) return "7d";
	if (s("7d_oi")) return "fable";
	if (res.headers.get("anthropic-ratelimit-unified-status") === "rejected") {
		return /fable/i.test(model || "") ? "fable" : "7d";
	}
	return null;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		let t: ReturnType<typeof setTimeout>;
		const done = () => {
			clearTimeout(t);
			signal?.removeEventListener?.("abort", done);
			resolve();
		};
		t = setTimeout(done, ms);
		signal?.addEventListener?.("abort", done, { once: true });
	});
}

// ---- the request handler -------------------------------------------------

async function handleAnthropicMessages(
	input: any,
	init: any,
): Promise<Response> {
	const g = gstate();
	const original = g.original!;
	const mgr = ensureManager();
	const body = init?.body;
	if (!mgr) return original(input, init);

	const model = typeof body === "string" ? parseRequestModel(body) : null;
	const sessionKey = sessionKeyOf(body);
	const signal: AbortSignal | undefined = init?.signal;
	const isAborted = () => !!signal?.aborted;
	const canRetry = typeof body === "string";
	// pi keeps the auth.json (external) account's token fresh and hands it to us as
	// the incoming bearer; use that for external accounts rather than our (never-
	// refreshed) stored copy, and never rotate pi's shared refresh token ourselves.
	const incomingToken = readAuthToken(input, init);
	const tokenFor = (a: {
		external: boolean;
		credential?: string;
	}): string | undefined =>
		a.external ? (incomingToken ?? a.credential) : a.credential;

	let acc = await mgr.selectFreshForSession(sessionKey, model);
	if (!acc || !tokenFor(acc)) return original(input, init); // fleet exhausted

	const tried = new Set<number>();
	let rlWaits = 0;
	let lastRes: Response | null = null;
	const maxAttempts = mgr.accounts.length + RL_MAX_WAITS + 1;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const idx = acc.index;
		tried.add(idx);
		const usedToken = tokenFor(acc)!;
		// External accounts are refreshed by pi, not us; only nudge dedicated ones.
		if (!acc.external && isTokenExpiringSoon(acc.expiresAt))
			void mgr.ensureTokenFresh(idx);

		const admitted = await mgr.admit(idx, isAborted);
		let res: Response;
		try {
			res = await original(input, withAuth(input, init, usedToken));
		} catch (err) {
			if (admitted) mgr.release(idx);
			throw err; // real transport error — let pi handle it
		}
		if (admitted) mgr.release(idx);
		lastRes = res;
		mgr.updateQuota(idx, res.headers);

		// --- 401: token stale/rotated. ---
		if (res.status === 401) {
			if (acc.external) {
				// pi owns this token; we must not refresh (would rotate its shared
				// refresh token). Rotate this request away; pi self-heals next request.
				const next = canRetry
					? await mgr.selectFreshForSession(sessionKey, model, tried)
					: null;
				if (next && !tried.has(next.index)) {
					await res.body?.cancel().catch(() => {});
					acc = next;
					continue;
				}
				return res;
			}
			await mgr.ensureTokenFresh(idx, true); // force; errors the account only on a genuine 400/401/403
			const fresh = mgr.accounts[idx];
			const refreshed = tokenFor(fresh);
			if (
				fresh.status !== "error" &&
				refreshed &&
				refreshed !== usedToken &&
				canRetry
			) {
				await res.body?.cancel().catch(() => {});
				const res2 = await original(input, withAuth(input, init, refreshed));
				mgr.updateQuota(idx, res2.headers);
				lastRes = res2;
				if (res2.status !== 401) {
					if (res2.ok) mgr.clearRateLimited(idx);
					return res2;
				}
				mgr.markError(idx); // fresh token STILL 401s → genuinely bad account
			}
			// Otherwise: a transient refresh failure left the token unchanged — do NOT
			// error a healthy account; just rotate this request away and retry later.
			const next = await mgr.selectFreshForSession(sessionKey, model, tried);
			if (next && !tried.has(next.index)) {
				await lastRes.body?.cancel().catch(() => {});
				acc = next;
				continue;
			}
			return lastRes;
		}

		// --- 429: quota rejection (rotate) vs rate-limit (absorb, no rotation) ---
		if (res.status === 429) {
			const bucket = classifyRejection(res, model);
			const retryAfter = parseRetryAfter(res);
			if (bucket) {
				mgr.markBucketRejected(idx, bucket);
				// Also hold the account briefly so it isn't re-picked immediately.
				mgr.markRateLimited(idx, Math.min(Math.max(retryAfter, 1), 3600));
				const next = canRetry
					? await mgr.selectFreshForSession(sessionKey, model, tried)
					: null;
				if (next && !tried.has(next.index)) {
					await res.body?.cancel().catch(() => {});
					acc = next;
					continue;
				}
				return res; // nothing else eligible
			}
			// Plain rate-limit: pause (still selectable) and absorb inline.
			mgr.pauseAccount(idx, Math.min(retryAfter, RL_ABSORB_MAX_SECONDS));
			if (
				retryAfter <= RL_ABSORB_MAX_SECONDS &&
				rlWaits < RL_MAX_WAITS &&
				canRetry &&
				!isAborted()
			) {
				rlWaits++;
				await res.body?.cancel().catch(() => {});
				await sleepAbortable(retryAfter * 1000, signal);
				// retry the SAME account (do not rotate) — tried already has idx.
				continue;
			}
			return res; // surface the 429
		}

		if (res.ok) mgr.clearRateLimited(idx);
		return res;
	}
	return lastRes ?? original(input, init);
}

// ---- installation --------------------------------------------------------

function installFetchPatch(): void {
	const g = gstate();
	// Always publish the newest handler so /reload picks up code changes.
	g.handle = handleAnthropicMessages;
	if (g.installed) return;
	const original = globalThis.fetch;
	if (typeof original !== "function") return;
	g.original = original;
	g.installed = true;

	const patched: typeof fetch = (input: any, init: any = {}) => {
		try {
			const url = extractUrl(input);
			const method = String(
				init?.method ?? (input && input.method) ?? "GET",
			).toUpperCase();
			if (
				method === "POST" &&
				url.includes("api.anthropic.com") &&
				url.includes("/v1/messages")
			) {
				const token = readAuthToken(input, init);
				if (token && token.startsWith("sk-ant-oat")) {
					const handle = gstate().handle;
					if (handle) return handle(input, init);
				}
			}
		} catch (err: any) {
			log(`patch dispatch error (passing through): ${err?.message}`);
		}
		return (gstate().original || original)(input as any, init);
	};
	globalThis.fetch = patched;
	log("fetch patch installed");
}

export default function claudeMultiAccount(pi: ExtensionAPI) {
	installFetchPatch();
	const reinstall = () => {
		installFetchPatch();
		ensureManager();
	};
	for (const ev of ["session_start", "model_select", "before_agent_start"]) {
		(pi.on as (e: string, fn: () => void) => void)(ev, reinstall);
	}
	// Flush persisted quota when pi shuts down (belt-and-suspenders with the
	// process exit hooks, since the debounce timer is unref'd).
	(pi.on as (e: string, fn: () => void) => void)("session_shutdown", () =>
		flushState(),
	);

	pi.registerCommand?.("claude-accounts", {
		description: "Show Claude multi-account rotation status",
		handler: async (_args: string, ctx: any) => {
			const mgr = ensureManager();
			if (!mgr) {
				ctx.ui.notify(
					"No accounts configured. Run: claude-accounts import",
					"warn",
				);
				return;
			}
			const pct = (v: number | null) =>
				v == null ? "  ?" : `${Math.round(v * 100)}%`.padStart(3);
			const dur = (ms: number | null) => {
				if (ms == null || ms <= 0) return "";
				const h = Math.floor(ms / 3.6e6);
				const d = Math.floor(h / 24);
				return d > 0 ? ` ${d}d${h % 24}h` : ` ${h}h`;
			};
			const lines = mgr.status().map((s) => {
				const mark = s.current ? "►" : " ";
				const tag = s.disabled
					? " [disabled]"
					: s.status !== "active"
						? ` [${s.status}]`
						: "";
				const ext = s.external ? " (pi)" : "";
				return `${mark} ${(s.name + ext).padEnd(20)} 5h:${pct(s.session)} 7d:${pct(
					s.weekly,
				)} fable:${pct(s.fable)} reqs:${s.requests}${tag}${dur(s.resetIn) ? ` resets${dur(s.resetIn)}` : ""}`;
			});
			ctx.ui.notify(`Claude accounts\n${lines.join("\n")}`, "info");
		},
	});
}
