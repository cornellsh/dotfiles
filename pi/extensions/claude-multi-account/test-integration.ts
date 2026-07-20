#!/usr/bin/env bun
// Integration tests: drive the real patched globalThis.fetch with a mock
// upstream to exercise token-swap, 401 refresh, 429 failover, rate-limit
// absorb, and reload-singleton behavior. Run: bun test-integration.ts
import ext from "./index.js";
import { AccountManager } from "./manager.js";

let pass = 0;
let fail = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a === b) {
		pass++;
		console.log(`  ✓ ${msg}`);
	} else {
		fail++;
		console.error(
			`  ✗ ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
		);
	}
}

const G = globalThis as any;
const URL_MSG = "https://api.anthropic.com/v1/messages";
function hdr(o: Record<string, string>): Headers {
	const h = new Headers();
	for (const [k, v] of Object.entries(o)) h.set(k, v);
	return h;
}

// Install the patch + publish the handler (no events fired, no file IO yet).
ext({ on: () => {}, registerCommand: () => {} } as any);

interface MockResp {
	status: number;
	headers?: Record<string, string>;
}
let queue: MockResp[] = [];
const seenAuth: string[] = [];
function installMock(): void {
	G.__claudeMA.original = async (_input: any, init: any) => {
		const h = init.headers as Headers;
		seenAuth.push(h.get("authorization") || "");
		const spec = queue.shift() || { status: 200 };
		return new Response("data", { status: spec.status, headers: spec.headers });
	};
}
function setManager(names: string[], refreshFn?: any): AccountManager {
	const m = new AccountManager(
		names.map((n) => ({
			name: n,
			accessToken: `tok-${n}`,
			refreshToken: `r-${n}`,
			expiresAt: Date.now() + 3600e3, // not expiring → no background refresh
		})),
		{ switchThreshold: 0.98, ramp: { enabled: false }, refreshFn },
	);
	G.__claudeMA.manager = m;
	return m;
}
function setManagerCfg(configs: any[], refreshFn?: any): AccountManager {
	const m = new AccountManager(configs, {
		switchThreshold: 0.98,
		ramp: { enabled: false },
		refreshFn,
	});
	G.__claudeMA.manager = m;
	return m;
}
function req(model: string): Promise<Response> {
	return globalThis.fetch(URL_MSG, {
		method: "POST",
		headers: {
			authorization: "Bearer sk-ant-oat-PI",
			"content-type": "application/json",
		},
		body: JSON.stringify({ model, messages: [] }),
	});
}

async function main() {
	installMock();

	// A) happy path — token swapped to the managed account's token
	console.log("A) happy path + token swap");
	{
		setManager(["A"]);
		seenAuth.length = 0;
		queue = [{ status: 200 }];
		const res = await req("claude-opus-4-8");
		eq(res.status, 200, "returns 200");
		eq(
			seenAuth[0],
			"Bearer tok-A",
			"swapped Authorization to account A's token",
		);
	}

	// B) quota-reject 429 → transparent failover to next account
	console.log("B) quota-reject failover");
	{
		const m = setManager(["A", "B"]);
		seenAuth.length = 0;
		queue = [
			{
				status: 429,
				headers: {
					"anthropic-ratelimit-unified-7d-status": "rejected",
					"retry-after": "1",
				},
			},
			{ status: 200 },
		];
		const res = await req("claude-opus-4-8");
		eq(res.status, 200, "final status 200 after failover");
		eq(seenAuth.length, 2, "exactly two upstream calls");
		eq(seenAuth[1], "Bearer tok-B", "retried on account B");
		eq((m as any).accounts[0].quota.unified7d, 1, "A's 7d bucket marked spent");
	}

	// C) Fable-only reject rotates for Fable but not the account wholesale
	console.log("C) Fable-only rejection");
	{
		const m = setManager(["A", "B"]);
		seenAuth.length = 0;
		queue = [
			{
				status: 429,
				headers: {
					"anthropic-ratelimit-unified-7d_oi-status": "rejected",
					"retry-after": "1",
				},
			},
			{ status: 200 },
		];
		const res = await req("claude-fable-5");
		eq(res.status, 200, "fable failover 200");
		eq(
			(m as any).accounts[0].quota.unified7dFable,
			1,
			"only Fable bucket marked on A",
		);
		eq((m as any).accounts[0].quota.unified5h, null, "A's 5h bucket untouched");
	}

	// D) rate-limit 429 (no rejection) → absorb on SAME account, no rotation
	console.log("D) rate-limit absorb (no rotation)");
	{
		setManager(["A", "B"]);
		seenAuth.length = 0;
		queue = [
			{ status: 429, headers: { "retry-after": "0" } }, // no *-status: rejected
			{ status: 200 },
		];
		const res = await req("claude-opus-4-8");
		eq(res.status, 200, "absorbed then 200");
		eq(seenAuth[0], seenAuth[1], "retried the SAME account (no rotation)");
		eq(seenAuth[1], "Bearer tok-A", "stayed on A");
	}

	// D2) cache affinity — identical session sticks even when another account
	// becomes strictly better between turns (warm-cache preservation).
	console.log("D2) cache-affinity stickiness end-to-end");
	{
		const m = setManager(["A", "B"]);
		const soon = Math.floor(Date.now() / 1000);
		m.updateQuota(
			0,
			hdr({ "anthropic-ratelimit-unified-7d-reset": String(soon + 5 * 86400) }),
		);
		m.updateQuota(
			1,
			hdr({ "anthropic-ratelimit-unified-7d-reset": String(soon + 6 * 86400) }),
		);
		seenAuth.length = 0;
		queue = [{ status: 200 }, { status: 200 }];
		await req("claude-opus-4-8"); // first turn lands on A (sooner reset)
		// Make B strictly better now; a stateless selector would switch to it.
		m.updateQuota(
			1,
			hdr({ "anthropic-ratelimit-unified-7d-reset": String(soon + 86400) }),
		);
		await req("claude-opus-4-8"); // same body → same session key → sticky
		eq(seenAuth[0], "Bearer tok-A", "first turn on A");
		eq(
			seenAuth[1],
			"Bearer tok-A",
			"second turn STAYS on A (cache kept warm) despite B now better",
		);
	}

	// D3) external (auth.json) account rides on pi's incoming token, not our copy
	console.log("D3) external account uses pi's live token");
	setManagerCfg([
		{
			name: "pi",
			external: true,
			accessToken: "tok-STALE-COPY",
			expiresAt: Date.now() + 3600e3,
		},
	]);
	seenAuth.length = 0;
	queue = [{ status: 200 }];
	await req("claude-opus-4-8");
	eq(
		seenAuth[0],
		"Bearer sk-ant-oat-PI",
		"external account sends pi's incoming token, not our stale copy",
	);

	// D4) external account 401 rotates to a dedicated account, never errors external
	console.log("D4) external 401 rotates without erroring pi's account");
	{
		const m = setManagerCfg([
			{
				name: "pi",
				external: true,
				accessToken: "x",
				expiresAt: Date.now() + 3600e3,
			},
			{
				name: "B",
				accessToken: "tok-B",
				refreshToken: "r-B",
				expiresAt: Date.now() + 3600e3,
			},
		]);
		seenAuth.length = 0;
		queue = [{ status: 401 }, { status: 200 }];
		const res = await req("claude-opus-4-8");
		eq(res.status, 200, "recovered by rotating off the external account");
		eq(
			(m as any).accounts[0].status,
			"active",
			"external account NOT errored (pi owns it)",
		);
		eq(seenAuth[1], "Bearer tok-B", "rotated to dedicated account B");
	}

	// D5) transient refresh failure during a 401 must NOT error a healthy account
	console.log("D5) transient refresh failure keeps account healthy");
	{
		const m = setManagerCfg(
			[
				{
					name: "A",
					accessToken: "tok-A",
					refreshToken: "r-A",
					expiresAt: Date.now() + 3600e3,
				},
				{
					name: "B",
					accessToken: "tok-B",
					refreshToken: "r-B",
					expiresAt: Date.now() + 3600e3,
				},
			],
			async () => {
				const e: any = new Error("network");
				e.code = "ECONNRESET";
				throw e;
			}, // transient
		);
		seenAuth.length = 0;
		queue = [{ status: 401 }, { status: 200 }];
		const res = await req("claude-opus-4-8");
		eq(res.status, 200, "rotated to B after A's transient refresh failure");
		eq(
			(m as any).accounts[0].status,
			"active",
			"A stays ACTIVE (transient failure never sidelines it)",
		);
	}

	// E) 401 → force refresh + retry once with fresh token
	console.log("E) 401 refresh + retry");
	{
		const m = setManager(["A"], async () => ({
			accessToken: "tok-A-REFRESHED",
			refreshToken: "r-A2",
			expiresAt: Date.now() + 3600e3,
		}));
		seenAuth.length = 0;
		queue = [{ status: 401 }, { status: 200 }];
		const res = await req("claude-opus-4-8");
		eq(res.status, 200, "recovered from 401");
		eq(seenAuth[0], "Bearer tok-A", "first attempt used stale token");
		eq(seenAuth[1], "Bearer tok-A-REFRESHED", "retry used refreshed token");
		eq(
			(m as any).accounts[0].status,
			"active",
			"account stays active after recovery",
		);
	}

	// F) persistent 401 → mark error, no eligible account left
	console.log("F) persistent 401 → error");
	{
		const m = setManager(["A"], async () => ({
			accessToken: "tok-A-STILL-BAD",
			refreshToken: "r-A2",
			expiresAt: Date.now() + 3600e3,
		}));
		seenAuth.length = 0;
		queue = [{ status: 401 }, { status: 401 }];
		const res = await req("claude-opus-4-8");
		eq(res.status, 401, "surfaces 401 when unrecoverable");
		eq((m as any).accounts[0].status, "error", "account marked error");
	}

	// G) reload singleton — a second ext() load reuses the same fetch + state slot
	console.log("G) reload singleton");
	{
		const patchedBefore = globalThis.fetch;
		const originalBefore = G.__claudeMA.original;
		ext({ on: () => {}, registerCommand: () => {} } as any);
		eq(globalThis.fetch, patchedBefore, "fetch not re-wrapped on reload");
		eq(
			G.__claudeMA.original,
			originalBefore,
			"original upstream preserved on reload",
		);
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
}
main();
