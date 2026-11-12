import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type PlatformProfile } from "../../src/trust/platform.ts";
import { isRepoSlug } from "../../src/trust/platform.ts";
import { isCadenceJob } from "../../src/maintenance/cadence.ts";
import { type CliIo, EXIT, USAGE } from "./platform.ts";
import { runController } from "./serve.ts";

export async function runCadenceCli(
	argv: readonly string[],
	io: CliIo,
	platform: PlatformProfile,
): Promise<number> {
	let parsed;

	try {
		parsed = parseArgs({
			args: [...argv],
			strict: true,
			allowPositionals: false,
			options: {
				once: { type: "boolean" },
				json: { type: "boolean" },
				job: { type: "string" },
				repo: { type: "string" },
				"state-dir": { type: "string" },
			},
		});
	} catch {
		io.stderr(`unrecognized cadence options\n${USAGE}\n`);

		return EXIT.usage;
	}

	const v = parsed.values;

	if (
		v.once !== true ||
		v.job === undefined ||
		!isCadenceJob(v.job) ||
		v.repo === undefined ||
		!isRepoSlug(v.repo) ||
		!v["state-dir"]
	) {
		io.stderr(`cadence requires --once --job --repo --state-dir\n${USAGE}\n`);

		return EXIT.usage;
	}

	return runController(
		{
			kind: "controller",
			command: "cadence",
			job: v.job,
			repo: v.repo,
			stateDir: resolve(v["state-dir"]),
			scope: null,
			verificationCap: null,
		},
		io,
		platform,
	);
}
