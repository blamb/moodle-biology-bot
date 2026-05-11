"""Fetch chapters from the TRU Pressbooks open textbooks via the v2 REST API.

Books:
  human-anatomy-i.pressbooks.tru.ca   — Units 1–17 (A&P I, for BIOL 1592)
  human-anatomy-ii.pressbooks.tru.ca  — Units 1–12 (A&P II, for BIOL 1692)

Endpoints:
  /wp-json/pressbooks/v2/toc                   list parts/chapters/front-/back-matter
  /wp-json/pressbooks/v2/chapters/{id}         single chapter with content.rendered HTML

Output:
  content/textbooks/<book-slug>/index.json     [{ id, title, slug, url, unit_no? }]
  content/textbooks/<book-slug>/chapter-<id>.json
      { id, title, source_url, fetched_at, text }
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup, NavigableString

ROOT = Path(__file__).resolve().parents[2]
OUT_BASE = ROOT / "content" / "textbooks"

BOOKS = [
    {
        "slug": "anatomy-i",
        "course": "BIOL 1592",
        "base": "https://human-anatomy-i.pressbooks.tru.ca",
    },
    {
        "slug": "anatomy-ii",
        "course": "BIOL 1692",
        "base": "https://human-anatomy-ii.pressbooks.tru.ca",
    },
]

UNIT_TITLE_RE = re.compile(r"^Unit\s+(\d+)\s*:\s*(.+)$", re.IGNORECASE)

HEADERS = {"User-Agent": "moodle-biology-bot/0.0.1 (TRU; +mailto:brian.lamb@gmail.com)"}


def fetch_json(url: str, *, retries: int = 3, backoff: float = 1.5) -> dict | list:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(backoff ** attempt)
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def html_to_text(html: str) -> str:
    """Convert chapter HTML to a plain-text representation suitable for LLM grounding.

    Preserves heading hierarchy as Markdown headings, keeps list bullets, drops
    images/captions/figure markup, and collapses whitespace.
    """
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    for tag in soup.find_all(["figure", "figcaption"]):
        tag.decompose()
    for tag in soup.find_all("img"):
        # Keep alt text inline if it carries info, drop the image element.
        alt = tag.get("alt", "").strip()
        if alt:
            tag.replace_with(NavigableString(f"[image: {alt}]"))
        else:
            tag.decompose()

    # Walk in document order, emitting Markdown-ish text.
    out_parts: list[str] = []
    for el in soup.descendants:
        if not getattr(el, "name", None):
            continue
        name = el.name.lower()
        if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            level = int(name[1])
            text = el.get_text(" ", strip=True)
            if text:
                out_parts.append("\n" + ("#" * level) + " " + text + "\n")
            # mark children consumed by clearing element's text role
            for sub in el.find_all(recursive=True):
                sub.clear()
        elif name == "p":
            text = el.get_text(" ", strip=True)
            if text:
                out_parts.append(text + "\n")
        elif name == "li":
            text = el.get_text(" ", strip=True)
            if text:
                out_parts.append("- " + text + "\n")
        elif name in {"blockquote"}:
            text = el.get_text(" ", strip=True)
            if text:
                out_parts.append("> " + text + "\n")

    text = "\n".join(out_parts)
    # Collapse 3+ blank lines to 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_unit_no(title: str) -> int | None:
    m = UNIT_TITLE_RE.match(title.strip())
    return int(m.group(1)) if m else None


def _title_str(t) -> str:
    """Pressbooks returns title as either a plain string (TOC) or {raw,rendered} (single endpoint)."""
    if isinstance(t, dict):
        return t.get("rendered") or t.get("raw") or ""
    return t or ""


def flatten_toc(toc: dict) -> list[dict]:
    """Pull chapter entries (only — not front/back matter) out of a TOC payload."""
    chapters: list[dict] = []
    for part in toc.get("parts", []):
        part_title = _title_str(part.get("title"))
        for ch in part.get("chapters", []):
            chapters.append({
                "id": ch["id"],
                "title": _title_str(ch.get("title")),
                "slug": ch.get("slug"),
                "url": ch.get("link"),
                "part": part_title,
                "word_count": ch.get("word_count"),
            })
    return chapters


def main() -> int:
    OUT_BASE.mkdir(parents=True, exist_ok=True)

    for book in BOOKS:
        out_dir = OUT_BASE / book["slug"]
        out_dir.mkdir(parents=True, exist_ok=True)

        print(f"\n=== {book['slug']}  ({book['course']}) ===")
        toc_url = book["base"] + "/wp-json/pressbooks/v2/toc"
        try:
            toc = fetch_json(toc_url)
        except Exception as e:
            print(f"  FAIL  TOC: {e}", file=sys.stderr)
            continue

        chapters = flatten_toc(toc)
        index = []
        for ch in chapters:
            ch["unit_no"] = parse_unit_no(ch["title"])
            index.append(ch)
            chap_path = out_dir / f"chapter-{ch['id']}.json"
            if chap_path.exists():
                print(f"  skip  ch {ch['id']:>4}  {ch['title'][:60]}  (cached)")
                continue
            chap_url = book["base"] + f"/wp-json/pressbooks/v2/chapters/{ch['id']}"
            try:
                payload = fetch_json(chap_url)
            except Exception as e:
                print(f"  FAIL  ch {ch['id']}: {e}", file=sys.stderr)
                continue
            html = (payload.get("content") or {}).get("rendered", "")
            # Prefer the title from the single-chapter payload (authoritative).
            title = _title_str(payload.get("title")) or ch["title"]
            text = html_to_text(html)
            data = {
                "id": ch["id"],
                "title": title,
                "slug": ch["slug"],
                "source_url": ch["url"],
                "unit_no": ch["unit_no"],
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "text": text,
            }
            with chap_path.open("w", encoding="utf-8") as fp:
                json.dump(data, fp, ensure_ascii=False, indent=2)
            print(f"  OK    ch {ch['id']:>4}  unit={str(ch['unit_no']):>3}  {len(text):>6}c  {ch['title'][:50]}")

        idx_path = out_dir / "index.json"
        with idx_path.open("w", encoding="utf-8") as fp:
            json.dump({
                "book": book["slug"],
                "course": book["course"],
                "base_url": book["base"],
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "chapters": index,
            }, fp, ensure_ascii=False, indent=2)
        print(f"  → {idx_path.relative_to(ROOT)}  ({len(index)} chapters)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
