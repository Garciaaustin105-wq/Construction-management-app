# agent-bus

A shared lock, a noticeboard and messaging for the agents working in this repo.

Several Claude sessions and a local GLM run here at once, across a shared
checkout and thirteen worktrees. Two things kept going wrong, and neither was
fixable by talking more:

1. **Two sessions used the same working tree** and switched branches under each
   other mid-edit.
2. **A lane spec went stale between being written and being read — four times.**
   Nobody was talking at the moment each fact went stale, so no message could
   have caught them. The fact has to outlive the conversation.

So this is a lock plus a noticeboard, with messaging as the smaller third
feature. It is an MCP server rather than a documented file convention because a
tool in the tool list gets used and a convention in a README gets skipped —
which is the same lesson that produced rule A4 in
[`docs/build-rules.md`](../../docs/build-rules.md).

## Which AI is connected right now

```
node tools/agent-bus/server.mjs status
```

One screen: who is on the bus and how long since each was heard from, who holds
the working tree and until when, and what the board is carrying. `agents` and
`board` each answer half of that, and needing both is what made the bus
confusing to look at.

"Last seen" is real rather than a guess — every bus call refreshes it, and an
agent an hour cold is dropped so its name frees up for a restarted session.


## Using it from a Claude session

Configured in `.mcp.json`, so it loads automatically. **MCP config is read at
session start** — a session already running when this landed will not see it
until it restarts.

At the start of a session:

```
register(name: "lane-d", lane: "components UI")
board()
```

Before any git operation in a shared checkout:

```
inbox()
claim_tree(path: "C:/Users/.../lowvoltage-app", reason: "rebase onto origin")
   ... do the work ...
release_tree()
```

When you learn something the next agent will need:

```
note(key: "table-pattern", value: "DataTable now, not PlantCatalogueManager")
```

**Messages are conversation; the board is for facts.** A message only reaches
agents who were registered when it was sent — deliberately, so a newcomer does
not inherit a backlog. Anything that must reach whoever comes next goes on the
board.

## Using it from PowerShell, GLM or any script

Not everything here speaks MCP. GLM runs locally through ollama and can execute
files, so it joins the same bus through the CLI:

```powershell
node tools/agent-bus/server.mjs board
node tools/agent-bus/server.mjs agents
node tools/agent-bus/server.mjs note table-pattern "DataTable now, not PlantCatalogueManager"
node tools/agent-bus/server.mjs send lane-d "rebase before you commit"
node tools/agent-bus/server.mjs inbox glm
node tools/agent-bus/server.mjs claim glm "C:/Users/.../lowvoltage-app" "running a build"
node tools/agent-bus/server.mjs release glm
```

Set `AGENT_BUS_NAME` to avoid passing a name each time.

## The tools

| Tool | Purpose |
|---|---|
| `register(name, lane)` | Claim a name. Do this first. |
| `agents()` | Who is active, and who holds the tree. |
| `claim_tree(path, reason, minutes)` | Exclusive claim. Refuses and names the holder. |
| `release_tree()` | Give it back. Do not hold it while idle. |
| `send(to, message)` | To a name, or `"all"`. |
| `inbox(include_read?)` | Your messages; marks them read. |
| `note(key, value)` | Post a durable fact, overwritable by key. |
| `board()` | Every fact, newest first. |

## How it works, and the two decisions that matter

**State lives in the git common dir.** Every worktree has its own working
directory, so a relative path would give thirteen separate buses — worse than
none. `git rev-parse --git-common-dir` resolves to the *main* repo's `.git` from
inside any worktree, so all agents agree on one location without configuring
anything. State is at `<git-common-dir>/agent-bus/state.json`, which is inside
`.git` and therefore never committed.

**A claim is released by process death, not by a timer.** `kill(pid, 0)` sends
no signal — it asks the OS whether the holding process still exists. One server
process is spawned per session, so the process *is* the session. This is exact
where a heartbeat would be a guess: a crashed agent and a busy one look
identical from outside, so anything purely time-based either deadlocks on a
crash or steals the tree from an agent that is mid-rebase. The TTL remains as a
courtesy cap.

CLI claims are the exception and carry no pid — a shell process exits the
instant it finishes, so recording its pid would make every CLI claim look
abandoned. Those fall back to the TTL.

No dependencies: raw JSON-RPC over stdio, so installing it never touches
`package.json`.

## Tests

```
node tools/agent-bus/e2e-agent-bus.mjs
```

50 assertions. It spawns **two real server processes** and races them for the
same lock, because the failure being prevented is a race and a single-process
test cannot see one. That test immediately found a crashed session deadlocking
every other agent, and the CLI smoke test found shell claims being stolen — both
defects in the first draft.

State is isolated to a temp directory per run; it never touches the real bus.
