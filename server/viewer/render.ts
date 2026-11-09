import {
	markerHistoryGap,
	type TimelineEvent,
	type ViewerRun,
} from "./evidence.ts";
import { icons } from "./design/icons/icons.ts";
import { objectOf, textOf } from "../sandbox/json.ts";
import { plainTitle } from "../../src/attention.ts";

export function expectedGap(
	gap: ViewerRun["gaps"][number],
	status: string,
): boolean {
	if (gap.reason === markerHistoryGap) return true;

	if (
		/pi-stderr-\d+\.log$/.test(gap.source) &&
		gap.reason === "missing, unsafe, unreadable or over size limit"
	)
		return true;

	const old = [
		"landed",
		"released",
		"cancelled",
		"needs_info",
		"stage_passed",
	].includes(status);

	return (
		old &&
		[
			"Pi session JSONL files missing",
			"gateway audit missing",
			"child result has no session file",
		].includes(gap.reason)
	);
}

function gapSentence(gap: ViewerRun["gaps"][number], status: string): string {
	if (gap.reason === markerHistoryGap)
		return "Earlier GitHub run updates are not kept on this machine. The latest run record is retained.";

	if (expectedGap(gap, status))
		return "This older run does not retain this optional log. That does not change its recorded outcome.";

	if (/receipt/.test(gap.source + gap.reason))
		return "A required execution record is missing or unreadable, so this step cannot be verified.";

	if (/claim/.test(gap.source + gap.reason))
		return "The saved run record is missing or unreadable.";

	if (/verdict/.test(gap.source + gap.reason))
		return "The saved check result is missing or unreadable; it is not a pass.";

	return "This part of the local record could not be verified. See the exact detail below.";
}

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"'\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function page(
	title: string,
	body: string,
	base: string,
	header?: string,
): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Factory</title><link rel="stylesheet" href="${base}/style.css"><link rel="manifest" href="${base}/manifest.webmanifest"><link rel="apple-touch-icon" href="${base}/icon-192.png"></head><body>${header ?? `<header><div class="heading"><a href="${base}/">Factory</a><span class="local">Local evidence</span></div></header>`}<main>${body}</main><footer>Local evidence only. No GitHub requests. No model calls. Missing evidence is never a pass.</footer></body></html>`;
}

function table(headers: string[], rows: string[][]): string {
	return `<div class="scroll"><table><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => `<td data-label="${escapeHtml(headers[index] ?? "")}">${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>${rows.length === 0 ? "<p class=muted>No recorded entries. Check the evidence gaps above.</p>" : ""}</div>`;
}

function timeline(events: TimelineEvent[]) {
	return table(
		[
			"When / source",
			"Stage",
			"Attempt",
			"Execution / evidence round",
			"Generation",
			"Event",
			"Detail",
		],
		events.map((item) => [
			item.at ?? `${item.source} (time unavailable)`,
			item.stage,
			String(item.attempt ?? "—"),
			String(item.round ?? "—"),
			String(item.generation ?? "—"),
			item.event,
			item.detail,
		]),
	);
}

export function renderRun(
	run: ViewerRun,
	view: string,
	base: string,
	owner?: {
		header: string;
		issue: number | null;
		title: string;
		summary: string;
		steps: string;
		links: string;
	},
): string {
	const problemGaps = run.gaps.some((gap) => !expectedGap(gap, run.status));

	const gapList = (expected: boolean) => {
		const items = run.gaps.filter(
			(gap) => expectedGap(gap, run.status) === expected,
		);

		const grouped = new Map<string, typeof items>();

		for (const gap of items) {
			const sentence = gapSentence(gap, run.status);
			const group = grouped.get(sentence) ?? [];
			group.push(gap);
			grouped.set(sentence, group);
		}

		return items.length === 0
			? ""
			: `<h3>${expected ? "Expected" : "Problems"} <span class="count">${items.length}</span></h3><ul>${[...grouped].map(([sentence, records]) => `<li>${escapeHtml(sentence)}${records.length === 1 ? "" : ` (${records.length} records)`}<details><summary>Exact detail</summary><ul>${records.map((gap) => `<li><code>${escapeHtml(gap.source)}</code> — ${escapeHtml(gap.reason)}</li>`).join("")}</ul></details></li>`).join("")}</ul>`;
	};

	const gaps =
		run.gaps.length === 0
			? ""
			: `<details class="gaps notice${problemGaps ? " notice-error" : ""}" open><summary>${problemGaps ? icons["alert-triangle"] : icons["info-circle"]}Evidence gaps</summary>${gapList(false)}${gapList(true)}</details>`;

	const tabs = ["timeline", "usage", "children", "gateway"]
		.map(
			(tab) =>
				`<a ${tab === view ? 'aria-current="page"' : ""} href="${base}/run/${run.runId}/${tab}">${tab[0]?.toUpperCase()}${tab.slice(1)}</a>`,
		)
		.join("");

	let content: string;

	if (view === "usage")
		content = `<h2>Token usage</h2><p>Receipt total: <strong>${run.usage.total}</strong> · parent ${run.usage.parent} · children ${run.usage.children} · spend <strong>unavailable</strong></p><p>Candidate accounting high-water: <strong>${run.usage.accounted ?? "unavailable"}</strong></p><p class="muted">Per-model splits below come from sessions; missing sessions leave a reconciliation gap, not zero spend.</p>${table(
			[
				"Model",
				"Parent session tokens",
				"Child session tokens",
				"Receipt total",
				"Cost",
			],
			run.usage.models.map((item) => [
				item.model,
				String(item.parent),
				String(item.children),
				String(item.total),
				item.cost,
			]),
		)}<h2>Sessions</h2>${table(
			[
				"Session",
				"Parent",
				"Stage",
				"Attempt",
				"Round",
				"Generation",
				"Tokens",
			],
			run.usage.sessions.map((item) => [
				item.id,
				item.parent ?? "root",
				item.stage,
				String(item.attempt ?? "—"),
				String(item.round ?? "—"),
				String(item.generation ?? "—"),
				String(item.tokens),
			]),
		)}`;
	else if (view === "children")
		content = `<h2>Children</h2><p class="muted">Each retained child session appears once under its recorded parent.</p>${run.children.map((child) => `<section class="child"><h3><code>${escapeHtml(child.id)}</code></h3><p>Parent: <code>${escapeHtml(child.parent ?? "unavailable")}</code> · ${child.tokens} tokens</p>${timeline(child.timeline)}</section>`).join("")}${run.children.length === 0 ? "<p>No retained children. Check gaps before interpreting this as no delegation.</p>" : ""}`;
	else if (view === "gateway")
		content = `<h2>Gateway decisions</h2>${table(
			[
				"Time",
				"Stage",
				"Attempt",
				"Round",
				"Generation",
				"Decision",
				"Destination",
				"Method",
				"Path",
				"Reason",
			],
			run.gateway.map((item) => [
				item.at,
				item.stage,
				String(item.attempt ?? "—"),
				String(item.round ?? "—"),
				String(item.generation ?? "—"),
				item.decision,
				item.destination,
				item.method,
				item.path,
				item.reason ?? "—",
			]),
		)}`;
	else
		content = `<div class="run-grid"><section class="evidence-card"><h2>Stage timeline</h2>${owner?.steps ?? "<p class=muted>Stage summary unavailable. The retained events are below.</p>"}</section>${gaps === "" ? "" : `<aside>${gaps}</aside>`}</div><details class="raw-events"><summary>Raw session events and execution details</summary><p class="muted">Events with times are chronological. Records without times follow by attempt. A passed check on an earlier change does not prove the current change.</p>${timeline(run.timeline)}<h2>Issue snapshot (untrusted text)</h2><pre>${escapeHtml(JSON.stringify(run.issue, null, 2))}</pre></details><details class="glossary"><summary>Technical glossary</summary><dl><dt>Generation</dt><dd>One version of the proposed change.</dd><dt>Certification</dt><dd>Checks and review bound to that exact change.</dd><dt>Settlement</dt><dd>The model and its helpers finished.</dd><dt>Evidence round</dt><dd>The repair attempt that produced these records.</dd></dl></details>`;

	const title =
		owner?.title ??
		plainTitle(textOf(objectOf(run.issue)?.title) ?? "Title unavailable");

	return page(
		title,
		`<p><a href="${base}/">All runs</a></p><p class="eyebrow">${owner?.issue == null ? "Run" : `Issue #${owner.issue}`} · run <code>${escapeHtml(run.runId.slice(0, 12))}</code></p><h1 class="run-title">${escapeHtml(title)}</h1>${owner?.summary ?? ""}${owner?.links ?? ""}${view === "timeline" ? "" : gaps}<nav aria-label="Run views">${tabs}<a class="json" href="${base}/run/${run.runId}/${escapeHtml(view)}.json">JSON ↗</a></nav>${content}`,

		base,
		owner?.header,
	);
}
