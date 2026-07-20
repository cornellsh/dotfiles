#!/usr/bin/env bun
// Management CLI for the pi Claude multi-account rotator.
//   claude-accounts list
//   claude-accounts import [--from <path>] [--name <name>]
//   claude-accounts login  [--name <name>]
//   claude-accounts enable|disable|remove <name>
//   claude-accounts priority <name> <n>
//   claude-accounts probe
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
	importCredentials,
	loginOAuth,
	fetchProfile,
	fetchUsage,
	isTokenExpired,
	refreshAccessToken,
} from "./oauth.js";

const PI_DIR = join(homedir(), ".pi", "agent");
const ACCOUNTS_FILE =
	process.env.PI_CLAUDE_ACCOUNTS_FILE || join(PI_DIR, "claude-accounts.json");
const STATE_FILE =
	process.env.PI_CLAUDE_ACCOUNTS_STATE_FILE ||
	join(PI_DIR, "claude-accounts-state.json");
const DEFAULT_CLAUDE_CREDS = join(homedir(), ".claude", ".credentials.json");
const AUTH_FILE = join(PI_DIR, "auth.json");

/** Current anthropic OAuth access token from pi's auth.json (external account). */
function readAuthAccess(): string | null {
	try {
		if (!existsSync(AUTH_FILE)) return null;
		const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
		return auth?.anthropic?.type === "oauth"
			? (auth.anthropic.access ?? null)
			: null;
	} catch {
		return null;
	}
}

interface AccountConfig {
	name: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number | null;
	priority?: number;
	disabled?: boolean;
	subscriptionType?: string;
	external?: boolean;
}
interface AccountsConfig {
	switchThreshold?: number;
	probeOnStart?: boolean;
	accounts: AccountConfig[];
}

function readConfig(): AccountsConfig {
	if (!existsSync(ACCOUNTS_FILE))
		return { switchThreshold: 0.98, probeOnStart: true, accounts: [] };
	try {
		return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"));
	} catch (err: any) {
		fail(`cannot parse ${ACCOUNTS_FILE}: ${err?.message}`);
	}
}

function writeConfig(cfg: AccountsConfig): void {
	mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
	const tmp = `${ACCOUNTS_FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(cfg, null, 2));
	renameSync(tmp, ACCOUNTS_FILE);
}

function readState(): Record<string, any> {
	if (!existsSync(STATE_FILE)) return {};
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function fail(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

function upsert(cfg: AccountsConfig, acc: AccountConfig): void {
	const i = cfg.accounts.findIndex((a) => a.name === acc.name);
	if (i >= 0) cfg.accounts[i] = { ...cfg.accounts[i], ...acc };
	else cfg.accounts.push(acc);
}

async function nameForTokens(
	accessToken: string,
	fallback: string,
): Promise<string> {
	const p = await fetchProfile(accessToken);
	if (p.error || !p.email) return fallback;
	return p.orgName ? `${p.email} (${p.orgName})` : p.email;
}

async function cmdImport(args: string[]): Promise<void> {
	const from = flag(args, "from") || DEFAULT_CLAUDE_CREDS;
	if (!existsSync(from)) fail(`credentials file not found: ${from}`);
	const creds = await importCredentials(from);
	if (!creds.accessToken) fail("no accessToken in credentials file");
	const name =
		flag(args, "name") || (await nameForTokens(creds.accessToken, "imported"));
	const cfg = readConfig();
	upsert(cfg, {
		name,
		accessToken: creds.accessToken,
		refreshToken: creds.refreshToken,
		expiresAt: creds.expiresAt,
		subscriptionType: creds.subscriptionType,
	});
	writeConfig(cfg);
	console.log(`imported account "${name}" (${cfg.accounts.length} total)`);
}

async function cmdLogin(args: string[]): Promise<void> {
	const tokens = await loginOAuth();
	const name =
		flag(args, "name") || (await nameForTokens(tokens.accessToken, "account"));
	const cfg = readConfig();
	upsert(cfg, {
		name,
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
	});
	writeConfig(cfg);
	console.log(`added account "${name}" (${cfg.accounts.length} total)`);
}

function cmdEnableDisable(name: string | undefined, disabled: boolean): void {
	if (!name) fail("account name required");
	const cfg = readConfig();
	const acc = cfg.accounts.find((a) => a.name === name);
	if (!acc) fail(`no account named "${name}"`);
	acc.disabled = disabled;
	writeConfig(cfg);
	console.log(`${disabled ? "disabled" : "enabled"} "${name}"`);
}

function cmdRemove(name: string | undefined): void {
	if (!name) fail("account name required");
	const cfg = readConfig();
	const before = cfg.accounts.length;
	cfg.accounts = cfg.accounts.filter((a) => a.name !== name);
	if (cfg.accounts.length === before) fail(`no account named "${name}"`);
	writeConfig(cfg);
	console.log(`removed "${name}"`);
}

function cmdExternal(name: string | undefined, on: boolean): void {
	if (!name) fail("account name required");
	const cfg = readConfig();
	const acc = cfg.accounts.find((a) => a.name === name);
	if (!acc) fail(`no account named "${name}"`);
	if (on) {
		acc.external = true;
		// External accounts ride on pi's live auth.json token; drop our copies so a
		// stale token is never used and we never rotate pi's shared refresh token.
		delete acc.accessToken;
		delete acc.refreshToken;
		delete acc.expiresAt;
	} else {
		delete acc.external;
	}
	writeConfig(cfg);
	console.log(`${on ? "marked" : "unmarked"} "${name}" as external (pi-owned)`);
	if (on)
		console.log(
			"note: pi manages this account's OAuth; add dedicated accounts with `login`/`import`.",
		);
}

function cmdPriority(name: string | undefined, n: string | undefined): void {
	if (!name || n == null) fail("usage: priority <name> <n>");
	const cfg = readConfig();
	const acc = cfg.accounts.find((a) => a.name === name);
	if (!acc) fail(`no account named "${name}"`);
	acc.priority = parseInt(n, 10) || 0;
	writeConfig(cfg);
	console.log(`set priority of "${name}" to ${acc.priority}`);
}

async function cmdProbe(): Promise<void> {
	const cfg = readConfig();
	if (!cfg.accounts.length) fail("no accounts configured");
	const state = readState();
	const authTok = readAuthAccess();
	for (const acc of cfg.accounts) {
		// External (auth.json-backed) accounts are owned by pi — never refresh them
		// (that rotates pi's shared token). Probe with pi's current token instead.
		if (acc.external) {
			if (!authTok) {
				console.error(`  ${acc.name}: (external) no auth.json token to probe`);
				continue;
			}
			acc.accessToken = authTok;
		}
		if (!acc.accessToken) continue;
		if (
			!acc.external &&
			acc.refreshToken &&
			isTokenExpired(acc.expiresAt ?? null)
		) {
			try {
				const t = await refreshAccessToken(acc.refreshToken);
				acc.accessToken = t.accessToken;
				acc.refreshToken = t.refreshToken;
				acc.expiresAt = t.expiresAt;
			} catch (err: any) {
				console.error(`  ${acc.name}: refresh failed (${err?.message})`);
				continue;
			}
		}
		const u = await fetchUsage(acc.accessToken!);
		if (u.error) {
			console.error(`  ${acc.name}: ${u.error}`);
			continue;
		}
		state[acc.name] = {
			unified5h: u.fiveHour?.utilization ?? null,
			unified5hReset: u.fiveHour?.resetAt ?? null,
			unified7d: u.sevenDay?.utilization ?? null,
			unified7dReset: u.sevenDay?.resetAt ?? null,
			unified7dSonnet: u.sevenDaySonnet?.utilization ?? null,
			unified7dSonnetReset: u.sevenDaySonnet?.resetAt ?? null,
			unified7dFable: u.sevenDayFable?.utilization ?? null,
			unified7dFableReset: u.sevenDayFable?.resetAt ?? null,
		};
	}
	writeConfig(cfg);
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	console.log("probe complete");
	cmdList();
}

function pct(v: number | null | undefined): string {
	return v == null ? "  ?" : `${Math.round(v * 100)}%`.padStart(4);
}

function cmdList(): void {
	const cfg = readConfig();
	const state = readState();
	if (!cfg.accounts.length) {
		console.log(
			"no accounts. Add one with: claude-accounts import   (or: login)",
		);
		return;
	}
	console.log(
		`accounts (threshold ${Math.round((cfg.switchThreshold ?? 0.98) * 100)}%):`,
	);
	for (const a of cfg.accounts) {
		const s = state[a.name] || {};
		const tags = [
			a.external ? "pi/auth.json" : null,
			a.disabled ? "disabled" : null,
			a.priority ? `prio ${a.priority}` : null,
			a.subscriptionType || null,
		]
			.filter(Boolean)
			.join(", ");
		console.log(
			`  ${a.name.padEnd(22)} 5h:${pct(s.unified5h)} 7d:${pct(s.unified7d)} fable:${pct(
				s.unified7dFable,
			)}${tags ? "   " + tags : ""}`,
		);
	}
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case "list":
		case "status":
		case undefined:
			cmdList();
			break;
		case "import":
			await cmdImport(rest);
			break;
		case "login":
			await cmdLogin(rest);
			break;
		case "enable":
			cmdEnableDisable(rest[0], false);
			break;
		case "disable":
			cmdEnableDisable(rest[0], true);
			break;
		case "remove":
		case "rm":
			cmdRemove(rest[0]);
			break;
		case "priority":
			cmdPriority(rest[0], rest[1]);
			break;
		case "external":
			cmdExternal(rest[0], rest[1] !== "off");
			break;
		case "probe":
			await cmdProbe();
			break;
		default:
			console.log(
				[
					"claude-accounts — manage pi Claude multi-account rotation",
					"",
					"  list                       show accounts + quota",
					"  import [--from p] [--name] import Claude Code creds (default ~/.claude/.credentials.json)",
					"  login  [--name n]          browser OAuth login for a new account",
					"  enable  <name>             re-enable an account",
					"  disable <name>             pause an account (kept, skipped by rotation)",
					"  remove  <name>             delete an account",
					"  priority <name> <n>        lower n = preferred (default 0)",
					"  external <name> [off]      mark account as pi/auth.json-owned (never refreshed by us)",
					"  probe                      refresh quota now (no message spend)",
				].join("\n"),
			);
	}
}

main().catch((err) => fail(err?.message || String(err)));
