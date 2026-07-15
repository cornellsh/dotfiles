/**
 * Microsoft Clarity — native pi extension.
 *
 * Registers Clarity Data Export tools that talk directly to the same
 * `clarity.microsoft.com/mcp/*` HTTP endpoints used by the official
 * @microsoft/clarity-mcp-server, without running a stdio MCP subprocess.
 *
 * Token resolution order:
 *   1. env CLARITY_API_TOKEN
 *   2. env clarity_api_token
 *   3. ./config.json  { "apiToken": "..." }  (next to this file)
 *
 * The dashboard/docs endpoints do server-side natural-language processing and
 * can take 30-40s, so tools use a generous timeout and honor the abort signal.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://clarity.microsoft.com/mcp";
const ANALYTICS_URL = `${API_BASE}/dashboard/query`;
const DOCS_URL = `${API_BASE}/documentation/query`;
const RECORDINGS_URL = `${API_BASE}/recordings/sample`;

const REQUEST_TIMEOUT_MS = 90_000;

function resolveToken(): string | undefined {
	if (process.env.CLARITY_API_TOKEN) return process.env.CLARITY_API_TOKEN;
	if (process.env.clarity_api_token) return process.env.clarity_api_token;
	try {
		const raw = readFileSync(join(HERE, "config.json"), "utf8");
		const parsed = JSON.parse(raw) as { apiToken?: string };
		if (parsed.apiToken) return parsed.apiToken;
	} catch {
		/* no config file */
	}
	return undefined;
}

async function clarityFetch(
	url: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<{ text: string; isError: boolean; data?: unknown }> {
	const token = resolveToken();
	if (!token) {
		return {
			isError: true,
			text:
				"No Clarity API token found. Set CLARITY_API_TOKEN or add apiToken to " +
				join(HERE, "config.json") +
				".",
		};
	}

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
	if (signal) {
		if (signal.aborted) ac.abort();
		else signal.addEventListener("abort", () => ac.abort(), { once: true });
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			signal: ac.signal,
		});

		const raw = await res.text();
		if (!res.ok) {
			return {
				isError: true,
				text: `Clarity request failed (HTTP ${res.status}): ${raw.slice(0, 2000)}`,
			};
		}

		let data: unknown = raw;
		try {
			data = JSON.parse(raw);
		} catch {
			/* keep raw text */
		}
		return {
			isError: false,
			data,
			text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			isError: true,
			text: ac.signal.aborted
				? `Clarity request aborted/timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${msg}`
				: `Clarity request error: ${msg}`,
		};
	} finally {
		clearTimeout(timer);
	}
}

export default function (pi: ExtensionAPI) {
	// 1) Analytics dashboard — natural-language query
	pi.registerTool({
		name: "clarity_query_analytics",
		label: "Clarity Analytics",
		description:
			"Query Microsoft Clarity analytics dashboard data with a simple, single-purpose natural-language query. " +
			"Always include an explicit time range. Focus on ONE metric/trend per call (e.g. 'Top browsers last 3 days', " +
			"'Average session duration for desktop users this week', 'JavaScript errors on PC in the last 7 days'). " +
			"Break complex asks into multiple calls.",
		promptSnippet:
			"Query Clarity analytics (traffic, users, devices, geo, pages, smart events, web vitals, JS errors) via natural language",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Single-purpose natural-language analytics query with an explicit time range.",
			}),
			timezone: Type.Optional(
				Type.String({
					description:
						"IANA timezone for interpreting the query (e.g. 'UTC', 'Europe/Zurich'). Defaults to UTC.",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const timezone =
				params.timezone ||
				Intl.DateTimeFormat().resolvedOptions().timeZone ||
				"UTC";
			const r = await clarityFetch(
				ANALYTICS_URL,
				{ query: params.query, timezone },
				signal,
			);
			return {
				content: [{ type: "text", text: r.text }],
				details: {},
				isError: r.isError,
			};
		},
	});

	// 2) Session recordings — structured filters
	pi.registerTool({
		name: "clarity_list_recordings",
		label: "Clarity Recordings",
		description:
			"List Microsoft Clarity session recordings with metadata (session link, duration, interaction timeline). " +
			"Filter by date range (required inside filters.date), device, browser, OS, geo, URLs, smart events, JS/click errors, " +
			"behavior flags (rage/dead/quickback clicks), web vitals, e-commerce fields, and more. See the clarity skill for the full filter schema.",
		promptSnippet:
			"List Clarity session recordings filtered by device/browser/geo/URL/behavior with sorting",
		parameters: Type.Object({
			filters: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description:
						"Clarity filter object. Include date:{start,end} in UTC ISO 8601 (yyyy-MM-ddTHH:mm:ss.fffZ). " +
						"Other keys: deviceType, browser, os, country/state/city, visitedUrls/entryUrls/exitUrls " +
						"([{url,operator}]), smartEvents, javascriptErrors, rageClickPresent, etc.",
				}),
			),
			sortBy: Type.Optional(
				StringEnum([
					"SessionStart_DESC",
					"SessionStart_ASC",
					"SessionDuration_ASC",
					"SessionDuration_DESC",
					"SessionClickCount_ASC",
					"SessionClickCount_DESC",
					"PageCount_ASC",
					"PageCount_DESC",
				] as const),
			),
			count: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 250,
					description: "Number of recordings to return (1-250, default 100).",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const sortIndex: Record<string, number> = {
				SessionStart_DESC: 0,
				SessionStart_ASC: 1,
				SessionDuration_ASC: 2,
				SessionDuration_DESC: 3,
				SessionClickCount_ASC: 4,
				SessionClickCount_DESC: 5,
				PageCount_ASC: 6,
				PageCount_DESC: 7,
			};
			const sortKey = params.sortBy ?? "SessionStart_DESC";

			const now = new Date().toISOString();
			const filters = (params.filters ?? {}) as {
				date?: { start?: string; end?: string };
			};
			const end = new Date(filters.date?.end || now);
			const start = new Date(filters.date?.start || now);
			if (!filters.date?.start) start.setDate(end.getDate() - 2);

			const r = await clarityFetch(
				RECORDINGS_URL,
				{
					sortBy: sortIndex[sortKey],
					start: start.toISOString(),
					end: end.toISOString(),
					filters: params.filters ?? {},
					count: params.count ?? 100,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: r.text }],
				details: {},
				isError: r.isError,
			};
		},
	});

	// 3) Documentation — natural-language query
	pi.registerTool({
		name: "clarity_query_docs",
		label: "Clarity Docs",
		description:
			"Retrieve Microsoft Clarity documentation snippets (setup, features, troubleshooting, integrations, API reference). " +
			"Ask ONE focused question per call.",
		promptSnippet:
			"Answer Microsoft Clarity how-to/setup/troubleshooting questions from official docs",
		parameters: Type.Object({
			query: Type.String({
				description: "One focused documentation question or topic.",
			}),
		}),
		async execute(_id, params, signal) {
			const r = await clarityFetch(DOCS_URL, { query: params.query }, signal);
			return {
				content: [{ type: "text", text: r.text }],
				details: {},
				isError: r.isError,
			};
		},
	});
}
