"""Assemble the final per-unit content store for BIOL 1592.

For each PPT unit (Units 1–17), combine:
  - PPT slides + speaker notes (content/units/unit-XX.pptx.json)
  - Matched Pressbooks chapter from anatomy-i (auto-matched on "Unit N: ...")
  - Unit-specific key terms (from content/terms.json)
  - Whole-course exam style anchor (content/exam_style.json) — same for all units

Output:
  content/units/unit-XX.json — the assembled per-unit blob the server reads.
  content/unit-mapping.yaml  — auto-generated mapping table for the prof to review.

This script is idempotent. Re-run after any of the upstream extractors change.

Unit 0 (Intro) is excluded — there's no matching textbook chapter and the prof
spec doesn't list it as a study target.
"""

from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTENT = ROOT / "content"
UNITS_DIR = CONTENT / "units"
TEXTBOOK_INDEX = CONTENT / "textbooks" / "anatomy-i" / "index.json"
TEXTBOOK_DIR = CONTENT / "textbooks" / "anatomy-i"
TERMS = CONTENT / "terms.json"
EXAM = CONTENT / "exam_style.json"
STUDY_GUIDES = CONTENT / "study_guides.json"

OUT_MAPPING = CONTENT / "unit-mapping.yaml"


def slides_to_markdown(slides: list[dict]) -> str:
    """Render the slide list as readable Markdown with speaker notes inline."""
    parts: list[str] = []
    for s in slides:
        head = s.get("title") or f"Slide {s['slide_no']}"
        parts.append(f"### Slide {s['slide_no']}: {head}")
        if s.get("body"):
            parts.append(s["body"])
        notes = s.get("notes", "").strip()
        if notes:
            # Indent notes block so they're visibly distinct from slide body.
            parts.append("> Speaker notes:\n> " + notes.replace("\n", "\n> "))
        parts.append("")
    return "\n".join(parts).strip()


def main() -> int:
    # Load shared inputs
    if not TERMS.exists():
        print(f"Missing {TERMS} — run extract_xlsx_terms.py first", file=sys.stderr)
        return 1
    if not EXAM.exists():
        print(f"Missing {EXAM} — run extract_exam_docx.py first", file=sys.stderr)
        return 1
    if not TEXTBOOK_INDEX.exists():
        print(f"Missing {TEXTBOOK_INDEX} — run fetch_pressbooks.py first", file=sys.stderr)
        return 1

    terms = json.load(TERMS.open())
    exam = json.load(EXAM.open())
    tb_index = json.load(TEXTBOOK_INDEX.open())

    # Instructor study guides are optional — warn but don't fail if absent
    # (run extract_study_guides.py to (re)generate). Maps unit_no -> [prompts].
    study_guides: dict[str, list[str]] = {}
    if STUDY_GUIDES.exists():
        study_guides = json.load(STUDY_GUIDES.open()).get("units", {})
    else:
        print(
            f"Note: {STUDY_GUIDES.name} not found — units will have an empty "
            "study_guide list. Run extract_study_guides.py first.",
            file=sys.stderr,
        )

    # Map unit_no -> chapter index entry
    chapter_by_unit: dict[int, dict] = {
        ch["unit_no"]: ch for ch in tb_index["chapters"] if ch.get("unit_no") is not None
    }

    # Walk PPT extracts in order, skip unit 00 (Intro).
    pptx_files = sorted(UNITS_DIR.glob("unit-*.pptx.json"))
    if not pptx_files:
        print("No unit-*.pptx.json found — run extract_pptx.py first", file=sys.stderr)
        return 1

    mapping_rows: list[str] = []
    assembled = 0

    for pp in pptx_files:
        ppt = json.load(pp.open())
        unit_no = ppt["unit_id"]
        if unit_no == 0:
            continue

        chapter_meta = chapter_by_unit.get(unit_no)
        chapter_text = ""
        chapter_title = ""
        chapter_url = None
        if chapter_meta is not None:
            chap_path = TEXTBOOK_DIR / f"chapter-{chapter_meta['id']}.json"
            if chap_path.exists():
                chap = json.load(chap_path.open())
                chapter_text = chap.get("text", "")
                chapter_title = html.unescape(chap.get("title", "") or "")
                chapter_url = chap.get("source_url")

        unit_terms = terms["units"].get(str(unit_no), [])
        unit_study_guide = study_guides.get(str(unit_no), [])
        slides_md = slides_to_markdown(ppt["slides"])

        body_chars = sum(len(s["body"]) for s in ppt["slides"])
        notes_chars = sum(len(s["notes"]) for s in ppt["slides"])

        out = {
            "course": "BIOL 1592",
            "unit_no": unit_no,
            "ppt_title": ppt["title"],
            "ppt_source_file": ppt["source_file"],
            "ppt_slide_count": ppt["slide_count"],
            "ppt_markdown": slides_md,
            "ppt_metrics": {"body_chars": body_chars, "notes_chars": notes_chars},
            "textbook": {
                "title": chapter_title,
                "url": chapter_url,
                "chars": len(chapter_text),
                "markdown": chapter_text,
            } if chapter_meta else None,
            "terms": unit_terms,
            "study_guide": unit_study_guide,
            "exam_style_ref": "see content/exam_style.json — shared style anchor across units",
        }

        out_path = UNITS_DIR / f"unit-{unit_no:02d}.json"
        with out_path.open("w", encoding="utf-8") as fp:
            json.dump(out, fp, ensure_ascii=False, indent=2)

        # Total grounding budget for this unit (for prompt-caching planning)
        total = body_chars + notes_chars + len(chapter_text)
        tag = "OK" if chapter_meta else "NO-TB"
        mapping_rows.append(
            f"  - unit_no: {unit_no}\n"
            f"    ppt_title: {ppt['title']!r}\n"
            f"    textbook_title: {chapter_title!r}\n"
            f"    textbook_url: {chapter_url!r}\n"
            f"    terms_count: {len(unit_terms)}\n"
            f"    chars_total: {total}\n"
        )
        print(
            f"  {tag:>5}  unit {unit_no:02d}  "
            f"ppt={body_chars+notes_chars:>6}c  tb={len(chapter_text):>6}c  "
            f"terms={len(unit_terms):>3}  sg={len(unit_study_guide):>2}  → {out_path.name}"
        )
        assembled += 1

    OUT_MAPPING.write_text(
        "# Auto-generated mapping table — review with the professor.\n"
        "# Each unit pairs the PPT with the matched Pressbooks A&P I chapter.\n"
        f"# Source: build_units.py against {TEXTBOOK_INDEX.relative_to(ROOT)}\n\n"
        "mapping:\n" + "".join(mapping_rows),
        encoding="utf-8",
    )

    print(f"\nAssembled {assembled} unit(s). Mapping at {OUT_MAPPING.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
