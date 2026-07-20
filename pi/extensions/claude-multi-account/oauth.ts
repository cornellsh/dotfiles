// OAuth helpers for the multi-account rotator. Ported/trimmed from teamclaude
// (MIT, KarpelesLab/teamclaude) to run inline inside pi instead of a proxy.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import { createInterface } from "node:readline";
import http from "node:http";

export interface Tokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_USAGE_BETA = "oauth-2025-04-20";
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTHORIZE = "https://claude.ai/oauth/authorize";
const OAUTH_SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export function normalizeExpiresAt(
	v: number | undefined | null,
): number | null {
	if (!v) return null;
	return v < 1e12 ? v * 1000 : v;
}

export function isTokenExpiringSoon(
	expiresAt: number | null,
	thresholdMs = 5 * 60 * 1000,
): boolean {
	if (!expiresAt) return false;
	return Date.now() + thresholdMs >= (normalizeExpiresAt(expiresAt) as number);
}

export function isTokenExpired(expiresAt: number | null): boolean {
	if (!expiresAt) return false;
	return Date.now() >= (normalizeExpiresAt(expiresAt) as number);
}

/** Refresh an access token via the refresh token. Retries transient 5xx/network. */
export async function refreshAccessToken(
	refreshToken: string,
): Promise<Tokens> {
	const maxRetries = 2;
	const timeoutMs = Number(process.env.PI_CLAUDE_REFRESH_TIMEOUT_MS) || 30_000;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
			const res = await fetch(TOKEN_ENDPOINT, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/plain, */*",
					"User-Agent": "axios/1.13.6",
				},
				body: JSON.stringify({
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: CLIENT_ID,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				if (res.status >= 500 && attempt < maxRetries) {
					await res.body?.cancel();
					continue;
				}
				const text = await res.text();
				const err: any = new Error(
					`Token refresh failed (${res.status}): ${text}`,
				);
				err.status = res.status;
				throw err;
			}
			const data: any = await res.json();
			return {
				accessToken: data.access_token,
				refreshToken: data.refresh_token || refreshToken,
				expiresAt:
					normalizeExpiresAt(data.expires_at) ||
					Date.now() + (data.expires_in || 3600) * 1000,
			};
		} catch (err: any) {
			const isNet =
				err?.name === "TimeoutError" ||
				err?.name === "AbortError" ||
				String(err?.message).includes("fetch failed") ||
				[
					"ECONNRESET",
					"ECONNREFUSED",
					"ETIMEDOUT",
					"UND_ERR_CONNECT_TIMEOUT",
				].includes(err?.code);
			if (attempt < maxRetries && isNet) continue;
			throw err;
		}
	}
	throw new Error("unreachable");
}

/** Import credentials from a Claude Code credentials.json (or compatible). */
export async function importCredentials(
	filePath: string,
): Promise<Tokens & { subscriptionType?: string }> {
	const resolved = filePath.replace(/^~/, homedir());
	const text = await readFile(resolved, "utf-8");
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`invalid JSON in credentials file: ${resolved}`);
	}
	const data = raw.claudeAiOauth || raw.anthropic || raw;
	return {
		accessToken: data.accessToken || data.access,
		refreshToken: data.refreshToken || data.refresh,
		expiresAt: normalizeExpiresAt(data.expiresAt || data.expires) as number,
		subscriptionType: data.subscriptionType,
	};
}

export interface Profile {
	accountUuid?: string;
	email?: string;
	name?: string;
	orgName?: string;
	hasClaudeMax?: boolean;
	hasClaudePro?: boolean;
	error?: string;
}

export async function fetchProfile(accessToken: string): Promise<Profile> {
	try {
		const res = await fetch(PROFILE_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const data: any = await res.json();
		return {
			accountUuid: data.account?.uuid,
			email: data.account?.email,
			name: data.account?.display_name,
			orgName: data.organization?.name,
			hasClaudeMax: data.account?.has_claude_max,
			hasClaudePro: data.account?.has_claude_pro,
		};
	} catch (err: any) {
		return { error: err?.message || String(err) };
	}
}

export interface UsageBucket {
	utilization: number | null;
	resetAt: number | null;
}
export interface Usage {
	fiveHour?: UsageBucket | null;
	sevenDay?: UsageBucket | null;
	sevenDaySonnet?: UsageBucket | null;
	sevenDayFable?: UsageBucket | null;
	error?: string;
}

function normalizeUsageBucket(bucket: any): UsageBucket | null {
	if (!bucket || typeof bucket !== "object") return null;
	const rawPct =
		bucket.used_percentage ??
		bucket.utilization ??
		bucket.usedPercentage ??
		bucket.percent;
	const parsedPct = typeof rawPct === "number" ? rawPct : parseFloat(rawPct);
	const utilization = Number.isFinite(parsedPct) ? parsedPct / 100 : null;
	const rawReset =
		bucket.resets_at ?? bucket.resetsAt ?? bucket.reset_at ?? bucket.resetAt;
	let resetAt: number | null = null;
	if (typeof rawReset === "number")
		resetAt = rawReset < 1e12 ? rawReset * 1000 : rawReset;
	else if (typeof rawReset === "string") {
		const asNum = Number(rawReset);
		if (Number.isFinite(asNum) && rawReset.trim() !== "")
			resetAt = asNum < 1e12 ? asNum * 1000 : asNum;
		else {
			const parsed = Date.parse(rawReset);
			if (Number.isFinite(parsed)) resetAt = parsed;
		}
	}
	return { utilization, resetAt };
}

function findScopedWeekly(data: any, pattern: RegExp): any {
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	const entry = limits.find(
		(l: any) =>
			l &&
			l.group === "weekly" &&
			l.scope?.model?.display_name &&
			pattern.test(l.scope.model.display_name),
	);
	return entry ? { percent: entry.percent, resets_at: entry.resets_at } : null;
}

/** Read quota utilization WITHOUT spending message quota. */
export async function fetchUsage(accessToken: string): Promise<Usage> {
	try {
		const res = await fetch(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": OAUTH_USAGE_BETA,
				Accept: "application/json",
			},
		});
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const data: any = await res.json();
		return {
			fiveHour: normalizeUsageBucket(data?.five_hour),
			sevenDay: normalizeUsageBucket(data?.seven_day),
			sevenDaySonnet: normalizeUsageBucket(data?.seven_day_sonnet),
			sevenDayFable: normalizeUsageBucket(findScopedWeekly(data, /fable/i)),
		};
	} catch (err: any) {
		return { error: err?.message || String(err) };
	}
}

/** Browser PKCE login. Returns tokens for a new account. */
export async function loginOAuth(): Promise<Tokens> {
	const codeVerifier = randomBytes(32).toString("base64url");
	const codeChallenge = createHash("sha256")
		.update(codeVerifier)
		.digest("base64url");
	const state = randomBytes(32).toString("base64url");
	const { port, codePromise, server } = await startCallbackServer(state);
	const redirectUri = `http://localhost:${port}/callback`;

	// OAUTH_AUTHORIZE is a fixed, valid constant, so this never throws in practice.
	let authUrl: URL;
	try {
		authUrl = new URL(OAUTH_AUTHORIZE);
	} catch (err: any) {
		throw new Error(`invalid authorize URL: ${err?.message}`);
	}
	authUrl.searchParams.set("code", "true");
	authUrl.searchParams.set("client_id", CLIENT_ID);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("scope", OAUTH_SCOPES);
	authUrl.searchParams.set("code_challenge", codeChallenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	authUrl.searchParams.set("state", state);

	console.log("Opening browser for authentication...");
	console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
	openBrowser(authUrl.toString());

	let code: string;
	try {
		code = await raceWithStdinCode(codePromise, state);
	} finally {
		server.close();
	}

	const tokenRes = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			code,
			state,
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
		}),
	});
	if (!tokenRes.ok)
		throw new Error(
			`Token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`,
		);
	const tokens: any = await tokenRes.json();
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt:
			normalizeExpiresAt(tokens.expires_at) ||
			Date.now() + (tokens.expires_in || 3600) * 1000,
	};
}

function raceWithStdinCode(
	callbackPromise: Promise<string>,
	expectedState: string,
): Promise<string> {
	if (!process.stdin.isTTY) return callbackPromise;
	return new Promise((resolve, reject) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stderr,
		});
		let settled = false;
		const settle = (fn: (v?: any) => void, val?: any) => {
			if (settled) return;
			settled = true;
			rl.close();
			fn(val);
		};
		rl.question(
			"Paste authorization code here (or wait for browser callback): ",
			(answer) => {
				const trimmed = answer.trim();
				if (!trimmed) return;
				try {
					const url = new URL(trimmed);
					const code = url.searchParams.get("code");
					const st = url.searchParams.get("state");
					if (code) {
						if (expectedState && st && st !== expectedState)
							settle(reject, new Error("OAuth state mismatch"));
						else settle(resolve, code);
						return;
					}
				} catch {
					// Not a URL — fall through and treat the raw input as the code.
				}
				settle(resolve, trimmed);
			},
		);
		callbackPromise.then(
			(code) => settle(resolve, code),
			(err) => settle(reject, err),
		);
	});
}

function startCallbackServer(
	expectedState: string,
): Promise<{
	port: number;
	codePromise: Promise<string>;
	server: http.Server;
}> {
	return new Promise((resolve, reject) => {
		let resolveCode!: (c: string) => void;
		let rejectCode!: (e: Error) => void;
		const codePromise = new Promise<string>((res, rej) => {
			resolveCode = res;
			rejectCode = rej;
		});
		const server = http.createServer((req, res) => {
			const url = new URL(req.url || "/", "http://localhost");
			if (url.pathname === "/callback") {
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				const st = url.searchParams.get("state");
				if (error) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>",
					);
					rejectCode(new Error(`OAuth error: ${error}`));
					return;
				}
				if (expectedState && st !== expectedState) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end("<html><body><h2>State mismatch</h2></body></html>");
					rejectCode(new Error("OAuth state mismatch"));
					return;
				}
				if (code) {
					res.writeHead(302, {
						Location:
							"https://platform.claude.com/oauth/code/success?app=claude-code",
					});
					res.end();
					resolveCode(code);
					return;
				}
			}
			res.writeHead(404);
			res.end("Not found");
		});
		server.listen(0, () =>
			resolve({ port: (server.address() as any).port, codePromise, server }),
		);
		server.on("error", reject);
		const timer = setTimeout(() => {
			rejectCode(new Error("Login timed out after 2 minutes"));
			server.close();
		}, 120_000);
		timer.unref();
	});
}

function openBrowser(url: string): void {
	const cmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "start"
				: "xdg-open";
	exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
