// Renders the newsletter email for a single blog post.
// Shared by api/cron-broadcast.js (production) and scripts/preview-email.js (local preview),
// so what you preview is byte-for-byte what subscribers receive.

const DEFAULT_SITE = 'https://vasylyna.net';

// Post HTML from Hugo uses root-relative links (/posts/foo, /images/bar.jpg).
// Those break in an inbox, so rewrite them to absolute URLs.
function absolutize(html, base) {
  return String(html || '')
    .replace(/(href|src)="\/(?!\/)/g, `$1="${base}/`)
    .replace(/(href|src)='\/(?!\/)/g, `$1='${base}/`);
}

function toPlainText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param post {title, url, date, summary, content}
 * @param opts.siteUrl        base URL for absolutising links
 * @param opts.unsubscribeUrl '{{{RESEND_UNSUBSCRIBE_URL}}}' in production, a dummy for previews
 */
function renderPostEmail(post, opts) {
  const o = opts || {};
  const site = (o.siteUrl || DEFAULT_SITE).replace(/\/$/, '');
  const unsubscribeUrl = o.unsubscribeUrl || '{{{RESEND_UNSUBSCRIBE_URL}}}';
  const host = site.replace(/^https?:\/\//, '');

  const title = escapeHtml(post.title);
  const url = escapeHtml(post.url);
  const content = absolutize(post.content, site);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title}</title>
<style>
  body { margin:0; padding:0; background:#f6f6f6; }
  .wrap { width:100%; background:#f6f6f6; padding:24px 12px; }
  .card { max-width:600px; margin:0 auto; background:#ffffff; border:1px solid #e5e5e5; border-radius:8px; }
  .inner { padding:28px 30px; font-family:Helvetica,Arial,sans-serif; font-size:16px; line-height:1.6; color:#000; }
  .kicker { font-size:13px; color:#767676; margin:0 0 18px; }
  .kicker a { color:#767676; }
  h1 { font-size:24px; line-height:1.25; margin:0 0 6px; color:#000; }
  .date { font-family:monospace; font-size:13px; color:#767676; margin:0 0 22px; }
  .post h2 { font-size:19px; margin:26px 0 6px; }
  .post h3 { font-size:16px; margin:22px 0 6px; }
  .post p { margin:0 0 14px; }
  .post a { color:#0000bb; }
  .post img { max-width:100%; height:auto; border-radius:4px; }
  .post ul, .post ol { margin:0 0 14px; padding-left:22px; }
  .post li { margin-bottom:6px; }
  .post blockquote { margin:18px 0; padding:8px 14px; background:#eeeeee; border-left:4px solid #cccccc; font-style:italic; }
  .post pre { background:#eeeeee; padding:10px; overflow:auto; font-size:14px; border-radius:4px; }
  .post code { font-size:14px; }
  .post hr { border:0; border-top:1px solid #e5e5e5; margin:22px 0; }
  .readmore { margin:28px 0 0; padding-top:20px; border-top:1px solid #e5e5e5; }
  .readmore a { color:#0000bb; font-weight:bold; text-decoration:none; }
  .foot { max-width:600px; margin:16px auto 0; font-family:Helvetica,Arial,sans-serif; font-size:12px; line-height:1.6; color:#8a8a8a; text-align:center; }
  .foot a { color:#8a8a8a; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="inner">
        <p class="kicker"><a href="${site}/">${host}</a></p>
        <h1>${title}</h1>
        <p class="date">${escapeHtml(post.date || '')}</p>
        <div class="post">${content}</div>
        <p class="readmore"><a href="${url}">Read this post on the web →</a></p>
      </div>
    </div>
    <div class="foot">
      <p>You're receiving this because you subscribed to the newsletter at ${host}.<br>
      <a href="${unsubscribeUrl}">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;

  const text = `${post.title}
${post.date || ''}

${toPlainText(post.content)}

Read this post on the web: ${post.url}

—
You're receiving this because you subscribed to the newsletter at ${host}.
Unsubscribe: ${unsubscribeUrl}`;

  return { subject: post.title, html, text };
}

module.exports = { renderPostEmail, absolutize, toPlainText };
