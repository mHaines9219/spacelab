# Spacelab

[PLAN.md](PLAN.md) is the north star: architecture, milestones, and the reasoning behind
both. Read it before proposing structural changes. [README.md](README.md) covers setup and
the two rules that shape the codebase.

## Every PR updates the plan

Before opening a PR, update the **Where we are** section of `PLAN.md`:

1. Flip the milestone table if a milestone's state changed.
2. Add a dated entry at the top of the log: what the PR accomplished, and what remains.
3. Carry unresolved items forward from the previous entry instead of dropping them.

"Remains" is the load-bearing half. It is how deferred work stays visible rather than
resurfacing as a surprise three milestones later, so record the awkward leftovers —
untested platforms, unvalidated bets, shortcuts taken — not just the tidy next steps.

## Scope discipline

The wedge is laying out one room. `PLAN.md` has a **Deliberately deferred** list; the
default answer to general 3D modeling features is no. If a change pulls toward mesh
editing, curved architecture, or multi-floor buildings, say so in the PR rather than
absorbing it quietly.
