// Account rotation + quota tracking for the pi multi-account rotator.
// Core selection logic ported/trimmed from teamclaude (MIT) to run inline in pi.
import {
	refreshAccessToken,
	isTokenExpiringSoon,
	isTokenExpired,
	fetchUsage,
	type Tokens,
	type Usage,
} from "./oauth.js";

export interface AccountConfig {
	name: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number | null;
	priority?: number;
	disabled?: boolean;
	subscriptionType?: string;
	// External = backed by pi's auth.json. pi owns its OAuth rotation; we never
	// refresh it (that would rotate the shared refresh token out from under pi).
	external?: boolean;
}

interface Quota {
	unified5h: number | null;
	unified7d: number | null;
	unified7dSonnet: number | null;
	unified7dFable: number | null;
	unified5hReset: number | null;
	unified7dReset: number | null;
	unified7dSonnetReset: number | null;
	unified7dFableReset: number | null;
	unifiedStatus: string | null;
}

type Status = "active" | "throttled" | "exhausted" | "error";

interface Account {
	index: number;
	name: string;
	priority: number;
	disabled: boolean;
	external: boolean;
	credential: string | undefined;
	refreshToken: string | null;
	expiresAt: number | null;
	status: Status;
	probing: boolean;
	requalify: boolean;
	quota: Quota;
	rateLimitedUntil: number | null;
	throttledAt: number | null;
	requests: number;
	lastUsed: number | null;
	_refreshPromise: Promise<void> | null;
	// Storm control: concurrent upstream requests in flight, and the time this
	// account last became current (starts a ramp window). pausedUntil holds a
	// rate-limit pause during which new requests wait in admit() without the
	// account becoming unavailable (so selection never rotates away from it).
	inFlight: number;
	rampStartedAt: number | null;
	pausedUntil: number | null;
}

export type RejectedBucket = "5h" | "7d" | "fable";

interface RampConfig {
	enabled: boolean;
	startConc: number;
	stepConc: number;
	stepMs: number;
	windowMs: number;
	pollMs: number;
}

const PERSISTED_QUOTA_FIELDS: (keyof Quota)[] = [
	"unified5h",
	"unified7d",
	"unified7dSonnet",
	"unified7dFable",
	"unified5hReset",
	"unified7dReset",
	"unified7dSonnetReset",
	"unified7dFableReset",
	"unifiedStatus",
];

function emptyQuota(): Quota {
	return {
		unified5h: null,
		unified7d: null,
		unified7dSonnet: null,
		unified7dFable: null,
		unified5hReset: null,
		unified7dReset: null,
		unified7dSonnetReset: null,
		unified7dFableReset: null,
		unifiedStatus: null,
	};
}

function modelFamily(
	model: string | null,
): "fable" | "sonnet" | "opus" | "haiku" | "other" {
	if (!model) return "other";
	if (/fable/i.test(model)) return "fable";
	if (/sonnet/i.test(model)) return "sonnet";
	if (/opus/i.test(model)) return "opus";
	if (/haiku/i.test(model)) return "haiku";
	return "other";
}

function weeklyBucketFor(model: string | null): keyof Quota {
	const f = modelFamily(model);
	if (f === "fable") return "unified7dFable";
	if (f === "sonnet") return "unified7dSonnet";
	return "unified7d";
}

export type PersistedState = Record<string, Partial<Quota>>;

export interface SelectResult {
	index: number;
	token: string;
	name: string;
}

export class AccountManager {
	accounts: Account[];
	currentIndex = 0;
	switchThreshold: number;
	ramp: RampConfig;
	cacheAffinity: boolean;
	pinTtlMs: number;
	private sessionPins = new Map<string, { index: number; expires: number }>();
	private log: (msg: string) => void;
	private onChange: () => void;
	private refreshFn: (refreshToken: string) => Promise<Tokens>;

	constructor(
		configs: AccountConfig[],
		opts: {
			switchThreshold?: number;
			log?: (m: string) => void;
			onChange?: () => void;
			ramp?: Partial<RampConfig>;
			refreshFn?: (refreshToken: string) => Promise<Tokens>;
			cacheAffinity?: boolean;
			pinTtlMs?: number;
		} = {},
	) {
		this.switchThreshold = opts.switchThreshold ?? 0.98;
		this.log = opts.log ?? (() => {});
		this.onChange = opts.onChange ?? (() => {});
		this.refreshFn = opts.refreshFn ?? refreshAccessToken;
		// Cache affinity: keep a session on one account so its prompt cache stays
		// warm. TTL defaults to 5min (Anthropic's ephemeral cache window); an active
		// session slides it forward on each request.
		this.cacheAffinity = opts.cacheAffinity ?? true;
		this.pinTtlMs = opts.pinTtlMs ?? 300_000;
		// Storm control defaults: 1 request at the instant of a switch, +1 every
		// 250ms, pacing off after 30s. Mirrors teamclaude's ramp.
		this.ramp = {
			enabled: true,
			startConc: 1,
			stepConc: 1,
			stepMs: 250,
			windowMs: 30_000,
			pollMs: 50,
			...opts.ramp,
		};
		this.accounts = configs.map((c, i) => this.make(c, i));
	}

	private make(c: AccountConfig, index: number): Account {
		return {
			index,
			name: c.name,
			priority: c.priority || 0,
			disabled: c.disabled || false,
			external: c.external || false,
			credential: c.accessToken,
			refreshToken: c.refreshToken || null,
			expiresAt: c.expiresAt ?? null,
			status: "active",
			probing: true,
			requalify: false,
			quota: emptyQuota(),
			rateLimitedUntil: null,
			throttledAt: null,
			requests: 0,
			lastUsed: null,
			_refreshPromise: null,
			inFlight: 0,
			rampStartedAt: null,
			pausedUntil: null,
		};
	}

	// ---- storm control ----------------------------------------------------

	/** Start (or restart) the ramp window for an account that just became current. */
	private beginRamp(acc: Account): void {
		if (acc && this.ramp.enabled) acc.rampStartedAt = Date.now();
	}

	/** Max concurrent upstream requests allowed to `acc` right now. */
	private rampCap(acc: Account, now = Date.now()): number {
		if (!this.ramp.enabled || acc.rampStartedAt == null) return Infinity;
		const elapsed = Math.max(0, now - acc.rampStartedAt);
		if (elapsed >= this.ramp.windowMs) {
			acc.rampStartedAt = null;
			return Infinity;
		}
		return (
			this.ramp.startConc +
			Math.floor(elapsed / this.ramp.stepMs) * this.ramp.stepConc
		);
	}

	/**
	 * Reserve a concurrency slot on `index` before sending upstream. Waits while
	 * the account is in a rate-limit pause and while it is over its ramp cap.
	 * Returns false if `isAborted()` reports the client went away while waiting;
	 * otherwise true (pair every true with release(index)).
	 */
	async admit(index: number, isAborted?: () => boolean): Promise<boolean> {
		const acc = this.accounts[index];
		if (!acc) return true;
		for (;;) {
			if (isAborted?.()) return false;
			const now = Date.now();
			if (acc.pausedUntil && now < acc.pausedUntil) {
				await sleep(Math.min(acc.pausedUntil - now, this.ramp.pollMs * 4));
				continue;
			}
			const cap = this.ramp.enabled ? this.rampCap(acc, now) : Infinity;
			if (acc.inFlight < cap) {
				acc.inFlight++;
				return true;
			}
			await sleep(this.ramp.pollMs);
		}
	}

	/** Release a slot taken by admit(). */
	release(index: number): void {
		const acc = this.accounts[index];
		if (acc && acc.inFlight > 0) acc.inFlight--;
	}

	/**
	 * Pause an account after a rate-limit (non-quota) 429 so concurrent requests
	 * wait in admit() instead of piling on. Does NOT mark it unavailable, so
	 * selection never rotates away — rotation is reserved for quota exhaustion.
	 */
	pauseAccount(index: number, seconds: number): void {
		const acc = this.accounts[index];
		if (!acc) return;
		const until = Date.now() + Math.max(0, seconds) * 1000;
		acc.pausedUntil = Math.max(acc.pausedUntil || 0, until);
		if (this.ramp.enabled) acc.rampStartedAt = acc.pausedUntil;
	}

	/** Merge persisted quota state (from disk) into accounts by name. */
	restoreState(state: PersistedState): void {
		for (const acc of this.accounts) {
			const saved = state[acc.name];
			if (!saved) continue;
			for (const f of PERSISTED_QUOTA_FIELDS) {
				if (saved[f] != null) (acc.quota[f] as any) = saved[f];
			}
			acc.probing = acc.quota.unified7dReset == null;
		}
		this.refreshExpiredQuotas();
	}

	exportState(): PersistedState {
		const out: PersistedState = {};
		for (const acc of this.accounts) {
			const q: Partial<Quota> = {};
			for (const f of PERSISTED_QUOTA_FIELDS)
				if (acc.quota[f] != null) (q[f] as any) = acc.quota[f];
			out[acc.name] = q;
		}
		return out;
	}

	// ---- selection --------------------------------------------------------

	private governingWeekly(acc: Account, model: string | null): number | null {
		const key = weeklyBucketFor(model);
		if (acc.quota[key] != null) return acc.quota[key] as number;
		return key !== "unified7d" ? acc.quota.unified7d : null;
	}

	private governingWeeklyReset(
		acc: Account,
		model: string | null,
	): number | null {
		const key = weeklyBucketFor(model);
		const rkey = `${key}Reset` as keyof Quota;
		return (
			(acc.quota[rkey] as number | null) || acc.quota.unified7dReset || null
		);
	}

	private isNearQuota(acc: Account, model: string | null): boolean {
		const q = acc.quota;
		if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;
		const weekly = this.governingWeekly(acc, model);
		if (weekly != null && weekly >= this.switchThreshold) return true;
		return false;
	}

	private isAvailable(
		acc: Account | undefined,
		model: string | null,
	): acc is Account {
		if (!acc) return false;
		if (acc.disabled) return false;
		if (acc.status === "throttled" && acc.rateLimitedUntil) {
			if (Date.now() < acc.rateLimitedUntil) return false;
			acc.status = "active";
			acc.rateLimitedUntil = null;
			acc.throttledAt = null;
			this.log(`account "${acc.name}" rate limit expired, active again`);
		}
		if (acc.status === "exhausted" || acc.status === "error") return false;
		if (this.isNearQuota(acc, model)) return false;
		return true;
	}

	private pickBest(
		exclude: Set<number> | null,
		model: string | null,
	): Account | null {
		let best: Account | null = null;
		let bestPriority = Infinity;
		let bestReset = Infinity;
		for (const acc of this.accounts) {
			if (exclude?.has(acc.index)) continue;
			if (!this.isAvailable(acc, model)) continue;
			const priority = acc.priority || 0;
			const weeklyReset = this.governingWeeklyReset(acc, model) ?? -Infinity;
			if (
				priority < bestPriority ||
				(priority === bestPriority && weeklyReset < bestReset)
			) {
				bestPriority = priority;
				bestReset = weeklyReset;
				best = acc;
			}
		}
		return best;
	}

	private selectNext(
		exclude: Set<number> | null,
		model: string | null,
	): Account | null {
		const best = this.pickBest(exclude, model);
		if (best) {
			const switched = best.index !== this.currentIndex;
			this.currentIndex = best.index;
			best.probing = best.quota.unified7dReset == null;
			if (switched) {
				this.beginRamp(best);
				this.log(`switched to account "${best.name}"`);
			}
			return best;
		}
		// all unavailable → soonest to reset
		let soonest: Account | null = null;
		let soonestTime = Infinity;
		for (const acc of this.accounts) {
			if (exclude?.has(acc.index)) continue;
			if (acc.disabled || acc.status === "error") continue;
			const t =
				acc.rateLimitedUntil ||
				acc.quota.unified5hReset ||
				acc.quota.unified7dReset ||
				null;
			if (t && t < soonestTime) {
				soonestTime = t;
				soonest = acc;
			}
		}
		if (soonest && soonestTime <= Date.now()) {
			soonest.status = "active";
			soonest.rateLimitedUntil = null;
			this.currentIndex = soonest.index;
			this.beginRamp(soonest);
			this.log(`account "${soonest.name}" reset, switching to it`);
			return soonest;
		}
		return null;
	}

	/** Choose the active account for a request. Returns null if all exhausted. */
	select(
		model: string | null,
		exclude: Set<number> | null = null,
	): Account | null {
		this.refreshExpiredQuotas();
		const current = this.accounts[this.currentIndex];
		if (current && current.requalify) {
			current.requalify = false;
			const next = this.selectNext(exclude, model);
			if (next) return next;
		}
		if (this.isAvailable(current, model) && !exclude?.has(current.index)) {
			const better = this.accounts.some(
				(a) =>
					this.isAvailable(a, model) &&
					!exclude?.has(a.index) &&
					(a.priority || 0) < (current.priority || 0),
			);
			return better ? this.selectNext(exclude, model) : current;
		}
		return this.selectNext(exclude, model);
	}

	/** Select and ensure the chosen account's token is fresh (blocks only if expired). */
	async selectFresh(
		model: string | null,
		exclude: Set<number> | null = null,
	): Promise<Account | null> {
		const acc = this.select(model, exclude);
		if (acc && acc.refreshToken && isTokenExpired(acc.expiresAt)) {
			await this.ensureTokenFresh(acc.index);
		}
		return acc;
	}

	// ---- cache-affinity (sticky per-session routing) ----------------------
	//
	// Anthropic prompt caching is per-account: rotating a session to a different
	// account discards its warm cache, so the next request re-reads the whole
	// context at cache-WRITE pricing (~1.25x input) plus latency. To avoid that,
	// a session (identified by a stable key derived from its cached prefix) sticks
	// to the account that first served it — across turns and independent of other
	// concurrent sessions — until that account is exhausted, at which point the
	// session re-pins to the next best account. This keeps the cache warm while
	// still spreading distinct sessions across accounts and rotating on quota.

	private pruneSessionPins(now = Date.now()): void {
		if (!this.sessionPins.size) return;
		for (const [key, pin] of this.sessionPins) {
			if (now >= pin.expires) this.sessionPins.delete(key);
		}
	}

	/**
	 * Session-aware selection. With cache affinity on and a sticky account still
	 * eligible for `model`, keeps the session there (sliding the TTL). Otherwise
	 * picks best-available and (re-)pins the session to it. Falls back to plain
	 * select() when affinity is off or no key is given.
	 */
	selectForSession(
		sessionKey: string | null,
		model: string | null,
		exclude: Set<number> | null = null,
	): Account | null {
		if (!this.cacheAffinity || !sessionKey) return this.select(model, exclude);
		this.refreshExpiredQuotas();
		const now = Date.now();
		this.pruneSessionPins(now);
		const pin = this.sessionPins.get(sessionKey);
		if (pin && !exclude?.has(pin.index)) {
			const acc = this.accounts[pin.index];
			if (this.isAvailable(acc, model)) {
				pin.expires = now + this.pinTtlMs; // sliding: active session stays warm
				this.currentIndex = acc.index;
				return acc;
			}
		}
		const acc = this.select(model, exclude);
		if (acc)
			this.sessionPins.set(sessionKey, {
				index: acc.index,
				expires: now + this.pinTtlMs,
			});
		return acc;
	}

	async selectFreshForSession(
		sessionKey: string | null,
		model: string | null,
		exclude: Set<number> | null = null,
	): Promise<Account | null> {
		const acc = this.selectForSession(sessionKey, model, exclude);
		if (acc && acc.refreshToken && isTokenExpired(acc.expiresAt)) {
			await this.ensureTokenFresh(acc.index);
		}
		return acc;
	}

	// ---- quota updates ----------------------------------------------------

	private num(headers: Headers, key: string): number | null {
		const v = parseFloat(headers.get(key) || "");
		return isNaN(v) ? null : v;
	}
	private int(headers: Headers, key: string): number | null {
		const v = parseInt(headers.get(key) || "", 10);
		return isNaN(v) ? null : v;
	}

	/** Learn quota from an upstream response's rate-limit headers. */
	updateQuota(index: number, headers: Headers): void {
		const acc = this.accounts[index];
		if (!acc) return;
		const q = acc.quota;
		const u5h = this.num(headers, "anthropic-ratelimit-unified-5h-utilization");
		const u7d = this.num(headers, "anthropic-ratelimit-unified-7d-utilization");
		if (u5h != null) q.unified5h = u5h;
		if (u7d != null) q.unified7d = u7d;
		const r5h = this.int(headers, "anthropic-ratelimit-unified-5h-reset");
		const r7d = this.int(headers, "anthropic-ratelimit-unified-7d-reset");
		if (r5h != null) q.unified5hReset = r5h * 1000;
		if (r7d != null) q.unified7dReset = r7d * 1000;
		const u7dOi = this.num(
			headers,
			"anthropic-ratelimit-unified-7d_oi-utilization",
		);
		if (u7dOi != null) q.unified7dFable = u7dOi;
		const r7dOi = this.int(headers, "anthropic-ratelimit-unified-7d_oi-reset");
		if (r7dOi != null) q.unified7dFableReset = r7dOi * 1000;
		const status = headers.get("anthropic-ratelimit-unified-status");
		if (status) q.unifiedStatus = status;

		if (acc.probing && q.unified7dReset != null) {
			acc.probing = false;
			acc.requalify = true;
			this.log(`learned weekly quota for "${acc.name}", re-evaluating`);
		}
		acc.requests++;
		acc.lastUsed = Date.now();
		this.onChange();
	}

	applyUsage(index: number, usage: Usage): void {
		const acc = this.accounts[index];
		if (!acc || !usage || usage.error) return;
		const q = acc.quota;
		const set = (bucket: any, uKey: keyof Quota, rKey: keyof Quota) => {
			if (!bucket) return;
			if (bucket.utilization != null) (q[uKey] as any) = bucket.utilization;
			if (bucket.resetAt != null) (q[rKey] as any) = bucket.resetAt;
		};
		set(usage.fiveHour, "unified5h", "unified5hReset");
		set(usage.sevenDay, "unified7d", "unified7dReset");
		set(usage.sevenDaySonnet, "unified7dSonnet", "unified7dSonnetReset");
		set(usage.sevenDayFable, "unified7dFable", "unified7dFableReset");
		if (acc.probing && q.unified7dReset != null) {
			acc.probing = false;
			acc.requalify = true;
		}
		this.onChange();
	}

	markRateLimited(index: number, retryAfterSeconds: number): void {
		const acc = this.accounts[index];
		if (!acc) return;
		acc.status = "throttled";
		acc.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
		acc.throttledAt = Date.now();
		this.log(`account "${acc.name}" rate limited for ${retryAfterSeconds}s`);
	}

	/**
	 * A quota-reject 429: mark ONLY the bucket the upstream said is spent, so a
	 * Fable-only rejection bars just Fable while the account keeps serving Opus/
	 * Sonnet. `bucket` comes from the per-bucket `-status: rejected` headers.
	 */
	markBucketRejected(index: number, bucket: RejectedBucket): void {
		const acc = this.accounts[index];
		if (!acc) return;
		const key: keyof Quota =
			bucket === "5h"
				? "unified5h"
				: bucket === "fable"
					? "unified7dFable"
					: "unified7d";
		const cur = acc.quota[key] as number | null;
		if (cur == null || cur < this.switchThreshold) (acc.quota[key] as any) = 1;
		this.log(
			`account "${acc.name}" ${bucket} quota rejected — will rotate for it`,
		);
		this.onChange();
	}

	/** Mark an account unusable (e.g. a hard 401 after a forced refresh). */
	markError(index: number): void {
		const acc = this.accounts[index];
		if (!acc) return;
		acc.status = "error";
		this.log(`account "${acc.name}" marked error (needs re-login)`);
		this.onChange();
	}

	clearRateLimited(index: number): void {
		const acc = this.accounts[index];
		if (!acc || acc.status !== "throttled") return;
		acc.status = "active";
		acc.rateLimitedUntil = null;
		acc.throttledAt = null;
	}

	// ---- token refresh ----------------------------------------------------

	/**
	 * Ensure a dedicated account's token is fresh, refreshing if expiring soon
	 * (or force). EXTERNAL accounts are never refreshed here — pi owns their
	 * `auth.json` rotation and we ride on its live token, so touching the shared
	 * refresh token would rotate it out from under pi and kill the account.
	 *
	 * Refresh-token rotation safety: before refreshing we re-read the on-disk
	 * token (another process/machine may have rotated it); on a 400 we re-read
	 * once more and retry with the newer token before declaring the account dead.
	 * Only a genuine auth rejection (400/401/403) errors the account — a transient
	 * network/5xx/timeout keeps the token and stays active for the next attempt.
	 */
	async ensureTokenFresh(index: number, force = false): Promise<void> {
		const acc = this.accounts[index];
		if (!acc || acc.external || !acc.refreshToken) return;
		if (!force && !isTokenExpiringSoon(acc.expiresAt)) return;
		if (acc._refreshPromise) return acc._refreshPromise;
		acc._refreshPromise = (async () => {
			this.log(`refreshing token for "${acc.name}"...`);
			// Pick up a token another owner may have rotated since we loaded.
			this.reloadRefreshToken?.(acc.name);
			const attempt = async (): Promise<Tokens> =>
				this.refreshFn(acc.refreshToken!);
			try {
				let t: Tokens;
				try {
					t = await attempt();
				} catch (err: any) {
					// A 400 often means our refresh token was already rotated by another
					// owner. Re-read the file once; if it changed, retry with the newer one.
					if (err?.status === 400 && this.reloadRefreshToken?.(acc.name)) {
						t = await attempt();
					} else {
						throw err;
					}
				}
				acc.credential = t.accessToken;
				acc.refreshToken = t.refreshToken;
				acc.expiresAt = t.expiresAt;
				if (acc.status === "error") acc.status = "active";
				this.log(`token refreshed for "${acc.name}"`);
				this.onTokenRefresh?.(acc.name, t);
			} catch (err: any) {
				this.log(`token refresh failed for "${acc.name}": ${err?.message}`);
				if ([400, 401, 403].includes(err?.status)) {
					acc.status = "error";
					this.log(
						`account "${acc.name}" needs re-login (refresh token rejected)`,
					);
				}
				// Transient (network/5xx/timeout): keep token + active for next time.
			} finally {
				acc._refreshPromise = null;
			}
		})();
		return acc._refreshPromise;
	}

	/**
	 * Proactively refresh every dedicated account whose token expires within
	 * `marginMs`, so a token is never caught expired at request time and the
	 * refresh token is exercised regularly (staying valid despite disuse).
	 */
	async refreshExpiring(marginMs = 10 * 60_000): Promise<void> {
		const jobs: Promise<void>[] = [];
		for (const acc of this.accounts) {
			if (
				acc.external ||
				acc.disabled ||
				acc.status === "error" ||
				!acc.refreshToken
			)
				continue;
			if (isTokenExpiringSoon(acc.expiresAt, marginMs))
				jobs.push(this.ensureTokenFresh(acc.index, true));
		}
		await Promise.all(jobs);
	}

	/** Update an external account's live token (synced from auth.json by the host). */
	setExternalCredential(
		index: number,
		accessToken: string,
		expiresAt: number | null,
	): void {
		const acc = this.accounts[index];
		if (!acc) return;
		acc.credential = accessToken;
		acc.expiresAt = expiresAt;
		if (acc.status === "error") acc.status = "active";
	}

	/** Indices of external (auth.json-backed) accounts. */
	externalIndices(): number[] {
		return this.accounts.filter((a) => a.external).map((a) => a.index);
	}

	onTokenRefresh?: (name: string, tokens: Tokens) => void;
	/** Host hook: re-read the account's refresh token from disk into memory if it
	 * changed there (another process/machine rotated it). Returns true if updated. */
	reloadRefreshToken?: (name: string) => boolean;

	/** Read quota for idle accounts without spending message quota. */
	async probeAll(): Promise<void> {
		const probe = async (acc: Account): Promise<void> => {
			if (acc.disabled || acc.status === "error" || !acc.credential) return;
			if (acc.refreshToken && isTokenExpired(acc.expiresAt))
				await this.ensureTokenFresh(acc.index);
			const usage = await fetchUsage(acc.credential);
			if (!usage.error) this.applyUsage(acc.index, usage);
		};
		const jobs: Promise<void>[] = [];
		for (const acc of this.accounts) jobs.push(probe(acc));
		await Promise.all(jobs);
	}

	// ---- housekeeping -----------------------------------------------------

	refreshExpiredQuotas(): void {
		const now = Date.now();
		for (const acc of this.accounts) {
			const q = acc.quota;
			if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
				q.unified5h = null;
				q.unified5hReset = null;
			}
			if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
				q.unified7d = null;
				q.unified7dReset = null;
				q.unifiedStatus = null;
			}
			if (
				q.unified7dSonnet != null &&
				q.unified7dSonnetReset &&
				now >= q.unified7dSonnetReset
			) {
				q.unified7dSonnet = null;
				q.unified7dSonnetReset = null;
			}
			if (
				q.unified7dFable != null &&
				q.unified7dFableReset &&
				now >= q.unified7dFableReset
			) {
				q.unified7dFable = null;
				q.unified7dFableReset = null;
			}
		}
	}

	/** Pick the best starting account once quota state is restored. */
	selectStart(): void {
		this.refreshExpiredQuotas();
		const best = this.pickBest(null, null);
		if (best) {
			this.currentIndex = best.index;
			best.probing = best.quota.unified7dReset == null;
			this.beginRamp(best);
		}
	}

	status(): Array<{
		name: string;
		current: boolean;
		disabled: boolean;
		external: boolean;
		status: Status;
		session: number | null;
		weekly: number | null;
		fable: number | null;
		requests: number;
		resetIn: number | null;
	}> {
		this.refreshExpiredQuotas();
		return this.accounts.map((a) => ({
			name: a.name,
			current: a.index === this.currentIndex,
			disabled: a.disabled,
			external: a.external,
			status: a.status,
			session: a.quota.unified5h,
			weekly: a.quota.unified7d,
			fable: a.quota.unified7dFable,
			requests: a.requests,
			resetIn: a.quota.unified7dReset
				? a.quota.unified7dReset - Date.now()
				: null,
		}));
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
