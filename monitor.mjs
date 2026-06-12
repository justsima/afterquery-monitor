// monitor.mjs
// Runs in GitHub Actions on a schedule. Restores the saved Firebase session,
// opens the Pluto submissions page in headless Chromium, and watches ONE thing:
// whether submissions are PAUSED or OPEN. It pings Telegram the moment the
// pause is lifted (paused -> open), and also if the session needs re-capturing.
//
// Why a boolean instead of a full-text diff: the goal is "tell me when the
// 'Submissions are currently paused' state changes" — not "tell me when any
// submission row changes". Tracking the pause flag directly avoids false alerts.

import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET_URL = 'https://experts.afterquery.com/projects/pluto?tab=submissions';
const STATE_FILE = 'state/last.txt';

// Phrases that mean "you cannot submit right now".
const PAUSED_PATTERNS = [
  /submissions are currently paused/i,
  /submissions paused/i,
  /submissions are temporarily (closed|paused)/i,
];
// Proof the real page actually rendered for a logged-in user. If none of these
// are present we assume a render failure / logout and refuse to draw any
// conclusion (prevents a false "it's open!" alert from a blank page).
const ANCHOR_PATTERNS = [/add submission/i, /my submissions/i, /requirements for approval/i];

if (process.env.AFTERQUERY_AUTH_B64) {
  fs.writeFileSync('auth.json', Buffer.from(process.env.AFTERQUERY_AUTH_B64, 'base64'));
}
if (!fs.existsSync('auth.json')) {
  console.error('No auth.json and no AFTERQUERY_AUTH_B64 secret. Aborting.');
  process.exit(1);
}

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.log('[notify skipped — no Telegram creds]', text);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    console.log('[telegram]', r.status, r.ok ? 'ok' : await r.text());
  } catch (e) {
    console.error('[telegram error]', e.message);
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: 'auth.json' });
const page = await context.newPage();

let bodyText = '';
let expired = false;
try {
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
  // Wait until the app has actually rendered the submissions UI (or give up).
  try {
    await page.waitForFunction(
      () => /add submission|my submissions/i.test(document.body.innerText || ''),
      { timeout: 25000 }
    );
  } catch {
    await page.waitForTimeout(6000);
  }

  const url = page.url();
  bodyText = await page.evaluate(() => document.body.innerText || '');

  const looksLikeLogin =
    /\/login/i.test(url) ||
    (/continue with google|sign in to|log in/i.test(bodyText) && bodyText.length < 1500);
  if (looksLikeLogin) expired = true;

  try { await page.screenshot({ path: 'debug.png', fullPage: true }); } catch {}
} catch (e) {
  console.error('Navigation error:', e.message);
  try { await page.screenshot({ path: 'debug.png', fullPage: true }); } catch {}
} finally {
  await browser.close();
}

if (expired) {
  console.log('Session expired.');
  await notify('⚠️ AfterQuery monitor: your login session expired. Re-run `node capture-auth.mjs` and update the AFTERQUERY_AUTH_B64 secret.');
  process.exit(0);
}

// Did the page really render? If not, stay silent — never guess "open".
const rendered = ANCHOR_PATTERNS.some((re) => re.test(bodyText));
if (!rendered) {
  console.log('Page did not render the submissions UI (no anchor found). Skipping — see debug.png artifact.');
  process.exit(0);
}

const paused = PAUSED_PATTERNS.some((re) => re.test(bodyText));
const current = paused ? 'paused' : 'open';

const prevRaw = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8').trim() : '';
const prev = prevRaw === 'paused' || prevRaw === 'open' ? prevRaw : null; // null = first run / reset

fs.mkdirSync('state', { recursive: true });
fs.writeFileSync(STATE_FILE, current);

console.log(`prev=${prev ?? '(none)'} current=${current}`);

if (prev === null) {
  // First run (or migrating from the old state format): just report status.
  if (paused) {
    await notify('🔕 AfterQuery Pluto: submissions are currently PAUSED.\nI\'ll message you the instant they reopen.\n' + TARGET_URL);
  } else {
    await notify('🟢 AfterQuery Pluto: submissions are currently OPEN.\n' + TARGET_URL);
  }
} else if (prev === 'paused' && current === 'open') {
  await notify('🎉🎉 AfterQuery Pluto SUBMISSIONS ARE OPEN! The pause has been lifted — go add your submission:\n' + TARGET_URL);
} else if (prev === 'open' && current === 'paused') {
  await notify('🔕 Heads up: AfterQuery Pluto submissions were just PAUSED again.\n' + TARGET_URL);
} else {
  console.log('No change in pause status.');
}
