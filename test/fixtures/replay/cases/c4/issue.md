# [F10c-lanes-H] Stop scripts/provenance.sh from wiping research/PROVENANCE.md in a fresh clone

`scripts/provenance.sh` wipes `research/PROVENANCE.md` when you run it in a fresh clone.

`research/upstream/` is local-only, so a clone doesn't have it. The script opens `research/PROVENANCE.md` for writing before `find` runs, then `find` fails on the missing directory and the script exits 1. All that's left is the three header lines, and the committed provenance has to be restored from git.

Done when:
- Running `scripts/provenance.sh` in a checkout with no `research/upstream/` directory exits non-zero and leaves `research/PROVENANCE.md` byte-for-byte unchanged.

No other behavior change.
