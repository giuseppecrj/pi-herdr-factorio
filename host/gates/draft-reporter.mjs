// Controller-owned companion to the base tree's stdout reporter. It never
// treats test stdout/stderr as protocol and never replaces the trusted facts.
export default async function* reporter(events) {
	const failures = [];

	let complete = false,
		invalid = false,
		truncated = false;

	const ansi = new RegExp(
		`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
		"g",
	);

	for await (const event of events) {
		const d = event.data;

		if (
			event.type === "test:diagnostic" &&
			/^'only' and 'runOnly' require the --test-only command-line option\.?$/.test(
				d.message,
			)
		)
			invalid = true;

		if (event.type === "test:summary" && d.file === undefined) complete = true;

		if (event.type !== "test:pass" && event.type !== "test:fail") continue;

		const load =
			(d.name === d.file || d.file?.endsWith(`/${d.name}`)) &&
			d.line === 1 &&
			d.column === 1;

		if (d.details?.type === "suite" && !load) continue;

		if (!d.skip && !d.todo && event.type !== "test:fail") continue;

		const error = d.details?.error,
			failureType = error?.failureType;

		if (failureType === "subtestsFailed") continue;

		if (failures.length >= 1000) {
			truncated = true;
			continue;
		}

		const code =
			error?.cause?.code == null
				? null
				: String(error.cause.code).slice(0, 100);

		const kind = load
			? "load_error"
			: d.skip
				? "skip"
				: d.todo
					? "todo"
					: failureType === "testTimeoutFailure"
						? "timeout"
						: failureType === "cancelledByParent" ||
								failureType === "testAborted"
							? "cancelled"
							: code === "ERR_ASSERTION"
								? "assertion"
								: "runtime_error";

		const message = String(error?.cause?.message ?? error?.message ?? "");

		const causes = new Set(),
			at = new Set(),
			seen = new Set();

		// The node:test wrapper itself is Error [ERR_TEST_FAILURE], not the cause.
		let cause = error?.cause;

		for (let depth = 0; cause != null; depth++, cause = cause.cause) {
			if (depth >= 8 || seen.has(cause)) {
				truncated = true;
				break;
			}

			seen.add(cause);
			const text = `${cause.message ?? ""}\n${cause.stack ?? ""}`;

			if (text.length > 1024 * 1024) {
				truncated = true;
				break;
			}

			for (const line of text.replace(ansi, "").split("\n")) {
				const clean = line.trim();

				if (/^(?:[A-Z][A-Za-z]*Error\b|Error:)/.test(clean))
					causes.add(clean.slice(0, 200));

				for (const match of clean.matchAll(
					/\/w\/test\/acceptance\/[A-Za-z0-9_-]+\/checks\/([A-Za-z0-9_./-]+:\d+:\d+)/g,
				))
					at.add(match[0]);
			}
		}

		// Never hide a later runtime cause behind three harmless assertion lines.
		const ordered = [...causes].sort(
			(a, b) =>
				Number(/^AssertionError\b/.test(a)) -
				Number(/^AssertionError\b/.test(b)),
		);

		failures.push({
			file:
				d.file?.replace(/^.*?\/(?:w|tree|baseline)\//, "") ?? "missing-file",
			name: String(d.name).slice(0, 300),
			kind,
			code,
			message: message.slice(0, 300),
			causes: ordered.slice(0, 3),
			at: [...at].slice(0, 3),
		});
	}

	const result = { complete, invalid, truncated, failures };

	if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) {
		result.truncated = true;
		result.failures = [];
	}

	yield `${JSON.stringify(result)}\n`;
}
