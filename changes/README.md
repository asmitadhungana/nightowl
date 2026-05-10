# changes/

Per-milestone change log so a fresh Claude session (or a fresh human) can catch up
without trawling git history.

## Convention

- One file per milestone: `M<NN>-<slug>.md` (zero-padded so they sort lexically).
- Milestone numbers continue from the M-numbering used in `CLAUDE.md`'s
  "Milestone log" section (current head: M6).
- File header carries the date and the branch/commit it landed on (or "uncommitted"
  while in-flight).
- Body covers: what shipped, what changed by file, why, what was deferred, what
  the *next* session needs to know to keep going.

## Where the older milestones live

- **M1–M5** are summarized in `CLAUDE.md` → "v2 — Friend Lock (alpha)" → "Milestone
  log", and each is one git commit (see `git log feat/v2-friend-lock-alpha`).
  They are not repeated here because the commit messages + CLAUDE.md already cover them.
- **M6 onward** lives in this folder.

## How to use this folder

When starting a fresh session:

1. Read `CLAUDE.md` end-to-end — it has the architecture + milestone log + paths-not-taken.
2. List `changes/` newest-first and skim the most recent 1–2 milestone files for
   the current state of in-flight work.
3. `git log --oneline -10` and `git status` to see what is committed vs uncommitted.
4. If memory has a `project_v2_friend_lock.md` entry, treat it as a cross-check, not
   ground truth — verify against the files before acting.

When closing a session that landed meaningful work:

1. Pick the next milestone number.
2. Drop a `M<NN>-<slug>.md` here with the structure used by `M06-*` as the template.
3. Update `CLAUDE.md` "Milestone log" with a one-paragraph entry pointing here.
4. If the work is committed, also bump the memory file under
   `~/.claude/projects/-Users-asmeedhungana-indie-nightowl/memory/`.
