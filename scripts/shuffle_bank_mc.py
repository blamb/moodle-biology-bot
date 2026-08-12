#!/usr/bin/env python3
"""
One-time (idempotent) fix for MC answer-position skew in the question bank.

The generator placed most correct answers at position A/B (instructor feedback,
Aug 11: the neural-signalling unit showed 29/30 correct answers at "A"). This
script re-shuffles every MC question's options so correct answers are evenly
distributed across A–E within each (unit, level) set, then rewrites the
"(A)"…"(E)" letter references inside each explanation to match the new order.

Deterministic: seeded per (unit, level), so re-running produces the same bank.

Usage:  python3 scripts/shuffle_bank_mc.py [--check]
        --check  report the current distribution without writing anything
"""

import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

BANK_DIR = Path(__file__).resolve().parent.parent / "content" / "question-bank"

LETTER_TOKEN = re.compile(r"\(([A-E])\)")
BULLET = re.compile(r"^- \*\*\([A-E]\)\*\*", re.M)


def remap_explanation(explanation: str, old_to_new: dict[int, int]) -> str:
    """Rewrite (X) letter tokens per the permutation, then re-sort the
    'Why the other options are wrong' bullets into the new letter order."""
    # Two-pass replace via placeholders so A->C and C->A can't collide.
    def to_placeholder(m: re.Match) -> str:
        old_idx = ord(m.group(1)) - 65
        return f"(\x00{old_to_new[old_idx]}\x00)"

    text = LETTER_TOKEN.sub(to_placeholder, explanation)
    text = re.sub("\x00(\\d)\x00", lambda m: chr(65 + int(m.group(1))), text)

    # Re-sort the distractor bullet lines (each a single markdown line starting
    # "- **(X)**") so they read A→E again. Non-bullet lines keep their place.
    lines = text.split("\n")
    bullet_idxs = [i for i, ln in enumerate(lines) if BULLET.match(ln)]
    if len(bullet_idxs) >= 2:
        sorted_bullets = sorted((lines[i] for i in bullet_idxs), key=lambda ln: ln[5])
        for i, ln in zip(bullet_idxs, sorted_bullets):
            lines[i] = ln
    return "\n".join(lines)


def shuffle_unit(path: Path, check_only: bool) -> Counter:
    data = json.loads(path.read_text())
    dist: Counter = Counter()
    changed = False
    for level, banks in data["levels"].items():
        items = banks["mc"]
        rng = random.Random(f"bank-shuffle-v1:{data['unit_no']}:{level}")
        # Balanced targets: cycle A–E across the set, then shuffle the cycle.
        targets = [i % 5 for i in range(len(items))]
        rng.shuffle(targets)
        for item, target in zip(items, targets):
            q = item["question"]
            opts = q["options"]
            n = len(opts)
            target = min(target, n - 1)
            dist[target] += 1
            if check_only:
                dist[q["correct_index"]] += 0  # counted below in --check mode
                continue
            old_correct = q["correct_index"]
            distractors = [i for i in range(n) if i != old_correct]
            rng.shuffle(distractors)
            new_order = distractors[:target] + [old_correct] + distractors[target:]
            # new_order[new_pos] = old_idx  →  invert for letter remapping
            old_to_new = {old: new for new, old in enumerate(new_order)}
            if old_to_new[old_correct] != target:
                raise AssertionError(f"{item['id']}: permutation bug")
            q["options"] = [opts[old] for old in new_order]
            q["correct_index"] = target
            q["explanation"] = remap_explanation(q["explanation"], old_to_new)
            changed = True
    if changed and not check_only:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return dist


def main() -> None:
    check_only = "--check" in sys.argv
    grand = Counter()
    for path in sorted(BANK_DIR.glob("unit-*.json")):
        if check_only:
            data = json.loads(path.read_text())
            for level, banks in data["levels"].items():
                c = Counter(it["question"]["correct_index"] for it in banks["mc"])
                grand.update(c)
                print(f"{path.name} {level:8s} {dict(sorted(c.items()))}")
        else:
            grand.update(shuffle_unit(path, check_only=False))
            print(f"shuffled {path.name}")
    print("overall correct_index distribution:", dict(sorted(grand.items())))


if __name__ == "__main__":
    main()
