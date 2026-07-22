// GET /api/confirm?token=...
// Step 2 of double opt-in. Verifies the signed token from the confirmation email and,
// if it's valid and unexpired, adds the reader to Resend as a subscribed contact.
// Redirects to a friendly status page either way.

const crypto = require('crypto');

const {
  RESEND_API_KEY,
  NEWSLETTER_SECRET,
  // Optional: if set, confirmed contacts are also added to this Resend segment.
  // Leave unset to just add them to your global contact list.
  RESEND_SEGMENT_ID,
} = process.env;

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Returns the email if the token's signature and expiry check out, otherwise null.
function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;

  const expected = crypto.createHmac('sha256', NEWSLETTER_SECRET).update(payload).digest();
  const given = b64urlToBuf(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  let data;
  try {
    data = JSON.parse(b64urlToBuf(payload).toString('utf8'));
  } catch {
    return null;
  }
  if (!data.e || !data.x || Date.now() > data.x) return null;
  return data.e;
}

async function resend(path, method, body) {
  return fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// Add (or re-subscribe) a confirmed contact. POST creates a new contact; if it already
// exists, PATCH flips `unsubscribed` back to false so re-subscribing works too.
async function subscribeContact(email) {
  const contact = { email, unsubscribed: false };
  if (RESEND_SEGMENT_ID) contact.segments = [RESEND_SEGMENT_ID];

  const created = await resend('/contacts', 'POST', contact);
  if (created.ok) return true;

  const updated = await resend(`/contacts/${encodeURIComponent(email)}`, 'PATCH', { unsubscribed: false });
  if (updated.ok) return true;

  console.error('Resend subscribe failed', created.status, await created.text(), updated.status, await updated.text());
  return false;
}

module.exports = async (req, res) => {
  const email = verifyToken(req.query.token);
  if (!email) return res.redirect(302, '/subscribe-invalid/');

  if (!RESEND_API_KEY || !NEWSLETTER_SECRET) {
    console.error('Newsletter misconfigured: RESEND_API_KEY and/or NEWSLETTER_SECRET is missing');
    return res.redirect(302, '/subscribe-invalid/');
  }

  try {
    const ok = await subscribeContact(email);
    return res.redirect(302, ok ? '/subscribed/' : '/subscribe-invalid/');
  } catch (err) {
    console.error('Resend request error', err);
    return res.redirect(302, '/subscribe-invalid/');
  }
};
