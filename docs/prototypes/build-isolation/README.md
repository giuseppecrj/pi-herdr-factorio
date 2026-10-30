# Build workspace isolation

Run on the VM after a real build, with the matching lane state and attempt number.

```sh
XDG_RUNTIME_DIR=/run/user/1000 node docs/prototypes/build-isolation/probe.ts <state-dir> <run-id> [attempt]
```

This adapts the F06b directory-aware canary probe to the actual `<runId>-build-<attempt>` workspace, not the earlier specify/accept workspace. It uses a fresh build-profile sandbox and no model requests. It checks inventoried earlier specify/accept attempt, replay and fallback records, private suite paths, exact raw-output/test-body fingerprints, test-path tokens, canaries, mounts, Git mask, fresh session/cache roots and denied GitHub access. It exports no suite, canary, private fingerprint or hit path.

A missing workspace, failed host-path discovery, missing roots or nonzero probe exit is not a pass. This measures the mounts and exact copy channels the probe checks. It does not prove secrecy against arbitrary transformed copies, kernel escapes or F07c's post-publication repair channels. Fingerprints may flag a coincidentally identical visible-test path; inspect that privately rather than suppressing the detector.
