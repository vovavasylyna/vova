#!/usr/bin/env node
// Checks whether Umami's numbers look like humans or bots.
//
// Umami only drops bots that admit it in their user-agent, so anything driving a
// real headless browser is counted as a visitor. This pulls the breakdowns that
// give those away and scores each one.
//
// Works off a Share URL, which is free — no Pro plan needed:
//   cloud.umami.is → Websites → Edit → Share URL → toggle on.
//   Enable at least the "Overview" and "Breakdown" sections.
//
//   node scripts/audit-bots.js https://cloud.umami.is/share/AbC123/vasylyna.net
//   node scripts/audit-bots.js https://cloud.umami.is/share/AbC123/vasylyna.net 7
//
// If you ever do have a Pro API key, this uses it instead:
//   UMAMI_API_KEY=... node scripts/audit-bots.js
//
// The share link is read-only and you choose what it exposes. Revoke it by
// toggling Share URL back off.

const CLOUD = 'https://cloud.umami.is';
const API = 'https://api.umami.is/v1';
const WEBSITE_ID = '695feae1-5ac1-478e-af34-0b7255de53a5';
const TIMEZONE = process.env.UMAMI_TZ || 'Europe/Kyiv';

const args = process.argv.slice(2);
const shareUrl = args.find((a) => a.includes('/share/')) || process.env.UMAMI_SHARE_URL;
const days = Number(args.find((a) => /^\d+$/.test(a)) || 30);

const endAt = Date.now();
const startAt = endAt - days * 24 * 60 * 60 * 1000;

// Umami Cloud namespaces each account by region, so a bare /share/<slug> link
// 307s to /analytics/<region>/share/<slug>. Follow it to learn where the API lives.
async function resolveRegion(slug) {
  const res = await fetch(`${CLOUD}/share/${slug}`, { redirect: 'follow' });
  const prefix = res.url?.split('/share/')[0];
  return prefix && prefix.startsWith(CLOUD) ? `${prefix}/api` : `${CLOUD}/api`;
}

// Resolves a share link into the token the dashboard itself uses. Both headers
// are required: the API rejects a share token presented outside a share context.
async function shareClient(url) {
  const slug = url.split('/share/')[1]?.split('/')[0]?.replace(/[?#].*$/, '');
  if (!slug) throw new Error(`Could not read a share slug out of "${url}"`);

  const base = await resolveRegion(slug);
  const res = await fetch(`${base}/share/${slug}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(
      `Share link lookup failed (${res.status}). Check the URL, and that Share URL is still toggled on.`
    );
  }
  const share = await res.json();
  if (!share.token) throw new Error('Share link resolved but returned no token.');

  const websiteId = share.websiteId || WEBSITE_ID;
  const headers = {
    Accept: 'application/json',
    'x-umami-share-token': share.token,
    'x-umami-share-context': slug,
  };
  return { base, websiteId, headers, parameters: share.parameters };
}

function apiKeyClient(key) {
  return {
    base: API,
    websiteId: WEBSITE_ID,
    headers: { Accept: 'application/json', 'x-umami-api-key': key },
  };
}

// The stats endpoint returns either a bare number or {value, prev} depending on version.
const num = (v) => (v && typeof v === 'object' ? Number(v.value) : Number(v)) || 0;

// Share of the total held by the named rows, as a percentage.
function shareOf(rows, names) {
  const total = rows.reduce((sum, r) => sum + r.y, 0);
  if (!total) return 0;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const hit = rows
    .filter((r) => wanted.has(String(r.x || '').toLowerCase()))
    .reduce((sum, r) => sum + r.y, 0);
  return (hit / total) * 100;
}

function table(title, rows, limit = 8) {
  const total = rows.reduce((sum, r) => sum + r.y, 0) || 1;
  console.log(`\n  ${title}`);
  if (!rows.length) return console.log('    (no data)');
  for (const r of rows.slice(0, limit)) {
    const pct = ((r.y / total) * 100).toFixed(1).padStart(5);
    console.log(`    ${pct}%  ${String(r.x || '(none)').slice(0, 40).padEnd(40)} ${r.y}`);
  }
}

const findings = [];
function flag(level, signal, detail) {
  findings.push({ level, signal, detail });
}

(async () => {
  let client;
  if (process.env.UMAMI_API_KEY) {
    client = apiKeyClient(process.env.UMAMI_API_KEY);
  } else if (shareUrl) {
    client = await shareClient(shareUrl);
  } else {
    console.error('Pass a Share URL, or set UMAMI_API_KEY. See the header of this file.');
    process.exit(1);
  }

  async function get(path, params = {}) {
    const url = new URL(`${client.base}/websites/${client.websiteId}${path}`);
    for (const [k, v] of Object.entries({ startAt, endAt, ...params })) {
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: client.headers });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' — the share link may not expose this section; enable Overview and Breakdown.'
          : '';
      throw new Error(`${res.status} ${res.statusText} on ${path}${hint}`);
    }
    return res.json();
  }

  const [stats, browser, os, device, screen, country, referrer, path, series] =
    await Promise.all([
      get('/stats'),
      get('/metrics', { type: 'browser' }),
      get('/metrics', { type: 'os' }),
      get('/metrics', { type: 'device' }),
      get('/metrics', { type: 'screen' }),
      get('/metrics', { type: 'country' }),
      get('/metrics', { type: 'referrer' }),
      get('/metrics', { type: 'path' }),
      get('/pageviews', { unit: 'hour', timezone: TIMEZONE }),
    ]);

  const pageviews = num(stats.pageviews);
  const visits = num(stats.visits);
  const visitors = num(stats.visitors);
  const bounces = num(stats.bounces);
  const totaltime = num(stats.totaltime);

  console.log(`\nvasylyna.net — last ${days} days (${TIMEZONE})`);
  console.log('='.repeat(60));
  console.log(`  ${pageviews} pageviews · ${visits} visits · ${visitors} visitors`);

  // 1. Bounce rate + time on site. A bot loads one page and leaves instantly.
  const bounceRate = visits ? (bounces / visits) * 100 : 0;
  const avgSeconds = visits ? totaltime / visits : 0;
  const perVisit = visits ? pageviews / visits : 0;
  console.log(
    `  ${bounceRate.toFixed(1)}% bounce · ${avgSeconds.toFixed(0)}s avg visit · ` +
      `${perVisit.toFixed(2)} pages/visit`
  );
  if (bounceRate > 90 && avgSeconds < 5) {
    flag('strong', 'Bounce + duration', `${bounceRate.toFixed(0)}% bounce at ${avgSeconds.toFixed(0)}s per visit — humans do not read that fast`);
  } else if (bounceRate > 80) {
    flag('weak', 'Bounce rate', `${bounceRate.toFixed(0)}% is high, but normal for a blog people land on from a link`);
  }

  // 2. Hour-of-day curve. Humans sleep; schedulers do not.
  const buckets = new Array(24).fill(0);
  const points = Array.isArray(series) ? series : series.pageviews || [];
  for (const p of points) {
    // Values come back as "2026-07-01 13:00:00" or ISO — the hour is in the same slot.
    const match = String(p.x).match(/[T ](\d{2}):/);
    if (match) buckets[Number(match[1])] += p.y;
  }
  const totalViews = buckets.reduce((a, b) => a + b, 0);
  if (totalViews > 50) {
    const night = buckets.slice(1, 6).reduce((a, b) => a + b, 0); // 01:00–05:59
    const nightShare = (night / totalViews) * 100;
    // 5 of 24 hours is 20.8% under a perfectly flat distribution.
    console.log(`\n  Overnight (01:00–06:00): ${nightShare.toFixed(1)}% of pageviews  [flat = 20.8%, human ≈ 3–8%]`);
    const peak = Math.max(...buckets);
    const bar = buckets.map((v) => ' ▁▂▃▄▅▆▇█'[Math.round((v / peak) * 8)] || ' ');
    console.log(`    ${bar.join('')}`);
    console.log('    0h      6h      12h     18h  ');
    if (nightShare > 15) {
      flag('strong', 'Hour-of-day curve', `${nightShare.toFixed(0)}% of traffic lands between 1am and 6am — that is a flat, machine-like distribution`);
    } else if (nightShare > 10) {
      flag('weak', 'Hour-of-day curve', `${nightShare.toFixed(0)}% overnight is a little high, could be a foreign timezone audience`);
    }
  } else {
    console.log('\n  Too few pageviews for the hour-of-day test.');
  }

  // 3. Datacenter fingerprints in the client breakdowns.
  table('Browser', browser);
  table('OS', os);
  table('Device', device);
  table('Screen', screen);
  table('Country', country);
  table('Referrer', referrer);
  table('Top paths', path);

  // Real audiences are a mix. Any single value dominating a breakdown means one
  // machine, or one fleet, repeating itself — regardless of which value it is.
  const top = (rows) => {
    const total = rows.reduce((s, r) => s + r.y, 0) || 1;
    const first = rows[0];
    return first ? { label: String(first.x), pct: (first.y / total) * 100 } : null;
  };

  const topOs = top(os);
  if (topOs && topOs.pct > 70) {
    flag('strong', 'OS monoculture', `${topOs.pct.toFixed(0)}% of visits report ${topOs.label} — a real audience spreads across Windows, macOS, iOS and Android`);
  }

  const linuxShare = shareOf(os, ['Linux', 'Ubuntu', 'GNU/Linux']);
  if (linuxShare > 20) {
    flag('strong', 'Server OS', `${linuxShare.toFixed(0)}% Linux — that share means datacenter machines, not readers`);
  }

  // A monitor size is hardware; thousands of visits at one exact pixel count is not.
  const topScreen = top(screen);
  if (topScreen && topScreen.pct > 50) {
    const known = ['800x600', '1280x720', '1920x1080', '1024x768'].includes(topScreen.label);
    flag('strong', 'Screen monoculture',
      `${topScreen.pct.toFixed(0)}% of visits report exactly ${topScreen.label}` +
      (known ? ' — a default headless viewport' : ' — a synthetic viewport, no such monitor is standard'));
  }

  const desktopShare = shareOf(device, ['desktop', 'laptop']);
  if (desktopShare > 92) {
    flag('weak', 'Device mix', `${desktopShare.toFixed(0)}% desktop — headless browsers never report as mobile`);
  }

  // Cloud regions, not readerships. Heavy concentration here is a hosting bill.
  const datacenterShare = shareOf(country, ['SG', 'VN', 'CN', 'NL', 'IE', 'IN', 'HK']);
  if (datacenterShare > 40) {
    flag('strong', 'Geography', `${datacenterShare.toFixed(0)}% from Singapore/Vietnam/China/Netherlands/Ireland/India/Hong Kong — these are where cheap compute lives`);
  } else if (datacenterShare > 25) {
    flag('weak', 'Geography', `${datacenterShare.toFixed(0)}% from common datacenter regions`);
  }

  // Bots arrive at a URL directly. People arrive from somewhere.
  const referrerTotal = referrer.reduce((s, r) => s + r.y, 0);
  if (visits > 50) {
    const directShare = ((visits - referrerTotal) / visits) * 100;
    if (directShare > 90) {
      flag('strong', 'No referrers', `${directShare.toFixed(0)}% of visits arrived with no referrer at all — only ${referrerTotal} of ${visits} came from a link or a search`);
    }
  }

  // Readers pile onto one or two posts. Crawlers walk the whole sitemap evenly.
  const pathTotal = path.reduce((s, r) => s + r.y, 0) || 1;
  const spread = path.slice(0, 10).filter((r) => (r.y / pathTotal) * 100 > 3).length;
  const topPath = top(path);
  if (topPath && topPath.pct < 15 && spread >= 7) {
    flag('strong', 'Flat path spread', `no post is above ${topPath.pct.toFixed(0)}% while ${spread} sit at a near-identical share — that is a sweep through the sitemap, not reading`);
  }

  console.log('\n' + '='.repeat(60));
  if (!findings.length) {
    console.log('VERDICT: nothing here looks like bot traffic.');
    console.log('The breakdowns above have the shape of real people.');
  } else {
    const strong = findings.filter((f) => f.level === 'strong');
    console.log(
      strong.length
        ? 'VERDICT: yes, this looks like bot traffic.'
        : 'VERDICT: mostly human, with some soft signals worth watching.'
    );
    for (const f of findings) {
      console.log(`\n  [${f.level === 'strong' ? '!!' : ' ?'}] ${f.signal}`);
      console.log(`       ${f.detail}`);
    }
  }
  console.log('');
})().catch((err) => {
  console.error(`\nFailed: ${err.message}\n`);
  process.exit(1);
});
