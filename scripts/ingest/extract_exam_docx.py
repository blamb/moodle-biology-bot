"""Extract structured questions from the BIOL 1592 example exam DOCX.

Two source files exist; we read the **Answer Key** version because it carries
the correct-answer signals:
  - MC and TF correct answers are runs colored blue (#0432FF). Anything that is
    not the default black/auto colour is treated as 'correct'.
  - FITB and Free Response answers follow their question on subsequent lines.

Output: content/exam_style.json — a structured representation of the example
exam, used downstream as a style/voice anchor when generating new questions.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import docx
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "materials" / "BIOL1592 Example Exam Questions - Answer Key.docx"
OUT = ROOT / "content" / "exam_style.json"

SECTION_HEADERS = {
    "multiple choice": "multiple_choice",
    "true or false": "true_false",
    "fill in the blank": "fill_in_blank",
    "free response": "free_response",
}

# Word's "auto" / black / unset values that mean "not specially highlighted"
NEUTRAL_COLORS = {None, "auto", "000000"}


def run_color(run) -> str | None:
    """Return the run's text-color hex (uppercase) or None for default."""
    rPr = run._r.find(qn("w:rPr"))
    if rPr is None:
        return None
    c = rPr.find(qn("w:color"))
    if c is None:
        return None
    val = c.get(qn("w:val"))
    return val.upper() if val else None


def paragraph_is_highlighted(para) -> bool:
    """True if *any* run in the paragraph carries a non-neutral text color."""
    for r in para.runs:
        col = run_color(r)
        if col is not None and col.lower() not in NEUTRAL_COLORS:
            return True
    return False


def detect_section(text: str) -> str | None:
    norm = re.sub(r"[^a-z]+", " ", text.lower()).strip()
    for header, key in SECTION_HEADERS.items():
        if norm.startswith(header):
            return key
    return None


def parse_marks(text: str) -> int:
    m = re.search(r"(\d+)\s*marks?", text.lower())
    return int(m.group(1)) if m else 0


def main() -> int:
    if not SRC.exists():
        print(f"Not found: {SRC}", file=sys.stderr)
        return 1

    d = docx.Document(SRC)
    # Walk through paragraphs (skipping empties) and split into sections.
    paras = [(i, p) for i, p in enumerate(d.paragraphs) if p.text.strip()]

    out: dict = {
        "course": "BIOL 1592",
        "source": str(SRC.relative_to(ROOT)),
        "note": (
            "Worked example exam used as a style and difficulty anchor for "
            "AI-generated questions. Correct answers extracted from blue-text "
            "highlighting in the answer-key DOCX."
        ),
        "sections": {
            "multiple_choice": [],
            "true_false": [],
            "fill_in_blank": [],
            "free_response": [],
        },
    }

    current: str | None = None
    i = 0
    while i < len(paras):
        _, p = paras[i]
        text = p.text.strip()

        sec = detect_section(text)
        if sec is not None:
            current = sec
            i += 1
            continue

        if current is None:
            # Pre-amble paragraph before first section header
            i += 1
            continue

        if current == "multiple_choice":
            stem = text
            options: list[str] = []
            correct_idx: list[int] = []
            j = i + 1
            # Collect option lines until the next stem (heuristic: next stem ends
            # with ':' or starts a section). We accept up to 6 options.
            while j < len(paras) and len(options) < 6:
                _, op = paras[j]
                op_text = op.text.strip()
                if detect_section(op_text) is not None:
                    break
                # A new stem usually ends with ':' OR is a sentence ending '.' that
                # is followed by lines that themselves end with '.' or ':' --
                # heuristic enough.
                if op_text.endswith(":") and len(options) >= 2:
                    break
                # Heuristic: if we've collected at least 4 options and the next
                # paragraph looks like a question (longer + ends with ':' or '?'),
                # stop. We've already covered ':' above.
                if op_text.endswith("?") and len(options) >= 2:
                    break
                options.append(op_text)
                if paragraph_is_highlighted(op):
                    correct_idx.append(len(options) - 1)
                j += 1
            out["sections"]["multiple_choice"].append({
                "stem": stem,
                "options": options,
                "correct_index": correct_idx,
            })
            i = j
            continue

        if current == "true_false":
            # Pattern: stem, "true", "false"
            stem = text
            if i + 2 < len(paras):
                _, p_true = paras[i + 1]
                _, p_false = paras[i + 2]
                if p_true.text.strip().lower() == "true" and p_false.text.strip().lower() == "false":
                    correct: bool | None = None
                    if paragraph_is_highlighted(p_true):
                        correct = True
                    elif paragraph_is_highlighted(p_false):
                        correct = False
                    out["sections"]["true_false"].append({
                        "stem": stem,
                        "correct": correct,
                    })
                    i += 3
                    continue
            # Fallback: skip orphan
            i += 1
            continue

        if current == "fill_in_blank":
            stem = text
            answer = ""
            j = i + 1
            # Answer is the next paragraph if it doesn't itself contain a blank.
            if j < len(paras):
                _, p_ans = paras[j]
                ans_text = p_ans.text.strip()
                if "___" not in ans_text and detect_section(ans_text) is None:
                    answer = ans_text
                    j += 1
            out["sections"]["fill_in_blank"].append({
                "stem": stem,
                "answer": answer,
            })
            i = j
            continue

        if current == "free_response":
            # First paragraph in this section is an instruction sentence ("Answer
            # each of the following questions..."). Skip if it doesn't look like
            # a question stem itself. Heuristic: a real question prompt is a
            # single line we treat as the stem; everything until the next prompt
            # is the model answer.
            if text.lower().startswith("free response") or text.lower().startswith("answer each"):
                i += 1
                continue
            prompt = text
            marks = parse_marks(prompt) or 5  # prof says 5 marks per Q
            j = i + 1
            answer_lines: list[str] = []
            while j < len(paras):
                _, q = paras[j]
                qt = q.text.strip()
                if detect_section(qt) is not None:
                    break
                # New free-response prompt heuristic: starts with a capital verb
                # imperative AND is the only sentence on the line AND doesn't
                # start with words like "Both", "They", "Also" etc. Cheap
                # heuristic: if a line ends with '?' or starts with verbs like
                # "Compare", "Describe", "Explain", "Discuss", "List".
                imperative = re.match(
                    r"^(Compare|Contrast|Describe|Explain|Discuss|List|Identify|"
                    r"State|Define|Outline|Summarize|Summarise|Why|How|What)\b",
                    qt,
                )
                if imperative and answer_lines:
                    break
                answer_lines.append(qt)
                j += 1
            out["sections"]["free_response"].append({
                "prompt": prompt,
                "marks": marks,
                "model_answer": "\n".join(answer_lines).strip(),
            })
            i = j
            continue

        i += 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)

    s = out["sections"]
    print(f"  MC  : {len(s['multiple_choice'])} questions  ({sum(1 for q in s['multiple_choice'] if q['correct_index'])} with answer)")
    print(f"  TF  : {len(s['true_false'])} questions  ({sum(1 for q in s['true_false'] if q['correct'] is not None)} with answer)")
    print(f"  FITB: {len(s['fill_in_blank'])} questions  ({sum(1 for q in s['fill_in_blank'] if q['answer'])} with answer)")
    print(f"  FR  : {len(s['free_response'])} prompts   ({sum(1 for q in s['free_response'] if q['model_answer'])} with model)")
    print(f"\n→ {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
