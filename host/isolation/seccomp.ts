export type SeccompArch = "x86_64" | "aarch64";

/** `AUDIT_ARCH_*` values from linux/audit.h. */
export const AUDIT_ARCH = {
	x86_64: 0xc000003e,
	aarch64: 0xc00000b7,
} as const satisfies Record<SeccompArch, number>;

const SYSCALL_NAMES = [
	"io_uring_setup",
	"io_uring_enter",
	"io_uring_register",
	"ptrace",
	"process_vm_readv",
	"process_vm_writev",
	"bpf",
	"perf_event_open",
	"userfaultfd",
	"keyctl",
	"add_key",
	"request_key",
	"kexec_load",
	"kexec_file_load",
	"mount",
	"umount2",
	"pivot_root",
	"open_tree",
	"move_mount",
	"fsopen",
	"fsconfig",
	"fsmount",
	"init_module",
	"finit_module",
	"socket",
	"clone",
	"clone3",
	"unshare",
] as const;

type SyscallName = (typeof SYSCALL_NAMES)[number];

/** Syscall numbers from asm/unistd_64.h (x86_64) and asm-generic/unistd.h (aarch64). */
export const SYSCALLS: Record<SeccompArch, Record<SyscallName, number>> = {
	x86_64: {
		io_uring_setup: 425,
		io_uring_enter: 426,
		io_uring_register: 427,
		ptrace: 101,
		process_vm_readv: 310,
		process_vm_writev: 311,
		bpf: 321,
		perf_event_open: 298,
		userfaultfd: 323,
		keyctl: 250,
		add_key: 248,
		request_key: 249,
		kexec_load: 246,
		kexec_file_load: 320,
		mount: 165,
		umount2: 166,
		pivot_root: 155,
		open_tree: 428,
		move_mount: 429,
		fsopen: 430,
		fsconfig: 431,
		fsmount: 432,
		init_module: 175,
		finit_module: 313,
		socket: 41,
		clone: 56,
		clone3: 435,
		unshare: 272,
	},
	aarch64: {
		io_uring_setup: 425,
		io_uring_enter: 426,
		io_uring_register: 427,
		ptrace: 117,
		process_vm_readv: 270,
		process_vm_writev: 271,
		bpf: 280,
		perf_event_open: 241,
		userfaultfd: 282,
		keyctl: 219,
		add_key: 217,
		request_key: 218,
		kexec_load: 104,
		kexec_file_load: 294,
		mount: 40,
		umount2: 39,
		pivot_root: 41,
		open_tree: 428,
		move_mount: 429,
		fsopen: 430,
		fsconfig: 431,
		fsmount: 432,
		init_module: 105,
		finit_module: 273,
		socket: 198,
		clone: 220,
		clone3: 435,
		unshare: 97,
	},
};

const DENIED: readonly SyscallName[] = SYSCALL_NAMES.filter(
	(name) => !["socket", "clone", "clone3", "unshare"].includes(name),
);

const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;

const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;

const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0_LOW = 16;

const X32_SYSCALL_BIT = 0x40000000;
const CLONE_NEWNS = 0x00020000;
const CLONE_NEWUSER = 0x10000000;
const AF_UNIX = 1;
const AF_VSOCK = 40;

export type Instruction = {
	readonly code: number;
	readonly jt: number;
	readonly jf: number;
	readonly k: number;
};

type Label = "allow" | "eperm" | "enosys" | "kill" | "socket" | "flags";

type Step =
	| { readonly kind: "label"; readonly name: Label }
	| { readonly kind: "load"; readonly offset: number }
	| {
			readonly kind: "jump";
			readonly code: number;
			readonly k: number;
			readonly yes: Label | null;
			readonly no: Label | null;
	  }
	| { readonly kind: "ret"; readonly k: number };

/** Maps Node's `process.arch` to a filter architecture. Anything else is `null`, and the runner refuses to start. */
export function detectArch(nodeArch: string): SeccompArch | null {
	if (nodeArch === "x64") return "x86_64";

	if (nodeArch === "arm64") return "aarch64";

	return null;
}

function steps(arch: SeccompArch, blockUnixSockets: boolean): Step[] {
	const nr = SYSCALLS[arch];

	const program: Step[] = [
		{ kind: "load", offset: OFFSET_ARCH },
		{ kind: "jump", code: JEQ_K, k: AUDIT_ARCH[arch], yes: null, no: "kill" },
		{ kind: "load", offset: OFFSET_NR },
	];

	if (arch === "x86_64") {
		program.push({
			kind: "jump",
			code: JGE_K,
			k: X32_SYSCALL_BIT,
			yes: "kill",
			no: null,
		});
	}

	for (const name of DENIED) {
		program.push({
			kind: "jump",
			code: JEQ_K,
			k: nr[name],
			yes: "eperm",
			no: null,
		});
	}

	program.push(
		{ kind: "jump", code: JEQ_K, k: nr.clone3, yes: "enosys", no: null },
		{ kind: "jump", code: JEQ_K, k: nr.socket, yes: "socket", no: null },
		{ kind: "jump", code: JEQ_K, k: nr.clone, yes: "flags", no: null },
		{ kind: "jump", code: JEQ_K, k: nr.unshare, yes: "flags", no: null },
		{ kind: "ret", k: RET_ALLOW },
		{ kind: "label", name: "socket" },
		{ kind: "load", offset: OFFSET_ARG0_LOW },
		{ kind: "jump", code: JEQ_K, k: AF_VSOCK, yes: "eperm", no: null },
	);

	if (blockUnixSockets) {
		program.push({
			kind: "jump",
			code: JEQ_K,
			k: AF_UNIX,
			yes: "eperm",
			no: null,
		});
	}

	program.push(
		{ kind: "ret", k: RET_ALLOW },
		{ kind: "label", name: "flags" },
		{ kind: "load", offset: OFFSET_ARG0_LOW },
		{
			kind: "jump",
			code: JSET_K,
			k: CLONE_NEWUSER | CLONE_NEWNS,
			yes: "eperm",
			no: null,
		},
		{ kind: "label", name: "allow" },
		{ kind: "ret", k: RET_ALLOW },
		{ kind: "label", name: "eperm" },
		{ kind: "ret", k: RET_ERRNO | EPERM },
		{ kind: "label", name: "enosys" },
		{ kind: "ret", k: RET_ERRNO | ENOSYS },
		{ kind: "label", name: "kill" },
		{ kind: "ret", k: RET_KILL_PROCESS },
	);

	return program;
}

function assemble(program: readonly Step[]): Instruction[] {
	const labels = new Map<Label, number>();
	let index = 0;

	for (const step of program) {
		if (step.kind === "label") labels.set(step.name, index);
		else index += 1;
	}

	const out: Instruction[] = [];

	for (const step of program) {
		if (step.kind === "label") continue;

		if (step.kind === "load") {
			out.push({ code: LD_W_ABS, jt: 0, jf: 0, k: step.offset });
		} else if (step.kind === "ret") {
			out.push({ code: RET_K, jt: 0, jf: 0, k: step.k >>> 0 });
		} else {
			const here = out.length + 1;

			const offset = (label: Label | null) => {
				if (label === null) return 0;

				const distance = (labels.get(label) ?? -1) - here;

				if (distance < 0 || distance > 255)
					throw new Error("seccomp jump out of range");

				return distance;
			};

			out.push({
				code: step.code,
				jt: offset(step.yes),
				jf: offset(step.no),
				k: step.k >>> 0,
			});
		}
	}

	return out;
}

/**
 * The stage seccomp filter as raw `sock_filter` records for `bwrap --seccomp`.
 * A deny list over default allow: foreign architectures and x32 are killed,
 * listed syscalls get EPERM, `clone3` gets ENOSYS so libc falls back to
 * `clone`, whose flags the filter can read. `AF_UNIX` stays allowed unless asked.
 */
export function seccompProgram(
	arch: SeccompArch,
	options: { blockUnixSockets: boolean },
): Buffer {
	const program = assemble(steps(arch, options.blockUnixSockets));
	const bytes = Buffer.alloc(program.length * 8);

	for (const [index, ins] of program.entries()) {
		bytes.writeUInt16LE(ins.code, index * 8);
		bytes.writeUInt8(ins.jt, index * 8 + 2);
		bytes.writeUInt8(ins.jf, index * 8 + 3);
		bytes.writeUInt32LE(ins.k, index * 8 + 4);
	}

	return bytes;
}

export function decodeProgram(bytes: Buffer): Instruction[] {
	const program: Instruction[] = [];

	for (let offset = 0; offset + 8 <= bytes.length; offset += 8) {
		program.push({
			code: bytes.readUInt16LE(offset),
			jt: bytes.readUInt8(offset + 2),
			jf: bytes.readUInt8(offset + 3),
			k: bytes.readUInt32LE(offset + 4),
		});
	}

	return program;
}
