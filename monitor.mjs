// monitor.mjs
// Runs in GitHub Actions on a schedule. Restores the saved Firebase session,
// opens the Pluto submissions page in headless Chromium, extracts the
// submissions text, compares it against the last run, and pings Telegram when
// it changes (or when the session has expired and needs re-capturing).

import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET_URL = 'https://experts.afterquery.com/projects/pluto?tab=submissions';
const STATE_FILE = 'state/last.txt';
// Which part of the page to watch. After your first real run, look at
// state/last.txt to see what's captured, then narrow this via the
// MONITOR_SELECTOR repo variable if there's too much noise.
const SELECTOR = process.env.MONITOR_SELECTOR || 'main';

// In CI the session arrives base64-encoded in a secret. Decode it to auth.json.
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

function normalize(s) {
  // Strip volatile bits so relative timestamps don't look like "changes".
  return s
    .replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago/gi, '')
    .replace(/just now/gi, '')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: 'auth.json' });
const page = await context.newPage();

let content = '';
let expired = false;
try {
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(6000); // give Firestore time to render the list

  const url = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText || '');

  // Heuristic: bounced to the login screen => session no longer valid.
  const looksLikeLogin =
    /\/login/i.test(url) ||
    (/continue with google|sign in to|log in/i.test(bodyText) && bodyText.length < 1500);

  if (looksLikeLogin) {
    expired = true;
  } else {
    try {
      content = await page.locator(SELECTOR).first().innerText({ timeout: 10000 });
    } catch {
      content = bodyText;
    }
  }

  try {
    await page.screenshot({ path: 'debug.png', fullPage: true });
  } catch {}
} catch (e) {
  console.error('Navigation/scrape error:', e.message);
  try { await page.screenshot({ path: 'debug.png', fullPage: true }); } catch {}
} finally {
  await browser.close();
}

if (expired) {
  console.log('Session expired.');
  await notify('⚠️ AfterQuery monitor: your login session expired. Re-run `node capture-auth.mjs` and update the AFTERQUERY_AUTH_B64 secret.');
  process.exit(0);
}

if (!content || content.trim().length < 5) {
  console.log('Empty content captured — not updating baseline. Check debug.png artifact.');
  process.exit(0);
}

const normalized = normalize(content);
const prev = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '';
fs.mkdirSync('state', { recursive: true });
fs.writeFileSync(STATE_FILE, normalized);

if (!prev) {
  console.log('First run — baseline saved.');
  await notify('✅ AfterQuery Pluto submissions monitor is live. Baseline captured — I\'ll message you when the submissions list changes.\n' + TARGET_URL);
} else if (prev !== normalized) {
  console.log('CHANGE detected.');
  await notify('🔔 AfterQuery Pluto *submissions changed*.\n' + TARGET_URL);
} else {
  console.log('No change.');
}
