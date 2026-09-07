# Spec: the hub as a command centre

Staged so each one lands as its own PR and is useful alone.
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
- The state object is `{ agents, lock, messages, board, tasks, taskSeq }`.
- A message is `{ id, from, to, text, at, readBy[] }`, capped at the last 500.
- A task is `{ id, lane, title, prompt, status, runner_id, by, at }`.
- `runners.json` beside `server.mjs` declares invokable agents:
  `{ id, label, type, model, enabled, note }`. `readRunners()` re-reads it on
  every call by design — adding a model must not need a restart.
- The hub POST handler dispatches on an `action` form field around line 1280.
- `readBuildRules()` / `readWorkflow()` parse markdown live so the rules can
  never go stale. Reuse that pattern rather than inventing a second one.

---

## Stage 0 — Split the hub out of the bus. No behaviour change.

`server.mjs` is 1,570 lines and the hub is ~700 of them, from line 861. The
stages below add several hundred more.

Move rendering and HTTP into `tools/agent-bus/hub.mjs`; leave `server.mjs` as
bus, MCP and state. Export what the hub needs rather than reaching into module
internals.

**Why this is first:** a render bug in the hub currently throws inside the MCP
server, and every Claude session in this repo loses its tool list. That is a bad
failure mode to carry into a feature expansion, and each new panel makes it more
likely. Same reasoning as `context-cost.mjs` being spawned rather than imported.

It also unblocks parallel work — nobody can build a hub feature while the whole
bus is one file with one owner.

Gate: `board`, `status`, `runners`, `cost` and `dashboard` all behave exactly as
before. This PR should be a move, not a rewrite.

---

## Stage 1 — Talk to the agents from the window

A compose box that writes to `state.messages`, and a thread showing the last 30.

- Form: `action=message`, fields `to` (select: `all` plus every registered
  agent) and `text`. Post as `from: "human"`.
- `send` calls `requireName()` and rejects a recipient that is not registered.
  The hub is not a registered agent, so **do not route through the `send` tool**
  — write the message inside `withState` directly, with the same 500-entry cap.
  Broadcast to `all` must work when nobody is registered, which is the normal
  case when the human opens the window first.
- Render newest last, `from → to`, local time, text wrapped and escaped.

**Label it honestly in the UI.** This is a noticeboard, not live chat. An agent
sees a message when it next calls `inbox()`. A Claude session already running
will not notice until it checks. A box that looks like chat and silently does
nothing for ten minutes is worse than no box.

Out of scope: push, notifications, read receipts beyond the existing `readBy`.

---

## Stage 2 — Know every AI, let the human choose, route safely

Previously two stages. They are one feature: capability data nobody routes on is
a decorative screen, and routing without capability data is impossible.

### 2a. Declare what each runner is

Extend `runners.json`:

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
- `max_risk` — `reversible` | `review-required` | `irreversible`. No runner but
  the human gets `irreversible`.

### 2b. Know which are actually here

**Declared** and **reachable** are different facts and must not be conflated — a
declared runner that is not installed is not a runner that does not exist
(rule 5, a blank is not a zero).

`readRunnerHealth()`:

- `type: "ollama"` — GET `/api/tags` and match on `model`. A cloud model such as
  `glm-5.3-flash:cloud` will **not** appear in that list and is still reachable;
  probe those with a 1-token generate call instead. Do not report a cloud model
  as missing because it was never pulled — that trap is already documented in
  the `runners.json` comment.
- `type: "shell"` — check the command resolves. Do not execute it.
- Cache for 60s. The hub re-renders often and must not stampede ollama.
- Three states: `ready`, `declared but unreachable`, `disabled`.

### 2c. Let the human choose — within what is safe

The human picks the agent. The bus decides who is *eligible* to be picked.

When queueing work, the hub shows every runner with an explicit verdict.

These are the five runners this machine actually has — four local models, all
installed, plus GLM as a cloud model. **`gpt-oss:20b` is the default local
model**; it leads the local list and is the standing preference for local work.

An ordinary implementation task, `kind: implement`, no restricted subject:

```
  ● gpt-oss:20b        eligible     local, default — preferred
  ● qwen2.5-coder:14b  eligible     local, code-weighted
  ● codestral:22b      eligible     local
  ● GLM 5.3 Flash      eligible     cloud — costs money, prefer local
  ○ qwen2.5:7b         not eligible cannot take: kind 'implement' not in `can`
```

The same queue, for a task tagged `subject: ["rls"]`:

```
  ○ gpt-oss:20b        not eligible cannot take: touches rls
  ○ qwen2.5-coder:14b  not eligible cannot take: touches rls
  ○ codestral:22b      not eligible cannot take: touches rls
  ○ GLM 5.3 Flash      not eligible cannot take: touches rls
  ○ qwen2.5:7b         not eligible cannot take: touches rls

  Nothing here can safely take this task. Needs a human.
```

That second screen is the feature. It is not an error state.

- **Show the ineligible ones, greyed, with the reason.** Do not hide them.
  Seeing *"cannot take: touches rls"* teaches the limits of the tool; an option
  that silently vanishes teaches nothing and looks like a bug.
- The human's pick is honoured for anything marked eligible.
- A pick that is **not** eligible is refused, with the reason, and the task stays
  queued. A human choosing badly from a dropdown is still a bad route.

**Standing preference.** Answering per task is friction. Store a preference map
in state, seeded to match how this machine is actually set up — `gpt-oss` is the
default local model and should be the default answer for local work:

```json
{ "implement": "gpt-oss", "research": "gpt-oss",
  "audit": "qwen-small", "migrate": "glm", "review": "glm" }
```

Editable from the hub, applied automatically when it names an eligible runner,
and quietly skipped when it does not. Show which preference fired, so an
automatic choice is never mysterious.

### 2d. Route

Tasks gain three optional fields so existing tasks keep working:
`kind` (`implement|research|audit|migrate|test|review`),
`risk` (`reversible|review-required|irreversible`),
`subject` (free tags, e.g. `["rls","money"]`).

`pickRunner(task)`:

1. Drop runners that are disabled or unreachable.
2. Drop any whose `never` intersects `task.subject`.
3. Drop any whose `max_risk` ranks below `task.risk`.
4. Drop any whose `can` does not include `task.kind`.
5. Apply the human's explicit pick, else the standing preference, else prefer
   local over cloud — a wrong answer must be cheap.
6. **If none survives, refuse.** Return the reason, leave the task queued, show
   it on the hub as `needs a human`. Never fall back to "the first enabled
   runner". Silently handing an RLS migration to a 7B model is precisely the
   failure this file exists to prevent.

`findRunner()` keeps its current behaviour for callers that pass an id. Add
routing beside it; do not change what already works.

### 2e. Benchmark the local models on *this* machine

The third fact about a runner, after declared and reachable: how fast it
actually is **here**. Model size tells you nothing useful — what matters is
whether it fits in this machine's VRAM or spills to CPU, and that is a per-system
answer no spec sheet gives you. On a 12GB card, `codestral:22b` (12.6GB) and
`gpt-oss:20b` (13.8GB) may run an order of magnitude slower than
`qwen2.5:7b` (4.7GB); on a 24GB card they may not. Measure, do not assume.

`benchmark(runnerId)` → `{ loadMs, firstTokenMs, tokensPerSec, ok, at }`

- Same fixed prompt to every runner. Never a prompt that varies between runs.
- Measure **cold** (first call after load) and **warm** separately. Cold is where
  the large models lose, and cold is what you actually pay on the first task.
- **Three runs minimum, report the median** — rules 14 and 15, medians never
  means, and gate on sample size. One run on a machine that was busy is noise.
- **Say what you could not measure** and why (rule 16). A model that timed out is
  not a model that scored zero.

**A correctness floor, not a quality score.** Three deterministic questions with
known answers — count something, extract a field, return a bare number. Record
`ok: false` for a runner that is fast and returns unparseable garbage. This is
not a quality ranking and must never be presented as one; it only separates
"fast" from "fast and useless".

**How speed may be used — and may not:**

- It breaks ties in `pickRunner` step 5, **among runners already eligible**.
- It never promotes an ineligible runner. Fast does not make a model safe.
- It never overrides an explicit human pick or a standing preference.

Label it in the UI as **speed on this machine, not a measure of whether the
answer is right** (rule C2 — report measurements, do not render verdicts). A
column of tokens/sec next to nothing else invites exactly the wrong conclusion,
which is that `qwen2.5:7b` is the best model here because it wins the race.

**Run it only when asked.** Benchmarking loads every declared model in turn —
about 40GB of paging on this machine — and takes minutes. A benchmark that fires
on page render would make the hub unusable. Explicit button, progress shown,
results cached in state with their timestamp, and a visible "measured 3 days ago"
so a stale number is never mistaken for a fresh one.

### 2f. Ask what each cloud agent costs, and save it

Local models cost electricity. Cloud models cost money, and the hub cannot know
the rate — it changes, it differs per account, and a wrong number here is worse
than none.

**Ask. Never seed a price** (rule 8: seed structure, never values). Ship the
fields empty with a prompt, exactly as the catalogue does for labor rates.

Stored in **state**, not in `runners.json`. `runners.json` declares *what a model
is* and is meant to be shared or shipped; a price is *what it costs this org*
and belongs beside their own data.

```json
"pricing": {
  "glm": {
    "currency": "USD",
    "per_mtok_input":  null,
    "per_mtok_output": null,
    "per_mtok_cache_read": null,
    "as_of": null
  }
}
```

- **`per_mtok_cache_read` is the field that matters.** 98.6% of this project's
  spend is cache reads (rule G1). A pricing model that only tracks input and
  output will understate real cost by roughly two orders of magnitude.
- **`as_of` is required once a price is entered.** Prices change. Show
  "entered 4 months ago" beside the figure — a stale price presented as current
  is the same failure as a stale rule.
- **A blank is not a zero** (rule 5). A runner with no price entered renders as
  **"price not set"**, never as `$0.00`. A cost tool that silently reports paid
  cloud work as free is worse than no cost tool. Refuse to total a column that
  contains an unpriced runner; say which runner is missing instead.
- Local runners render as **"no API cost"**, not `$0.00`. They are not free —
  they cost time and electricity — and the hub should not imply otherwise.

**Capture the tokens each task actually spends.** The bus currently throws this
away: `askOllama` reads `response` and discards `prompt_eval_count` and
`eval_count`, which ollama already returns. Record them on the finished task
(`tokens_in`, `tokens_out`) so cost is measured rather than estimated. If a
runner returns no counts, store `null` — do not infer from string length.

**Extend `context-cost.mjs`** to report money alongside tokens, and keep the two
streams separate. They are not the same spend:

- **Claude Code sessions** — the transcripts the analyser already reads, billed
  by Anthropic.
- **Runner tasks** — work the bus dispatched to GLM or a local model.

Totalling them into one number would hide which one is actually expensive, which
is the whole point of the tool.

This is also the screen that sells it. A buyer sees, on their own machine: what
each agent costs, what it has spent, and which work went local for free.

---

## Stage 3 — Scopes

A scope is a goal with a definition of done, and tasks belong to it.

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

Tasks gain `scope` (the heading slug). The hub lists each scope with its
`done_when` lines, the tasks under it, and how many remain — the "what still
needs doing to reach the goal" view.

A task with no scope shows under **Unscoped**. Do not invent a scope for it.

---

## Stage 4 — Projects. DEFERRED, do not build yet.

Recorded so the shape is known, not scheduled. There is one actively worked
project; a registry for it is building for a customer who does not exist yet.
Revisit when there is a second project in real use, or when a buyer asks.

When it happens: **state stays per repository.** Do not move it and do not merge
several repos into one state file — every worktree, CLI call and MCP client
depends on `stateDir()` resolving the way it does. Add a registry *above* the
repo at `~/.agent-bus/projects.json` (`{ id, name, path }`), make `/` a project
list and `/p/<id>` the project page, and read other projects' state read-only by
joining `<path>/.git/agent-bus/state.json`. Writing into another project's state
needs that project's lock; read-only and honest beats writable and racy.

---

## Gates, for every stage

`tsc --noEmit`, `eslint`, a real `next build`, and `node tools/agent-bus/server.mjs board`
plus `cost` still running afterwards. The bus starting is not optional — if it
throws, every Claude session in this repo loses its tool list.

Report on the bus with `note`. Open a PR per stage. Do not merge.
