import type { TimelineEvent, ViewerRun } from "./evidence.ts";
import { icons } from "./design/icons/icons.ts";

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"'\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function page(title: string, body: string, base: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Factory</title><link rel="stylesheet" href="${base}/style.css"></head><body><header><a href="${base}/">Factory <span>/ run evidence</span></a><span class="local">Read only · local</span></header><main>${body}</main><footer>Local evidence only. No GitHub requests. No model calls. Missing evidence is never a pass.</footer></body></html>`;
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

export function renderIndex(ids: string[], base: string): string {
	return page(
		"Runs",
		`<h1>Run evidence</h1><p class="muted">Select one run from the local controller state.</p><ul class="runs">${ids.map((id) => `<li><a href="${base}/run/${id}/timeline"><code>${escapeHtml(id)}</code><span>View run →</span></a></li>`).join("")}</ul>${ids.length === 0 ? "<p>No runs found. This does not establish a completed run.</p>" : ""}`,

		base,
	);
}

export function renderRun(run: ViewerRun, view: string, base: string): string {
	const problemGaps = run.gaps.some(
		(gap) =>
			gap.reason !==
			"marker comment history is not retained locally; claim is only the latest state",
	);

	const gaps =
		run.gaps.length === 0
			? ""
			: `<details class="gaps notice${problemGaps ? " notice-error" : ""}" open><summary>${problemGaps ? icons["alert-triangle"] : icons["info-circle"]}${run.gaps.length} evidence gaps · not complete</summary><ul>${run.gaps.map((gap) => `<li><code>${escapeHtml(gap.source)}</code> — ${escapeHtml(gap.reason)}</li>`).join("")}</ul></details>`;

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
		content = `<h2>Timeline</h2><p class="muted">Timestamped events are chronological. Events without timestamps follow in round, generation, stage and attempt order. Selected evidence generation and active execution round are separate. Historical certification does not imply current readiness. Receipt settlement is not a fabricated session event.</p>${timeline(run.timeline)}<h2>Issue snapshot (untrusted text)</h2><pre>${escapeHtml(JSON.stringify(run.issue, null, 2))}</pre>`;

	return page(
		"Run",
		`<p class="eyebrow">Run / <span class="status${run.status === "failed" ? " status-error" : ""}">${run.status === "failed" ? icons["alert-triangle"] : ""}${escapeHtml(run.status)}</span></p><h1 class="run-title"><code>${escapeHtml(run.runId.slice(0, 16))}</code><span class="muted">…</span></h1><p><code>${escapeHtml(run.runId)}</code></p><p class="completeness">${run.complete ? "Evidence complete" : "Evidence incomplete"}</p>${gaps}<nav aria-label="Run views">${tabs}<a class="json" href="${base}/run/${run.runId}/${escapeHtml(view)}.json">JSON ↗</a></nav>${content}`,

		base,
	);
}
