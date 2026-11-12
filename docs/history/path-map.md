# Path map

Every file that the layout program in `docs/plans/codebase-layout.md` moves, renames or splits gets one row here, in the PR that moves it. Use this map to read a historical document, decision row or acceptance suite that names an old path.

Each row is bound to the revision that made the move. The old path is valid at the parent of that revision, and the new path is valid at the revision itself. Write a line citation to an old path as `<sha>:path:line`, so the citation check validates its form instead of looking for the file at HEAD.

| PR | Revision | Old path | New path | Symbols that moved |
| --- | --- | --- | --- | --- |

L00 moves no files. The first rows arrive with L02.
