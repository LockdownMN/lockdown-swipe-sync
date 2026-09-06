# Lockdown — Swipe day-closing sync

Nightly job that pulls the day's paid invoices from Swipe (via its MCP server), splits them to
branch by room, tallies by payment mode, and writes `swipeClosings/{YYYY-MM-DD__Branch}` in
Firestore. Runs on **GitHub Actions cron** — no Cloud Functions, no Blaze, ₹0.

The Command Centre later reconciles this against the handwritten closing (`dailyClosings.reported`)
and the BMS bookings.

```
sync.mjs      the job
swipe.js      Swipe MCP client + pure tally helpers (copy of the CC's swipe.js)
swipe.test.mjs  runs in CI before every sync
.github/workflows/nightly.yml   cron 02:30 UTC (08:00 IST) + manual "Run workflow" button
```

## One-time setup

### 1. Firebase service account

Firebase console → **Project settings → Service accounts → Generate new private key** → a JSON
file downloads. This key can read/write all of Firestore, so treat it like a password.

*(Optional hardening: in Google Cloud console → IAM, create a dedicated service account with only
the **Cloud Datastore User** role and generate the key from that instead.)*

### 2. GitHub repo

```sh
cd "Financial Plugin/swipe-sync"
git init && git add -A && git commit -m "Swipe day-closing sync"
gh repo create lockdown-swipe-sync --private --source=. --push
```

### 3. GitHub secret

Repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `FIREBASE_SERVICE_ACCOUNT`
- Value: paste the **entire contents** of the service-account JSON file

### 4. Connect Swipe (owner, in the Command Centre)

lockdown-bms-cc.web.app → Day Closing → **Connect Swipe**. Reconnect every ~30 days (the CC
shows a "reconnect soon" warning; `config/swipeStatus.tokenDaysLeft` also tracks it).

### 5. Test it

Repo → **Actions → Swipe day-closing sync → Run workflow**. Leave the inputs blank for
"yesterday", or set `sync_from` / `sync_to` (YYYY-MM-DD) to backfill a range. Check the run log
and the `swipeClosings` collection.

## How dates/branches are decided

- **Yesterday (IST)** by default. `SYNC_FROM`/`SYNC_TO` or `SYNC_DAYS=N` override.
- Branch comes from the invoice line-item name. Default map (`swipe.js` `DEFAULT_ROOM_MAP`):
  | contains | branch |
  |---|---|
  | harry potter, pirate | Gomti Nagar |
  | jail, murder, terrorist | Mahanagar |
  Override by creating `config/swipeRooms` = `{ rooms: [ { match, branch }, … ] }` (owner-writable).
- Invoices with no recognised room, and cancelled invoices, are skipped and listed in
  `config/swipeStatus.warnings`.
- Player count = sum of item `quantity`. Payment split = `payments[].method` bucketed
  cash / card / online (upi, netbanking, wallet → online).

## What it writes

`swipeClosings/{date}__{branch}`:
```
{ date, branch, source: "swipe", games, players, cash, card, online, total,
  invoices: ["INV-26/359", …], pulledAt }
```

`config/swipeStatus` (sync heartbeat the CC reads):
```
{ lastRunAt, lastRunOk, connected, expired, tokenExpiresAt, tokenDaysLeft,
  datesSynced: [{date, branches, invoices}], warnings: [], note }
```
