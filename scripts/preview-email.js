#!/usr/bin/env node
// Renders the newsletter email to an HTML file you can open in a browser.
// Uses the same template as the live cron job, so the preview is accurate.
//
//   hugo                              # build first, to refresh public/posts/index.json
//   node scripts/preview-email.js     # newest post
//   node scripts/preview-email.js 2   # 3rd newest post (0-indexed)

const fs = require('fs');
const path = require('path');
const { renderPostEmail } = require('../lib/broadcast-email');

const feedPath = path.join(__dirname, '..', 'public', 'posts', 'index.json');
if (!fs.existsSync(feedPath)) {
  console.error('No public/posts/index.json — run `hugo` first.');
  process.exit(1);
}

const posts = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
const index = Number(process.argv[2] || 0);
const post = posts[index];

if (!post) {
  console.error(`No post at index ${index}. The feed has ${posts.length}.`);
  process.exit(1);
}

const { subject, html, text } = renderPostEmail(post, {
  // A real-looking placeholder: in production Resend swaps in the actual URL.
  unsubscribeUrl: 'https://vasylyna.net/unsubscribe-example',
});

const outDir = path.join(__dirname, '..', 'public', '_preview');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'email.html');
fs.writeFileSync(outFile, html);

console.log(`Subject: ${subject}`);
console.log(`Date:    ${post.date}`);
console.log(`Text:    ${text.length} chars, HTML: ${html.length} chars`);
console.log(`Written: ${outFile}`);
