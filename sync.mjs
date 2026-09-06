// Lockdown Command Centre — nightly Swipe day-closing pull (v2-1).
// Runs in GitHub Actions on cron. Reads the owner-connected Swipe token from Firestore
// `config/swipe`, pulls the day's paid invoices, splits them to branch by room, tallies by
// payment mode, and writes `swipeClosings/{YYYY-MM-DD__Branch}`. No Blaze, no server.
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT   the service-account JSON (a GitHub secret)
//   SYNC_FROM / SYNC_TO        optional YYYY-MM-DD backfill range (inclusive)
//   SYNC_DAYS                  optional: sync the last N days (overrides FROM/TO)
//   default (no env)           sync yesterday (IST)

import admin from "firebase-admin";
import { mcp, callTool, unwrapDetail, tallyInvoices, parseSwipeDate, txArgs, DEFAULT_ROOM_MAP } from "./swipe.js";

const IST_OFFSET_MS = 5.5 * 3600_000;
const ymd = d => d.toISOString().slice(0, 10);
const ddmmyyyy = ymdStr => { const [y, m, d] = ymdStr.split("-"); return `${d}-${m}-${y}`; };
const inr = n => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");

function targetDates() {
  if (process.env.SYNC_FROM && process.env.SYNC_TO) {
    const out = [];
    for (let t = Date.parse(process.env.SYNC_FROM); t <= Date.parse(process.env.SYNC_TO); t += 86400_000)
      out.push(ymd(new Date(t)));
    return out;
  }
  const istToday = new Date(Date.now() + IST_OFFSET_MS);
  const n = Number(process.env.SYNC_DAYS) || 1;
  const out = [];
  for (let i = n; i >= 1; i--) out.push(ymd(new Date(istToday.getTime() - i * 86400_000)));
  return out;
}

async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (!sa.project_id) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing or invalid");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  const status = { lastRunAt: new Date().toISOString(), lastRunOk: false, datesSynced: [], warnings: [] };
  const saveStatus = () => db.doc("config/swipeStatus").set(status, { merge: true });

  // 1. token
  const swipeDoc = await db.doc("config/swipe").get();
  const cfg = swipeDoc.exists ? swipeDoc.data() : null;
  if (!cfg || !cfg.token) {
    status.connected = false;
    status.note = "Swipe not connected — owner must click Connect Swipe in the Command Centre.";
    await saveStatus();
    console.log(status.note);
    return;
  }
  status.connected = true;
  status.tokenExpiresAt = cfg.expiresAt || null;
  const daysLeft = cfg.expiresAt ? Math.round((cfg.expiresAt - Date.now()) / 86400_000) : null;
  status.tokenDaysLeft = daysLeft;
  if (daysLeft != null && daysLeft <= 0) {
    status.expired = true;
    status.note = "Swipe token expired — owner must Reconnect Swipe. No data pulled.";
    await saveStatus();
    console.log(status.note);
    return;
  }
  status.expired = false;
  if (daysLeft != null && daysLeft <= 5) status.warnings.push(`Swipe token expires in ${daysLeft} day(s) — reconnect soon.`);

  // 2. room map (owner override or default)
  const roomDoc = await db.doc("config/swipeRooms").get();
  const roomMap = (roomDoc.exists && Array.isArray(roomDoc.data().rooms) && roomDoc.data().rooms.length)
    ? roomDoc.data().rooms : DEFAULT_ROOM_MAP;

  const token = cfg.token;
  const dates = targetDates();
  console.log(`Syncing ${dates.length} date(s): ${dates.join(", ")}  (Swipe company ${cfg.companyId}, token ${daysLeft}d left)`);

  await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lockdown-sync", version: "1" } });
  await mcp(token, "notifications/initialized", {}).catch(() => {});

  // 3. one get_transactions covering the whole window
  const listRes = await callTool(token, "get_transactions", txArgs(ddmmyyyy(dates[0]), ddmmyyyy(dates[dates.length - 1])));
  if (listRes.isError) throw new Error("get_transactions failed: " + JSON.stringify(listRes.data).slice(0, 300));
  const allTx = (listRes.data && (listRes.data.transactions || listRes.data.data)) || [];
  console.log(`get_transactions → ${allTx.length} invoices in the window`);

  // 4. per date: pull detail for that date's invoices, tally, write
  for (const date of dates) {
    const dayTx = allTx.filter(t => parseSwipeDate(t.invoice_date) === date);
    const details = [];
    for (const t of dayTx) {
      const hid = t.hash_id || t.hashId;
      if (!hid) continue;
      try {
        const d = await callTool(token, "get_document_details", { document_type: "sales", hash_id: hid });
        const det = unwrapDetail(d.data);
        if (det) { det.serial_number = det.serial_number || t.serial_number; details.push(det); }
        else status.warnings.push(`${date}: no detail for ${t.serial_number}`);
      } catch (e) {
        status.warnings.push(`${date}: detail fetch failed for ${t.serial_number} (${e.message})`);
      }
    }

    const { byBranch, unknown } = tallyInvoices(details, roomMap);
    if (unknown.length) status.warnings.push(`${date}: ${unknown.length} invoice(s) with no recognised room: ${unknown.join(", ")}`);

    const branches = Object.keys(byBranch);
    for (const branch of branches) {
      const b = byBranch[branch];
      await db.doc(`swipeClosings/${date}__${branch}`).set({
        date, branch, source: "swipe",
        games: b.games, players: b.players,
        cash: b.cash, card: b.card, online: b.online, total: b.total,
        invoices: b.invoices,
        pulledAt: admin.firestore.FieldValue.serverTimestamp(),
        pulledForTokenExp: cfg.expiresAt || null,
      }, { merge: true });
      console.log(`  ${date} ${branch}: ${b.games} games, ${b.players} players, ${inr(b.total)} ` +
        `(cash ${inr(b.cash)} / card ${inr(b.card)} / online ${inr(b.online)})`);
    }
    if (!branches.length) console.log(`  ${date}: no invoices`);
    status.datesSynced.push({ date, branches, invoices: dayTx.length });
  }

  status.lastRunOk = true;
  status.note = `Synced ${dates.length} day(s), ${status.datesSynced.reduce((s, x) => s + x.invoices, 0)} invoices.`;
  await saveStatus();
  console.log("\n" + status.note + (status.warnings.length ? `\nWarnings:\n - ${status.warnings.join("\n - ")}` : ""));
}

main().catch(async (e) => {
  console.error("SYNC FAILED:", e.stack || e.message);
  try {
    admin.apps.length && await admin.firestore().doc("config/swipeStatus").set(
      { lastRunAt: new Date().toISOString(), lastRunOk: false, error: String(e.message || e) }, { merge: true });
  } catch { /* */ }
  process.exit(1);
});
