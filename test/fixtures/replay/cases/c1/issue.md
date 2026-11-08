# [F10-B] isBranchName accepts names git rejects

The `--ref` and `--reload-ref` flags check their value with `isBranchName`. It currently accepts names that git itself refuses as branch names: `release.lock`, `a/b.lock`, `a.`, `a/.b`, and anything with a path part that starts with a dot. These should be refused up front, so the user gets the "must be branch names" message, not a confusing error later. Names that work today (`main`, `feature/x-1`, `v1.2.3`) must keep working.
Please add a test with a table of valid and invalid names. It may check them against `git check-ref-format`.

