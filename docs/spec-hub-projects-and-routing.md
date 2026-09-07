# Spec: the hub as a command centre

Four features, staged so each one lands as its own PR and is useful alone.
Written by Claude (orchestrator). Implemented by GLM. Do not merge — the human
merges.

**Base branch: `feat/bus-status`.** `docs/how-we-work.md` and the whole hub only
exist there, not on `main`. Branching from `main` will not compile against this
spec. Take your own worktree; `tools/agent-bus/server.mjs` has one owner at a
time (rule 3) and that is you for the duration.

---

## What exists today, so you do not rediscover it

- State lives at `<main repo>/.git/agent-bus/state.json`, resolved by
  `stateDir()` via `git rev-parse --git-common-dir`. It is **per repository**.
- The state object is
  `{ agents, lock, messages, board, tasks, taskSeq }`.
- A message is `{ id, from, to, text, at, readBy[] }`, capped at the last 500.
- A task is `{ id, lane, title, prompt, status, runner_id, by, at }`.
- `runners.json` beside `server.mjs` declares invokable agents:
  `{ id, label, type, model, enabled, note }`. `readRunners()` re-reads it on
  every call by design — adding a model must not need a restart.
- The hub POST handler dispatches on a `action` form field around line 1280.
- `readBuildRules()` / `readWorkflow()` parse markdown live so the rules can
  never go stale. Reuse that pattern rather than inventing a second one.

---

## Stage 1 — Talk to the agents from the window

A compose box on the hub that writes to `state.messages`, and a thread showing
the last 30.

- Form: `action=message`, fields `to` (select: `all` plus every registered
  agent) and `text`. Post as `from: "human"`.
- `send` currently calls `requireName()` and rejects a recipient that is not
  registered. The hub is not a registered agent, so **do not route through the
  `send` tool** — write the message inside `withState` directly, with the same
  500-entry cap. Broadcast to `all` must work when nobody is registered, which
  is the normal case when the human opens the window first.
- Render newest last, `from → to`, local time, text wrapped and escaped.

**Label it honestly in the UI.** This is a noticeboard, not live chat. An agent
sees a message when it next calls `inbox()`. A Claude session already running
will not notice until it checks. The window must say so — a box that looks like
chat and silently does nothing for ten minutes is worse than no box.

Out of scope: push, notifications, read receipts beyond the existing `readBy`.

---

## Stage 2 — Know which AI is actually here, and what it can do

Two separate facts, and they must not be conflated: what is **declared**, and
what is **reachable**. A declared runner that is not installed is not the same
as a runner that does not exist (rule 5 — a blank is not a zero).

**Extend `runners.json`** with capability declarations:

```json
{
  "id": "glm",
  "label": "GLM 5.3 Flash — cloud",
  "type": "ollama",
  "model": "glm-5.3-flash:cloud",
  "enabled": true,
  "can": ["implement", "refactor", "migrate", "test"],
  "never": ["auth", "rls", "money", "snapshot", "credentials"],
  "max_risk": "reversible"
}
```

- `can` — task kinds this runner may take.
- `never` — subject areas it must never touch, whatever the kind. Seed these
  from `docs/how-we-work.md` → "The lanes", which already states them in prose:
  local models never touch auth, RLS, migrations, money or the snapshot rule,
  because being subtly wrong there is invisible until it costs a customer.
- `max_risk` — one of `reversible`, `review-required`, `irreversible`. No runner
  but the human gets `irreversible`.

**Add availability probing.** A new `readRunnerHealth()`:

- `type: "ollama"` — GET `/api/tags`, match on `model`. A cloud model such as
  `glm-5.3-flash:cloud` will **not** appear in that list and is still reachable;
  probe those with a 1-token generate call instead. Do not report a cloud model
  as missing because it was never pulled — that bug is already documented in the
  `runners.json` comment.
- `type: "shell"` — check the command resolves. Do not execute it.
- Cache health for 60s. The hub re-renders often and must not stampede ollama.
- Report three states: `ready`, `declared but unreachable`, `disabled`.

**Hub panel "Your agents":** one row per runner — label, type, health, what it
can do, what it must never touch. This is also the sales surface: it is the
screen that shows a buyer their own hardware being used.

Out of scope: installing or pulling models. Report, do not fix (rule C2).

---

## Stage 3 — Route work to the agent that can handle it

Tasks gain two fields, both optional so existing tasks keep working:

- `kind` — `implement | research | audit | migrate | test | review`
- `risk` — `reversible | review-required | irreversible`
- `subject` — free tags, e.g. `["rls","money"]`

**`pickRunner(task)`:**

1. Drop runners that are disabled or unreachable.
2. Drop any whose `never` intersects `task.subject`.
3. Drop any whose `max_risk` ranks below `task.risk`.
4. Drop any whose `can` does not include `task.kind`.
5. If more than one survives, prefer local over cloud — a wrong answer must be
   cheap (how-we-work, Rules of delegation).
6. **If none survives, refuse.** Return the reason, leave the task queued, and
   show it on the hub as `needs a human`. Never fall back to "the first enabled
   runner" — silently handing an RLS migration to a 7B model is precisely the
   failure this whole file exists to prevent.

An explicit `runner_id` on a task still wins, but must be checked against
`never` and `max_risk` and refused if it violates either. A human choosing badly
from a dropdown is still a bad route.

`findRunner()` keeps its current behaviour for callers that pass an id. Add
routing beside it; do not change what already works.

---

## Stage 4 — Projects, and scopes inside them

The largest change. **State stays per repository.** Do not move it, do not merge
several repos into one state file — every worktree, CLI call and MCP client
depends on `stateDir()` resolving the way it does.

Instead add a registry **above** the repo, at `~/.agent-bus/projects.json`:

```json
{ "projects": [
  { "id": "lawn", "name": "Terra Verde — lawn", "path": "C:/Users/.../lowvoltage-app" }
] }
```

- Hub `/` becomes a project list: name, path, agents online, tasks queued/running,
  and whether the path still exists.
- Hub `/p/<id>` is the project page — the board, tasks, workers, agents and
  messages that the single-project hub shows today.
- Read another project's `state.json` **read-only** by joining
  `<path>/.git/agent-bus/state.json`. Writing into another project's state means
  taking that project's lock; if that is awkward, make remote projects read-only
  for this stage and say so in the UI. Read-only and honest beats writable and
  racy.
- A missing or unreadable project renders as unavailable. It must never take the
  hub down.

**Scopes** — a scope is a goal with a definition of done, and tasks belong to it.

Store them in the repo, not in state: `docs/scopes.md`, parsed live with the
same `## ` heading + `- ` bullet reader already used for the workflow doc. A
goal is a durable, reviewable fact and belongs in a commit (rule F2), not in a
`.git` directory that a clean checkout wipes.

```markdown
## Receiving on material orders
- goal: a delivery can be recorded against an order without losing partials
- done_when: receipts table live with RLS
- done_when: partial and over-delivery both visible on the order
- task: 12
- task: 15
```

Tasks gain `scope` (the scope's heading slug). The project page lists each scope
with its `done_when` lines, the tasks under it, and how many remain. That is the
"what still needs doing to reach the goal" view.

A task with no scope shows under **Unscoped**. Do not invent a scope for it.

---

## Gates, for every stage

`tsc --noEmit`, `eslint`, a real `next build`, and `node tools/agent-bus/server.mjs board`
plus `cost` still running afterwards. The bus starting is not optional — if it
throws, every Claude session in this repo loses its tool list.

Report on the bus with `note`. Open a PR per stage. Do not merge.
