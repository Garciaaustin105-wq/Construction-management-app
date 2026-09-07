# HANDOFF — finish PR #14, the construction half of desktop phase 2

**For:** GLM
**PR:** [#14](https://github.com/Garciaaustin105-wq/Construction-management-app/pull/14) — `feat/desktop-pass-phase-2`
**Written:** 2026-09-07, against `main` at `510ffa8`

---

## What this is, and what it is not

The code is **already written**. Nine files, +821/-603, migrating the
construction and shared desktop tables onto `DataTable`. Somebody wrote it on
2026-09-06 and it has sat open since.

**Your job is to land it, not to rewrite it.** Rebase, verify, get the checks
green, and confirm it on a construction preview. If you find something genuinely
wrong in the diff, say so in the PR rather than quietly changing it — the
original author is not around to defend a decision you would be overruling.

---

## State, verified 2026-09-07

| Fact | Value |
|---|---|
| Mergeable | **Yes** — all nine files are untouched on `main` since the PR was opened |
| Behind `main` by | **59 commits** |
| Checks | `UNSTABLE` — see below, it is probably stale noise |

The nine files:

```
src/app/admin/orgs/page.tsx          both apps
src/app/change-orders/page.tsx       construction
src/app/daily-logs/page.tsx          construction
src/app/estimates/page.tsx           both apps
src/app/punch/page.tsx               construction
src/app/submittals/page.tsx          construction
src/components/CrewMembersManager.tsx    both apps
src/components/CustomersManager.tsx      both apps
src/components/invoices/InvoicesList.tsx both apps
```

**Four of those nine reach BOTH apps.** That is the entire reason this PR was
split out of #13 — so the construction side gets reviewed on a construction
preview instead of riding along with lawn work.

---

## Do this

### 1. Take your own worktree

The shared checkout has been mid-merge before and it cost days. Do not work in
`Projects/lowvoltage-app` directly.

```
git -C /c/Users/garci_9e2kg3l/Projects/lowvoltage-app worktree add ../lv-phase2 feat/desktop-pass-phase-2
cd ../lv-phase2 && npm ci && cp ../lowvoltage-app/.env.local .
```

### 2. Merge `main` in — do not rebase

`git merge origin/main`. **Not** `rebase`, and not `push --force`: these are
someone else's commits and rewriting them is against
[`docs/build-rules.md`](../build-rules.md) rule 25.

It should merge cleanly. If it does not, stop and report which file.

### 3. Why the checks are probably red for a reason that no longer exists

This PR predates three CI changes that landed on 2026-09-07:

- **#29 / #32** added `.deepsource.toml`. Before it, every `.mjs` file in the
  repo failed to *parse* under the JavaScript analyzer and reported a syntax
  error, which is what kept the check red on `main` for weeks. Merging `main`
  should clear that.
- **#33** added a `quotes` rule to `eslint.config.mjs` — double quotes, and no
  template literal without interpolation. Your merge may surface it on these
  nine files. `npx eslint <file> --fix` handles it.
- **#35** told eslint to ignore `.claude/**` and `.*-build/**`.

If the JavaScript check is still red after merging `main`, **compare against
`main` before assuming you broke it** — read the inline comments on the PR and
check whether the same finding exists on `main`.

### 4. Verify

```
npx tsc --noEmit          # must be silent
npx eslint .              # 0 errors; ~31 pre-existing warnings are fine
npx next build            # must compile
```

There is no harness for this work — it is presentational. The build and the
preview are the check.

### 5. The one hard rule: mobile must not change

The desktop pass is **`lg:`-and-up only. Mobile is byte-identical.**

`DataTable` gives you a real `<table>` at `lg` and a stacked card list below it
from one column config, so following the pattern gets this right for free. What
to confirm on the preview:

- At a **phone width**, every one of the nine screens looks exactly as it does
  on `main`. Open both side by side.
- At `lg+`, the table is real: aligned columns, money right-aligned and
  tabular.

I spot-checked the diff and it looks disciplined — 28 `DataTable` / `hidden
lg:block` / `lg:hidden` markers, and the only added classes without an `lg:`
prefix are inside desktop-only blocks (table headers). **I did not review all
nine diffs line by line.** Verify it yourself rather than trusting that.

### 6. Review it where it actually ships

Vercel builds **two projects** from this branch. The one that matters here is
**`construction-management-app`**, not `terraverdelawnmanagementapp`. Four of
the nine files reach both, so check the lawn preview too — but the construction
preview is the one this PR exists for.

### 7. Report back

Comment on the PR with: that `main` merged cleanly, the three command results,
and what you saw at phone width vs `lg` on the construction preview. Do not
merge it yourself — the owner merges.

---

## Rules that apply

Full list in [`docs/build-rules.md`](../build-rules.md). The ones that bite here:

- **Rule 25** — never rewrite another agent's commits. Merge, don't rebase.
- **Rule 23** — claim the tree or take your own worktree.
- **Rule 3** — one owner per file. If you need to touch something outside these
  nine, stop and say so.
- **Rule 22** — check your own assumption before "fixing" working code. A red
  check that is also red on `main` is not yours.

## Coordination

`agent-bus` is on `main` and reachable from PowerShell without MCP:

```
node tools/agent-bus/server.mjs register glm "desktop phase 2 construction"
node tools/agent-bus/server.mjs claim glm C:/Users/garci_9e2kg3l/Projects/lv-phase2 "phase 2"
node tools/agent-bus/server.mjs note phase2-status "merged main, checks green, reviewing preview"
node tools/agent-bus/server.mjs release glm
```

## Do not touch

- **Peanutz L&L**, org `d236eba1-8e84-4dae-a40d-ef2651cbbb9c` — a live customer.
  Never read or write it.
- The lawn estimator, the catalogues, or `navItems.ts` — all changed heavily on
  2026-09-07 and none of it is in scope here.
