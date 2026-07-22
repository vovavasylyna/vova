// GET /api/confirm?token=...
// Step 2 of double opt-in. Verifies the signed token from the confirmation email and,
// if it's valid and unexpired, adds the reader to Resend as a subscribed contact.
// Redirects to a friendly status page either way.

const crypto = require('crypto');

const {
  RESEND_API_KEY,
  NEWSLETTER_SECRET,
  // Confirmed contacts are added to this Resend segment. Broadcasts target a
  // segment, so without it the newsletter has nobody to send to.
  RESEND_SEGMENT_ID,
  NEWSLETTER_FROM = 'Volodymyr Vasylyna <newsletter@vasylyna.net>',
  // Where to send "you have a new subscriber" notifications. Unset = no notifications.
  NOTIFY_EMAIL,
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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Add (or re-subscribe) a confirmed contact.
//
// New contact  → POST /contacts, which can attach the segment in one call.
// Existing one → POST fails, so PATCH clears `unsubscribed` and a second call puts
//                them back in the segment (PATCH alone cannot change membership).
//
// Note `segments` takes objects, not bare ids: [{ id }] — a plain [id] is rejected.
async function subscribeContact(email) {
  const contact = { email, unsubscribed: false };
  if (RESEND_SEGMENT_ID) contact.segments = [{ id: RESEND_SEGMENT_ID }];

  const created = await resend('/contacts', 'POST', contact);
  if (created.ok) return true;
  const createdDetail = await created.text();

  const updated = await resend(`/contacts/${encodeURIComponent(email)}`, 'PATCH', { unsubscribed: false });
  if (!updated.ok) {
    console.error('Resend subscribe failed', created.status, createdDetail, updated.status, await updated.text());
    return false;
  }

  if (RESEND_SEGMENT_ID) {
    const seg = await resend(
      `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(RESEND_SEGMENT_ID)}`,
      'POST'
    );
    // Already-a-member is fine; only log a genuine failure. They are subscribed either way.
    if (!seg.ok) console.error('Could not add re-subscriber to segment', seg.status, await seg.text());
  }
  return true;
}

// Fire-and-forget heads-up to the site owner. Never allowed to break the
// subscription itself — a failed notification is logged and ignored.
async function notifyOwner(email) {
  if (!NOTIFY_EMAIL) return;
  try {
    const r = await resend('/emails', 'POST', {
      from: NEWSLETTER_FROM,
      to: NOTIFY_EMAIL,
      subject: `New newsletter subscriber: ${email}`,
      text: `${email} just confirmed their subscription to the vasylyna.net newsletter.`,
    });
    if (!r.ok) console.error('Subscriber notification failed', r.status, await r.text());
  } catch (err) {
    console.error('Subscriber notification error', err);
  }
}

module.exports = async (req, res) => {
  const email = verifyToken(req.query.token);
  if (!email) return res.redirect(302, '/subscribe-invalid/');

  // Past this point the link itself was valid, so any failure is ours, not the
  // reader's. Sending them to "link expired" would be a lie that tells them to
  // retry something that will fail again — /subscribe-error/ says so honestly.
  if (!RESEND_API_KEY || !NEWSLETTER_SECRET) {
    console.error('Newsletter misconfigured: RESEND_API_KEY and/or NEWSLETTER_SECRET is missing');
    return res.redirect(302, '/subscribe-error/');
  }

  try {
    const ok = await subscribeContact(email);
    if (ok) await notifyOwner(email);
    return res.redirect(302, ok ? '/subscribed/' : '/subscribe-error/');
  } catch (err) {
    console.error('Resend request error', err);
    return res.redirect(302, '/subscribe-error/');
  }
};
