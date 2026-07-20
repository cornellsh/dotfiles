#!/usr/bin/env bun
// Edge-case tests for the multi-account rotator. Run: bun test.ts
import { AccountManager } from "./manager.js";
import { parseRequestModel } from "./parse.js";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log(`  ✓ ${msg}`);
	} else {
		fail++;
		console.error(`  ✗ ${msg}`);
	}
}
function eq(a: unknown, b: unknown, msg: string): void {
	ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

const now = () => Math.floor(Date.now() / 1000);
function hdr(o: Record<string, string>): Headers {
	const h = new Headers();
	for (const [k, v] of Object.entries(o)) h.set(k, v);
	return h;
}
function mgrOf(names: string[], refreshFn?: any) {
	return new AccountManager(
		names.map((n) => ({
			name: n,
			accessToken: `sk-ant-oat-${n}`,
			refreshToken: `r-${n}`,
			expiresAt: Date.now() + 3600e3,
		})),
		{ switchThreshold: 0.98, ramp: { enabled: false }, refreshFn },
	);
}

// ---- parse.ts: top-level model only --------------------------------------
console.log("parse: top-level model extraction");
eq(
	parseRequestModel('{"model":"claude-opus-4-8","messages":[]}'),
	"claude-opus-4-8",
	"reads leading top-level model",
);
eq(
	parseRequestModel(
		'{"messages":[{"role":"user","content":"model: claude-x"}],"model":"claude-opus-4-8"}',
	),
	"claude-opus-4-8",
	"ignores 'model' text inside content",
);
eq(
	parseRequestModel(
		'{"messages":[{"model":"nested-bad"}],"model":"claude-sonnet-4-6"}',
	),
	"claude-sonnet-4-6",
	"ignores nested 'model' KEY inside array element",
);
eq(
	parseRequestModel('{"tools":[],"model":"claude-fable-5"}'),
	"claude-fable-5",
	"model after other keys",
);
eq(parseRequestModel("not json"), null, "non-JSON → null");
eq(parseRequestModel(""), null, "empty → null");

// ---- selection: soonest-reset, priority ----------------------------------
console.log("selection: soonest-reset & priority");
{
	const m = mgrOf(["A", "B"]);
	m.updateQuota(
		0,
		hdr({
			"anthropic-ratelimit-unified-7d-utilization": "0.5",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 7 * 86400),
		}),
	);
	m.updateQuota(
		1,
		hdr({
			"anthropic-ratelimit-unified-7d-utilization": "0.5",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 3 * 86400),
		}),
	);
	eq(m.select("claude-opus-4-8")?.name, "B", "picks soonest weekly reset");
}
{
	const m = mgrOf(["A", "B"]);
	(m as any).accounts[1].priority = -1; // B preferred
	m.updateQuota(
		0,
		hdr({
			"anthropic-ratelimit-unified-7d-utilization": "0.5",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 86400),
		}),
	);
	m.updateQuota(
		1,
		hdr({
			"anthropic-ratelimit-unified-7d-utilization": "0.5",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 7 * 86400),
		}),
	);
	eq(m.select("claude-opus-4-8")?.name, "B", "priority beats soonest-reset");
}

// ---- per-family Fable bucket ---------------------------------------------
console.log("per-family: Fable-only rejection bars only Fable");
{
	const m = mgrOf(["A", "B"]);
	// Both accounts have KNOWN weekly windows (A sooner) so the discover-unknown
	// preference doesn't interfere; A is the natural pick for opus.
	m.updateQuota(
		0,
		hdr({
			"anthropic-ratelimit-unified-5h-utilization": "0.2",
			"anthropic-ratelimit-unified-7d-utilization": "0.2",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 5 * 86400),
		}),
	);
	m.updateQuota(
		1,
		hdr({
			"anthropic-ratelimit-unified-5h-utilization": "0.2",
			"anthropic-ratelimit-unified-7d-utilization": "0.2",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 6 * 86400),
		}),
	);
	m.markBucketRejected(0, "fable"); // A's Fable spent
	eq(m.select("claude-opus-4-8")?.name, "A", "opus still served by A");
	eq(m.select("claude-fable-5")?.name, "B", "fable rotates away from A");
}

// ---- 5h bucket gates all models ------------------------------------------
console.log("5h bucket gates every model");
{
	const m = mgrOf(["A", "B"]);
	m.markBucketRejected(0, "5h");
	eq(m.select("claude-opus-4-8")?.name, "B", "5h-spent A skipped for opus");
	eq(m.select("claude-fable-5")?.name, "B", "5h-spent A skipped for fable");
}

// ---- markError removes from rotation -------------------------------------
console.log("markError");
{
	const m = mgrOf(["A", "B"]);
	m.markError(0);
	eq(m.select("claude-opus-4-8")?.name, "B", "errored A skipped");
	eq(
		m.select("claude-opus-4-8", new Set([1]))?.name ?? "none",
		"none",
		"no eligible when B excluded & A errored",
	);
}

// ---- token refresh: coalescing + injectable + error classification -------
console.log("token refresh");
{
	let calls = 0;
	const m = mgrOf(["A"], async (_rt: string) => {
		calls++;
		await new Promise((r) => setTimeout(r, 20));
		return {
			accessToken: "sk-ant-oat-A2",
			refreshToken: "r-A2",
			expiresAt: Date.now() + 3600e3,
		};
	});
	(m as any).accounts[0].expiresAt = Date.now() - 1000; // expired
	await Promise.all([
		m.ensureTokenFresh(0),
		m.ensureTokenFresh(0),
		m.ensureTokenFresh(0),
	]);
	eq(calls, 1, "concurrent refreshes coalesce into one");
	eq((m as any).accounts[0].credential, "sk-ant-oat-A2", "credential updated");
}
{
	const m = mgrOf(["A"], async () => {
		const e: any = new Error("bad");
		e.status = 400;
		throw e;
	});
	(m as any).accounts[0].expiresAt = Date.now() - 1000;
	await m.ensureTokenFresh(0, true);
	eq(
		(m as any).accounts[0].status,
		"error",
		"auth-rejection (400) → error state",
	);
}
{
	const m = mgrOf(["A"], async () => {
		const e: any = new Error("net");
		e.code = "ECONNRESET";
		throw e;
	});
	(m as any).accounts[0].expiresAt = Date.now() - 1000;
	await m.ensureTokenFresh(0, true);
	eq(
		(m as any).accounts[0].status,
		"active",
		"transient net error does NOT sideline account",
	);
}

// ---- storm control: ramp caps concurrency on a fresh account -------------
console.log("storm control (ramp)");
{
	const m = new AccountManager([{ name: "A", accessToken: "sk-ant-oat-A" }], {
		ramp: {
			enabled: true,
			startConc: 1,
			stepConc: 1,
			stepMs: 100000,
			windowMs: 100000,
			pollMs: 5,
		},
	});
	(m as any).beginRamp((m as any).accounts[0]);
	const a1 = await m.admit(0); // takes the 1 slot
	eq(a1, true, "first request admitted immediately");
	let secondAdmitted = false;
	const p2 = m.admit(0).then(() => {
		secondAdmitted = true;
	});
	await new Promise((r) => setTimeout(r, 30));
	eq(secondAdmitted, false, "second request waits (cap=1 during ramp)");
	m.release(0);
	await p2;
	eq(secondAdmitted, true, "second admitted after first releases");
	m.release(0);
}
{
	const m = new AccountManager([{ name: "A", accessToken: "x" }], {
		ramp: { enabled: true, pollMs: 5 },
	});
	(m as any).beginRamp((m as any).accounts[0]);
	const aborted = await m.admit(0, () => true);
	eq(aborted, false, "admit returns false when aborted");
}

// ---- quota persistence round-trip ----------------------------------------
console.log("quota persistence");
{
	const m = mgrOf(["A", "B"]);
	m.updateQuota(
		0,
		hdr({
			"anthropic-ratelimit-unified-7d-utilization": "0.42",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 5 * 86400),
		}),
	);
	const state = m.exportState();
	const m2 = mgrOf(["A", "B"]);
	m2.restoreState(state);
	eq(
		(m2 as any).accounts[0].quota.unified7d,
		0.42,
		"restored weekly utilization",
	);
}
{
	const m = mgrOf(["A"]);
	m.updateQuota(
		0,
		hdr({
			"anthropic-ratelimit-unified-5h-utilization": "0.9",
			"anthropic-ratelimit-unified-5h-reset": String(now() - 10),
		}),
	);
	m.refreshExpiredQuotas();
	eq((m as any).accounts[0].quota.unified5h, null, "expired window cleared");
}

// ---- cache affinity: sticky per-session routing --------------------------
console.log("cache affinity (sticky sessions)");
{
	const m = mgrOf(["A", "B"]);
	// B resets sooner, so plain select would prefer B; stickiness must keep the
	// session wherever it first landed.
	m.updateQuota(
		0,
		hdr({
			"anthropic-ratelimit-unified-7d-utilization": "0.3",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 7 * 86400),
		}),
	);
	m.updateQuota(
		1,
		hdr({
			"anthropic-ratelimit-unified-7d-utilization": "0.3",
			"anthropic-ratelimit-unified-7d-reset": String(now() + 3 * 86400),
		}),
	);
	const first = m.selectForSession("sess-1", "claude-opus-4-8")?.name;
	const again = m.selectForSession("sess-1", "claude-opus-4-8")?.name;
	eq(again, first, "same session sticks to its first account across turns");
}
{
	const m = mgrOf(["A", "B"]);
	m.updateQuota(
		0,
		hdr({ "anthropic-ratelimit-unified-7d-reset": String(now() + 5 * 86400) }),
	);
	m.updateQuota(
		1,
		hdr({ "anthropic-ratelimit-unified-7d-reset": String(now() + 5 * 86400) }),
	);
	const pinned = m.selectForSession("s", "claude-opus-4-8")!;
	m.markBucketRejected(pinned.index, "5h"); // pinned account now exhausted
	const rerouted = m.selectForSession("s", "claude-opus-4-8")?.name;
	ok(
		rerouted != null && rerouted !== pinned.name,
		`session re-pins when its account is exhausted (${pinned.name} → ${rerouted})`,
	);
}
{
	const m = mgrOf(["A", "B"]);
	m.updateQuota(
		0,
		hdr({ "anthropic-ratelimit-unified-7d-reset": String(now() + 5 * 86400) }),
	);
	m.updateQuota(
		1,
		hdr({ "anthropic-ratelimit-unified-7d-reset": String(now() + 5 * 86400) }),
	);
	const s1 = m.selectForSession("one", "claude-opus-4-8")!;
	m.markBucketRejected(s1.index, "5h"); // force the next new session elsewhere
	const s2 = m.selectForSession("two", "claude-opus-4-8")?.name;
	ok(s2 !== s1.name, "a different session can occupy a different account");
}
{
	const m = new AccountManager(
		[
			{ name: "A", accessToken: "a" },
			{ name: "B", accessToken: "b" },
		],
		{ ramp: { enabled: false }, cacheAffinity: false },
	);
	m.updateQuota(
		1,
		hdr({ "anthropic-ratelimit-unified-7d-reset": String(now() + 86400) }),
	);
	m.updateQuota(
		0,
		hdr({ "anthropic-ratelimit-unified-7d-reset": String(now() + 7 * 86400) }),
	);
	eq(
		m.selectForSession("x", "claude-opus-4-8")?.name,
		"B",
		"affinity off → plain soonest-reset select",
	);
}
{
	const m = mgrOf(["A", "B"]);
	(m as any).pinTtlMs = 20; // expire fast
	const first = m.selectForSession("t", "claude-opus-4-8")!.index;
	m.markBucketRejected(first, "5h");
	await new Promise((r) => setTimeout(r, 30)); // pin expires
	const after = m.selectForSession("t", "claude-opus-4-8")?.index;
	ok(after !== first, "expired pin is not reused");
}

// ---- OAuth lifecycle: external accounts + proactive/rotation-safe refresh --
console.log("oauth lifecycle");
{
	let calls = 0;
	const m = new AccountManager(
		[
			{
				name: "ext",
				external: true,
				accessToken: "e1",
				refreshToken: "re",
				expiresAt: Date.now() - 1000,
			},
		],
		{
			refreshFn: async () => {
				calls++;
				return {
					accessToken: "e2",
					refreshToken: "re2",
					expiresAt: Date.now() + 3600e3,
				};
			},
		},
	);
	await m.ensureTokenFresh(0, true);
	eq(
		calls,
		0,
		"external account is NEVER refreshed by us (pi owns its rotation)",
	);
}
{
	const refreshed = new Set<string>();
	const m = new AccountManager(
		[
			{
				name: "a",
				accessToken: "a1",
				refreshToken: "ra",
				expiresAt: Date.now() + 60_000,
			}, // expiring soon
			{
				name: "ext",
				external: true,
				accessToken: "e1",
				refreshToken: "re",
				expiresAt: Date.now() + 60_000,
			},
			{
				name: "b",
				accessToken: "b1",
				refreshToken: "rb",
				expiresAt: Date.now() + 3600e3,
			}, // not soon
		],
		{
			refreshFn: async (rt: string) => {
				refreshed.add(rt);
				return {
					accessToken: "x",
					refreshToken: "y",
					expiresAt: Date.now() + 3600e3,
				};
			},
		},
	);
	await m.refreshExpiring();
	eq(
		refreshed.has("ra"),
		true,
		"refreshExpiring refreshes a dedicated soon-to-expire token",
	);
	eq(refreshed.has("re"), false, "refreshExpiring skips external accounts");
	eq(
		refreshed.has("rb"),
		false,
		"refreshExpiring skips tokens not near expiry",
	);
}
{
	// A 400 (refresh token rotated by another owner) triggers a re-read + retry.
	const m = new AccountManager(
		[
			{
				name: "a",
				accessToken: "a1",
				refreshToken: "OLD",
				expiresAt: Date.now() - 1000,
			},
		],
		{
			refreshFn: async (rt: string) => {
				if (rt === "OLD") {
					const e: any = new Error("rotated");
					e.status = 400;
					throw e;
				}
				return {
					accessToken: "a2",
					refreshToken: "r2",
					expiresAt: Date.now() + 3600e3,
				};
			},
		},
	);
	let call = 0;
	m.reloadRefreshToken = () => {
		call++;
		if (call === 2) {
			(m as any).accounts[0].refreshToken = "NEW";
			return true;
		}
		return false;
	};
	await m.ensureTokenFresh(0, true);
	eq(
		(m as any).accounts[0].status,
		"active",
		"400-then-reload recovers WITHOUT erroring the account",
	);
	eq(
		(m as any).accounts[0].credential,
		"a2",
		"refreshed with the reloaded (rotated) token",
	);
}
{
	// A hard 400 with no newer token on disk is a genuine dead account.
	const m = new AccountManager(
		[
			{
				name: "a",
				accessToken: "a1",
				refreshToken: "DEAD",
				expiresAt: Date.now() - 1000,
			},
		],
		{
			refreshFn: async () => {
				const e: any = new Error("revoked");
				e.status = 400;
				throw e;
			},
		},
	);
	m.reloadRefreshToken = () => false; // nothing newer on disk
	await m.ensureTokenFresh(0, true);
	eq(
		(m as any).accounts[0].status,
		"error",
		"genuine 400 with no rotation available → error",
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
