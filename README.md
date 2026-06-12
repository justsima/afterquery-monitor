# AfterQuery Pluto Submissions Monitor

Free, unattended watcher for **https://experts.afterquery.com/projects/pluto?tab=submissions**.
It runs in **GitHub Actions** (no server, no cost), opens the page in a real
headless browser using a login session you capture once, and **messages you on
Telegram** when the submissions list changes.

## Why it's built this way

AfterQuery Experts uses **Firebase Auth + Google sign-in + Firestore**, and ships
**Firebase App Check**. That combination is hostile to simple "curl the API"
scripts. The robust, auth-agnostic answer is to drive a *real* browser that
replays your saved session — which is exactly what this does.

Firebase keeps its refresh token in **IndexedDB**, so the session is captured
with `storageState({ indexedDB: true })`. That's what lets it run for weeks
unattended instead of dying after the 1-hour ID-token expiry.

---

## Setup (about 15 minutes, once)

### 1. Install + capture your login (on your Mac)

```bash
cd ~/Documents/Testing/afterquery-monitor
npm install
npx playwright install chromium
node capture-auth.mjs
```

A Chrome window opens. **Log in with Google**, go to **Pluto → Submissions**,
confirm you can see your submissions, then press **Enter** in the terminal.
This writes `auth.json` (gitignored — it's your session, never commit it).

### 2. Turn the session into a secret

```bash
base64 -i auth.json | pbcopy   # macOS: copies the encoded session to clipboard
```

### 3. Create a Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the
   **bot token** (looks like `123456:ABC-...`).
2. Send any message to your new bot (e.g. "hi").
3. Get your chat id: open
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and copy
   `result[0].message.chat.id`. (Or message **@userinfobot** — it replies with
   your id.)

### 4. Push this folder to a new GitHub repo

```bash
cd ~/Documents/Testing/afterquery-monitor
git init && git add . && git commit -m "AfterQuery submissions monitor"
gh repo create afterquery-monitor --private --source=. --push
# (or create the repo on github.com and `git remote add origin ... && git push -u origin main`)
```

Keep it **private** — see the budget note below.

### 5. Add the secrets to the repo

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name           | Value                                   |
|-----------------------|-----------------------------------------|
| `AFTERQUERY_AUTH_B64` | the base64 string from step 2           |
| `TELEGRAM_BOT_TOKEN`  | your bot token from step 3              |
| `TELEGRAM_CHAT_ID`    | your chat id from step 3               |

### 6. Turn it on

Repo → **Actions** tab → enable workflows if prompted → open **AfterQuery Pluto
Submissions Monitor** → **Run workflow**. The first run sets the baseline and
sends you a "monitor is live" Telegram message. After that it runs hourly.

---

## Day-to-day

- **You'll get a Telegram ping** when the submissions list changes.
- **Session expired?** You'll get a ⚠️ message. Re-run `node capture-auth.mjs`,
  redo step 2, and update the `AFTERQUERY_AUTH_B64` secret. (Expect this every
  few weeks at most.)
- **Too noisy / wrong area?** After the first real run, look at `state/last.txt`
  in the repo to see what's being captured. If it's grabbing more than the
  submissions, set a repo **Variable** (Settings → Variables → Actions) named
  `MONITOR_SELECTOR` to a tighter CSS selector. Download the `debug-screenshot`
  artifact from any run to help pick one.

## Cost / budget

- **Private repo:** 2,000 free Actions minutes/month. A run is ~1–2 min, so
  **hourly ≈ 700–1,400 min/month** — comfortably free.
- **Want every 5–15 min?** Either accept it may approach the 2,000 cap, or make
  the repo **public** (unlimited Actions minutes) — but if you go public, change
  `monitor.mjs` to store only a hash of the content in `state/last.txt` so your
  submission data isn't committed in the clear. Change the cron in
  `.github/workflows/monitor.yml` (`- cron: '*/15 * * * *'`, etc.).
- GitHub may delay scheduled runs by a few minutes and disables crons after 60
  days of repo inactivity — the daily heartbeat commit prevents that.

## Files

| File | Purpose |
|------|---------|
| `capture-auth.mjs` | One-time local login capture → `auth.json` |
| `monitor.mjs` | The scheduled check: scrape → diff → Telegram |
| `.github/workflows/monitor.yml` | Hourly cron + manual trigger |
| `state/last.txt` | Last seen submissions snapshot (auto-committed) |
