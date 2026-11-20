// Family tree viewer for tree.vasylyna.net.
// Reads data.json (made by scripts/import-gedcom.mjs) and draws an hourglass
// chart around one person: their ancestors above, siblings beside, spouses and
// descendants below. Clicking anyone re-centres the chart on them (#I123).
'use strict';

(() => {
  const CARD_W = 172;
  const CARD_H = 58;
  const ROW = 122; // vertical distance between generations
  const GAP = 16; // min horizontal gap between cards of different branches
  const COUPLE_GAP = 12; // gap between spouses
  const MIN_K = 0.15;
  const MAX_K = 2;
  const MAX_DEPTH = 30;

  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport');
  const stage = $('stage');
  const linksSvg = $('links');
  const panel = $('panel');
  const focusbar = $('focusbar');
  const rootDative = document.body.dataset.rootDative || '';

  const people = new Map();
  const families = new Map();
  let rootId = null;
  let meta = {};
  let focusId = null;
  let currentLayout = null;
  const relations = new Map();

  // ---------------------------------------------------------------------------
  // Data helpers

  const person = (id) => people.get(id);
  const famsOf = (id) => (person(id)?.f || []).map((f) => families.get(f)).filter(Boolean);
  const spouseIn = (fam, id) => (fam.h === id ? fam.w : fam.h) || null;
  const spousesOf = (id) => famsOf(id).map((f) => spouseIn(f, id)).filter(Boolean);
  const birthFamily = (id) => {
    const c = person(id)?.c;
    return c ? families.get(c) : null;
  };
  const parentsOf = (id) => {
    const f = birthFamily(id);
    return f ? [f.h, f.w].filter(Boolean) : [];
  };
  const yearOf = (p) => Number(p?.b?.match(/\d{3,4}/)?.[0]) || null;

  function siblingsOf(id) {
    const own = birthFamily(id);
    const full = own ? own.k.filter((k) => k !== id) : [];
    const half = [];
    for (const parent of parentsOf(id)) {
      for (const fam of famsOf(parent)) {
        if (fam === own) continue;
        for (const k of fam.k) if (k !== id && !full.includes(k) && !half.includes(k)) half.push(k);
      }
    }
    return { full, half };
  }

  // ---------------------------------------------------------------------------
  // Text

  const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  const MONTHS_NOM = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
  const QUAL = { '~': 'бл. ', '<': 'до ', '>': 'після ' };

  function fmtDate(d, short) {
    if (!d) return '';
    if (d.includes('..')) {
      const [a, b] = d.split('..');
      return short ? `${fmtDate(a, true)}–${fmtDate(b, true)}` : `між ${fmtDate(a)} і ${fmtDate(b)}`;
    }
    const q = QUAL[d[0]] || '';
    if (q) d = d.slice(1);
    const [y, m, day] = d.split('-');
    if (short || !m) return q + y;
    if (day) return `${q}${Number(day)} ${MONTHS_GEN[m - 1]} ${y}`;
    return `${q}${MONTHS_NOM[m - 1]} ${y}`;
  }

  const UNKNOWN = 'Ім’я невідоме';
  function fullName(p) {
    if (p.g && p.s) return `${p.g} ${p.s}`;
    if (p.g) return p.g;
    if (p.s) return `${p.s} (ім’я невідоме)`;
    return UNKNOWN;
  }

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
    return `${n} ${many}`;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------------------------------------------------------------------------
  // Kinship: how each person is related to the root person, in Ukrainian.

  function ancestorDistances(id) {
    const dist = new Map([[id, 0]]);
    const queue = [id];
    while (queue.length) {
      const x = queue.shift();
      for (const p of parentsOf(x)) {
        if (!dist.has(p)) {
          dist.set(p, dist.get(x) + 1);
          queue.push(p);
        }
      }
    }
    return dist;
  }

  const ancCache = new Map();
  const ancestorsOf = (id) => {
    if (!ancCache.has(id)) ancCache.set(id, ancestorDistances(id));
    return ancCache.get(id);
  };

  // Shortest blood link: `a` generations up from `from`, `b` down to `to`.
  function bloodLink(from, to) {
    const A = ancestorsOf(from);
    let best = null;
    for (const [anc, b] of ancestorsOf(to)) {
      const a = A.get(anc);
      if (a !== undefined && (!best || a + b < best.a + best.b)) best = { a, b };
    }
    if (best && best.a === 1 && best.b === 1) {
      const pa = parentsOf(from);
      const pb = parentsOf(to);
      const shared = pa.filter((x) => pb.includes(x));
      if (shared.length === 1 && pa.length === 2 && pb.length === 2) {
        best.half = person(shared[0]).x === 'F' ? 'по матері' : 'по батькові';
      }
    }
    return best;
  }

  const DEGREE = { 2: 'двоюрідн', 3: 'троюрідн', 4: 'чотириюрідн', 5: 'пʼятиюрідн', 6: 'шестиюрідн' };
  // Returns [nominative, genitive].
  function kinTerm({ a, b, half }, sex) {
    const f = sex === 'F';
    const pick = (m, w) => (f ? w : m);
    const pra = (k) => 'пра'.repeat(k);
    const prefix = (n, [nom, gen]) => {
      if (n <= 1) return [nom, gen];
      const stem = DEGREE[n] || `${n}-юрідн`;
      return [`${stem}${f ? 'а' : 'ий'} ${nom}`, `${stem}${f ? 'ої' : 'ого'} ${gen}`];
    };
    const grandchild = (k) =>
      k === 0 ? pick(['онук', 'онука'], ['онука', 'онуки']) : pick([`${pra(k)}внук`, `${pra(k)}внука`], [`${pra(k)}внучка`, `${pra(k)}внучки`]);
    const grandparent = (k) => pick([`${pra(k)}дід`, `${pra(k)}діда`], [`${pra(k)}бабуся`, `${pra(k)}бабусі`]);

    if (a === 0) {
      if (b === 1) return pick(['син', 'сина'], ['донька', 'доньки']);
      return grandchild(b - 2);
    }
    if (b === 0) {
      if (a === 1) return pick(['батько', 'батька'], ['мати', 'матері']);
      if (a === 2) return pick(['дідусь', 'дідуся'], ['бабуся', 'бабусі']);
      return grandparent(a - 2);
    }
    if (a === b) {
      const t = prefix(a, pick(['брат', 'брата'], ['сестра', 'сестри']));
      return half ? [`${t[0]} ${half}`, `${t[1]} ${half}`] : t;
    }
    if (a === b + 1) return prefix(b, pick(['дядько', 'дядька'], ['тітка', 'тітки']));
    if (a > b + 1) return prefix(b + 1, grandparent(a - b - 2));
    if (b === a + 1) return prefix(a, pick(['племінник', 'племінника'], ['племінниця', 'племінниці']));
    return prefix(a + 1, grandchild(b - a - 2));
  }

  function computeRelation(id) {
    if (id === rootId) return null;
    const t = person(id);
    const female = t.x === 'F';
    const blood = bloodLink(rootId, id);
    if (blood) return kinTerm(blood, t.x)[0];

    const spouses = spousesOf(id);
    if (spouses.includes(rootId)) return female ? 'дружина' : 'чоловік';

    // Married to a blood relative.
    let best = null;
    for (const s of spouses) {
      const link = bloodLink(rootId, s);
      if (link && (!best || link.a + link.b < best.link.a + best.link.b)) best = { s, link };
    }
    if (best) {
      const { a, b } = best.link;
      if ((a === 0 && b === 1) || (a === 1 && b === 1)) return female ? 'невістка' : 'зять';
      if (a === 1 && b === 0) return female ? 'мачуха' : 'вітчим';
      return `${female ? 'дружина' : 'чоловік'} ${kinTerm(best.link, person(best.s).x)[1]}`;
    }

    // Blood relative of the root's spouse, or married to one.
    for (const sp of spousesOf(rootId)) {
      const link = bloodLink(sp, id);
      if (link) return inLawTerm(link, t.x, sp)[0];
    }
    for (const sp of spousesOf(rootId)) {
      for (const s of spouses) {
        const link = bloodLink(sp, s);
        if (link) return `${female ? 'дружина' : 'чоловік'} ${inLawTerm(link, person(s).x, sp)[1]}`;
      }
    }
    return null;
  }

  // Relatives of the root's spouse: [nominative, genitive].
  function inLawTerm(link, sex, spouseId) {
    const f = sex === 'F';
    const rootFemale = person(rootId).x === 'F';
    if (link.a === 1 && link.b === 0) {
      if (rootFemale) return f ? ['свекруха', 'свекрухи'] : ['свекор', 'свекра'];
      return f ? ['теща', 'тещі'] : ['тесть', 'тестя'];
    }
    if (link.a === 1 && link.b === 1 && !link.half) {
      if (rootFemale) return f ? ['зовиця', 'зовиці'] : ['дівер', 'дівера'];
      return f ? ['своячка', 'своячки'] : ['шурин', 'шурина'];
    }
    const of = person(spouseId).x === 'F' ? 'дружини' : 'чоловіка';
    return kinTerm(link, sex).map((t) => `${t} ${of}`);
  }

  // ---------------------------------------------------------------------------
  // Layout. Subtrees are packed using per-generation contours (left/right
  // extents), so branches sit as close as possible without overlapping.

  function mergeContour(acc, contour, dx, shift = 0) {
    contour.forEach((c, i) => {
      if (!c) return;
      const d = i + shift;
      const l = c[0] + dx;
      const r = c[1] + dx;
      if (!acc[d]) acc[d] = [l, r];
      else {
        if (l < acc[d][0]) acc[d][0] = l;
        if (r > acc[d][1]) acc[d][1] = r;
      }
    });
    return acc;
  }

  // Smallest offset for `contour` so that it sits right of `acc`.
  function minOffset(acc, contour, gap) {
    let need = -Infinity;
    const n = Math.min(acc.length, contour.length);
    for (let d = 0; d < n; d++) {
      if (acc[d] && contour[d]) need = Math.max(need, acc[d][1] + gap(d) - contour[d][0]);
    }
    return need;
  }

  function pack(trees, gap = () => GAP) {
    const offsets = [];
    const contour = [];
    trees.forEach((t, i) => {
      const off = i === 0 ? 0 : Math.max(minOffset(contour, t.contour, gap), offsets[i - 1]);
      offsets.push(off);
      mergeContour(contour, t.contour, off);
    });
    return { offsets, contour };
  }

  const shiftTree = (into, tree, dx) => {
    for (const n of tree.nodes) into.nodes.push({ ...n, x: n.x + dx, d: n.d + 1 });
    for (const l of tree.links) into.links.push({ ...l, d: l.d + 1, px: l.px.map((x) => x + dx), kids: l.kids.map((x) => x + dx) });
  };

  // Descendants of `id`, which sits at x = 0, depth 0. A link {d, px, kids}
  // joins parents at depth d with children at depth d + 1.
  function descendantTree(id, depthLeft, seen) {
    seen.add(id);
    const fams = famsOf(id);
    const step = CARD_W + COUPLE_GAP;
    const block = [{ id, x: 0 }];
    const withSpouse = fams.filter((f) => spouseIn(f, id));
    const spouseX = new Map();
    if (fams.length === 2 && withSpouse.length === 2) {
      spouseX.set(fams[0], -step);
      spouseX.set(fams[1], step);
    } else {
      withSpouse.forEach((f, i) => spouseX.set(f, step * (i + 1)));
    }
    for (const f of fams) if (spouseX.has(f)) block.push({ id: spouseIn(f, id), x: spouseX.get(f), spouse: true });

    const xs = block.map((b) => b.x);
    const tree = {
      nodes: block.map((b) => ({ id: b.id, x: b.x, d: 0, role: b.spouse ? 'spouse' : 'desc' })),
      links: [],
      contour: [[Math.min(...xs) - CARD_W / 2, Math.max(...xs) + CARD_W / 2]],
    };

    const kidLists = fams.map((f) => (depthLeft > 0 ? f.k.filter((k) => !seen.has(k) && people.has(k)) : []));
    // Spouses on both sides: children of the left marriage stay left of its
    // drop line and the right marriage's to the right, so the lines never mix.
    const twoSided = spouseX.get(fams[0]) < 0 && kidLists.every((k) => k.length);
    const withKids = kidLists.filter((k) => k.length).length;
    let groups = null;
    let groupIndex = 0;
    fams.forEach((f, i) => {
      const sx = spouseX.get(f);
      const px = sx === undefined ? [0] : [0, sx];
      const kids = kidLists[i].filter((k) => !seen.has(k));
      if (!kids.length) {
        if (px.length === 2) tree.links.push({ d: 0, px, kids: [] });
        return;
      }
      const subtrees = kids.map((k) => descendantTree(k, depthLeft - 1, seen));
      const { offsets, contour } = pack(subtrees);
      const first = offsets[0];
      const last = offsets[offsets.length - 1];
      const drop = px.length === 2 ? sx / 2 : 0;
      let dx = drop - (first + last) / 2;
      if (twoSided) dx = i === 0 ? Math.min(dx, drop - last) : Math.max(dx, drop - first);
      if (groups) dx = Math.max(dx, minOffset(groups, contour, () => GAP * 2));
      groups = mergeContour(groups || [], contour, dx);
      subtrees.forEach((t, j) => shiftTree(tree, t, dx + offsets[j]));
      // Otherwise several marriages share one bus height; stagger them.
      const bus = twoSided || withKids < 2 ? 0 : (groupIndex - (withKids - 1) / 2) * 10;
      groupIndex++;
      tree.links.push({ d: 0, px, kids: offsets.map((o) => o + dx), bus });
    });
    if (groups) mergeContour(tree.contour, groups, 0, 1);
    return tree;
  }

  // Ancestors of `id` (x = 0, depth 0), growing upwards. A link {d, px, kids}
  // joins parents at depth d + 1 with the child at depth d.
  function ancestorTree(id, depthLeft, seen) {
    seen.add(id);
    const tree = { nodes: [{ id, x: 0, d: 0, role: 'anc' }], links: [], contour: [[-CARD_W / 2, CARD_W / 2]] };
    const fam = birthFamily(id);
    if (!fam || depthLeft <= 0) return tree;
    const parents = [fam.h, fam.w].filter((p) => p && people.has(p) && !seen.has(p));
    if (!parents.length) return tree;
    const subtrees = parents.map((p) => ancestorTree(p, depthLeft - 1, seen));
    const { offsets, contour } = pack(subtrees, (d) => (d === 0 ? COUPLE_GAP : GAP));
    const dx = -(offsets[0] + offsets[offsets.length - 1]) / 2;
    subtrees.forEach((t, i) => shiftTree(tree, t, dx + offsets[i]));
    tree.links.push({ d: 0, px: offsets.map((o) => o + dx), kids: [0] });
    mergeContour(tree.contour, contour, dx, 1);
    return tree;
  }

  // Absolute layout: rows grow downwards, the focus person is at row 0, x 0.
  function layout(id) {
    const seen = new Set();
    const up = ancestorTree(id, MAX_DEPTH, seen);
    seen.delete(id);
    const down = descendantTree(id, MAX_DEPTH, seen);

    const nodes = [];
    const links = [];
    for (const n of up.nodes) if (n.d > 0) nodes.push({ id: n.id, x: n.x, row: -n.d, role: 'anc' });
    for (const n of down.nodes) nodes.push({ id: n.id, x: n.x, row: n.d, role: n.d === 0 && n.id === id ? 'focus' : n.role });

    // Siblings stand to the left of the focus person, in birth order.
    const fam = birthFamily(id);
    const sibs = fam ? fam.k.filter((k) => k !== id && people.has(k)) : [];
    let x = down.contour[0][0] - GAP - CARD_W / 2;
    const sibX = [];
    for (let i = sibs.length - 1; i >= 0; i--) {
      sibX[i] = x;
      nodes.push({ id: sibs[i], x, row: 0, role: 'sib' });
      x -= CARD_W + GAP;
    }

    for (const l of up.links) {
      const kids = l.d === 0 && sibX.length ? [...sibX, ...l.kids] : l.kids;
      links.push({ row: -(l.d + 1), px: l.px, kids });
    }
    for (const l of down.links) links.push({ row: l.d, px: l.px, kids: l.kids, bus: l.bus });

    let minX = Infinity;
    let maxX = -Infinity;
    let minRow = Infinity;
    let maxRow = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - CARD_W / 2);
      maxX = Math.max(maxX, n.x + CARD_W / 2);
      minRow = Math.min(minRow, n.row);
      maxRow = Math.max(maxRow, n.row);
    }
    return { nodes, links, bounds: { minX, maxX, minY: minRow * ROW, maxY: maxRow * ROW + CARD_H } };
  }

  function linkPath({ row, px, kids, bus: busShift = 0 }) {
    const top = row * ROW;
    const mid = top + CARD_H / 2;
    const bottom = top + CARD_H;
    const bus = bottom + (ROW - CARD_H) / 2 + busShift;
    const kidTop = (row + 1) * ROW;
    const p = [...px].sort((a, b) => a - b);
    let d = '';
    if (p.length === 2) d += `M${p[0] + CARD_W / 2} ${mid}H${p[1] - CARD_W / 2}`;
    if (!kids.length) return d;
    const drop = p.length === 2 ? (p[0] + p[1]) / 2 : p[0];
    const start = p.length === 2 ? mid : bottom;
    if (kids.length === 1 && Math.abs(kids[0] - drop) < 1) return `${d}M${drop} ${start}V${kidTop}`;
    d += `M${drop} ${start}V${bus}M${Math.min(drop, ...kids)} ${bus}H${Math.max(drop, ...kids)}`;
    for (const k of kids) d += `M${k} ${bus}V${kidTop}`;
    return d;
  }

  // ---------------------------------------------------------------------------
  // Rendering

  const cards = new Map(); // key → element
  let linkTimer = 0;

  function makeCard(id) {
    const p = person(id);
    const a = document.createElement('a');
    a.href = `#${id}`;
    a.draggable = false;
    a.dataset.id = id;
    const given = document.createElement('span');
    given.className = 'given';
    if (p.g) given.textContent = p.g;
    else {
      given.textContent = UNKNOWN;
      given.classList.add('unknown');
    }
    const surname = document.createElement('span');
    surname.className = 'surname';
    surname.textContent = p.s || '';
    const year = document.createElement('span');
    year.className = 'year';
    year.textContent = fmtDate(p.b, true);
    a.append(given, surname, year);
    const rel = relations.get(id);
    const label = [fullName(p), fmtDate(p.b, true), rel].filter(Boolean).join(', ');
    a.title = label;
    a.setAttribute('aria-label', label);
    return a;
  }

  function render(id, animate) {
    const lay = layout(id);
    const used = new Set();
    const fresh = [];
    for (const n of lay.nodes) {
      let key = n.id;
      for (let i = 2; used.has(key); i++) key = `${n.id}~${i}`;
      used.add(key);
      let el = cards.get(key);
      if (!el) {
        el = makeCard(n.id);
        cards.set(key, el);
        if (animate) {
          el.style.opacity = '0';
          fresh.push(el);
        }
        stage.appendChild(el);
      }
      const p = person(n.id);
      el.className = `card ${p.x === 'F' ? 'f' : p.x === 'M' ? 'm' : 'u'}${n.role === 'focus' ? ' focus' : ''}${n.id === rootId ? ' root' : ''}`;
      el.style.transform = `translate(${n.x - CARD_W / 2}px, ${n.row * ROW}px)`;
      el.tabIndex = 0;
      if (n.role === 'focus') el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    }
    for (const [key, el] of cards) {
      if (used.has(key)) continue;
      cards.delete(key);
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.tabIndex = -1;
      setTimeout(() => el.remove(), animate ? 450 : 0);
    }
    if (fresh.length) {
      void stage.offsetWidth; // start the fade from opacity 0
      for (const el of fresh) el.style.opacity = '';
    }

    const d = lay.links.map(linkPath).join('');
    clearTimeout(linkTimer);
    if (animate) {
      linksSvg.classList.add('hidden');
      linkTimer = setTimeout(() => {
        linksSvg.innerHTML = `<path d="${d}"/>`;
        linksSvg.classList.remove('hidden');
      }, 420);
    } else {
      linksSvg.innerHTML = `<path d="${d}"/>`;
    }
    return lay;
  }

  // ---------------------------------------------------------------------------
  // Pan and zoom

  const view = { x: 0, y: 0, k: 1 };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function applyView(animate) {
    stage.classList.toggle('smooth', !!animate);
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  }

  function zoomAt(px, py, k, animate) {
    k = clamp(k, MIN_K, MAX_K);
    const sx = (px - view.x) / view.k;
    const sy = (py - view.y) / view.k;
    view.k = k;
    view.x = px - sx * k;
    view.y = py - sy * k;
    applyView(animate);
  }

  function zoomBy(factor) {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, view.k * factor, true);
  }

  // Frame the layout: show as much of it as possible while keeping the
  // focus person on screen. `fit` also picks a zoom level.
  function frame(lay, { animate = false, fit = false, minK = 0.45 } = {}) {
    const r = viewport.getBoundingClientRect();
    const b = lay.bounds;
    const pad = 32;
    if (fit) {
      const k = Math.min((r.width - pad * 2) / (b.maxX - b.minX), (r.height - pad * 2) / (b.maxY - b.minY));
      view.k = clamp(k, minK, 1);
    }
    let cx = (b.minX + b.maxX) / 2;
    let cy = (b.minY + b.maxY) / 2;
    const slackX = Math.max(0, r.width / 2 / view.k - CARD_W / 2 - pad);
    const slackY = Math.max(0, r.height / 2 / view.k - CARD_H / 2 - pad);
    cx = clamp(cx, -slackX, slackX);
    cy = clamp(cy, CARD_H / 2 - slackY, CARD_H / 2 + slackY);
    view.x = r.width / 2 - cx * view.k;
    view.y = r.height / 2 - cy * view.k;
    applyView(animate);
  }

  const pointers = new Map();
  let gesture = null;
  let suppressClick = false;

  function startGesture() {
    const pts = [...pointers.values()];
    if (pts.length === 1) {
      gesture = { type: 'pan', sx: pts[0].x, sy: pts[0].y, vx: view.x, vy: view.y, moved: false };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const r = viewport.getBoundingClientRect();
      gesture = {
        type: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        ox: ((a.x + b.x) / 2 - r.left - view.x) / view.k,
        oy: ((a.y + b.y) / 2 - r.top - view.y) / view.k,
        k: view.k,
      };
      suppressClick = true;
    }
  }

  function endPointer(e) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size) startGesture();
    else {
      gesture = null;
      viewport.classList.remove('dragging');
    }
  }

  function initPanZoom() {
    viewport.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.controls, .focusbar')) return;
      if (pointers.size === 0) suppressClick = false;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      startGesture();
    });
    window.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !gesture) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointers.values()];
      if (gesture.type === 'pan') {
        const dx = pts[0].x - gesture.sx;
        const dy = pts[0].y - gesture.sy;
        if (!gesture.moved) {
          if (Math.hypot(dx, dy) < 6) return;
          gesture.moved = true;
          suppressClick = true;
          viewport.classList.add('dragging');
          hideHint();
        }
        view.x = gesture.vx + dx;
        view.y = gesture.vy + dy;
        applyView(false);
      } else if (pts.length >= 2) {
        const [a, b] = pts;
        const r = viewport.getBoundingClientRect();
        view.k = clamp((gesture.k * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.dist, MIN_K, MAX_K);
        view.x = (a.x + b.x) / 2 - r.left - gesture.ox * view.k;
        view.y = (a.y + b.y) / 2 - r.top - gesture.oy * view.k;
        applyView(false);
        hideHint();
      }
    });
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
    // A drag that ends on a card must not open it.
    viewport.addEventListener(
      'click',
      (e) => {
        if (suppressClick) {
          e.preventDefault();
          e.stopPropagation();
          suppressClick = false;
        }
      },
      true,
    );
    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = viewport.getBoundingClientRect();
        const lines = e.deltaMode === 1;
        const mouseWheel = lines || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
        if (e.ctrlKey || mouseWheel) {
          const dy = lines ? e.deltaY * 33 : e.deltaY;
          zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), false);
        } else {
          view.x -= e.deltaX;
          view.y -= e.deltaY;
          applyView(false);
        }
        hideHint();
      },
      { passive: false },
    );
    $('zoom-in').addEventListener('click', () => zoomBy(1.25));
    $('zoom-out').addEventListener('click', () => zoomBy(0.8));
    $('zoom-fit').addEventListener('click', () => currentLayout && frame(currentLayout, { animate: true, fit: true, minK: MIN_K }));
  }

  let hintHidden = false;
  function hideHint() {
    if (hintHidden) return;
    hintHidden = true;
    $('hint').classList.add('gone');
  }

  // ---------------------------------------------------------------------------
  // Side panel

  function personItem(id) {
    const p = person(id);
    return `<li><a href="#${esc(id)}">${esc(fullName(p))}</a>${p.b ? `<span class="year">${esc(fmtDate(p.b, true))}</span>` : ''}</li>`;
  }

  function section(title, ids) {
    return ids.length ? `<h2>${title}</h2><ul>${ids.map(personItem).join('')}</ul>` : '';
  }

  function renderPanel(id) {
    const p = person(id);
    const rel = relations.get(id);
    const female = p.x === 'F';
    const { full, half } = siblingsOf(id);
    const fams = famsOf(id);
    let html = `<h1>${esc(fullName(p))}</h1>`;
    if (rel) html += `<p class="rel">${esc(rootDative ? `Ким доводиться ${rootDative}: ` : '')}<strong>${esc(rel)}</strong></p>`;

    const birth = [fmtDate(p.b), p.p].filter(Boolean).join(', ');
    html += `<p class="birth"><span class="muted">Народження:</span> ${birth ? esc(birth) : '<span class="muted">невідомо</span>'}</p>`;

    html += section('Батьки', parentsOf(id));
    html += section('Брати й сестри', full);
    html += section('Брати й сестри по одному з батьків', half);
    const spouses = spousesOf(id);
    html += section(female ? (spouses.length > 1 ? 'Чоловіки' : 'Чоловік') : spouses.length > 1 ? 'Дружини' : 'Дружина', spouses);
    const withKids = fams.filter((f) => f.k.length);
    for (const f of withKids) {
      const other = spouseIn(f, id);
      const title =
        withKids.length > 1 && other ? `Діти <span class="muted">(${female ? 'батько' : 'мати'} — ${esc(fullName(person(other)))})</span>` : 'Діти';
      html += section(title, f.k.filter((k) => people.has(k)));
    }

    html += `<footer>
      <p>${plural(people.size, 'людина', 'людини', 'людей')} · ${plural(meta.generations, 'покоління', 'покоління', 'поколінь')} · з ${meta.firstYear} року.</p>
      ${meta.privateAfter ? `<p>Для народжених після ${meta.privateAfter} року показано лише рік народження.</p>` : ''}
      <p>Оновлено ${esc(meta.updated)}.</p>
    </footer>`;
    panel.innerHTML = html;
    panel.scrollTop = 0;

    focusbar.innerHTML = `<strong>${esc(fullName(p))}</strong>${rel ? ` · ${esc(rel)}` : ''} <button type="button" class="linklike" id="to-panel">деталі ↓</button>`;
    focusbar.hidden = false;
    $('to-panel').addEventListener('click', () => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  // ---------------------------------------------------------------------------
  // Search

  const norm = (s) => s.toLowerCase().replace(/[ʼ’'`]/g, "'").replace(/ё/g, 'е');
  let searchIndex = [];
  let results = [];
  let active = -1;

  function initSearch() {
    const input = $('q');
    const list = $('results');
    searchIndex = [...people.values()].map((p) => ({ id: p.id, name: norm(fullName(p)), given: norm(p.g || ''), surname: norm(p.s || '') }));

    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const go = (id) => {
      close();
      input.value = '';
      input.blur();
      location.hash = id;
    };
    const paint = () => {
      list.innerHTML = results.length
        ? results
            .map((id, i) => {
              const p = person(id);
              const sub = [fmtDate(p.b, true), relations.get(id)].filter(Boolean).join(' · ');
              return `<li role="option" id="opt-${i}" aria-selected="${i === active}"><a href="#${esc(id)}" tabindex="-1">${esc(fullName(p))}${sub ? `<span class="muted">${esc(sub)}</span>` : ''}</a></li>`;
            })
            .join('')
        : '<li class="empty muted">Нікого не знайдено</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${active}`);
      else input.removeAttribute('aria-activedescendant');
    };

    input.addEventListener('input', () => {
      const tokens = norm(input.value).split(/\s+/).filter(Boolean);
      if (!tokens.length) return close();
      const score = (e) => (tokens.some((t) => e.given.startsWith(t) || e.surname.startsWith(t)) ? 0 : 1);
      results = searchIndex
        .filter((e) => tokens.every((t) => e.name.includes(t)))
        .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, 'uk'))
        .slice(0, 12)
        .map((e) => e.id);
      active = results.length ? 0 : -1;
      paint();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (list.hidden || !results.length) return;
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        paint();
        $(`opt-${active}`)?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (active >= 0 && results[active]) {
          e.preventDefault();
          go(results[active]);
        }
      } else if (e.key === 'Escape') {
        input.value = '';
        close();
      }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus until click
    list.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      go(a.getAttribute('href').slice(1));
    });
    input.addEventListener('blur', () => setTimeout(close, 100));
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement === document.body) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Everyone, grouped by surname

  function initPeopleDialog() {
    const dialog = $('people');
    const groups = new Map();
    for (const p of people.values()) {
      const key = p.s || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const keys = [...groups.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b, 'uk')));
    $('people-title').textContent = `Усі люди · ${people.size}`;
    $('people-list').innerHTML = keys
      .map((k) => {
        const list = groups
          .get(k)
          .sort((a, b) => (a.g || 'я').localeCompare(b.g || 'я', 'uk') || (yearOf(a) || 0) - (yearOf(b) || 0));
        return `<section><h3>${k ? esc(k) : 'Без прізвища'} <span class="muted">${list.length}</span></h3><ul>${list
          .map((p) => `<li><a href="#${esc(p.id)}">${esc(p.g || UNKNOWN)}</a>${p.b ? ` <span class="year">${esc(fmtDate(p.b, true))}</span>` : ''}</li>`)
          .join('')}</ul></section>`;
      })
      .join('');
    $('all-btn').addEventListener('click', () => dialog.showModal());
    $('people-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('a')) dialog.close();
    });
  }

  // ---------------------------------------------------------------------------
  // Routing

  const idFromHash = () => {
    const h = decodeURIComponent(location.hash.slice(1));
    return people.has(h) ? h : rootId;
  };

  function show(id, animate) {
    focusId = id;
    currentLayout = render(id, animate);
    frame(currentLayout, { animate, fit: !animate, minK: 0.6 });
    renderPanel(id);
    const p = person(id);
    document.title = id === rootId ? 'Сімейне дерево' : `${fullName(p)} — Сімейне дерево`;
  }

  function init(data) {
    rootId = data.root;
    for (const p of data.people) people.set(p.id, { ...p, f: p.f || [] });
    for (const f of data.families) families.set(f.id, { ...f, k: f.k || [] });
    for (const id of people.keys()) relations.set(id, computeRelation(id));

    const depth = new Map();
    const gen = (id) => {
      if (!depth.has(id)) {
        depth.set(id, 1);
        depth.set(id, 1 + Math.max(0, ...parentsOf(id).map(gen)));
      }
      return depth.get(id);
    };
    const years = [...people.values()].map(yearOf).filter(Boolean);
    meta = {
      generations: Math.max(...[...people.keys()].map(gen)),
      firstYear: Math.min(...years),
      privateAfter: data.privateAfter,
      updated: data.updated.split('-').reverse().join('.'),
    };

    $('brand').href = `#${rootId}`;
    initPanZoom();
    initSearch();
    initPeopleDialog();
    show(idFromHash(), false);
    window.addEventListener('hashchange', () => {
      const id = idFromHash();
      if (id !== focusId) {
        hideHint();
        show(id, true);
      }
    });
  }

  fetch('data.json')
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(init)
    .catch((err) => {
      console.error(err);
      panel.innerHTML = '<p>Не вдалося завантажити дерево. Спробуйте оновити сторінку.</p>';
    });
})();
