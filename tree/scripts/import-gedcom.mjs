#!/usr/bin/env node
// Converts a GEDCOM export (e.g. from MyHeritage) into tree/data.json,
// the only data file the tree.vasylyna.net viewer reads.
//
//   node tree/scripts/import-gedcom.mjs ~/Downloads/export.ged
//
// Privacy: the repository is public, so the raw .ged file is never committed.
// For anyone born within the last PRIVATE_YEARS years (likely still alive —
// the export carries no death records) only the birth year is kept; the exact
// date and the place are dropped. Pass --full-dates to keep everything.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_YEARS = 100;
const ROOT = 'I1'; // the person the tree opens on and relations are counted from

const args = process.argv.slice(2);
const fullDates = args.includes('--full-dates');
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('Usage: node tree/scripts/import-gedcom.mjs <file.ged> [--full-dates]');
  process.exit(1);
}
const output = join(dirname(fileURLToPath(import.meta.url)), '..', 'data.json');

// --- Parse GEDCOM lines into a record tree -----------------------------------

const records = [];
const stack = [];
const text = readFileSync(input, 'utf8').replace(/^﻿/, '');
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$/);
  if (!m) continue;
  const level = Number(m[1]);
  const node = { xref: m[2], tag: m[3], value: m[4] ?? '', children: [] };
  if (level === 0) {
    records.push(node);
    stack.length = 0;
  } else {
    const parent = stack[level - 1];
    if (!parent) continue;
    if (node.tag === 'CONC') { parent.value += node.value; continue; }
    if (node.tag === 'CONT') { parent.value += '\n' + node.value; continue; }
    parent.children.push(node);
  }
  stack[level] = node;
  stack.length = level + 1;
}

const child = (node, ...path) => {
  for (const tag of path) {
    node = node?.children.find((c) => c.tag === tag);
  }
  return node;
};
const val = (node, ...path) => child(node, ...path)?.value.trim() || '';
const all = (node, tag) => node.children.filter((c) => c.tag === tag).map((c) => c.value.trim());
const id = (xref) => xref.replace(/@/g, '');

// --- Dates --------------------------------------------------------------------

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, '0');

// "13 JUN 1965" → "1965-06-13", "JUN 1965" → "1965-06", "ABT 1900" → "~1900",
// "BEF 1900" → "<1900", "AFT 1900" → ">1900", "BET 1900 AND 1910" → "1900..1910".
function parseDate(raw) {
  const s = raw.toUpperCase().trim();
  if (!s) return null;
  const between = s.match(/^BET\s+(.+?)\s+AND\s+(.+)$/);
  if (between) {
    const a = parseDate(between[1]);
    const b = parseDate(between[2]);
    return a && b ? `${a}..${b}` : a || b;
  }
  const qual = s.match(/^(ABT|EST|CAL|BEF|AFT)\s+(.*)$/);
  if (qual) {
    const inner = parseDate(qual[2]);
    if (!inner) return null;
    return ({ ABT: '~', EST: '~', CAL: '~', BEF: '<', AFT: '>' })[qual[1]] + inner;
  }
  const m = s.match(/^(?:(\d{1,2})\s+)?(?:([A-Z]{3})\s+)?(\d{3,4})$/);
  if (!m) return null;
  const [, day, mon, year] = m;
  const month = MONTHS[mon];
  if (month && day) return `${year}-${pad(month)}-${pad(day)}`;
  if (month) return `${year}-${pad(month)}`;
  return year;
}
const yearOf = (date) => Number(date?.match(/\d{3,4}/)?.[0]) || null;
const onlyYear = (date) => date.replace(/(\d{3,4})-\d{2}(-\d{2})?/g, '$1');

// --- Build people and families -------------------------------------------------

const cutoff = new Date().getFullYear() - PRIVATE_YEARS;
const people = [];
const families = [];
let hidden = 0;

for (const rec of records) {
  if (rec.tag === 'INDI') {
    const nameRec = child(rec, 'NAME');
    const raw = nameRec?.value ?? '';
    const given = (val(rec, 'NAME', 'GIVN') || raw.replace(/\/.*$/, '')).trim();
    const surname = (val(rec, 'NAME', 'SURN') || raw.match(/\/([^/]*)\//)?.[1] || '').trim();
    let birth = parseDate(val(rec, 'BIRT', 'DATE'));
    let place = val(rec, 'BIRT', 'PLAC');
    const year = yearOf(birth);
    if (!fullDates && year && year > cutoff) {
      if (birth !== onlyYear(birth) || place) hidden++;
      birth = onlyYear(birth);
      place = '';
    }
    const p = { id: id(rec.xref), g: given, s: surname, x: val(rec, 'SEX') || 'U' };
    if (birth) p.b = birth;
    if (place) p.p = place;
    const famc = all(rec, 'FAMC');
    if (famc.length) p.c = id(famc[0]);
    const fams = all(rec, 'FAMS');
    if (fams.length) p.f = fams.map(id);
    people.push(p);
  } else if (rec.tag === 'FAM') {
    const f = { id: id(rec.xref) };
    const h = val(rec, 'HUSB');
    const w = val(rec, 'WIFE');
    if (h) f.h = id(h);
    if (w) f.w = id(w);
    f.k = all(rec, 'CHIL').map(id);
    families.push(f);
  }
}

// Children in birth order (stable for undated ones).
const birthYear = new Map(people.map((p) => [p.id, yearOf(p.b)]));
for (const f of families) {
  f.k = f.k
    .map((c, i) => ({ c, i, y: birthYear.get(c) }))
    .sort((a, b) => (a.y && b.y ? a.y - b.y : 0) || a.i - b.i)
    .map((o) => o.c);
}

if (!people.some((p) => p.id === ROOT)) {
  console.error(`Root person ${ROOT} not found in ${input}`);
  process.exit(1);
}

const data = {
  root: ROOT,
  updated: new Date().toISOString().slice(0, 10),
  privateAfter: fullDates ? null : cutoff,
  people,
  families,
};
writeFileSync(output, JSON.stringify(data) + '\n');
console.log(
  `Wrote ${output}: ${people.length} people, ${families.length} families` +
    (fullDates ? ' (full dates kept)' : `; exact dates/places hidden for ${hidden} people born after ${cutoff}`),
);
