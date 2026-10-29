export type GhCause = "not_found" | "auth" | "network" | "other";

/** Why `gh` exited non-zero, read from its stderr. Never carries the stderr text. */
export type GhFailure = {
	readonly cause: GhCause;
	readonly status: number | null;
};

export type ExecResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
};

/** Runs a program with an argument array. Never a shell string. */
export type Exec = (
	command: string,
	args: readonly string[],
) => Promise<ExecResult>;

const NETWORK_FAILURE =
	/error connecting|could not resolve host|no such host|dial tcp|connection (?:refused|reset)|timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|TLS handshake/i;

export function ghFailure(result: ExecResult): GhFailure {
	const code = /\bHTTP (\d{3})\b/.exec(result.stderr)?.[1];
	const status = code === undefined ? null : Number(code);

	if (status === 404) return { cause: "not_found", status };

	if (status === 401 || status === 403) return { cause: "auth", status };

	if (status !== null) return { cause: "other", status };

	return {
		cause: NETWORK_FAILURE.test(result.stderr) ? "network" : "other",
		status: null,
	};
}
