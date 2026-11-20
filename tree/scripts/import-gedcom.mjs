#!/usr/bin/env node
// Converts GEDCOM exports (e.g. from MyHeritage) into tree/data.json, the only
// data file the tree.vasylyna.net viewer reads.
//
//   node tree/scripts/import-gedcom.mjs vova.ged
//   node tree/scripts/import-gedcom.mjs vova.ged --merge nastia.ged
//
// --merge adds another tree on top of the first one. People are matched by
// name and birth year first, then by their place in the family (the father of
// a matched person matches the father in the other tree, and so on), so
// unnamed placeholders get filled in. Everyone else from the merged tree is
// added. When both trees disagree on a date or place, the more precise value
// wins, and on a tie the merged tree wins: it is the one kept by the person
// whose side of the family it is. Every match and conflict is printed.
//
// Privacy: the repository is public, so the raw .ged files are never committed.
// For anyone who may still be alive (not marked as dead, and born within the
// last PRIVATE_YEARS years or with no birth date) only the birth year is kept;
// exact dates and places are dropped. Pass --full-dates to keep everything.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_YEARS = 100;
const ROOT = 'I1'; // the person the tree opens on and relations are counted from
const MERGE_PREFIXES = ['A', 'B', 'C', 'D'];

const args = process.argv.slice(2);
const fullDates = args.includes('--full-dates');
const merges = [];
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--merge') merges.push(args[++i]);
  else if (!args[i].startsWith('--')) inputs.push(args[i]);
}
if (inputs.length !== 1 || merges.includes(undefined)) {
  console.error('Usage: node tree/scripts/import-gedcom.mjs <main.ged> [--merge <other.ged>]... [--full-dates]');
  process.exit(1);
}
const output = join(dirname(fileURLToPath(import.meta.url)), '..', 'data.json');

// --- GEDCOM ---------------------------------------------------------------------

function parseRecords(path) {
  const records = [];
  const stack = [];
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$/);
    if (!m) continue;
    const level = Number(m[1]);
    const node = { xref: m[2], tag: m[3], value: (m[4] ?? '').trim(), children: [] };
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
  return records;
}

const child = (node, ...path) => {
  for (const tag of path) node = node?.children.find((c) => c.tag === tag);
  return node;
};
const val = (node, ...path) => child(node, ...path)?.value.trim() || '';
const all = (node, tag) => node.children.filter((c) => c.tag === tag).map((c) => c.value.trim());
const xid = (xref) => xref.replace(/@/g, '');

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, '0');

// "13 JUN 1965" → "1965-06-13", "JUN 1965" → "1965-06", "ABT 1900" → "~1900",
// "BEF 1900" → "<1900", "AFT 1900" → ">1900", "BET 1900 AND 1910" → "1900..1910".
function parseDate(raw) {
  const s = raw.toUpperCase().trim();
  if (!s) return '';
  const between = s.match(/^BET\s+(.+?)\s+AND\s+(.+)$/);
  if (between) {
    const a = parseDate(between[1]);
    const b = parseDate(between[2]);
    return a && b ? `${a}..${b}` : a || b;
  }
  const qual = s.match(/^(ABT|EST|CAL|BEF|AFT)\s+(.*)$/);
  if (qual) {
    const inner = parseDate(qual[2]);
    return inner ? { ABT: '~', EST: '~', CAL: '~', BEF: '<', AFT: '>' }[qual[1]] + inner : '';
  }
  const m = s.match(/^(?:(\d{1,2})\s+)?(?:([A-Z]{3})\s+)?(\d{3,4})$/);
  if (!m) return '';
  const [, day, mon, year] = m;
  const month = MONTHS[mon];
  if (month && day) return `${year}-${pad(month)}-${pad(day)}`;
  if (month) return `${year}-${pad(month)}`;
  return year;
}
const yearOf = (date) => Number(date?.match(/\d{3,4}/)?.[0]) || null;
const onlyYear = (date) => date.replace(/(\d{3,4})-\d{2}(-\d{2})?/g, '$1');
const precision = (date) => (!date ? 0 : (date.match(/-/g)?.length ?? 0) + 1 - (/^[~<>]|\.\./.test(date) ? 0.5 : 0));

function readTree(path) {
  const people = new Map();
  const families = new Map();
  for (const rec of parseRecords(path)) {
    if (rec.tag === 'INDI') {
      const raw = val(rec, 'NAME');
      const death = child(rec, 'DEAT');
      people.set(xid(rec.xref), {
        id: xid(rec.xref),
        g: (val(rec, 'NAME', 'GIVN') || raw.replace(/\/.*$/, '')).trim(),
        s: (val(rec, 'NAME', 'SURN') || raw.match(/\/([^/]*)\//)?.[1] || '').trim(),
        m: val(rec, 'NAME', '_MARNM'),
        x: val(rec, 'SEX') || 'U',
        b: parseDate(val(rec, 'BIRT', 'DATE')),
        p: val(rec, 'BIRT', 'PLAC'),
        dead: Boolean(death) && !/^N/i.test(death.value),
        dd: parseDate(val(rec, 'DEAT', 'DATE')),
        dp: val(rec, 'DEAT', 'PLAC'),
        bu: val(rec, 'BURI', 'PLAC'),
        c: all(rec, 'FAMC').map(xid)[0] || null,
        f: all(rec, 'FAMS').map(xid),
      });
    } else if (rec.tag === 'FAM') {
      families.set(xid(rec.xref), {
        id: xid(rec.xref),
        h: val(rec, 'HUSB') ? xid(val(rec, 'HUSB')) : null,
        w: val(rec, 'WIFE') ? xid(val(rec, 'WIFE')) : null,
        k: all(rec, 'CHIL').map(xid),
        md: parseDate(val(rec, 'MARR', 'DATE')),
        mp: val(rec, 'MARR', 'PLAC'),
        dv: Boolean(child(rec, 'DIV')) && !/^N/i.test(child(rec, 'DIV').value),
      });
    }
  }
  return { people, families };
}

// --- Matching helpers -------------------------------------------------------------

const norm = (s) => (s || '').toLowerCase().replace(/[ʼ’'`]/g, "'").replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const firstName = (p) => norm(p.g).split(' ')[0] || '';
const nameOf = (p) => [p.g, p.s || p.m].filter(Boolean).join(' ') || '(без імені)';

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
// Геннадій/Генадій, Юлія/Юля, Костянтин/Константин are the same name.
const similar = (a, b) => {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  return len >= 3 && distance(a, b) <= (len >= 5 ? 2 : 1);
};

// -1: certainly different people, 3: same first name, 1: nothing against it.
function personScore(p, q) {
  if (p.x !== 'U' && q.x !== 'U' && p.x !== q.x) return -1;
  const yp = yearOf(p.b);
  const yq = yearOf(q.b);
  if (yp && yq && Math.abs(yp - yq) > 5) return -1;
  const a = firstName(p);
  const b = firstName(q);
  if (a && b) return similar(a, b) ? 3 : -1;
  return 1;
}

// --- Merge --------------------------------------------------------------------------

function mergeTree(base, extra, prefix, log) {
  const match = new Map(); // extra id → base id
  const taken = new Set(); // base ids already matched
  const famMap = new Map(); // extra family id → base family id
  const famTaken = new Set();
  const queue = [];

  const link = (eid, bid, why) => {
    if (match.has(eid) || taken.has(bid)) return;
    match.set(eid, bid);
    taken.add(bid);
    queue.push([bid, eid]);
    const a = base.people.get(bid);
    const b = extra.people.get(eid);
    log.matched.push(`${nameOf(a)} = ${nameOf(b)} (${why})`);
  };

  const mapFamily = (fa, fb) => {
    if (famMap.has(fb.id) || famTaken.has(fa.id)) return;
    famMap.set(fb.id, fa.id);
    famTaken.add(fa.id);
    for (const role of ['h', 'w']) {
      if (!fa[role] || !fb[role] || match.has(fb[role])) continue;
      const score = personScore(base.people.get(fa[role]), extra.people.get(fb[role]));
      if (score >= 0) link(fb[role], fa[role], role === 'h' ? 'чоловік у тій самій сімʼї' : 'дружина в тій самій сімʼї');
      else log.conflicts.push(`Різні люди на одному місці в сімʼї: ${nameOf(base.people.get(fa[role]))} / ${nameOf(extra.people.get(fb[role]))}`);
    }
    // Children are matched by first name only; unnamed ones are never guessed.
    const kidsA = fa.k.filter((k) => !taken.has(k));
    for (const kb of fb.k) {
      if (match.has(kb)) continue;
      const q = extra.people.get(kb);
      const hit = kidsA.find((ka) => !taken.has(ka) && personScore(base.people.get(ka), q) === 3);
      if (hit) link(kb, hit, 'дитина в тій самій сімʼї');
    }
  };

  // Anchors: same full name and the same birth year, unique on both sides.
  const keyed = (tree) => {
    const index = new Map();
    for (const p of tree.people.values()) {
      if (!p.g || !p.s || !yearOf(p.b)) continue;
      const key = `${norm(p.g)}|${norm(p.s)}|${yearOf(p.b)}`;
      index.set(key, index.has(key) ? null : p.id);
    }
    return index;
  };
  const baseKeys = keyed(base);
  for (const [key, eid] of keyed(extra)) {
    if (eid && baseKeys.get(key)) link(eid, baseKeys.get(key), 'імʼя і рік народження');
  }
  if (!queue.length) throw new Error('No person appears in both trees; nothing to anchor the merge on.');

  while (queue.length) {
    const [bid, eid] = queue.shift();
    const a = base.people.get(bid);
    const b = extra.people.get(eid);

    // Parents' family.
    const fb = b.c && extra.families.get(b.c);
    const fa = a.c && base.families.get(a.c);
    if (fa && fb) mapFamily(fa, fb);

    // Own marriages: pair them up by spouse and children.
    const candidates = a.f.map((id) => base.families.get(id)).filter((f) => !famTaken.has(f.id));
    const scored = [];
    for (const fbid of b.f) {
      const fb2 = extra.families.get(fbid);
      if (famMap.has(fbid)) continue;
      for (const fa2 of candidates) {
        const sa = fa2.h === bid ? fa2.w : fa2.h;
        const sb = fb2.h === eid ? fb2.w : fb2.h;
        let score = 0;
        if (sa && sb) {
          const s = personScore(base.people.get(sa), extra.people.get(sb));
          if (s < 0) continue;
          score += s;
        } else if (!sa && !sb) score += 1;
        for (const kb of fb2.k) {
          if (fa2.k.some((ka) => personScore(base.people.get(ka), extra.people.get(kb)) === 3)) score += 2;
        }
        if (score >= 2) scored.push({ score, fa: fa2, fb: fb2 });
      }
    }
    for (const { fa: fa2, fb: fb2 } of scored.sort((x, y) => y.score - x.score)) mapFamily(fa2, fb2);
  }

  // Merge details of matched people.
  for (const [eid, bid] of match) mergePerson(base.people.get(bid), extra.people.get(eid), log);

  // Everyone else from the extra tree is new.
  for (const [eid, q] of extra.people) {
    if (match.has(eid)) continue;
    const nid = prefix + eid.replace(/^\D+/, '');
    match.set(eid, nid);
    base.people.set(nid, { ...q, id: nid, c: null, f: [] });
    log.added.push(nid);
  }

  // Families: extend the matched ones, copy the rest.
  for (const [fid, fb] of extra.families) {
    let fa = famMap.has(fid) && base.families.get(famMap.get(fid));
    if (!fa) {
      fa = { id: `${prefix}F${fid.replace(/^\D+/, '')}`, h: null, w: null, k: [], md: '', mp: '', dv: false };
      base.families.set(fa.id, fa);
    }
    fa.md = pickDate(fa.md, fb.md, log, `дата шлюбу (${fa.id})`);
    fa.mp = pickPlace(fa.mp, fb.mp, log, `місце шлюбу (${fa.id})`);
    fa.dv = fa.dv || fb.dv;
    for (const role of ['h', 'w']) {
      if (!fb[role]) continue;
      const pid = match.get(fb[role]);
      if (!fa[role]) {
        fa[role] = pid;
        const p = base.people.get(pid);
        if (!p.f.includes(fa.id)) p.f.push(fa.id);
      } else if (fa[role] !== pid) {
        log.conflicts.push(`Не додано: ${nameOf(base.people.get(pid))} як ${role === 'h' ? 'чоловіка' : 'дружину'} в сімʼю, де вже є ${nameOf(base.people.get(fa[role]))}`);
      }
    }
    for (const kid of fb.k) {
      const pid = match.get(kid);
      const p = base.people.get(pid);
      if (fa.k.includes(pid)) continue;
      if (!p.c) {
        p.c = fa.id;
        fa.k.push(pid);
      } else if (p.c !== fa.id) {
        log.conflicts.push(`Не змінено батьків: ${nameOf(p)} — у дереві вже інші батьки`);
      }
    }
  }
}

function pickDate(a, b, log, what) {
  if (!b || a === b) return a;
  if (!a) return b;
  if (yearOf(a) === yearOf(b) && precision(a) !== precision(b)) return precision(a) > precision(b) ? a : b;
  log.conflicts.push(`${what}: ${a} → ${b}`);
  return b;
}

const generic = (place) => /^україна$/i.test(place.trim());
function pickPlace(a, b, log, what) {
  if (!b || norm(a) === norm(b)) return a;
  if (!a || generic(a)) return b;
  if (generic(b)) return a;
  log.conflicts.push(`${what}: ${a} → ${b}`);
  return b;
}

function mergePerson(a, b, log) {
  const before = nameOf(a);
  if (!a.g && b.g) {
    a.g = b.g;
    if (b.s) a.s = b.s;
    log.filled.push(`${before} → ${nameOf(a)}`);
  } else if (!a.s && b.s) {
    a.s = b.s;
    log.filled.push(`${before} → ${nameOf(a)}`);
  } else if ((b.g && firstName(a) !== firstName(b)) || (b.s && norm(a.s) !== norm(b.s))) {
    log.spelling.push(`${nameOf(a)} (лишено) / ${nameOf(b)}`);
  }
  if (!a.m && b.m) a.m = b.m;
  if (a.x === 'U') a.x = b.x;
  const who = nameOf(a);
  a.b = pickDate(a.b, b.b, log, `${who}, народження`);
  a.p = pickPlace(a.p, b.p, log, `${who}, місце народження`);
  a.dead = a.dead || b.dead;
  a.dd = pickDate(a.dd, b.dd, log, `${who}, смерть`);
  a.dp = pickPlace(a.dp, b.dp, log, `${who}, місце смерті`);
  a.bu = pickPlace(a.bu, b.bu, log, `${who}, поховання`);
}

// --- Build ----------------------------------------------------------------------------

const tree = readTree(inputs[0]);
if (!tree.people.has(ROOT)) {
  console.error(`Root person ${ROOT} not found in ${inputs[0]}`);
  process.exit(1);
}
merges.forEach((path, i) => {
  const log = { matched: [], filled: [], spelling: [], conflicts: [], added: [] };
  mergeTree(tree, readTree(path), MERGE_PREFIXES[i], log);
  const added = log.added.map((id) => nameOf(tree.people.get(id)));
  console.log(`\nMerged ${path}`);
  console.log(`  matched ${log.matched.length}:\n    ${log.matched.join('\n    ')}`);
  console.log(`  filled in ${log.filled.length}:\n    ${log.filled.join('\n    ')}`);
  console.log(`  spelling differs, kept the main tree's ${log.spelling.length}:\n    ${log.spelling.join('\n    ')}`);
  console.log(`  conflicts ${log.conflicts.length}:\n    ${log.conflicts.join('\n    ')}`);
  console.log(`  added ${added.length}:\n    ${added.join('\n    ')}`);
});

// Drop anyone the merge left unconnected to the root.
const reach = new Set([ROOT]);
const stack = [ROOT];
while (stack.length) {
  const p = tree.people.get(stack.pop());
  const fams = [p.c, ...p.f].filter(Boolean).map((id) => tree.families.get(id));
  for (const f of fams) {
    for (const id of [f.h, f.w, ...f.k]) {
      if (id && !reach.has(id)) {
        reach.add(id);
        stack.push(id);
      }
    }
  }
}
for (const [id, p] of tree.people) {
  if (!reach.has(id)) {
    console.log(`  dropped, not connected to ${ROOT}: ${nameOf(p)}`);
    tree.people.delete(id);
  }
}

const cutoff = new Date().getFullYear() - PRIVATE_YEARS;
const isPrivate = (p) => !fullDates && !p.dead && (!yearOf(p.b) || yearOf(p.b) > cutoff);
let hidden = 0;

const people = [...tree.people.values()].map((p) => {
  const out = { id: p.id, g: p.g, s: p.s, x: p.x };
  if (p.m && norm(p.m) !== norm(p.s)) out.m = p.m;
  if (isPrivate(p)) {
    if (p.b) out.b = onlyYear(p.b);
    if ((p.b && p.b !== out.b) || p.p) hidden++;
  } else {
    if (p.b) out.b = p.b;
    if (p.p) out.p = p.p;
  }
  if (p.dead) {
    out.z = 1;
    if (p.dd) out.d = p.dd;
    if (p.dp) out.dp = p.dp;
    if (p.bu) out.bu = p.bu;
  }
  if (p.c && tree.families.has(p.c)) out.c = p.c;
  if (p.f.length) out.f = p.f;
  return out;
});

const birthYear = new Map(people.map((p) => [p.id, yearOf(p.b)]));
const families = [...tree.families.values()]
  .filter((f) => [f.h, f.w, ...f.k].some((id) => id && tree.people.has(id)))
  .map((f) => {
    const out = { id: f.id };
    if (f.h && tree.people.has(f.h)) out.h = f.h;
    if (f.w && tree.people.has(f.w)) out.w = f.w;
    // Children in birth order (stable for undated ones).
    out.k = f.k
      .filter((id) => tree.people.has(id))
      .map((c, i) => ({ c, i, y: birthYear.get(c) }))
      .sort((a, b) => (a.y && b.y ? a.y - b.y : 0) || a.i - b.i)
      .map((o) => o.c);
    // Marriage details of living couples stay private beyond the year.
    const spouses = [f.h, f.w].map((id) => tree.people.get(id)).filter(Boolean);
    const open = spouses.every((p) => !isPrivate(p));
    if (f.md) out.md = open ? f.md : onlyYear(f.md);
    if (f.mp && open) out.mp = f.mp;
    if (f.dv && open) out.dv = 1;
    return out;
  });

const data = {
  root: ROOT,
  updated: new Date().toISOString().slice(0, 10),
  privateAfter: fullDates ? null : cutoff,
  people,
  families,
};
writeFileSync(output, JSON.stringify(data) + '\n');
console.log(
  `\nWrote ${output}: ${people.length} people, ${families.length} families` +
    (fullDates ? ' (full dates kept)' : `; exact dates/places hidden for ${hidden} people who may be alive`),
);
