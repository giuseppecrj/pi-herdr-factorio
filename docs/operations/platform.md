# Platform profile

The factory runs on one host platform at a time. A platform is a validated, immutable `PlatformProfile` from `src/trust/platform.ts`. It holds every value that differs between hosts: the model integration, the edge address, the model base paths, the forbidden upstream domains, the controller's GitHub identity, `GH_HOST`, the repository allowlist and the Anthropic stage positions. With nothing configured the profile is `exe-dev`, and behaviour is what it was before profiles existed.

## Selecting a platform

Two host-owned sources select the platform. `WORKFLOW.md` never does, because a merged PR could then change the security boundary, and because loading it already needs `gh`.

- **`FACTORY_PLATFORM`** names a built-in: `exe-dev` or `exmach:<domain>`. Only the canonical lowercase spelling parses.
- **`/etc/factory/platform.json`** is optional and root-owned. It is small and versioned, and it holds only these keys. Every key except `version` is optional:

```json
{
  "version": 1,
  "platform": "exmach:exmach.net",
  "controllerLogin": "<app-slug>[bot]",
  "controllerAppSlug": "<app-slug>",
  "botEmail": "<id>+<app-slug>[bot]@users.noreply.github.com",
  "repositories": ["nublai/pi-herdr-factorio"],
  "ghHost": "<label>.int.exmach.net"
}
```

It never holds an upstream host, an address, a path or a provider permission. Those come only from the built-in contract for the selected name. Its only host is the controller's `ghHost`, and only as one label under the platform's `int.` domain.

These rules apply:

- With neither source naming a platform, the profile is `exe-dev`.
- If both name a platform, they must agree.
- `exmach` needs no file. `FACTORY_PLATFORM=exmach:exmach.net` alone resolves to a complete profile with the published identity and `ghHost` below.
- On `exmach` the file may override the identity, but only as all three of `controllerLogin`, `controllerAppSlug` and `botEmail` together. Setting some of them and not the others refuses with `controller_identity_missing`. Nothing derives or invents a missing field.
- On `exmach` the file may override `ghHost` with exactly one DNS label under `int.<domain>`, such as `github.int.<domain>`. Anything else refuses with `gh_host_invalid`: two or more labels, another domain, a label that starts or ends with `-`, an empty label, uppercase or a trailing dot. A later rename of the GitHub integration then needs only this file.
- `exe-dev` takes no identity fields and no `ghHost`, because both are fixed. They refuse with `controller_identity_unexpected` and `gh_host_unexpected`.
- `repositories` is optional on both platforms. When present it must be a non-empty list of distinct `owner/name` slugs.
- The reader opens the file once with `O_NOFOLLOW` and checks the open file, so the file it checks is the file it reads. Only a missing path counts as no file. A symlink, even a dangling one, a path that is not a regular file, a group- or world-writable file, or a file owned by anyone but root or the reading user refuses with `platform_file_unsafe`. The reading user already chooses `FACTORY_PLATFORM`, so owning the file gives it nothing more. A file over 16 KiB is not read and refuses with `platform_file_malformed`.
- Every value must have its JSON type. A string field given an object, an array or a number is never converted, and refuses with that field's reason.
- Every resolved hostname, the domain, `modelHost` and `ghHost`, must be a whole DNS name: at most 253 characters, each label at most 63. A one-label `ghHost` that makes the name too long refuses with `gh_host_invalid`.
- A malformed or unreadable file, a malformed selector, a partial identity or an invalid `ghHost` refuses. Nothing falls back to `exe-dev` or to the built-in defaults after an error.
- The platform is read once, when a process starts. Changing it means restarting the controller.

Every entry point uses the same resolver, `resolvePlatform`, with the environment and a file reader passed in. These are the CLI (before any command dispatches), the Pi extension (once, when it loads) and the replay driver. `parsePlatformProfile` itself is pure.

## Profiles

| Field | `exe-dev` | `exmach:<domain>` |
|---|---|---|
| `domain` | `exe.xyz` | `<domain>` |
| `modelHost` (host, `Host` and SNI) | `llm.int.exe.xyz` | `llm.int.<domain>` |
| `edgeAddress` (the pin) | `169.254.169.254` | `10.74.1.1` |
| `modelBasePaths.openai` | `/openai/v1/` | `/v1/` |
| `modelBasePaths.anthropic` | `/anthropic/` | `/` |
| `modelBasePaths.xai` | `/xai/v1/` | `null` (no xAI route) |
| `forbiddenDomains` | `exe.xyz`, `int.exe.xyz`, `github.com`, `githubusercontent.com`, `ghe.com` | `<domain>`, `int.<domain>`, `github.com`, `githubusercontent.com`, `ghe.com` |
| `controllerLogin` | `exe-dev-github-integration[bot]` | `nubl-agent[bot]`, or the file's identity |
| `controllerAppSlug` | `exe-dev-github-integration` | `nubl-agent`, or the file's identity |
| `botEmail` | `267204973+exe-dev-github-integration[bot]@users.noreply.github.com` | `353429311+nubl-agent[bot]@users.noreply.github.com`, or the file's identity |
| `ghHost` | `github.int.exe.xyz` | `factorio.int.<domain>`, or the file's one-label `ghHost` |
| `repositories` | `nublai/pi-herdr-factorio` | the same, or the file's list |
| `anthropicStages` | `accept`, `code-review` | `accept`, `code-review` |

## Historical repository alias

The repository moved from `giuseppecrj/pi-herdr-factorio` to `nublai/pi-herdr-factorio` on 2026-11-10. `historicalRepositories` in `src/trust/platform.ts` maps the current slug to its earlier names, so ledger, metrics and replay can read markers and rows written before the move. The alias is read-only: the controller never writes under an old name.

The `exmach` identity is the published `nubl-agent` GitHub App (app id 5645247, user id 353429311), from giuseppecrj/exmach#94. Its default `ghHost` is the dedicated `factorio` integration, the only one that will carry `actions`. That host is provisional until exmach's E1 and E2 land.

The sandbox prefixes do not change between platforms. The gateway strips the prefix and prepends the base path, so on `exmach` a sandbox request to `/openai/v1/responses` goes upstream to `/v1/responses`, and `/anthropic/v1/messages?beta=true` goes to `/v1/messages?beta=true`.

## Enforcement

- **Forbidden domains.** A profile must list its own domain and its `int.` domain. Otherwise it is refused with `own_domain_not_forbidden` or `internal_domain_not_forbidden`. A profile whose network values differ from its selector's built-in contract is refused with `network_contract_mismatch`. The route-table parser and the ceiling parser both check this before reading anything, and both refuse a credentialed route or ceiling at or under any forbidden domain. Matching is on domain boundaries, after lowercasing and dropping a trailing dot, so `x.int.<domain>` is forbidden and `not<domain>` is not.
- **The gateway decides for itself.** The controller passes the gateway a separate `--platform <descriptor>` argument, `exe-dev` or `exmach:<domain>`. The gateway rebuilds the expected built-in upstreams from that alone and refuses any route whose host, pin, base path, `Host` header or SNI differs. That refusal is the `bad-table` fatal code. The route table never authorizes itself. A missing `--platform` is `bad-arguments`, and a malformed one is `bad-platform`.
- **xAI.** On `exmach`, an `xai/` fallback fails workflow validation, and route construction refuses it again.
- **Anthropic.** Workflow parsing allows `anthropic/` primaries only at the profile's `anthropicStages` positions. The exe-dev refusal text is unchanged. Fallbacks, the grader policy and the Anthropic limits table do not depend on the profile.
- **Identity.** Marker trust, PR ownership, CI actor checks, feedback filters and ledger commit authorship all use the profile's login, app slug and email. A marker by any other login, including the previous platform's, is ignored and never adopted. The existing case rules are kept: marker, CI and PR checks are exact, and the feedback filters ignore case.

## Startup and status

- An invalid platform logs `event=platform_invalid reason=<reason>` and exits 2, before any lock, `gh` call or stage launch. This applies to every CLI command.
- `tick`, `run`, `serve` and `cadence` also require `GH_HOST` to equal `ghHost`. Otherwise they log `controller_refused reason=gh_host_mismatch` and exit 1 before taking the lock. The controller still checks the `gh` viewer against `controllerLogin`. The CLI never sets `GH_HOST` itself.
- `status --json` prints a top-level `platform` object: `name`, `domain`, `descriptor`, `digest` and every field above. An unset selection and an explicit `exe-dev` print the same object.
- The controller writes its own startup profile into `status.json`, shown as `controller.lastTick.platform`. If the two digests differ, the CLI's selection and the running controller's do not match.

Refusal reasons: `unknown_platform`, `domain_invalid`, `platform_selection_mismatch`, `platform_file_unreadable`, `platform_file_unsafe`, `platform_file_malformed`, `version_unsupported`, `unknown_field`, `controller_identity_missing`, `controller_identity_invalid`, `controller_identity_unexpected`, `repositories_empty`, `repository_invalid`, `gh_host_invalid`, `gh_host_unexpected`, `own_domain_not_forbidden`, `internal_domain_not_forbidden` and `network_contract_mismatch`.

## Provisioning environment

`node host/cli/index.ts platform --env` prints nonsecret assignments from the same resolved profile, without a workflow, lock, GitHub call or model request. Full `host/install/provision.sh` uses them for the host Pi configuration and installs the exact output as `/etc/factory/factory.env`, root-owned and mode 0644. `host/install/factory.service` requires that environment file rather than hard-coding `GH_HOST`.

The assignments are `FACTORY_PLATFORM`, `GH_HOST`, `LLM_API_KEY_PLACEHOLDER`, `LLM_BASE_URL`, `LLM_OPENAI_BASE_URL` and `LLM_ANTHROPIC_BASE_URL`. Only exmach adds `GH_ENTERPRISE_TOKEN=exmach`; exe-dev sets no GitHub token, preserving its existing `gh` behaviour. The edge injects the real credential. Host Pi uses the separate `LLM_API_KEY_PLACEHOLDER`, `exe-dev-integration` on exe-dev and `exmach` on exmach. Provider URLs use the profile's model base paths, without a trailing slash, so the default Pi configuration remains byte-identical. The sandbox still uses its own loopback URLs.

After changing either selection source, rerun full provisioning before restarting the unit. The generated `FACTORY_PLATFORM` and the selection file must agree. Provisioning leaves `/etc/factory/platform.json` untouched.

## Remaining exe-dev literals

Run the full inventory with `rg -n 'exe\.xyz|exe-dev-github-integration|169\.254\.169\.254|nublai/pi-herdr-factorio' host src extension`.

- `src/trust/platform.ts` holds the built-in exe-dev network, identity and repository defaults. Its `exe-dev-integration` placeholder is deliberately retained for host Pi, not used as a GitHub token.
- `host/gateway/echo-fixture.ts` holds a redirect target for a test, not a platform value.
- `host/install/factory.service:18` deliberately keeps the repository in `ExecStart`. The unit also retains its `/home/exedev` paths and `User=exedev` (`Group=exedev` too); those deployment values are not profile-selected. It no longer hard-codes an exe-dev host.

## Not covered here

Installing the optional root-owned selection file remains an operator action. Provisioning renders the unit environment but does not install or start the unit. Fresh-VM and cgroup checks remain MV3 live work. Foreign-marker reporting is MV4. Widening `exmach`'s Anthropic positions and its limits table is MV7.
