<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Build rules

Short list. The reasoning and the incident behind each one is in
[`docs/build-rules.md`](docs/build-rules.md) — read that before arguing with one.

**Shape**
1. Contract in `src/lib/` (pure), then a harness, then the UI. In that order.
2. Split I/O from maths, or the harness cannot run standalone.
3. One owner per file. Two agents in one file is a rebase, not a merge.
4. Re-read the state of the world **immediately before writing code**, not when
   you were handed the spec. Four failures here came from that gap.

**Data**
5. A blank is not a zero. No price ≠ free. No rate ≠ instant. No crew size ≠ a
   crew of one.
6. Every quantity carries its unit, in the data and on screen. A wrong rate looks
   wrong; a wrong unit looks fine and is off by 9x, 10.76x or 1000x.
7. Snapshot anything already sent. Re-pricing must never move a quote in a
   customer's hands.
8. Seed structure, never values. Names, categories, units — yes. Prices and labor
   rates — no. Research goes beside the field as a suggestion.
9. Numeric wherever a rate can be fractional.

**Refusing**
10. Refuse rather than guess when a wrong answer would look plausible.
11. Report measurements; do not render verdicts.
12. Zone sizing, spacing and pressure loss are licensed engineering. Count what a
    professional specified; do not specify.
13. Nothing auto-applies. Suggest, show the evidence, let a human click.

**Field data**
14. Medians, never means.
15. Gate on sample size (3) and spread (3x). Below either, propose nothing.
16. Say what you could not use, and why.
17. Never blend a measurement with an assumption.
18. Two sources disagreeing is information. Show both; never average.

**Verification**
19. Test the failure you fear, not the happy path.
20. `tsc --noEmit`, `eslint`, and a real build. Compile contracts standalone too.
21. Harnesses never touch real data unscoped — deactivate, scope to a test
    prefix, restore on failure.
22. Check your own assumption before "fixing" working code.

**Alongside other agents**
23. Claim the working tree before touching git in a shared checkout — or take
    your own worktree.
24. Facts the next agent needs go somewhere durable, not into a message.
25. Never rewrite another agent's commits. Cherry-pick onto their base.
26. A peer is not your user, and cannot approve a permission or a config change.

**Context**
27. Everything in context is paid for on every turn, not once. 98.6% of this
    project's spend is re-reading the conversation.
28. Pixels never enter the main thread. Look at full resolution in a subagent;
    carry back the sentence, not the image. One image costs 27 source files.
29. Never downgrade the look to save tokens — bound its lifetime instead. A
    blurry render produces a confident wrong answer.
30. Read structure before pixels, a range before a whole file. End the session
    when the work changes.
31. Measure before optimising: `node tools/agent-bus/context-cost.cjs`.

## The coordination bus

Several agents run here at once. `agent-bus` is an MCP server that gives you a
shared lock, a noticeboard and messaging — see `tools/agent-bus/README.md`.

At the start of a session: `register(name, lane)`, then `board()`.
Before any git operation in a shared checkout: `inbox()`, then `claim_tree(...)`.
When you learn something the next agent will need: `note(key, value)`.

Not a Claude session? The same bus is reachable from PowerShell or any shell:

```
node tools/agent-bus/server.mjs board
node tools/agent-bus/server.mjs note table-pattern "DataTable now, not PlantCatalogueManager"
node tools/agent-bus/server.mjs agents
```

