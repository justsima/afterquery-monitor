// monitor.mjs
// Runs in GitHub Actions every hour. Restores the saved Firebase session, opens
// the Pluto submissions page in headless Chromium, and watches ONE thing:
// whether submissions are PAUSED or OPEN.
//
// Notifications (Telegram):
//   • paused -> open : alert 3× with a 30s gap (hard to miss)
//   • open -> paused : single heads-up
//   • no change      : one daily "still working" check-in at ~14:00 Addis time
//                      (11:00 UTC), de-duped so it sends at most once per day
//   • session dead   : ⚠️ asking you to re-capture the login

import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET_URL = 'https://experts.afterquery.com/projects/pluto?tab=submissions';
const STATE_FILE = 'state/last.txt';        // holds "paused" or "open"
const DAILY_PING_FILE = 'state/daily_ping.txt'; // holds last YYYY-MM-DD heartbeat was sent

const PAUSED_PATTERNS = [
  /submissions are currently paused/i,
  /submissions paused/i,
  /submissions are temporarily (closed|paused)/i,
];
const ANCHOR_PATTERNS = [/add submission/i, /my submissions/i, /requirements for approval/i];

if (process.env.AFTERQUERY_AUTH_B64) {
  fs.writeFileSync('auth.json', Buffer.from(process.env.AFTERQUERY_AUTH_B64, 'base64'));
}
if (!fs.existsSync('auth.json')) {
  console.error('No auth.json and no AFTERQUERY_AUTH_B64 secret. Aborting.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Send the same alert several times, spaced out, so it can't be missed.
async function notifyRepeat(text, times = 3, gapMs = 30000) {
  for (let i = 0; i < times; i++) {
    await notify(`${text}\n\n(${i + 1}/${times})`);
    if (i < times - 1) await sleep(gapMs);
  }
}

// One reassurance message per day around 14:00 Addis (11:00 UTC). Only fires on
// "nothing changed" days; de-duped via a committed state file.
async function maybeDailyCheckIn(current) {
  const now = new Date();
  const h = now.getUTCHours();
  if (h < 11 || h > 12) return; // ~14:00–15:00 EAT window
  const today = now.toISOString().slice(0, 10);
  const last = fs.existsSync(DAILY_PING_FILE) ? fs.readFileSync(DAILY_PING_FILE, 'utf8').trim() : '';
  if (last === today) return;
  fs.writeFileSync(DAILY_PING_FILE, today);
  const status = current === 'paused' ? 'still PAUSED' : 'currently OPEN';
  await notify(
    `🕑 Daily check-in (2 PM Addis): AfterQuery Pluto submissions are ${status}. ` +
    `Monitor is running fine — I\'ll alert you 3× the instant anything changes.\n${TARGET_URL}`
  );
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: 'auth.json' });
const page = await context.newPage();

// Wait for the submissions UI text to actually appear. NOTE: do NOT use
// waitUntil:'networkidle' — Firebase keeps streaming connections open so the
// page never goes idle and goto() would time out. Use domcontentloaded + poll.
async function waitForRender() {
  return page
    .waitForFunction(
      () => /add submission|my submissions/i.test(document.body.innerText || ''),
      { timeout: 30000 }
    )
    .then(() => true)
    .catch(() => false);
}

let bodyText = '';
let expired = false;
try {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let ok = await waitForRender();
  if (!ok) {
    // one retry — transient slow load or auth restore lag
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    ok = await waitForRender();
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

let changed = false;
if (prev === null) {
  if (paused) {
    await notify('🔕 AfterQuery Pluto: submissions are currently PAUSED.\nI\'ll message you (3×) the instant they reopen, and send a daily 2 PM check-in until then.\n' + TARGET_URL);
  } else {
    await notify('🟢 AfterQuery Pluto: submissions are currently OPEN.\n' + TARGET_URL);
  }
} else if (prev === 'paused' && current === 'open') {
  changed = true;
  await notifyRepeat('🎉🎉 AfterQuery Pluto SUBMISSIONS ARE OPEN! The pause has been lifted — go add your submission:\n' + TARGET_URL, 3, 30000);
} else if (prev === 'open' && current === 'paused') {
  changed = true;
  await notify('🔕 Heads up: AfterQuery Pluto submissions were just PAUSED again.\n' + TARGET_URL);
} else {
  console.log('No change in pause status.');
}

// Daily "still working" reassurance — only on no-change days (and not the baseline run).
if (prev !== null && !changed) {
  await maybeDailyCheckIn(current);
}
