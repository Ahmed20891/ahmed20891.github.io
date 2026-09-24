/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  AL SALAMA ACADEMY — MOYASAR PAYMENT SERVICE (no Jira Automation needed)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Runs inside the certificate service (same process / port) and does both
 *  halves of the payment flow directly against the Jira REST API:
 *
 *   1. INVOICE  — every PAY_POLL_INTERVAL_MINUTES it searches ASAC for
 *      "Trainee Requests" in "Waiting for Payment". For each ticket without an
 *      open invoice it creates a Moyasar invoice (amount = Total Cost), saves
 *      issue_key ↔ invoice_id ↔ amount in payments-db.json and posts the
 *      payment link on the ticket (public comment → the trainee is notified).
 *
 *   2. RESULT   — the result reaches the service two ways; either one is enough:
 *      a) POST /payments/moyasar/webhook   (instant; needs a public HTTPS URL)
 *      b) the same poll re-reads every open invoice from Moyasar (works with no
 *         public URL at all — the webhook only makes it faster)
 *      Paid → transition to "Paid". Failed → transition to "Failed Payment".
 *
 *  Nothing is trusted from the webhook body: the payment is always re-fetched
 *  from the Moyasar API with the secret key, and its amount / currency are
 *  compared with what was stored when the invoice was created.
 *
 *  Wire-up (certificate-server.js):
 *      const payments = require("./payment-service");
 *      payments.mount(app);          // after app.use(express.json())
 *      payments.start();             // inside start()
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
const flag = (k, d) => env(k, d).toLowerCase() !== "false";

const JIRA_BASE_URL = env("JIRA_BASE_URL");
const JIRA_AUTH     = "Basic " + Buffer.from(`${env("JIRA_EMAIL")}:${env("JIRA_API_TOKEN")}`).toString("base64");

const PAY_ENABLED       = flag("PAY_ENABLED", "true");
const PAY_DRY_RUN       = env("PAY_DRY_RUN", "false").toLowerCase() === "true"; // true → no invoices, no transitions
const PAY_PROJECT_KEY   = env("PAY_PROJECT_KEY", "ASAC");
const PAY_REQUEST_TYPE  = env("PAY_REQUEST_TYPE", "Trainee Requests");    // matched case-insensitively
const STATUS_WAITING    = env("PAY_STATUS_WAITING", "Waiting for Payment");
const STATUS_PAID       = env("PAY_STATUS_PAID",    "Paid");
const STATUS_FAILED     = env("PAY_STATUS_FAILED",  "Failed Payment");
const POLL_INTERVAL     = parseFloat(env("PAY_POLL_INTERVAL_MINUTES", "2")) * 60 * 1000;

// Jira fields
const CF_TOTAL_COST   = env("PAY_CF_TOTAL_COST",   "customfield_11636");
const CF_TRAINEE_NAME = env("PAY_CF_TRAINEE_NAME", "customfield_13434");
const CF_TRAINEE_ID   = env("PAY_CF_TRAINEE_ID",   "customfield_13457");
const CF_INVOICE_URL  = env("PAY_CF_INVOICE_URL",  "customfield_14189");  // "Payment Link" (URL field); blank = off

// What happens on a failed payment attempt:
//   manual     → internal comment only; staff transition the ticket by hand (default)
//   transition → move the ticket to "Failed Payment" automatically
const ON_FAILED       = env("PAY_ON_FAILED", "manual").toLowerCase();
const PUBLIC_COMMENT  = flag("PAY_PUBLIC_COMMENT", "true");               // link comment visible to the trainee

// Moyasar
const MOYASAR_API        = env("MOYASAR_API_URL", "https://api.moyasar.com/v1");
const MOYASAR_SECRET_KEY = env("MOYASAR_SECRET_KEY");                     // sk_test_… / sk_live_…
const MOYASAR_WH_SECRET  = env("MOYASAR_WEBHOOK_SECRET");                 // "Secret Token" set on the dashboard webhook
const PAY_CURRENCY       = env("PAY_CURRENCY", "SAR");
const PAY_SUCCESS_URL    = env("PAY_SUCCESS_URL");                        // optional page after payment
const PAY_BACK_URL       = env("PAY_BACK_URL");                           // optional "back" link on the invoice page
const PAY_INVOICE_DAYS   = parseFloat(env("PAY_INVOICE_EXPIRY_DAYS", "7"));
const PAY_API_KEY        = env("PAY_API_KEY") || env("CERT_API_KEY");     // x-api-key for the admin routes
const PAY_DESC_PREFIX    = env("PAY_DESCRIPTION_PREFIX", "Alsalama Academy training fee");

const MOYASAR_AUTH = "Basic " + Buffer.from(`${MOYASAR_SECRET_KEY}:`).toString("base64");
const TEST_MODE    = MOYASAR_SECRET_KEY.startsWith("sk_test_");

// ─── DB (JSON file, atomic write) ─────────────────────────────────────────────
//  invoices[invoiceId] = { issueKey, amount, currency, url, status, traineeName,
//                          traineeId, createdAt, updatedAt, resolvedPaymentId }
//  events[eventId]     = ISO time processed (webhook de-duplication)
const DB_PATH = path.resolve(__dirname, env("PAY_DB_PATH", "payments-db.json"));

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    return { invoices: db.invoices || {}, events: db.events || {} };
  } catch {
    return { invoices: {}, events: {} };
  }
}
function saveDb(db) {
  // Drop de-dup entries older than 30 days so the file stays small
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [id, at] of Object.entries(db.events)) if (Date.parse(at) < cutoff) delete db.events[id];
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_PATH);
}
function updateInvoice(invoiceId, patch) {
  const db = loadDb();
  if (!db.invoices[invoiceId]) return null;
  Object.assign(db.invoices[invoiceId], patch, { updatedAt: new Date().toISOString() });
  saveDb(db);
  return db.invoices[invoiceId];
}
const invoicesForIssue = (db, key) =>
  Object.entries(db.invoices).filter(([, r]) => r.issueKey === key).map(([id, r]) => ({ id, ...r }));

// One operation per ticket at a time — the poll and the webhook can race.
const locks = new Map();
async function withLock(key, fn) {
  while (locks.has(key)) await locks.get(key).catch(() => {});
  const p = (async () => fn())();
  locks.set(key, p);
  try { return await p; } finally { locks.delete(key); }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const log  = (...a) => console.log("[Pay]", ...a);
const warn = (...a) => console.warn("[Pay] ⚠️ ", ...a);

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a || "")).digest();
  const hb = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ha, hb) && !!a && !!b;
}

function readText(fields, id) {
  const v = fields?.[id];
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  return String(v.value || v.name || v.displayName || "").trim();
}

// "1,500.50" / 1500.5 / "1500 SAR" → 150050 halalas. null when not a valid amount.
function toMinorUnits(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
const fmt = (minor, cur = PAY_CURRENCY) => `${(minor / 100).toFixed(2)} ${cur}`;

function requestTypeName(fields) {
  const r = fields?.customfield_10010;
  return (r?.requestType?.name || r?.value || r?.name || "").toString();
}

// ─── MOYASAR API ──────────────────────────────────────────────────────────────
async function moyasar(method, route, body) {
  const res = await fetch(`${MOYASAR_API}${route}`, {
    method,
    headers: { Authorization: MOYASAR_AUTH, Accept: "application/json",
               ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Moyasar ${method} ${route} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ─── JIRA API ─────────────────────────────────────────────────────────────────
async function jira(method, route, body) {
  const res = await fetch(`${JIRA_BASE_URL}${route}`, {
    method,
    headers: { Authorization: JIRA_AUTH, Accept: "application/json",
               ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Jira ${method} ${route} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

const ISSUE_FIELDS = ["summary", "status", "customfield_10010", CF_TOTAL_COST, CF_TRAINEE_NAME, CF_TRAINEE_ID]
  .filter(Boolean).join(",");

const getIssue = key => jira("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`);

async function searchWaitingIssues() {
  const jql = `project = "${PAY_PROJECT_KEY}" AND status = "${STATUS_WAITING}" ORDER BY created ASC`;
  const out = [];
  let token;
  do {
    const qs = new URLSearchParams({ jql, maxResults: "100", fields: ISSUE_FIELDS });
    if (token) qs.set("nextPageToken", token);
    const page = await jira("GET", `/rest/api/3/search/jql?${qs}`);
    out.push(...(page.issues || []));
    token = page.nextPageToken;
  } while (token);
  const wanted = PAY_REQUEST_TYPE.toLowerCase();
  return out.filter(i => !wanted || requestTypeName(i.fields).toLowerCase().includes(wanted));
}

// Transition by TARGET STATUS NAME, so workflow transition ids can change freely.
async function transitionTo(issueKey, statusName) {
  const { transitions = [] } = await jira("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
  const t = transitions.find(t => t.to?.name?.toLowerCase() === statusName.toLowerCase())
         || transitions.find(t => t.name?.toLowerCase() === statusName.toLowerCase());
  if (!t) {
    throw new Error(`No transition to "${statusName}" available on ${issueKey} ` +
                    `(available: ${transitions.map(t => `${t.name}→${t.to?.name}`).join(", ") || "none"})`);
  }
  if (PAY_DRY_RUN) { log(`[dry-run] would transition ${issueKey} via "${t.name}" → ${statusName}`); return; }
  await jira("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, { transition: { id: t.id } });
  log(`✅ ${issueKey} → ${statusName}`);
}

async function comment(issueKey, text, isPublic = false) {
  if (PAY_DRY_RUN) { log(`[dry-run] ${isPublic ? "public" : "internal"} comment on ${issueKey}: ${text}`); return; }
  try {
    await jira("POST", `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment`,
               { body: text, public: isPublic });
  } catch (e) {
    warn(`comment on ${issueKey} failed: ${e.message}`);
  }
}

async function setInvoiceUrlField(issueKey, url) {
  if (!CF_INVOICE_URL || PAY_DRY_RUN) return;
  try {
    await jira("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}?notifyUsers=false`,
               { fields: { [CF_INVOICE_URL]: url } });
  } catch (e) { warn(`could not write ${CF_INVOICE_URL} on ${issueKey}: ${e.message}`); }
}

// ─── STEP 1: CREATE INVOICE FOR A "WAITING FOR PAYMENT" TICKET ────────────────
const alerted = new Set();   // tickets already told about a data problem (once per run)

async function ensureInvoice(issue) {
  const key    = issue.key;
  const f      = issue.fields;
  const amount = toMinorUnits(f[CF_TOTAL_COST]);
  const name   = readText(f, CF_TRAINEE_NAME);
  const tid    = readText(f, CF_TRAINEE_ID);

  if (!amount || amount < 100) {   // Moyasar minimum is 1.00 SAR
    if (!alerted.has(key)) {
      alerted.add(key);
      warn(`${key}: Total Cost (${CF_TOTAL_COST}) is empty or below 1.00 — invoice not created.`);
      await comment(key, `Payment link not created: Total Cost is empty or invalid (${f[CF_TOTAL_COST] ?? "empty"}). ` +
                         `Fix the field — the link is created automatically within a few minutes.`);
    }
    return;
  }
  alerted.delete(key);

  const db       = loadDb();
  const existing = invoicesForIssue(db, key);

  // Already paid → never charge twice. Someone moved the ticket back on purpose,
  // so leave the decision to them (told once).
  const paid = existing.find(r => r.status === "paid");
  if (paid) {
    if (!alerted.has(key)) {
      alerted.add(key);
      warn(`${key} is in "${STATUS_WAITING}" but invoice ${paid.id} is already paid — no new invoice.`);
      await comment(key, `This request already has a paid invoice (${paid.id}, ${fmt(paid.amount, paid.currency)}), ` +
                         `so no new payment link was created. Move it to "${STATUS_PAID}" manually if that is correct.`);
    }
    return;
  }

  // An open invoice for the same amount is reused (e.g. ticket moved back after a
  // failed attempt) — the link is re-posted once so the trainee can retry.
  const open = existing.find(r => r.status === "initiated");
  if (open && open.amount === amount && open.currency === PAY_CURRENCY) {
    if (ON_FAILED === "transition" && open.lastFailedPaymentId && open.repostedFor !== open.lastFailedPaymentId) {
      updateInvoice(open.id, { repostedFor: open.lastFailedPaymentId });
      await comment(key, `Please retry the payment of ${fmt(amount)} using the same secure link:\n${open.url}`,
                    PUBLIC_COMMENT);
    }
    return;
  }

  // Amount changed since the invoice was issued → cancel the old one first.
  if (open) {
    log(`${key}: Total Cost changed ${fmt(open.amount)} → ${fmt(amount)}, replacing invoice ${open.id}`);
    try { if (!PAY_DRY_RUN) await moyasar("PUT", `/invoices/${open.id}/cancel`); }
    catch (e) { warn(`cancel ${open.id}: ${e.message} — marking superseded anyway`); }
    updateInvoice(open.id, { status: "superseded" });
  }

  const description = `${PAY_DESC_PREFIX} — ${key} — ${name || "Trainee"}${tid ? ` (${tid})` : ""}`.slice(0, 255);
  const body = {
    amount,
    currency: PAY_CURRENCY,
    description,
    metadata: { issue_key: key, trainee_name: name, trainee_id: tid },
    ...(PAY_SUCCESS_URL ? { success_url: PAY_SUCCESS_URL } : {}),
    ...(PAY_BACK_URL    ? { back_url:    PAY_BACK_URL }    : {}),
    ...(PAY_INVOICE_DAYS > 0
      ? { expired_at: new Date(Date.now() + PAY_INVOICE_DAYS * 864e5).toISOString() } : {}),
  };

  if (PAY_DRY_RUN) { log(`[dry-run] would create invoice for ${key}:`, JSON.stringify(body)); return; }

  const inv = await moyasar("POST", "/invoices", body);
  const now = new Date().toISOString();
  const db2 = loadDb();
  db2.invoices[inv.id] = {
    issueKey: key, amount, currency: PAY_CURRENCY, url: inv.url, status: inv.status || "initiated",
    traineeName: name, traineeId: tid, live: !TEST_MODE, createdAt: now, updatedAt: now,
  };
  saveDb(db2);
  log(`🧾 ${key}: invoice ${inv.id} ${fmt(amount)} → ${inv.url}`);

  await setInvoiceUrlField(key, inv.url);
  await comment(key,
    `Please complete the training fee payment of ${fmt(amount)} using this secure link:\n${inv.url}\n\n` +
    `Trainee: ${name || "-"}${tid ? ` (ID ${tid})` : ""}\n` +
    `The request is updated automatically as soon as the payment is received.`,
    PUBLIC_COMMENT);
}

// ─── STEP 2: APPLY A PAYMENT RESULT TO THE TICKET ─────────────────────────────
//  `payment` must come from the Moyasar API (never from the webhook body).
async function applyPayment(payment, source) {
  const invoiceId = payment.invoice_id;
  const db        = loadDb();
  const rec       = invoiceId && db.invoices[invoiceId];
  if (!rec) {
    warn(`${source}: payment ${payment.id} (invoice ${invoiceId || "none"}) is not one of ours — ignored.`);
    return { ignored: "unknown-invoice" };
  }
  const key = rec.issueKey;

  return withLock(key, async () => {
    const fresh = loadDb().invoices[invoiceId];
    if (fresh.status === "paid") return { ignored: "already-paid", issueKey: key };

    if (payment.status === "paid" || payment.status === "captured") {
      if (payment.amount !== fresh.amount || String(payment.currency).toUpperCase() !== fresh.currency) {
        warn(`${key}: AMOUNT MISMATCH on payment ${payment.id}: got ${fmt(payment.amount, payment.currency)}, ` +
             `expected ${fmt(fresh.amount, fresh.currency)} — NOT marking paid.`);
        await comment(key, `⚠️ Payment ${payment.id} received ${fmt(payment.amount, payment.currency)} but the invoice ` +
                           `was ${fmt(fresh.amount, fresh.currency)}. Not marked as paid — please review in Moyasar.`);
        return { error: "amount-mismatch", issueKey: key };
      }
      updateInvoice(invoiceId, { status: "paid", resolvedPaymentId: payment.id, paidAt: new Date().toISOString() });

      const issue  = await getIssue(key);
      const status = issue.fields.status?.name || "";
      if (status.toLowerCase() === STATUS_PAID.toLowerCase()) return { ok: true, issueKey: key, note: "already Paid" };
      try {
        await transitionTo(key, STATUS_PAID);
      } catch (e) {
        // e.g. ticket was moved to "Failed Payment" and that status has no path to "Paid"
        warn(`${key}: paid but could not transition from "${status}": ${e.message}`);
        await comment(key, `⚠️ Payment ${payment.id} of ${fmt(payment.amount)} was received, but the request is in ` +
                           `"${status}" and could not be moved to "${STATUS_PAID}" automatically. Please move it manually.`);
        return { error: "transition-failed", issueKey: key };
      }
      await comment(key, `Payment received: ${fmt(payment.amount)} — Moyasar payment ${payment.id}` +
                         `${TEST_MODE ? " (TEST MODE)" : ""}.`);
      return { ok: true, issueKey: key, status: STATUS_PAID };
    }

    if (payment.status === "failed") {
      if (fresh.lastFailedPaymentId === payment.id) return { ignored: "already-handled", issueKey: key };
      updateInvoice(invoiceId, { lastFailedPaymentId: payment.id });
      const reason = payment.source?.message || payment.source?.response_code || "declined";

      const issue  = await getIssue(key);
      const status = issue.fields.status?.name || "";
      if (ON_FAILED === "transition" && status.toLowerCase() === STATUS_WAITING.toLowerCase()) {
        await transitionTo(key, STATUS_FAILED);
        await comment(key, `Payment attempt failed (${reason}) — Moyasar payment ${payment.id}.`);
        return { ok: true, issueKey: key, status: STATUS_FAILED };
      }
      await comment(key, `⚠️ Payment attempt failed (${reason}) — Moyasar payment ${payment.id}. ` +
                         `Please follow up and transition the request manually. If the trainee retries ` +
                         `and pays with the same link, it is moved to "${STATUS_PAID}" automatically.`);
      return { ok: true, issueKey: key, note: "failure recorded — manual handling" };
    }

    return { ignored: `payment-status-${payment.status}`, issueKey: key };
  });
}

// ─── RECONCILE OPEN INVOICES (works without the webhook) ──────────────────────
async function reconcileOpenInvoices() {
  const open = Object.entries(loadDb().invoices).filter(([, r]) => r.status === "initiated");
  for (const [invoiceId, rec] of open) {
    try {
      const inv = await moyasar("GET", `/invoices/${invoiceId}`);
      const payments = Array.isArray(inv.payments) ? inv.payments : [];
      const paid = payments.find(p => p.status === "paid" || p.status === "captured");
      if (paid) { await applyPayment({ ...paid, invoice_id: invoiceId }, "reconcile"); continue; }

      const lastFailed = payments.filter(p => p.status === "failed").pop();
      if (lastFailed) await applyPayment({ ...lastFailed, invoice_id: invoiceId }, "reconcile");

      if (["expired", "canceled", "cancelled", "voided", "failed"].includes(inv.status)) {
        updateInvoice(invoiceId, { status: inv.status });
        log(`${rec.issueKey}: invoice ${invoiceId} is ${inv.status} — a new one is created if the ticket is still waiting.`);
      }
    } catch (e) {
      warn(`reconcile ${invoiceId} (${rec.issueKey}): ${e.message}`);
    }
  }
}

// ─── POLL LOOP ────────────────────────────────────────────────────────────────
let polling = false;
async function pollPayments() {
  if (polling) return;
  polling = true;
  try {
    await reconcileOpenInvoices();              // results first, so a paid ticket never gets a 2nd invoice
    const issues = await searchWaitingIssues();
    if (issues.length) log(`🔍 ${issues.length} ticket(s) in "${STATUS_WAITING}"`);
    for (const issue of issues) {
      try { await withLock(issue.key, () => ensureInvoice(issue)); }
      catch (e) { console.error(`[Pay] ❌ ${issue.key}: ${e.message}`); }
    }
  } catch (e) {
    console.error(`[Pay] ❌ poll error: ${e.message}`);
  } finally {
    polling = false;
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
function requireKey(req, res, next) {
  if (PAY_API_KEY && safeEqual(req.get("x-api-key"), PAY_API_KEY)) return next();
  if (!PAY_API_KEY && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return next();
  res.status(401).json({ error: "Invalid or missing x-api-key" });
}

function mount(app) {
  // Moyasar → us. Always answers 200 for events we deliberately skip, so Moyasar
  // does not retry them; answers 5xx on transient errors so it DOES retry.
  app.post("/payments/moyasar/webhook", async (req, res) => {
    const evt = req.body || {};
    if (!MOYASAR_WH_SECRET || !safeEqual(evt.secret_token, MOYASAR_WH_SECRET)) {
      warn(`webhook rejected: bad secret_token from ${req.ip}`);
      return res.status(401).json({ error: "unauthorized" });
    }
    if (!["payment_paid", "payment_failed"].includes(evt.type)) return res.json({ ignored: evt.type });
    if (!evt.id || !evt.data?.id) return res.status(400).json({ error: "missing id" });
    if (!!evt.live === TEST_MODE) return res.json({ ignored: "live/test mode mismatch" });

    if (loadDb().events[evt.id]) return res.json({ ignored: "duplicate" });

    try {
      const payment = await moyasar("GET", `/payments/${encodeURIComponent(evt.data.id)}`);
      const result  = await applyPayment(payment, `webhook ${evt.type}`);
      const db = loadDb(); db.events[evt.id] = new Date().toISOString(); saveDb(db);
      res.json(result);
    } catch (e) {
      console.error(`[Pay] ❌ webhook ${evt.id}: ${e.message}`);
      res.status(502).json({ error: "processing failed, retry" });
    }
  });

  // Admin (local / API key)
  app.get("/payments/health", (req, res) => {
    const inv = Object.values(loadDb().invoices);
    const count = s => inv.filter(r => r.status === s).length;
    res.json({
      enabled: PAY_ENABLED, dryRun: PAY_DRY_RUN, mode: MOYASAR_SECRET_KEY ? (TEST_MODE ? "test" : "live") : "no-key",
      webhook: !!MOYASAR_WH_SECRET, project: PAY_PROJECT_KEY, watchStatus: STATUS_WAITING,
      pollMinutes: POLL_INTERVAL / 60000,
      invoices: { open: count("initiated"), paid: count("paid"), total: inv.length },
    });
  });
  app.get("/payments/issue/:key", requireKey, (req, res) =>
    res.json(invoicesForIssue(loadDb(), req.params.key.toUpperCase())));
  app.post("/payments/poll-now", requireKey, (req, res) => {
    pollPayments();
    res.json({ ok: true, message: "poll triggered" });
  });
}

function start() {
  if (!PAY_ENABLED) return log("disabled (PAY_ENABLED=false)");
  if (!MOYASAR_SECRET_KEY && !PAY_DRY_RUN) {
    return warn("MOYASAR_SECRET_KEY not set — payments disabled. Set PAY_DRY_RUN=true to test without a key.");
  }
  if (!MOYASAR_WH_SECRET) warn("MOYASAR_WEBHOOK_SECRET not set — webhook off, results arrive by polling only.");
  const mode = !MOYASAR_SECRET_KEY ? "NO KEY" : TEST_MODE ? "TEST" : "LIVE";
  log(`✅ ${PAY_DRY_RUN ? "DRY-RUN · " : ""}${mode} mode · ${PAY_PROJECT_KEY} · ` +
      `"${PAY_REQUEST_TYPE}" in "${STATUS_WAITING}" · every ${POLL_INTERVAL / 60000} min`);
  pollPayments();
  setInterval(pollPayments, POLL_INTERVAL);
}

module.exports = { mount, start, pollPayments, applyPayment, toMinorUnits };
