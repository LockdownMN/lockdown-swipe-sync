// Swipe MCP OAuth — browser side. `app.getswipe.in` sends `Access-Control-Allow-Origin: *`
// on /api/mcp/{register,token,sse}, so the whole connect flow runs in the browser: no server.
// The nightly GitHub Action reuses the stored token (30-day life, no refresh — v2-0 spike).
// Pure helpers + fetch wrappers; no Firebase, no DOM. Tested by swipe.test.mjs.

const ISSUER = "https://app.getswipe.in";
export const SWIPE_AUTHORIZE = `${ISSUER}/api/mcp/authorize`;
export const SWIPE_TOKEN = `${ISSUER}/api/mcp/token`;
export const SWIPE_REGISTER = `${ISSUER}/api/mcp/register`;
export const SWIPE_MCP = `${ISSUER}/api/mcp/sse`;   // POST = streamable HTTP transport

const b64url = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randB64url = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}

// JWT payload -> object (no signature check — we only read our own token's claims).
export function decodeJwt(token) {
  try {
    const p = String(token).split(".");
    if (p.length !== 3) return {};
    return JSON.parse(atob(p[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
}

// Build the /authorize URL for a PKCE flow.
export function authorizeUrl({ clientId, redirectUri, challenge, state }) {
  const u = new URL(SWIPE_AUTHORIZE);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("scope", "");   // matches the proven spike request
  return u.toString();
}

// Shape a token response into what we store in config/swipe.
export function tokenToConfig(json, clientId) {
  const claims = decodeJwt(json.access_token);
  return {
    token: json.access_token,
    expiresAt: claims.exp ? claims.exp * 1000 : Date.now() + (Number(json.expires_in) || 0) * 1000,
    companyId: claims.company_id ?? null,
    userId: claims.user_id ?? null,
    clientId,
  };
}

// ---- network ----------------------------------------------------------

export async function registerClient(redirectUri) {
  const res = await fetch(SWIPE_REGISTER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Lockdown Command Centre",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.client_id) throw new Error(`Swipe client registration failed (${res.status})`);
  return j.client_id;
}

// Kick off: returns { url, verifier, state } — caller stashes verifier+state, then navigates to url.
export async function beginConnect(clientId, redirectUri) {
  const verifier = randB64url(32);
  const state = randB64url(16);
  const url = authorizeUrl({ clientId, redirectUri, challenge: await pkceChallenge(verifier), state });
  return { url, verifier, state };
}

// Exchange the code. `pending` = { verifier, state, clientId, redirectUri } from before the redirect.
export async function exchangeCode(code, returnedState, pending) {
  if (!pending) throw new Error("no pending Swipe connection in this browser");
  if (pending.state !== returnedState) throw new Error("state mismatch — start the connection again");
  const res = await fetch(SWIPE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token)
    throw new Error(j.error_description || j.error || `Swipe token exchange failed (${res.status})`);
  return tokenToConfig(j, pending.clientId);
}

// A raw JSON-RPC call to the (stateless) MCP endpoint.
export async function mcp(token, method, params = {}) {
  const res = await fetch(SWIPE_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (!res.ok) throw new Error(`Swipe MCP ${method} → HTTP ${res.status}`);
  const text = await res.text();
  const raw = text.trimStart().startsWith("{")
    ? text
    : (text.split("\n").find(l => l.startsWith("data:")) || "data:{}").slice(5);
  const j = JSON.parse(raw);
  if (j.error) throw new Error(j.error.message || "Swipe MCP error");
  return j.result;
}

// Confirm a token works. Returns the tool count.
export async function pingSwipe(token) {
  const r = await mcp(token, "tools/list");
  return (r && r.tools ? r.tools.length : 0);
}

export async function listTools(token) {
  return (await mcp(token, "tools/list")).tools || [];
}

// ---- day-closing tally (pure) ---------------------------------------------
// Invoice line-item name -> branch. The owner can override via config/swipeRooms.
export const DEFAULT_ROOM_MAP = [
  { match: "harry potter", branch: "Gomti Nagar" },
  { match: "pirate",       branch: "Gomti Nagar" },
  { match: "jail",         branch: "Mahanagar" },
  { match: "murder",       branch: "Mahanagar" },
  { match: "terrorist",    branch: "Mahanagar" },
];
export function branchForItem(name, map = DEFAULT_ROOM_MAP) {
  const n = String(name || "").toLowerCase();
  for (const r of map) if (r.match && n.includes(String(r.match).toLowerCase())) return r.branch;
  return null;
}

const _num = x => Number(x) || 0;
export function paymentBucket(method) {
  const m = String(method || "").toLowerCase();
  if (m.includes("cash")) return "cash";
  if (m.includes("card") || m.includes("credit") || m.includes("debit")) return "card";
  return "online";   // upi / netbanking / wallet / cheque / …
}

const _MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "06 Sep 2026" | "06-09-2026" | "2026-09-06" -> "2026-09-06"; "" for junk.
export function parseSwipeDate(s) {
  s = String(s || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/.exec(s);
  if (m && _MON[m[2].toLowerCase()]) return `${m[3]}-${String(_MON[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

// Pull the invoice_details object out of a get_document_details result (`callTool` .data).
export function unwrapDetail(callToolData) {
  const d = callToolData;
  return (d && d.data && d.data.invoice_details) || (d && d.invoice_details) || null;
}

// details: array of invoice_details objects. -> { byBranch, unknown[] }.
// byBranch["<branch>"] = { games, players, cash, card, online, total, invoices[] }.
export function tallyInvoices(details, map = DEFAULT_ROOM_MAP) {
  const byBranch = {};
  const row = name => byBranch[name] ||
    (byBranch[name] = { games: 0, players: 0, cash: 0, card: 0, online: 0, total: 0, invoices: [] });
  const unknown = [];
  for (const inv of details || []) {
    if (!inv) continue;
    if (String(inv.payment_status || "").toLowerCase() === "cancelled") continue;
    let branch = null;
    for (const it of inv.items || []) { branch = branchForItem(it.name, map); if (branch) break; }
    if (!branch) { unknown.push(inv.serial_number || inv.hash_id || "?"); continue; }
    const r = row(branch);
    r.games += 1;
    r.players += (inv.items || []).reduce((s, it) => s + _num(it.quantity), 0);
    r.total += _num(inv.total_amount);
    const pays = inv.payments && inv.payments.length ? inv.payments : [{ method: "", amount: inv.total_amount }];
    for (const p of pays) r[paymentBucket(p.method)] += _num(p.amount);
    r.invoices.push(inv.serial_number || inv.hash_id);
  }
  return { byBranch, unknown };
}

// Args for get_transactions (all fields are "required" but most are just defaults).
export function txArgs(startDDMMYYYY, endDDMMYYYY) {
  return {
    document_type: "invoice", start_date: startDDMMYYYY, end_date: endDDMMYYYY,
    payment_status: 0, search: "", sort_type: "", sort_order: "",
  };
}

// Call a Swipe MCP tool. Returns the parsed content (Swipe returns JSON text in content[0].text).
export async function callTool(token, name, args = {}) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const parts = (r && r.content) || [];
  const text = parts.map(p => p.text ?? JSON.stringify(p)).join("\n");
  try { return { isError: !!r.isError, data: JSON.parse(text) }; }
  catch { return { isError: !!r.isError, data: text }; }
}
