export default async function* reporter(events) {
	const counts = new Map();
	const failures = [];
	let bad = false;
	let complete = false;

	for await (const event of events) {
		const d = event.data;

		if (event.type === "test:diagnostic" && /only.*(?:require|option)/i.test(d.message)) bad = true;

		if (event.type === "test:pass" || event.type === "test:fail") {
			if (d.skip || d.todo || event.type === "test:fail") bad = true;

			if ((d.name === d.file || d.file?.endsWith(`/${d.name}`)) && d.line === 1 && d.column === 1) { bad = true; continue; }

			if (d.details?.type === "suite") continue;
			const file = d.file?.replace(/^.*?\/(?:w|tree|baseline)\//, "") ?? "missing-file";
			counts.set(file, (counts.get(file) ?? 0) + 1);

			if ((d.skip || d.todo || event.type === "test:fail") && failures.length < 20) failures.push({ file, name: String(d.name).slice(0, 300), outcome: d.skip ? "skip" : d.todo ? "todo" : "failed" });
		}

		if (event.type === "test:summary" && d.file === undefined) {
			complete = true;

			if (!d.success) bad = true;
		}
	}

	yield `${JSON.stringify({ complete, bad, counts: Object.fromEntries([...counts].sort()), failures })}\n`;
}
