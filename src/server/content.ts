/**
 * Reads the per-unit content blobs produced by scripts/ingest/build_units.py.
 *
 * Files live at `content/units/unit-NN.json` (gitignored, baked at deploy time).
 * Cached in memory because they're stable — re-run ingestion to refresh.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNITS_DIR = join(ROOT, 'content', 'units');

export interface UnitContent {
  course: string;
  unit_no: number;
  ppt_title: string;
  ppt_source_file: string;
  ppt_slide_count: number;
  ppt_markdown: string;
  ppt_metrics: { body_chars: number; notes_chars: number };
  textbook: {
    title: string;
    url: string | null;
    chars: number;
    markdown: string;
  } | null;
  terms: string[];
}

const cache = new Map<number, UnitContent>();

export function getUnit(unitNo: number): UnitContent {
  const hit = cache.get(unitNo);
  if (hit) return hit;
  const file = join(UNITS_DIR, `unit-${String(unitNo).padStart(2, '0')}.json`);
  const data: UnitContent = JSON.parse(readFileSync(file, 'utf8'));
  cache.set(unitNo, data);
  return data;
}

export interface UnitSummary {
  unit_no: number;
  title: string;
  terms_count: number;
  has_textbook: boolean;
  total_chars: number;
}

let summariesCache: UnitSummary[] | null = null;

export function listUnits(): UnitSummary[] {
  if (summariesCache) return summariesCache;
  const files = readdirSync(UNITS_DIR)
    .filter((f) => /^unit-\d{2}\.json$/.test(f))
    .sort();
  summariesCache = files.map((f) => {
    const u: UnitContent = JSON.parse(readFileSync(join(UNITS_DIR, f), 'utf8'));
    return {
      unit_no: u.unit_no,
      title: u.ppt_title,
      terms_count: u.terms.length,
      has_textbook: u.textbook !== null,
      total_chars:
        u.ppt_metrics.body_chars + u.ppt_metrics.notes_chars + (u.textbook?.chars ?? 0),
    };
  });
  return summariesCache;
}
