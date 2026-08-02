#!/usr/bin/env python3
"""Structural checks on PLAN.md's "Where we are" log.

Four PRs merged in one session and three-quarters of the log quietly vanished. Every PR
was green, every merge reported success, and nobody noticed until someone read the file.
CLAUDE.md calls "Remains" the load-bearing half — the record of what we still owe — and
it was the one thing no check covered.

These are structural checks only. They cannot tell whether an entry is *honest*; they
catch the mechanical ways the log gets damaged by concurrent merges resolving the same
block against a moving base.

Usage: check_plan.py <base-ref> [--post-merge]

It reads `git show HEAD:PLAN.md`, **not the working tree**. Run it on uncommitted edits and
it silently grades the previous commit and passes — a true answer about the wrong tree.
Commit first, then run it.
"""

import re
import subprocess
import sys
from collections import Counter

PLAN = "PLAN.md"
HEADING = re.compile(r"^### (.+)$")
# Changes to these are what oblige a PR to add a log entry. A PR touching only CI, docs
# or tests is exempt — the rule exists to record product work, not to tax housekeeping.
PRODUCT_PATHS = ("crates/", "web/src/", "web/scripts/", "ios/")


def sh(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def entries(text: str) -> dict[str, list[str]]:
    """Map each `### ` heading to the body lines beneath it, in file order."""
    found: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        m = HEADING.match(line)
        if m:
            current = m.group(1).strip()
            found[current] = []
        elif current is not None:
            found[current].append(line)
    return found


def fingerprint(body: list[str]) -> str:
    """The first substantive line of an entry — enough to tell two entries apart."""
    for line in body:
        stripped = line.strip().lstrip("-*# ").strip()
        # Skip the boilerplate that opens every entry.
        if len(stripped) > 30 and stripped.lower() not in ("**accomplished**", "**remains**"):
            return stripped[:120]
    return ""


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
    # `--post-merge` runs this against `main` after something has landed, comparing the
    # previous tip to the new one. It was the only line of defence back when the repo was
    # private and branch protection was unavailable; `PLAN.md log` is a required context
    # now, so the PR-side run does the blocking and this one is the backstop for anything
    # that reaches `main` another way. The "must add an entry" rule is skipped there: a
    # revert or a docs-only merge would trip it for no reason.
    post_merge = "--post-merge" in sys.argv
    problems: list[str] = []

    changed = sh("git", "diff", "--name-only", f"{base}...HEAD").split()
    head = entries(sh("git", "show", f"HEAD:{PLAN}"))
    old = entries(sh("git", "show", f"{base}:{PLAN}"))

    # 1. Nothing already written may disappear. This is the one that just failed four
    #    times: a stale base wins the merge and silently drops a teammate's entry.
    #
    #    A heading that changed while its body stayed put is a *rename*, not a loss, and
    #    treating the two alike made every heading permanent — including a wrong one. That
    #    is a real cost: this check exists to keep the log honest, so it must not be the
    #    reason a dishonest heading has to stay. Renames are allowed and printed, never
    #    silent. A rename that also rewrites the opening line still reads as a
    #    disappearance, which is the safe direction to fail in.
    by_body = {fp: h for h, b in head.items() if (fp := fingerprint(b))}
    renamed: list[tuple[str, str]] = []
    for lost in [h for h in old if h not in head]:
        fp = fingerprint(old[lost])
        if fp and fp in by_body:
            renamed.append((lost, by_body[fp]))
            continue
        problems.append(f"PLAN.md entry disappeared relative to {base}: '### {lost}'")

    # 2. Product work has to leave a trace in the log. A renamed heading is not a new
    #    entry and must not satisfy this — otherwise retitling something old would excuse
    #    a PR from recording what it did.
    touches_product = any(f.startswith(PRODUCT_PATHS) for f in changed)
    renames = {after for _, after in renamed}
    added = [h for h in head if h not in old and h not in renames]
    if touches_product and not added and not post_merge:
        problems.append(
            "This PR changes product code but adds no new '### ' entry to PLAN.md.\n"
            "    CLAUDE.md: 'Add a dated entry at the top of the log: what the PR\n"
            "    accomplished, and what remains.'"
        )

    # 3. Headings must be unique, or two entries claim the same work.
    for heading, n in Counter(HEADING.match(l).group(1).strip()
                              for l in sh("git", "show", f"HEAD:{PLAN}").splitlines()
                              if HEADING.match(l)).items():
        if n > 1:
            problems.append(f"PLAN.md has {n} entries titled '### {heading}'")

    # 4. Two entries must not share a body. A heading-presence check cannot see a
    #    heading/body mismatch — the damage that slipped past three reviewers was a
    #    surviving heading sitting above someone else's body text.
    seen: dict[str, str] = {}
    for heading, body in head.items():
        fp = fingerprint(body)
        if not fp:
            continue
        if fp in seen:
            problems.append(
                f"PLAN.md entries '### {seen[fp]}' and '### {heading}' share body text.\n"
                f"    Both begin: {fp[:80]}…\n"
                "    A heading almost certainly survived a merge above the wrong body."
            )
        seen[fp] = heading

    # 5. Every entry owes a Remains. That half is what keeps deferred work visible.
    for heading in added:
        if not any("remains" in l.lower() for l in head[heading]):
            problems.append(f"New PLAN.md entry '### {heading}' has no **Remains** section")

    if problems:
        print("PLAN.md log check failed:\n")
        for p in problems:
            print(f"  - {p}")
        return 1

    for before, after in renamed:
        print(f"PLAN.md entry renamed (body unchanged): '### {before}' → '### {after}'")
    print(f"PLAN.md log OK — {len(head)} entries, {len(added)} added in this PR")
    return 0


if __name__ == "__main__":
    sys.exit(main())
