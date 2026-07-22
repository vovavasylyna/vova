// GET /api/cron-broadcast — invoked daily by Vercel Cron (see vercel.json).
//
// Reads /posts/index.json, and for every post that hasn't been broadcast yet
// creates a Resend broadcast. Cron delivery is best-effort and can fire twice,
// so this is idempotent: each broadcast is named `post:<slug>` and the job skips
// any name that already exists in Resend.
//
// Safety: by default a broadcast is created as a DRAFT and you get an email to
// review and send it. Set BROADCAST_AUTOSEND=true to have it sent automatically.

const { renderPostEmail } = require('../lib/broadcast-email');

const {
  RESEND_API_KEY,
  RESEND_SEGMENT_ID,
  NEWSLETTER_FROM = 'Volodymyr Vasylyna <newsletter@vasylyna.net>',
  SITE_URL = 'https://vasylyna.net',
  CRON_SECRET,
  BROADCAST_SINCE, // e.g. "2026-07-22" — posts dated before this are never sent
  BROADCAST_AUTOSEND,
  NOTIFY_EMAIL,
} = process.env;

const site = SITE_URL.replace(/\/$/, '');
const autosend = String(BROADCAST_AUTOSEND).toLowerCase() === 'true';

async function resend(path, method, body) {
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, json, text };
}

// https://vasylyna.net/posts/dora/ → "dora"
function slugFromUrl(url) {
  const parts = String(url).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

async function sendEmail(to, subject, text) {
  return resend('/emails', 'POST', { from: NEWSLETTER_FROM, to, subject, text });
}

module.exports = async (req, res) => {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!RESEND_API_KEY || !RESEND_SEGMENT_ID) {
    return res.status(500).json({ error: 'RESEND_API_KEY and RESEND_SEGMENT_ID must be set' });
  }

  // Without an explicit start date we never send anything — otherwise the first
  // run would blast the entire back catalogue at everyone.
  const dryRun = req.query.dry === '1' || !BROADCAST_SINCE;

  try {
    const feedRes = await fetch(`${site}/posts/index.json`, { headers: { 'cache-control': 'no-cache' } });
    if (!feedRes.ok) {
      return res.status(502).json({ error: `Could not read post feed (${feedRes.status})` });
    }
    const posts = await feedRes.json();

    const eligible = posts.filter((p) => !BROADCAST_SINCE || p.date >= BROADCAST_SINCE);

    const list = await resend('/broadcasts', 'GET');
    if (!list.ok) {
      return res.status(502).json({ error: 'Could not list broadcasts', detail: list.text });
    }
    const existing = new Set(((list.json && list.json.data) || []).map((b) => b.name));

    const pending = eligible.filter((p) => !existing.has(`post:${slugFromUrl(p.url)}`));

    if (dryRun) {
      return res.status(200).json({
        dryRun: true,
        reason: BROADCAST_SINCE ? 'requested via ?dry=1' : 'BROADCAST_SINCE is not set',
        wouldCreate: pending.map((p) => ({ name: `post:${slugFromUrl(p.url)}`, title: p.title, date: p.date })),
      });
    }

    const created = [];
    for (const post of pending) {
      const name = `post:${slugFromUrl(post.url)}`;
      const { subject, html, text } = renderPostEmail(post, { siteUrl: site });

      const made = await resend('/broadcasts', 'POST', {
        segment_id: RESEND_SEGMENT_ID,
        from: NEWSLETTER_FROM,
        subject,
        name,
        html,
        text,
      });

      if (!made.ok) {
        console.error('Broadcast create failed', name, made.status, made.text);
        created.push({ name, ok: false, error: made.text });
        continue;
      }

      const id = made.json && made.json.id;
      let sent = false;
      if (autosend && id) {
        const sendRes = await resend(`/broadcasts/${id}/send`, 'POST', {});
        sent = sendRes.ok;
        if (!sendRes.ok) console.error('Broadcast send failed', name, sendRes.status, sendRes.text);
      }
      created.push({ name, id, ok: true, sent });

      if (NOTIFY_EMAIL) {
        await sendEmail(
          NOTIFY_EMAIL,
          sent ? `Newsletter sent: ${post.title}` : `Newsletter draft ready: ${post.title}`,
          sent
            ? `"${post.title}" has been sent to your subscribers.\n\n${post.url}`
            : `A draft broadcast for "${post.title}" is waiting in Resend.\n\nReview and send it: https://resend.com/broadcasts\n\nPost: ${post.url}`
        ).catch((err) => console.error('notify failed', err));
      }
    }

    return res.status(200).json({ autosend, created });
  } catch (err) {
    console.error('cron-broadcast error', err);
    return res.status(500).json({ error: 'Unexpected failure' });
  }
};
