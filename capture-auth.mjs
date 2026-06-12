// capture-auth.mjs
// ONE-TIME, run on your own Mac. Opens a real Chrome window, you log in with
// Google manually, then this saves your full Firebase session (cookies +
// IndexedDB, which is where the refresh token lives) to auth.json.
//
//   npm install
//   npx playwright install chromium
//   node capture-auth.mjs
//
// Then base64 it into a GitHub secret (see README).

import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const LOGIN_URL = 'https://experts.afterquery.com/login';
const TARGET_URL = 'https://experts.afterquery.com/projects/pluto?tab=submissions';
const USER_DATA_DIR = './.chrome-profile';

console.log('\nLaunching a browser window...');

// A persistent context + real Chrome ("channel: chrome") behaves like a normal
// profile, which is the most reliable way to get past Google's "this browser
// may not be secure" block during OAuth sign-in.
let context;
try {
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
} catch (e) {
  console.log('Could not launch system Chrome (' + e.message + ').');
  console.log('Falling back to Playwright\'s bundled Chromium. If Google blocks');
  console.log('the login, install Google Chrome and re-run.\n');
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

const page = context.pages()[0] || (await context.newPage());
await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

const rl = readline.createInterface({ input, output });
console.log('\n──────────────────────────────────────────────────────────────');
console.log('1. Log in with Google in the window that just opened.');
console.log('2. Navigate to the Pluto > Submissions tab and confirm you can');
console.log('   actually SEE your submissions list.');
console.log('3. Then come back here.');
console.log('──────────────────────────────────────────────────────────────');
await rl.question('\nPress Enter once you can see the submissions list... ');
rl.close();

// Make sure we land on the target so the right Firestore data/origin is primed.
try {
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
} catch { /* fine if it times out, session is what matters */ }

await context.storageState({ path: 'auth.json', indexedDB: true });
console.log('\n✅ Saved session to auth.json');
console.log('   Next: turn it into a GitHub secret. On macOS:');
console.log('   base64 -i auth.json | pbcopy');
console.log('   ...then paste as the AFTERQUERY_AUTH_B64 repo secret.\n');

await context.close();
process.exit(0);
