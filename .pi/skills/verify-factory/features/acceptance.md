# Held-out acceptance (F06b)

Use a committed head and fresh scoped lane as in `SKILL.md`. Re-provision the asset bundle when `skills/acceptance/` changes. Never mount lane state into a stage, and never export suite code or canary text to GitHub.

1. Run the doctor, snapshot the VM, set up the lane and record its head and bundle digest.
2. Create a `[F06b-build]` three-criterion fixture issue as the owner, then apply `factory:ready` as the owner. Run `drive-stage.sh` in that lane. Do not touch `factory:enabled`.
3. Require marker stages `specify:claimed`, `specify:running`, `accept:claimed`, `accept:running`, `accept:stage_passed`. A contract summary precedes claiming accept; one redacted acceptance summary precedes the terminal marker. A specify needs-info run never launches accept.
4. On the host, read `<state>/contracts/<run>/receipt.json` and `<state>/acceptance/<run>/receipt.json`. Check contract digest/base binding, nonempty scenario coverage, 0600 files/0700 dirs and the family disclosure. Use `fileRunFiles(...).readContract` and `artifacts.read` to check the exact-byte acceptance digest. Keep suite bytes on the VM.
5. Sum specify root receipt usage once, and accept receipt usage once. Read nested specify audit files for per-request figures, accept's audit for its requests. Record per-stage wall time and total to terminal marker. Require accept <=25,000 tokens/5 minutes and specify+accept <=45,000 tokens/10 minutes. If the fixed fixture cannot fit 45,000 tokens, stop model spend and report the request breakdown.
6. Run the build-profile prototype in `docs/prototypes/acceptance-isolation/` against the stored run. It spends no model tokens and must show mount/session/Git/cache/tool denial. It proves only the pre-build boundary, not F07c repair secrecy.
7. Read the actual issue comments through repository-scoped `gh`; verify there is no code, private suite path, judge text or canary and that the summary says `context-isolated, same family, not cross-family`.
8. Close every fixture, confirm CLOSED, stop only recorded lane processes, snapshot again, and clean up the lane. Keep redacted evidence and private mode/digest evidence before cleanup.

Recovery and hostile-output cases also run through `test/orchestrator.test.ts` and `test/artifacts.test.ts`: invalid/empty output fails; budget output is ignored; a stored suite is reused after restart without output/session replay; damaged bytes block with a typed reason rather than regenerate.
