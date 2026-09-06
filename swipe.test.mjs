import assert from "node:assert/strict";
import {
  pkceChallenge, decodeJwt, authorizeUrl, tokenToConfig, randB64url,
  branchForItem, paymentBucket, parseSwipeDate, unwrapDetail, tallyInvoices, txArgs,
} from "./swipe.js";

// PKCE — RFC 7636 Appendix B test vector
assert.equal(
  await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
);

// randB64url — url-safe, no padding, right rough length
const r = randB64url(32);
assert.match(r, /^[A-Za-z0-9_-]+$/);
assert.equal(r.length, 43);                       // 32 bytes -> 43 b64url chars
assert.notEqual(randB64url(16), randB64url(16));

// decodeJwt — reads the payload, tolerates junk
const jwt = "x." + Buffer.from(JSON.stringify({ company_id: 603057, user_id: 710837, exp: 1791277375 }))
  .toString("base64").replace(/=+$/, "") + ".y";
assert.deepEqual(decodeJwt(jwt), { company_id: 603057, user_id: 710837, exp: 1791277375 });
assert.deepEqual(decodeJwt("not-a-jwt"), {});
assert.deepEqual(decodeJwt(undefined), {});

// authorizeUrl
const u = new URL(authorizeUrl({ clientId: "abc", redirectUri: "https://x.web.app/", challenge: "CH", state: "ST" }));
assert.equal(u.origin + u.pathname, "https://app.getswipe.in/api/mcp/authorize");
assert.equal(u.searchParams.get("response_type"), "code");
assert.equal(u.searchParams.get("client_id"), "abc");
assert.equal(u.searchParams.get("redirect_uri"), "https://x.web.app/");
assert.equal(u.searchParams.get("code_challenge"), "CH");
assert.equal(u.searchParams.get("code_challenge_method"), "S256");
assert.equal(u.searchParams.get("state"), "ST");

// tokenToConfig — prefers the JWT exp claim
const cfg = tokenToConfig({ access_token: jwt, expires_in: 2592000 }, "client-1");
assert.equal(cfg.token, jwt);
assert.equal(cfg.companyId, 603057);
assert.equal(cfg.userId, 710837);
assert.equal(cfg.clientId, "client-1");
assert.equal(cfg.expiresAt, 1791277375 * 1000);

// tokenToConfig — falls back to expires_in when the token isn't a JWT
const before = Date.now();
const cfg2 = tokenToConfig({ access_token: "opaque", expires_in: 3600 }, "c");
assert.ok(cfg2.expiresAt >= before + 3600_000 && cfg2.expiresAt <= Date.now() + 3600_000);
assert.equal(cfg2.companyId, null);

// ---- day-closing tally --------------------------------------------------

// branchForItem — real room names from the escape room
assert.equal(branchForItem("Harry Potter Escape Game (2-4 Players, Weekend)"), "Gomti Nagar");
assert.equal(branchForItem("Pirates Escape Game (5-8 Players)"), "Gomti Nagar");
assert.equal(branchForItem("Murder Mystery Escape Game (5-8 Players, Weekend)"), "Mahanagar");
assert.equal(branchForItem("Escape the Jail (Weekday)"), "Mahanagar");
assert.equal(branchForItem("Terrorist Hideout"), "Mahanagar");
assert.equal(branchForItem("Some Unknown Room"), null);
assert.equal(branchForItem(""), null);
assert.equal(branchForItem("harry potter", [{ match: "harry", branch: "X" }]), "X");

// paymentBucket
assert.equal(paymentBucket("upi"), "online");
assert.equal(paymentBucket("cash"), "cash");
assert.equal(paymentBucket("Credit Card"), "card");
assert.equal(paymentBucket("netbanking"), "online");
assert.equal(paymentBucket(""), "online");

// parseSwipeDate — the three formats Swipe uses
assert.equal(parseSwipeDate("06 Sep 2026"), "2026-09-06");
assert.equal(parseSwipeDate("06-09-2026"), "2026-09-06");
assert.equal(parseSwipeDate("2026-09-06"), "2026-09-06");
assert.equal(parseSwipeDate("31 Aug 2026"), "2026-08-31");
assert.equal(parseSwipeDate("bogus"), "");

// unwrapDetail — the get_document_details envelope
assert.deepEqual(unwrapDetail({ data: { invoice_details: { x: 1 } } }), { x: 1 });
assert.equal(unwrapDetail({}), null);

// tallyInvoices — the three real invoices from the discovery dump
const details = [
  { serial_number: "INV-26/360", payment_status: "paid", total_amount: 3146,
    items: [{ name: "Murder Mystery Escape Game (5-8 Players, Weekend)", quantity: 5 }],
    payments: [{ amount: 3146, method: "upi" }] },
  { serial_number: "INV-26/359", payment_status: "paid", total_amount: 1498,
    items: [{ name: "Harry Potter Escape Game (2-4 Players, Weekend)", quantity: 2 }],
    payments: [{ amount: 1498, method: "cash" }] },
  { serial_number: "INV-26/358", payment_status: "paid", total_amount: 2696,
    items: [{ name: "Murder Mystery Escape Game (2-4 Players, Weekend)", quantity: 4 }],
    payments: [{ amount: 2696, method: "upi" }] },
  { serial_number: "INV-26/CXL", payment_status: "cancelled", total_amount: 999,
    items: [{ name: "Harry Potter Escape Game", quantity: 3 }], payments: [] },
  { serial_number: "INV-26/UNK", payment_status: "paid", total_amount: 500,
    items: [{ name: "Gift Voucher", quantity: 1 }], payments: [{ amount: 500, method: "cash" }] },
];
const { byBranch, unknown } = tallyInvoices(details);
assert.deepEqual(unknown, ["INV-26/UNK"], "the gift voucher has no room");
assert.equal(byBranch["Gomti Nagar"].games, 1);
assert.equal(byBranch["Gomti Nagar"].players, 2);
assert.equal(byBranch["Gomti Nagar"].cash, 1498);
assert.equal(byBranch["Gomti Nagar"].online, 0);
assert.equal(byBranch["Mahanagar"].games, 2);
assert.equal(byBranch["Mahanagar"].players, 9);
assert.equal(byBranch["Mahanagar"].online, 3146 + 2696);
assert.equal(byBranch["Mahanagar"].total, 3146 + 2696);
assert.deepEqual(byBranch["Mahanagar"].invoices, ["INV-26/360", "INV-26/358"]);

// split payment across methods
const split = tallyInvoices([{ serial_number: "S", payment_status: "paid", total_amount: 1000,
  items: [{ name: "Pirates Escape", quantity: 3 }],
  payments: [{ amount: 600, method: "cash" }, { amount: 400, method: "card" }] }]);
assert.equal(split.byBranch["Gomti Nagar"].cash, 600);
assert.equal(split.byBranch["Gomti Nagar"].card, 400);

// txArgs
assert.deepEqual(txArgs("01-09-2026", "06-09-2026"), {
  document_type: "invoice", start_date: "01-09-2026", end_date: "06-09-2026",
  payment_status: 0, search: "", sort_type: "", sort_order: "",
});

console.log("swipe.test: all passed");
