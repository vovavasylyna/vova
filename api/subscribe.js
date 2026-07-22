// POST /api/subscribe
// Step 1 of double opt-in. Validates the email, then sends a confirmation email
// containing a signed, expiring link. Nothing is stored yet — the link itself carries
// an HMAC-signed token, so a reader is only added to Resend once they click it
// (see api/confirm.js). No database required.

const crypto = require('crypto');

const {
  RESEND_API_KEY,
  NEWSLETTER_SECRET,
  NEWSLETTER_FROM = 'Volodymyr Vasylyna <newsletter@vasylyna.net>',
  SITE_URL, // optional override; otherwise derived from the request host
} = process.env;

const DEFAULT_ORIGIN = 'https://vasylyna.net';

// Build the confirmation link against the host that actually served the form, so
// Vercel preview deployments and `vercel dev` work without extra config. The host is
// allowlisted so a forged Host header can't redirect the link somewhere else.
function originFrom(req) {
  if (SITE_URL) return SITE_URL.replace(/\/$/, '');
  const host = String(req.headers.host || '');
  const isLocal = /^localhost(:\d+)?$/i.test(host);
  const allowed = isLocal || /(^|\.)vasylyna\.net$/i.test(host) || /\.vercel\.app$/i.test(host);
  if (!allowed) return DEFAULT_ORIGIN;
  return `${isLocal ? 'http' : req.headers['x-forwarded-proto'] || 'https'}://${host}`;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // confirmation links are valid for 24h
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// token = base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret))
function signToken(email) {
  const payload = b64url(JSON.stringify({ e: email, x: Date.now() + TOKEN_TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', NEWSLETTER_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function confirmationEmail(confirmUrl) {
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f6;font-family:Helvetica,Arial,sans-serif;color:#111;line-height:1.6;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;">
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0 0 12px;font-size:20px;">Confirm your subscription</h1>
        <p style="margin:0 0 16px;">Thanks for signing up to the newsletter from <strong>vasylyna.net</strong>. Please confirm your email address to start receiving new posts.</p>
        <p style="margin:0 0 24px;">
          <a href="${confirmUrl}" style="display:inline-block;padding:11px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Confirm subscription</a>
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#666;">Or paste this link into your browser:</p>
        <p style="margin:0 0 20px;font-size:13px;color:#666;word-break:break-all;"><a href="${confirmUrl}" style="color:#0000bb;">${confirmUrl}</a></p>
        <p style="margin:0;font-size:13px;color:#666;">This link expires in 24 hours. If you didn't request this, you can safely ignore this email — you won't be subscribed.</p>
      </td></tr>
      <tr><td style="padding:16px 28px 24px;border-top:1px solid #eee;font-size:12px;color:#999;">— Volodymyr Vasylyna · vasylyna.net</td></tr>
    </table>
  </body>
</html>`;

  const text = `Confirm your subscription

Thanks for signing up to the newsletter from vasylyna.net. Confirm your email address to start receiving new posts:

${confirmUrl}

This link expires in 24 hours. If you didn't request this, ignore this email — you won't be subscribed.

— Volodymyr Vasylyna · vasylyna.net`;

  return { html, text };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // The JS form posts fetch() with `Accept: application/json`; a no-JS form submit
  // navigates the page, so we redirect it to a friendly status page instead.
  const wantsJson = (req.headers.accept || '').includes('application/json');
  const reply = (status, jsonBody, redirectPath) =>
    wantsJson ? res.status(status).json(jsonBody) : res.redirect(303, redirectPath);

  let body = {};
  try {
    body = req.body || {};
  } catch {
    body = {};
  }

  const email = String(body.email || '').trim().toLowerCase();
  const honeypot = String(body.website || '').trim(); // hidden field; real people leave it empty

  // Bot caught by the honeypot — pretend it worked so we don't reveal the trap.
  if (honeypot) return reply(200, { ok: true }, '/check-inbox/');

  if (!EMAIL_RE.test(email)) {
    return reply(400, { error: 'Please enter a valid email address.' }, '/subscribe-invalid/');
  }

  if (!RESEND_API_KEY || !NEWSLETTER_SECRET) {
    console.error('Newsletter misconfigured: RESEND_API_KEY and/or NEWSLETTER_SECRET is missing');
    return reply(500, { error: 'The newsletter is not configured yet.' }, '/subscribe-invalid/');
  }

  const confirmUrl = `${SITE_URL}/api/confirm?token=${encodeURIComponent(signToken(email))}`;
  const { html, text } = confirmationEmail(confirmUrl);

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: NEWSLETTER_FROM,
        to: email,
        subject: 'Confirm your subscription',
        html,
        text,
      }),
    });

    if (!r.ok) {
      console.error('Resend send failed', r.status, await r.text());
      return reply(502, { error: 'Could not send the confirmation email. Please try again later.' }, '/subscribe-invalid/');
    }
  } catch (err) {
    console.error('Resend request error', err);
    return reply(502, { error: 'Could not send the confirmation email. Please try again later.' }, '/subscribe-invalid/');
  }

  return reply(200, { ok: true }, '/check-inbox/');
};
