import type { HandoffReason } from "../../src/candidate/state.ts";
import { STAGE_ORDER } from "../../src/core/stages.ts";
import type {
	DisplayGroup,
	FeedEntry,
	OwnerFeed,
	OwnerHeader,
} from "../../src/views/feed.ts";
import { icons } from "./design/icons/icons.ts";
import { escapeHtml as esc, page } from "./render.ts";

const HOLD_WORDS: Record<HandoffReason, string> = {
	disabled: "the factory is paused",
	main_moving: "main keeps changing",
	refresh_limit: "the update limit was reached",
	review_attempts: "the review attempt limit was reached",
	review_tokens: "token cap reached",
	repair_tokens: "token cap reached",
	run_tokens: "token cap reached",
	head_drift: "the PR branch changed",
	owner_head: "checking your commit",
	owner_head_refused: "your commit cannot be checked safely",
	owner_head_failed: "checks or review of your commit did not pass",
	owner_head_behind: "update your branch with main",
	checks_failed: "a required check did not pass",
	head_lag: "waiting for GitHub to see the new commit",
	checks_incomplete: "waiting for required checks",
	review_failed: "review found a problem",
	review_input_too_large: "the change is too large for review",
	summary_too_large: "the PR summary is too long",
	pr_identity: "the PR identity could not be verified",
	pr_ambiguous: "more than one PR matches",
	workflow_unavailable: "the run's workflow file cannot be read",
	validation_failed: "checks could not finish",
	evidence_unavailable: "saved checks or review cannot be read",
	repair_limit: "the repair limit was reached",
	diagnosis_oracle: "a hidden test can never pass",
	diagnosis_missing_evidence: "evidence needed to continue is missing",
	diagnosis_infrastructure: "the test environment could not finish",
	feedback_overflow: "too much review feedback to process",
	feedback_repair: "applying your review feedback",
	repair_no_progress: "the repair made no progress",
	repair_repeated_finding: "the same review problem remains",
	closed: "the PR was closed",
	withdrawn: "the ready label was removed",
};

export function holdWords(reason: string | null): string {
	const known = Object.entries(HOLD_WORDS).find(([key]) => key === reason);

	if (known !== undefined) return known[1];

	if (reason?.startsWith("claim_unverified"))
		return "run ownership could not be verified";

	if (reason?.startsWith("feedback_unavailable"))
		return "review feedback cannot be read";

	if (reason === "candidate_book_unavailable")
		return "the saved run record cannot be read";

	return "reason not recorded";
}

export function duration(ms: number | null): string {
	if (ms === null || ms < 0 || !Number.isFinite(ms)) return "time unknown";

	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;

	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;

	if (ms < 86_400_000) {
		const hours = Math.floor(ms / 3_600_000);

		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}

	const days = Math.floor(ms / 86_400_000);

	return `${days} ${days === 1 ? "day" : "days"}`;
}

const numbers = new Intl.NumberFormat("en");

const stageNames = {
	admit: "Getting ready",
	specify: "Spec",
	accept: "Tests",
	build: "Build",
	validate: "CI",
	review: "Review",
	land: "PR",
};

export const stageName = (name: string) =>
	Object.entries(stageNames).find(([key]) => key === name)?.[1] ??
	"Unknown step";

const failureWords = {
	review_input_too_large: "the change is too large for review",
	expected_red: "a hidden test can never pass",
	model_failure: "the model could not finish",
	preservation_failed: "a hidden test could not run correctly",
};

const failureText = (entry: FeedEntry) =>
	Object.entries(failureWords).find(
		([key]) => key === entry.failure?.reason,
	)?.[1] ??
	(
		entry.failure?.reason ??
		entry.failure?.class ??
		"reason not recorded"
	).replaceAll("_", " ");

export function stateWord(entry: FeedEntry): string {
	if (entry.group === "done")
		return entry.status === "landed" ? "Landed" : "Closed";

	if (entry.group === "failed") return `Failed: ${failureText(entry)}`;

	if (entry.group === "working")
		return entry.kind === "question_answered"
			? "Answered, resuming"
			: "Working";

	if (entry.kind === "pr_review") return "Your review";

	if (entry.kind === "question_asked") return "Your answer";

	if (entry.kind === "spec_review") return "Approve spec";

	if (entry.kind === "budget") return "Out of budget";

	return `On hold: ${holdWords(entry.reason)}`;
}

export function runSentence(entry: FeedEntry): string {
	if (entry.group === "done")
		return entry.status === "landed"
			? "Landed. The owner merged the PR."
			: "Closed. This run will not restart.";

	if (entry.group === "failed")
		return entry.failure === null
			? "Stopped. The reason was not recorded."
			: `Stopped at ${stageName(entry.failure.stage)} because ${failureText(entry)}.`;

	if (entry.group === "working")
		return entry.kind === "question_answered"
			? "Your answer is recorded. The factory is resuming."
			: `Working on ${stageName(entry.stage)}${entry.reason === "working_generation" ? " to update the PR" : ""}.`;

	if (entry.kind === "pr_review")
		return `Waiting for your review on PR ${entry.prUrl?.split("/").at(-1) ?? "on GitHub"}.`;

	if (entry.kind === "question_asked")
		return "Waiting for your answer on the issue. Answer there, then add the ready label.";

	if (entry.kind === "budget")
		return "Stopped because the token budget was used. Decide what to do on GitHub.";

	if (
		["run_tokens", "review_tokens", "repair_tokens"].includes(
			entry.reason ?? "",
		)
	)
		return "The PR is open, but updating it would exceed the token cap.";

	return entry.reason === null
		? "On hold. The reason was not recorded."
		: `On hold because ${holdWords(entry.reason)}.`;
}

function stateGlyph(entry: FeedEntry): string {
	if (entry.group === "working") return "";

	return icons[
		entry.group === "failed"
			? "alert-triangle"
			: entry.group === "done"
				? "circle-check"
				: entry.kind === "question_asked"
					? "message-question"
					: "alert-circle"
	];
}

export function githubLink(
	url: string,
	label: string,
	primary = false,
	button = primary,
): string {
	return `<a class="github${button ? " button" : ""}${primary ? " primary" : ""}" href="${esc(url)}">${esc(label)} ${icons["external-link"]}</a>`;
}

export function renderHeader(
	feed: OwnerHeader,
	base: string,
	token: string,
	home = false,
): string {
	const lastTick =
		feed.controller.lastTick === null
			? null
			: Math.max(0, feed.at - Date.parse(feed.controller.lastTick));

	const running = feed.controller.state === "running";
	const held = feed.controller.localSwitch === "disabled";
	const live = `${running ? "Running" : "Stopped"} · last tick ${lastTick === null ? "unknown" : `${duration(lastTick)} ago`}`;

	return `<header><div class="heading"><a class="${home ? "brand" : ""}" href="${base}/">Factory</a><span class="local">${esc(live)}</span></div><div class="hold"><span class="hold-state">${held ? "On hold" : "Taking new tickets"}</span><form method="post" action="${base}/hold"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="hold" value="${held ? "off" : "on"}"><button type="submit">${held ? "Resume factory" : "Hold factory"}</button></form></div></header>`;
}

export function renderSteps(entry: FeedEntry): string {
	const stages: readonly string[] = STAGE_ORDER.filter(
		(stage) => stage !== "admit",
	);

	const current = stages.indexOf(entry.stage);

	return `<ol class="steps">${stages
		.map((stage, index) => {
			const receipt = entry.steps.find((step) => step.stage === stage);

			const failed = entry.group === "failed" && entry.failure?.stage === stage;

			const waiting = stage === "land" && entry.kind === "pr_review";

			const passed =
				receipt?.outcome === "passed" ||
				(stage === "validate" && entry.ci === "Passed") ||
				(stage === "land" && entry.status === "landed");

			const result =
				failed || (stage === "validate" && entry.ci === "Failed")
					? "Failed"
					: waiting
						? "Waiting for your review"
						: passed
							? "Passed"
							: receipt !== undefined
								? receipt.outcome.replaceAll("_", " ")
								: current === index && entry.group === "working"
									? "Running"
									: index < current
										? "Record unavailable"
										: "Not reached";

			const glyph = failed
				? icons["alert-triangle"]
				: waiting
					? icons["alert-circle"]
					: passed
						? icons["circle-check"]
						: result === "Running"
							? ""
							: icons.circle;

			return `<li class="${failed ? "status-error" : waiting ? "attention" : "muted"}" data-stage="${stage}"><span>${glyph}</span><strong>${stageName(stage)}</strong><span>${esc(result)}</span><span class="step-numbers">${receipt?.wallMs == null ? "—" : duration(receipt.wallMs)} · ${stage === "validate" || stage === "land" ? "no model" : receipt?.tokens == null ? "tokens unknown" : `${numbers.format(receipt.tokens)} tokens`}</span></li>`;
		})
		.join("")}</ol>`;
}

function stageMeta(entry: FeedEntry): string {
	return [
		stageName(
			entry.group === "failed"
				? (entry.failure?.stage ?? entry.stage)
				: entry.stage,
		),
		entry.round !== null && entry.round > 0
			? `Repair round ${entry.round}`
			: null,
		["validate", "review", "land"].includes(entry.stage) ||
		entry.steps.some((step) => step.stage === "validate")
			? `CI ${entry.ci}`
			: null,
	]
		.filter((word) => word !== null)
		.join(" · ");
}

function tokenWords(entry: FeedEntry): string {
	return entry.tokens === null
		? "Tokens unknown"
		: `${numbers.format(entry.tokens)}${entry.cap === null ? "" : ` of ${numbers.format(entry.cap)}`} tokens`;
}

function ageWords(entry: FeedEntry): string {
	return entry.stale
		? `${entry.kind === "pr_review" ? "Waiting" : "No progress for"} ${duration(entry.ageMs)}`
		: `${duration(entry.ageMs)}${entry.ageMs === null ? "" : " ago"}`;
}

export function runAction(entry: FeedEntry): string {
	const primary = entry.group === "needs_you";

	const label =
		entry.prUrl === null
			? `Open issue #${entry.issue} on GitHub`
			: `${primary ? "Review" : "See"} PR #${entry.prUrl.split("/").at(-1)} on GitHub`;

	return `<div class="run-action">${githubLink(entry.prUrl ?? entry.issueUrl, label, primary, true)}</div>`;
}

export function renderRunSummary(entry: FeedEntry): string {
	return `<p class="state ${entry.group === "needs_you" ? "attention" : entry.group === "failed" ? "status-error" : "muted"}">${stateGlyph(entry)}${esc(stateWord(entry))}</p><p>${esc(runSentence(entry))}</p><p class="meta">${esc(stageMeta(entry))} · ${esc(tokenWords(entry))}</p>${entry.cap !== null && entry.tokens !== null ? `<progress max="${entry.cap}" value="${Math.min(entry.tokens, entry.cap)}" aria-label="Run token budget"></progress>` : ""}${entry.stale ? `<p class="age ${entry.group === "needs_you" ? "attention" : entry.group === "failed" ? "status-error" : ""}">${esc(ageWords(entry))}</p>` : ""}${entry.failure === null ? "" : `<details><summary>Exact failure</summary><code>${esc(`${entry.failure.stage}: ${entry.failure.class} / ${entry.failure.reason}`)}</code></details>`}${entry.notProven.length === 0 ? "" : `<details class="limitations"><summary>${icons["help-circle"]}Not proven</summary><ul>${entry.notProven.map((text) => `<li>${esc(text.replace("R8 cross-family review remains incomplete.", "Independent model-family review is not complete."))}</li>`).join("")}</ul></details>`}`;
}

function row(
	entry: FeedEntry,
	base: string,
	selected: string | undefined,
): string {
	const title = `<span class="issue">#${entry.issue}</span><span class="row-title">${esc(entry.title)}</span><span class="meta">${esc(stageMeta(entry))}</span>`;

	const tone =
		entry.group === "needs_you"
			? "attention"
			: entry.group === "failed"
				? "status-error"
				: "muted";

	return `<li class="run-row${selected === entry.runId ? " selected" : ""}"><a class="row-main to-pane" href="${base}/?run=${entry.runId}"${selected === entry.runId ? ' aria-current="true"' : ""}>${title}</a><a class="row-main to-page" href="${base}/run/${entry.runId}/timeline">${title}</a><div class="row-state"><span class="${tone}">${stateGlyph(entry)}${esc(stateWord(entry))}</span><span class="age ${entry.stale ? tone : ""}">${esc(ageWords(entry))}</span></div><div class="row-tokens" title="${esc(tokenWords(entry))}">${entry.cap !== null && entry.tokens !== null ? `<progress max="${entry.cap}" value="${Math.min(entry.tokens, entry.cap)}" aria-label="Run token budget"></progress>` : ""}<span>${entry.tokens === null ? "Unknown" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(entry.tokens)}</span></div>${githubLink(entry.prUrl ?? entry.issueUrl, entry.prUrl === null ? `Issue #${entry.issue}` : `PR #${entry.prUrl.split("/").at(-1)}`)}</li>`;
}

function clockTime(instant: string, now: number): string {
	const time = new Date(instant);

	if (!Number.isFinite(time.getTime())) return "time unknown";

	const clock = time.toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});

	return time.toDateString() === new Date(now).toDateString()
		? clock
		: `${time.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${clock}`;
}

export function renderDashboard(
	feed: OwnerFeed,
	base: string,
	token: string,
	selectedRun?: string,
): string {
	const groupNames: Record<DisplayGroup, string> = {
		needs_you: "Needs you",
		failed: "Failed",
		working: "Working",
		done: "Done recently",
	};

	const needs = feed.entries.filter(
		(entry) => entry.group === "needs_you",
	).length;

	const metric = feed.metrics;

	const selected =
		feed.entries.find((entry) => entry.runId === selectedRun) ??
		feed.entries.find((entry) => entry.group === "needs_you") ??
		feed.entries[0];

	const recorded = feed.durableUsage;

	const total =
		recorded.total === null
			? "Tokens not recorded yet"
			: `${recorded.kind === "exact" ? "" : "At least "}${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(recorded.total)} tokens recorded`;

	const health = `${feed.controller.localSwitch === "disabled" ? `<div class="notice">${icons["info-circle"]}On hold. The factory takes no new tickets until you resume it.</div>` : ""}${feed.controller.state !== "running" ? `<div class="notice notice-error">${icons["alert-triangle"]}${feed.controller.state === "stopped" ? "Stopped" : "Controller status unavailable"}${feed.controller.lastTick === null ? "." : ` since ${esc(clockTime(feed.controller.lastTick, feed.at))} (${duration(Math.max(0, feed.at - Date.parse(feed.controller.lastTick)))} ago).`}</div>` : ""}`;

	const unreadable =
		feed.unreadable.length === 0
			? ""
			: `<div class="notice notice-error">${icons["alert-triangle"]}${feed.unreadable.length} ${feed.unreadable.length === 1 ? "ticket can't" : "tickets can't"} be read: ${feed.unreadable.map((item) => githubLink(item.issueUrl, `#${item.issue}`)).join(", ")}. The controller skips them, so they are not counted here.</div>`;

	const body = `<div class="stats">${needs === 0 ? "" : `<a class="stat need" href="${base}/#needs-you"><span class="badge">${needs}</span> need you</a>`}<section class="stat"><span class="muted">Recorded tokens</span><strong>${esc(total)}</strong><span class="meta">${recorded.kind === "exact" ? "Exact receipt total" : recorded.kind === "uncertain" ? "Lower bound; some requests are unsettled" : recorded.kind === "lower_bound" ? "Lower bound; some receipts are missing" : "Waiting for the controller's usage snapshot"}</span></section><section class="stat"><span class="muted">Clean landings</span><strong>${metric.share === null ? "Pending" : `${Math.round(metric.share * 100)}% · ${metric.numerator} of ${metric.denominator}`}</strong><span class="meta">${metric.computedAt === null ? "Waiting for the controller's metric snapshot" : `${metric.stale ? "Stale snapshot" : "Snapshot"} ${esc(clockTime(metric.computedAt, feed.at))}`}${metric.tokensPerCleanLanding === null ? "" : ` · ${numbers.format(Math.round(metric.tokensPerCleanLanding))} tokens per clean landing`}</span></section></div>${health}<div class="dashboard-split"><div class="run-list">${unreadable}${(
		["needs_you", "failed", "working", "done"] as const
	)
		.map((group) => {
			const entries = feed.entries.filter((entry) => entry.group === group);

			if (entries.length === 0) return "";
			const list = `<ul class="dashboard-runs">${entries.map((entry) => row(entry, base, selected?.runId)).join("")}</ul>`;

			return group === "done"
				? `<details class="group" id="done-recently"><summary>Done recently</summary>${list}</details>`
				: `<section class="group" id="${group === "needs_you" ? "needs-you" : group}"><h2>${groupNames[group]}</h2>${list}</section>`;
		})
		.join(
			"",
		)}${feed.gaps.length === 0 ? "" : `<details class="notice notice-error"><summary>${icons["alert-triangle"]}Some local records are unavailable</summary><ul>${feed.gaps.map((gap) => `<li>${esc(gap.replaceAll("_", " "))}</li>`).join("")}</ul></details>`}`;

	const pane =
		selected === undefined
			? ""
			: `<aside class="run-pane"><p class="eyebrow">Issue #${selected.issue} · run <code>${selected.runId.slice(0, 12)}</code></p><h1 class="pane-title">${esc(selected.title)}</h1>${renderRunSummary(selected)}${runAction(selected)}${renderSteps(selected)}<a class="full-run" href="${base}/run/${selected.runId}/timeline">Open the full run page →</a></aside>`;

	return page(
		"Home",
		`${body}</div>${pane}</div>`,
		base,
		renderHeader(feed, base, token, true),
	);
}
