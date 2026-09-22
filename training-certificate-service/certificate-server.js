/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  AL SALAMA HOSPITAL — TRAINING COMPLETION CERTIFICATE SERVICE
 * ─────────────────────────────────────────────────────────────────────────────
 *  Standalone service (own process / own port) that watches the ASAC Jira
 *  Service Management project and, when a "Trainee Requests" ticket reaches the
 *  clearance status, emails the reporter a branded Training Completion
 *  Certificate (A4 landscape PDF) and writes the certificate back to the ticket.
 *
 *  Run:      node certificate-server.js
 *  Requires: express, puppeteer, nodemailer, dotenv   (already in package.json)
 *            Node.js 18+ (global fetch / FormData / Blob)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express    = require("express");
const puppeteer  = require("puppeteer");
const nodemailer = require("nodemailer");
const path       = require("path");
const fs         = require("fs");

const app = express();
app.use(express.json());

// ─── JIRA CONFIG ──────────────────────────────────────────────────────────────
const JIRA_BASE_URL  = process.env.JIRA_BASE_URL;
const JIRA_EMAIL     = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const SYSTEM_AUTH    = "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
const HOSPITAL_NAME  = process.env.HOSPITAL_NAME || "Al Salama Hospital";

// ─── SERVICE CONFIG ───────────────────────────────────────────────────────────
const CERT_PORT     = parseInt(process.env.CERT_PORT || "3004");
const CERT_BIND     = process.env.CERT_BIND || "127.0.0.1";   // localhost-only by default
const CERT_API_KEY  = process.env.CERT_API_KEY || "";          // optional x-api-key for the routes
const POLL_INTERVAL = parseInt(process.env.CERT_POLL_INTERVAL_MINUTES || "5") * 60 * 1000;

// Each poll only looks at tickets updated since the previous one. If the service
// was stopped (restart, patching, server reboot) the tickets that cleared in the
// meantime would fall outside that window, so the FIRST poll after startup looks
// back further. The sent-certificates tracker still prevents duplicates.
const STARTUP_LOOKBACK_HOURS = parseFloat(process.env.CERT_STARTUP_LOOKBACK_HOURS || "24");
let isFirstPoll = true;

// ─── TRIGGER CONFIG — confirm these three against Jira, they are exact-match ──
const CERT_PROJECT_KEY  = process.env.CERT_PROJECT_KEY  || "ASAC";
const CERT_STATUS       = process.env.CERT_STATUS       || "Clearance";        // exact Jira status name
const CERT_REQUEST_TYPE = process.env.CERT_REQUEST_TYPE || "Trainee Requests"; // matched case-insensitively

// ─── CERTIFICATE FIELD IDS ────────────────────────────────────────────────────
const CF_TRAINEE_NAME = process.env.CF_TRAINEE_NAME || "customfield_13434";
const CF_TRAINEE_ID   = process.env.CF_TRAINEE_ID   || "customfield_13457";
const CF_INSTITUTION  = process.env.CF_INSTITUTION  || "customfield_13438";
const CF_PROGRAM      = process.env.CF_PROGRAM      || "customfield_13451";
const CF_DEPARTMENT   = process.env.CF_DEPARTMENT   || "customfield_10074";
const CF_START_DATE   = process.env.CF_START_DATE   || "";   // optional — leave blank to hide
const CF_END_DATE     = process.env.CF_END_DATE     || "";   // optional — leave blank to hide

// Fields that must carry a value before a certificate is issued
const REQUIRED_FIELDS = [
  { id: CF_TRAINEE_NAME, label: "Trainee Name" },
  { id: CF_TRAINEE_ID,   label: "Trainee ID" },
  { id: CF_INSTITUTION,  label: "Institution Name" },
  { id: CF_PROGRAM,      label: "Preferred Program" },
  { id: CF_DEPARTMENT,   label: "Training Department" },
];

// ─── EMAIL CONFIG ─────────────────────────────────────────────────────────────
const SMTP_HOST    = process.env.SMTP_HOST;
const SMTP_PORT    = parseInt(process.env.SMTP_PORT || "25");
const SMTP_USER    = process.env.SMTP_USER || "";
const SMTP_PASS    = process.env.SMTP_PASS || "";
const SMTP_FROM    = process.env.SMTP_FROM    || "noreply@alsalamahospital.com";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "Ahmed.Gouda@alsalamahospital.com";

// Fixed training-team CC — set CERT_CC_EMAILS in .env as a comma-separated list
const TRAINING_TEAM_CC = (process.env.CERT_CC_EMAILS || "")
  .split(",").map(e => e.trim()).filter(Boolean);

// ─── SIGNATORIES ──────────────────────────────────────────────────────────────
const SIGNATORY_1_NAME  = process.env.CERT_SIGNATORY_1_NAME  || "";
const SIGNATORY_1_TITLE = process.env.CERT_SIGNATORY_1_TITLE || "Training & Academic Affairs";
const SIGNATORY_2_NAME  = process.env.CERT_SIGNATORY_2_NAME  || "";
const SIGNATORY_2_TITLE = process.env.CERT_SIGNATORY_2_TITLE || "Medical Director";

// ─── JIRA WRITE-BACK ──────────────────────────────────────────────────────────
const ATTACH_TO_JIRA  = (process.env.CERT_ATTACH_TO_JIRA  || "true").toLowerCase() !== "false";
const COMMENT_ON_JIRA = (process.env.CERT_COMMENT_ON_JIRA || "true").toLowerCase() !== "false";

// ─── LOGO ─────────────────────────────────────────────────────────────────────
// Priority: assets/alsalama-logo.png  →  logo.js  →  public/<HOSPITAL_LOGO_PATH>
let LOGO_DATA_URI = null;
(function loadLogo() {
  const assetLogo = path.join(__dirname, "assets", "alsalama-logo.png");
  if (fs.existsSync(assetLogo)) {
    LOGO_DATA_URI = "data:image/png;base64," + fs.readFileSync(assetLogo).toString("base64");
    console.log("[Logo] ✅ Loaded from assets/alsalama-logo.png");
    return;
  }
  const logoJs = path.join(__dirname, "logo.js");
  if (fs.existsSync(logoJs)) {
    try {
      LOGO_DATA_URI = require("./logo.js");
      console.log("[Logo] ✅ Loaded from logo.js");
      return;
    } catch (e) { console.warn("[Logo] ❌ logo.js failed:", e.message); }
  }
  const logoPath  = process.env.HOSPITAL_LOGO_PATH;
  const publicDir = path.join(__dirname, "public");
  if (logoPath && fs.existsSync(publicDir)) {
    const target  = logoPath.trim().toLowerCase();
    const matched = fs.readdirSync(publicDir).find(f => f.toLowerCase() === target);
    if (matched) {
      const ext  = path.extname(matched).replace(".", "").toLowerCase();
      const mime = (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : "image/png";
      LOGO_DATA_URI = `data:${mime};base64,` + fs.readFileSync(path.join(publicDir, matched)).toString("base64");
      console.log(`[Logo] ✅ Loaded from public/${matched}`);
      return;
    }
  }
  console.warn("[Logo] ⚠️  No logo found — certificate will print without it.");
})();

// ─── OPTIONAL IMAGES (seal + accreditation marks) ─────────────────────────────
const IMAGE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};

function fileToDataUri(fullPath) {
  const ext  = path.extname(fullPath).replace(".", "").toLowerCase();
  const mime = IMAGE_MIME[ext] || "image/png";
  return `data:${mime};base64,` + fs.readFileSync(fullPath).toString("base64");
}

// Looks for an explicit .env path first, then the default asset filenames in
// any supported extension. Returns null (and logs) when nothing is found.
function loadOptionalImage(label, envPath, baseNames) {
  if (envPath) {
    const full = path.isAbsolute(envPath) ? envPath : path.join(__dirname, envPath);
    if (fs.existsSync(full)) {
      console.log(`[${label}] ✅ Loaded from ${envPath}`);
      return fileToDataUri(full);
    }
    console.warn(`[${label}] ⚠️  Not found: ${full}`);
    return null;
  }
  for (const base of baseNames) {
    for (const ext of Object.keys(IMAGE_MIME)) {
      const full = path.join(__dirname, "assets", `${base}.${ext}`);
      if (fs.existsSync(full)) {
        console.log(`[${label}] ✅ Loaded from assets/${base}.${ext}`);
        return fileToDataUri(full);
      }
    }
  }
  return null;
}

// Round seal / stamp — optional
const SEAL_DATA_URI = loadOptionalImage("Seal", process.env.CERT_SEAL_PATH, ["seal"]);

// Accreditation marks — drop the approved artwork in assets/ and it appears
// automatically; nothing breaks if a file is absent.
const JCI_DATA_URI   = loadOptionalImage("JCI",   process.env.CERT_JCI_LOGO_PATH,   ["jci-logo", "jci"]);
const CBAHI_DATA_URI = loadOptionalImage("CBAHI", process.env.CERT_CBAHI_LOGO_PATH, ["cbahi-logo", "cbahi"]);
const ACCREDITATION_LABEL = process.env.CERT_ACCREDITATION_LABEL || "Accredited by";

// Printed height of each mark in millimetres. A round seal needs a little more
// height than a wide wordmark to look the same size, hence the two defaults.
const JCI_HEIGHT_MM   = parseFloat(process.env.CERT_JCI_HEIGHT_MM   || "15");
const CBAHI_HEIGHT_MM = parseFloat(process.env.CERT_CBAHI_HEIGHT_MM || "10");

if (!JCI_DATA_URI && !CBAHI_DATA_URI) {
  console.warn("[Accreditation] ⚠️  No JCI/CBAHI artwork in assets/ — the accreditation strip is hidden.");
}

// ─── SENT TRACKER ─────────────────────────────────────────────────────────────
const sentFilePath = path.join(__dirname, "sent-certificates.json");

function loadSentCerts() {
  if (!fs.existsSync(sentFilePath)) return {};
  try { return JSON.parse(fs.readFileSync(sentFilePath, "utf8")); }
  catch { return {}; }
}
function markCertSent(issueKey, info) {
  const sent = loadSentCerts();
  sent[issueKey] = { sentAt: new Date().toISOString(), ...info };
  fs.writeFileSync(sentFilePath, JSON.stringify(sent, null, 2), "utf8");
}
function alreadySentCert(issueKey) {
  return !!loadSentCerts()[issueKey];
}

// Tickets whose fields were incomplete — remembered only so ICT is alerted once
const incompleteAlerted = new Set();

// ─── USER → EMAIL MAP ─────────────────────────────────────────────────────────
const userEmailMapPath = path.join(__dirname, "user-email-map.json");
let userEmailMap = {};
try {
  userEmailMap = JSON.parse(fs.readFileSync(userEmailMapPath, "utf8"));
  delete userEmailMap["_comment"];
  delete userEmailMap["_usage"];
  console.log(`[UserMap] ✅ ${Object.keys(userEmailMap).length} name→email mappings loaded.`);
} catch {
  console.warn("[UserMap] ⚠️  user-email-map.json not found — relying on Jira API only.");
}

function lookupEmailByName(displayName) {
  if (!displayName) return null;
  if (userEmailMap[displayName]) return userEmailMap[displayName];
  const lower = displayName.toLowerCase();
  const found = Object.entries(userEmailMap).find(([k]) => k.toLowerCase() === lower);
  return found ? found[1] : null;
}
function lookupEmailByAccountId(accountId) {
  return accountId && userEmailMap[accountId] ? userEmailMap[accountId] : null;
}

const userEmailCache = {};
async function fetchUserEmailByAccountId(accountId, displayName) {
  if (!accountId && !displayName) return null;
  const byId = lookupEmailByAccountId(accountId);
  if (byId) return byId;
  if (displayName) {
    const byName = lookupEmailByName(displayName);
    if (byName) return byName;
  }
  if (!accountId) return null;
  if (userEmailCache[accountId]) return userEmailCache[accountId];
  try {
    const res = await fetch(
      `${JIRA_BASE_URL}/rest/api/3/user?accountId=${encodeURIComponent(accountId)}&expand=emailAddress`,
      { headers: { Authorization: SYSTEM_AUTH, Accept: "application/json" } }
    );
    if (res.ok) {
      const user = await res.json();
      if (user.emailAddress) {
        userEmailCache[accountId] = user.emailAddress;
        return user.emailAddress;
      }
    }
    console.warn(`[UserMap] ⚠️  "${displayName || accountId.slice(-8)}" unresolved — add to user-email-map.json`);
  } catch (e) {
    console.warn(`[UserMap] error: ${e.message}`);
  }
  return null;
}

// ─── JIRA HELPERS ─────────────────────────────────────────────────────────────
async function fetchTicket(issueKey) {
  const res = await fetch(
    `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}?fields=*all`,
    { headers: { Authorization: SYSTEM_AUTH, Accept: "application/json" } }
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Ticket ${issueKey} not found.`);
    if (res.status === 401 || res.status === 403) throw new Error(`Access denied for ${issueKey} — check the API token.`);
    throw new Error(`Jira API error (${res.status}) for ${issueKey}`);
  }
  return res.json();
}

async function fetchJsmRequester(issueKey) {
  try {
    const res = await fetch(
      `${JIRA_BASE_URL}/rest/servicedeskapi/request/${issueKey}`,
      { headers: { Authorization: SYSTEM_AUTH, Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const reporter = (await res.json()).reporter;
    if (!reporter) return null;
    if (reporter.emailAddress) return reporter.emailAddress;
    return fetchUserEmailByAccountId(reporter.accountId, reporter.displayName);
  } catch (e) {
    console.warn(`[JSM] requester lookup failed: ${e.message}`);
    return null;
  }
}

async function fetchParticipants(issueKey) {
  try {
    const res = await fetch(
      `${JIRA_BASE_URL}/rest/servicedeskapi/request/${issueKey}/participant`,
      { headers: { Authorization: SYSTEM_AUTH, Accept: "application/json" } }
    );
    if (!res.ok) return [];
    return ((await res.json()).values || []).map(u => u.emailAddress || "").filter(Boolean);
  } catch { return []; }
}

function getRequestTypeName(fields) {
  const raw = fields["customfield_10010"];
  if (!raw) return "";
  return raw.requestType?.name || raw.requestType?.description || raw.value || raw.name || "";
}

// Upload the certificate PDF as an attachment on the ticket
async function attachCertificateToJira(issueKey, pdfBuffer, filename) {
  try {
    const form = new FormData();
    form.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), filename);
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`, {
      method:  "POST",
      headers: { Authorization: SYSTEM_AUTH, "X-Atlassian-Token": "no-check", Accept: "application/json" },
      body:    form,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
    console.log(`[Jira] 📎 Certificate attached to ${issueKey}`);
    return true;
  } catch (e) {
    console.warn(`[Jira] ⚠️  Attach failed for ${issueKey}: ${e.message}`);
    return false;
  }
}

// Post an internal (agent-only) comment; falls back to a normal Jira comment
async function commentOnJira(issueKey, text) {
  try {
    const res = await fetch(`${JIRA_BASE_URL}/rest/servicedeskapi/request/${issueKey}/comment`, {
      method:  "POST",
      headers: { Authorization: SYSTEM_AUTH, Accept: "application/json", "Content-Type": "application/json" },
      body:    JSON.stringify({ body: text, public: false }),
    });
    if (res.ok) { console.log(`[Jira] 💬 Internal comment added to ${issueKey}`); return true; }

    const fallback = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`, {
      method:  "POST",
      headers: { Authorization: SYSTEM_AUTH, Accept: "application/json", "Content-Type": "application/json" },
      body:    JSON.stringify({
        body: {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
      }),
    });
    if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
    console.log(`[Jira] 💬 Comment added to ${issueKey}`);
    return true;
  } catch (e) {
    console.warn(`[Jira] ⚠️  Comment failed for ${issueKey}: ${e.message}`);
    return false;
  }
}

// ─── FIELD VALUE RESOLVER ─────────────────────────────────────────────────────
// Shape-agnostic: plain text, number, date, single/multi select, cascading
// select, user picker, and ADF rich text all resolve to a display string.
function adfToText(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  let text = "";
  if (adf.content) {
    for (const node of adf.content) {
      if (node.type === "text")           text += node.text || "";
      else if (node.type === "hardBreak") text += " ";
      else                                text += adfToText(node);
      if (node.type === "paragraph" || node.type === "heading") text += " ";
    }
  }
  return text.trim();
}

// Several ASAC select lists carry a bilingual label, e.g. the Training
// Department option "ICT قسم تقنية المعلومات". The certificate is written in
// English, and mixing scripts inside an English sentence reads badly (and
// depends on an Arabic font being installed on the print host), so the Arabic
// half is dropped when a Latin half exists. Arabic-only values are left
// untouched — nothing is ever blanked out.
const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ENGLISH_ONLY_FIELDS = (process.env.CERT_ENGLISH_ONLY_FIELDS || "true").toLowerCase() !== "false";

function preferLatinScript(value, fieldLabel) {
  if (!ENGLISH_ONLY_FIELDS || !value) return value;
  if (!ARABIC_RANGE.test(value)) return value;
  if (!/[A-Za-z]/.test(value)) return value;   // Arabic-only — keep as it is

  const cleaned = value
    .replace(new RegExp(ARABIC_RANGE.source, "g"), "")
    .replace(/[\u060C\u061B\u061F\u0640]/g, "")   // Arabic comma, semicolon, question mark, tatweel
    .replace(/[-–—/|،]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleaned) return value;
  if (cleaned !== value) {
    console.log(`[Cert] 🔤 ${fieldLabel || "field"}: "${value}" → "${cleaned}" (English-only certificate)`);
  }
  return cleaned;
}

function readFieldValue(fields, fieldId) {
  if (!fieldId) return "";
  const raw = fields[fieldId];
  if (raw === null || raw === undefined) return "";

  if (typeof raw === "string")  return raw.trim();
  if (typeof raw === "number")  return String(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";

  if (Array.isArray(raw)) {
    return raw
      .map(v => (typeof v === "object" && v !== null)
        ? (v.value || v.name || v.displayName || v.emailAddress || "")
        : String(v))
      .filter(Boolean)
      .join(", ");
  }

  if (typeof raw === "object") {
    if (raw.type === "doc") return adfToText(raw);
    let val = raw.value || raw.name || raw.displayName || raw.accountName || raw.emailAddress || "";
    if (raw.child) val += " — " + (raw.child.value || raw.child.name || "");
    return String(val).trim();
  }
  return "";
}

// ─── FORMATTING ───────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatCertDate(d) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}

// Deterministic certificate number — the same ticket always yields the same number
function buildCertificateNumber(issue) {
  const key    = issue.key || "";
  const num    = (key.split("-")[1] || "0").padStart(5, "0");
  const source = issue.fields.resolutiondate || issue.fields.updated || issue.fields.created;
  const year   = source ? new Date(source).getFullYear() : new Date().getFullYear();
  return `ASH/TRN/${year}/${num}`;
}

// ─── CERTIFICATE DATA ─────────────────────────────────────────────────────────
function buildCertificateData(issue) {
  const f = issue.fields;
  return {
    issueKey:    issue.key,
    traineeName: preferLatinScript(readFieldValue(f, CF_TRAINEE_NAME), "Trainee Name"),
    traineeId:   readFieldValue(f, CF_TRAINEE_ID),
    institution: preferLatinScript(readFieldValue(f, CF_INSTITUTION), "Institution"),
    program:     preferLatinScript(readFieldValue(f, CF_PROGRAM),     "Program"),
    department:  preferLatinScript(readFieldValue(f, CF_DEPARTMENT),  "Department"),
    startDate:   CF_START_DATE ? formatCertDate(readFieldValue(f, CF_START_DATE)) : "",
    endDate:     CF_END_DATE   ? formatCertDate(readFieldValue(f, CF_END_DATE))   : "",
    certNo:      buildCertificateNumber(issue),
    issuedOn:    formatCertDate(f.resolutiondate || f.updated || new Date()),
    requestType: getRequestTypeName(f),
  };
}

function missingRequiredFields(issue) {
  return REQUIRED_FIELDS
    .filter(f => !readFieldValue(issue.fields, f.id))
    .map(f => `${f.label} (${f.id})`);
}

// ─── CERTIFICATE HTML TEMPLATE (A4 landscape) ─────────────────────────────────
function buildCertificateHTML(data) {
  const navy = "#16355e", teal = "#0e9aa7", gold = "#c0973f", ink = "#2b3648";

  const detail = (label, value) => !value ? "" : `
    <div class="detail">
      <div class="detail-label">${escapeHtml(label)}</div>
      <div class="detail-value">${escapeHtml(value)}</div>
    </div>`;

  const signature = (name, title) => `
    <div class="sign">
      <div class="sign-line"></div>
      ${name ? `<div class="sign-name">${escapeHtml(name)}</div>` : `<div class="sign-name">&nbsp;</div>`}
      <div class="sign-title">${escapeHtml(title)}</div>
    </div>`;

  const periodLine = (data.startDate && data.endDate)
    ? `<div class="period">Training period: ${escapeHtml(data.startDate)} &mdash; ${escapeHtml(data.endDate)}</div>`
    : "";

  // Accreditation strip — rendered only for the artwork that is actually present
  const accreditationMarks = [
    JCI_DATA_URI   ? `<img src="${JCI_DATA_URI}" alt="JCI Accredited" style="height:${JCI_HEIGHT_MM}mm"/>`       : "",
    CBAHI_DATA_URI ? `<img src="${CBAHI_DATA_URI}" alt="CBAHI Accredited" style="height:${CBAHI_HEIGHT_MM}mm"/>` : "",
  ].filter(Boolean);

  const accreditationStrip = accreditationMarks.length
    ? `<div class="accreditation">
         <span class="accreditation-label">${escapeHtml(ACCREDITATION_LABEL)}</span>
         <span class="divider"></span>
         ${accreditationMarks.join(`<span class="divider"></span>`)}
       </div>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  @page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; width: 297mm; height: 210mm;
    font-family: Georgia, "Times New Roman", serif; color: ${ink};
    background: #ffffff;
  }
  .sheet {
    position: relative; width: 297mm; height: 210mm; padding: 9mm;
    background:
      radial-gradient(circle at 12% 88%, rgba(14,154,167,0.07), transparent 42%),
      radial-gradient(circle at 88% 12%, rgba(192,151,63,0.09), transparent 42%),
      #ffffff;
  }
  .frame {
    position: relative; width: 100%; height: 100%;
    border: 2.4mm solid ${navy}; border-radius: 2mm; padding: 2mm;
  }
  .frame-inner {
    width: 100%; height: 100%; border: 0.5mm solid ${gold}; border-radius: 1mm;
    padding: 6mm 14mm 5mm; display: flex; flex-direction: column; align-items: center;
    text-align: center;
  }

  .logo { height: 25mm; margin-bottom: 3mm; }
  .logo-fallback {
    font-size: 22pt; font-weight: 700; color: ${navy}; letter-spacing: .5pt; margin-bottom: 4mm;
  }

  .rule { width: 46mm; height: 0.9mm; background: ${gold}; border-radius: 1mm; margin: 1mm 0 5mm; }

  .title {
    font-size: 30pt; font-weight: 700; color: ${navy};
    letter-spacing: 5pt; text-transform: uppercase; line-height: 1.05;
  }
  .subtitle {
    font-size: 11.5pt; color: ${teal}; letter-spacing: 3.6pt;
    text-transform: uppercase; margin-top: 2mm;
  }

  .lead { font-size: 12pt; color: #5a6675; margin-top: 6mm; font-style: italic; }

  .name {
    font-size: 30pt; font-weight: 700; color: ${navy}; margin-top: 3mm;
    padding: 0 8mm 2.5mm; border-bottom: 0.6mm solid ${gold}; display: inline-block;
    max-width: 210mm; line-height: 1.25;
  }

  .statement {
    font-size: 12.5pt; line-height: 1.85; color: ${ink};
    max-width: 218mm; margin-top: 6mm;
  }
  .statement strong { color: ${navy}; font-weight: 700; }

  .period { font-size: 10.5pt; color: #5a6675; margin-top: 3mm; font-style: italic; }

  .details {
    display: flex; justify-content: center; gap: 4mm; flex-wrap: wrap;
    margin-top: 6mm; width: 100%;
  }
  .detail {
    min-width: 46mm; max-width: 64mm; padding: 3mm 4mm;
    background: #f4f7fb; border: 0.3mm solid #dce4ef; border-top: 1mm solid ${teal};
    border-radius: 1.2mm; text-align: left;
  }
  .detail-label {
    font-family: "Segoe UI", Arial, sans-serif; font-size: 7pt; font-weight: 700;
    letter-spacing: 1.1pt; text-transform: uppercase; color: ${teal}; margin-bottom: 1.2mm;
  }
  .detail-value {
    font-family: "Segoe UI", Arial, sans-serif; font-size: 9.5pt; font-weight: 600;
    color: ${navy}; line-height: 1.35; word-break: break-word;
  }

  .signatures {
    margin-top: auto; padding-top: 4mm; width: 100%;
    display: flex; justify-content: space-around; align-items: flex-end;
  }
  .sign { width: 70mm; }
  .sign-line { border-bottom: 0.4mm solid ${navy}; margin-bottom: 2mm; }
  .sign-name  { font-size: 10.5pt; font-weight: 700; color: ${navy}; }
  .sign-title {
    font-family: "Segoe UI", Arial, sans-serif; font-size: 8pt; color: #6b7889;
    letter-spacing: .6pt; text-transform: uppercase; margin-top: .8mm;
  }
  .seal { height: 26mm; opacity: .92; }

  .accreditation {
    width: 100%; margin-top: 3.5mm;
    display: flex; align-items: center; justify-content: center; gap: 6mm;
  }
  .accreditation-label {
    font-family: "Segoe UI", Arial, sans-serif; font-size: 7pt; font-weight: 700;
    letter-spacing: 1.4pt; text-transform: uppercase; color: #9aa6b6; white-space: nowrap;
  }
  .accreditation img { width: auto; object-fit: contain; }
  .accreditation .divider { width: 0.3mm; height: 7mm; background: #dce4ef; }

  .footer {
    width: 100%; margin-top: 3mm; padding-top: 2mm; border-top: 0.3mm solid #dce4ef;
    display: flex; justify-content: space-between;
    font-family: "Segoe UI", Arial, sans-serif; font-size: 7.5pt; color: #8b98a8;
    letter-spacing: .3pt;
  }
</style></head>
<body>
  <div class="sheet"><div class="frame"><div class="frame-inner">

    ${LOGO_DATA_URI
      ? `<img class="logo" src="${LOGO_DATA_URI}" alt="${escapeHtml(HOSPITAL_NAME)}"/>`
      : `<div class="logo-fallback">${escapeHtml(HOSPITAL_NAME)}</div>`}

    <div class="rule"></div>

    <div class="title">Certificate</div>
    <div class="subtitle">of Training Completion</div>

    <div class="lead">This is to certify that</div>
    <div class="name">${escapeHtml(data.traineeName)}</div>

    <div class="statement">
      holder of ID <strong>${escapeHtml(data.traineeId)}</strong>, from
      <strong>${escapeHtml(data.institution)}</strong>, has successfully completed the training
      program <strong>${escapeHtml(data.program)}</strong> at
      <strong>${escapeHtml(HOSPITAL_NAME)}</strong>,
      <strong>${escapeHtml(data.department)}</strong> Department.
    </div>

    ${periodLine}

    <div class="details">
      ${detail("Trainee ID", data.traineeId)}
      ${detail("Institution", data.institution)}
      ${detail("Program", data.program)}
      ${detail("Department", data.department)}
    </div>

    <div class="signatures">
      ${signature(SIGNATORY_1_NAME, SIGNATORY_1_TITLE)}
      ${SEAL_DATA_URI ? `<img class="seal" src="${SEAL_DATA_URI}" alt="Seal"/>` : `<div style="width:26mm"></div>`}
      ${signature(SIGNATORY_2_NAME, SIGNATORY_2_TITLE)}
    </div>

    ${accreditationStrip}

    <div class="footer">
      <span>Certificate No: <strong>${escapeHtml(data.certNo)}</strong></span>
      <span>Issued on ${escapeHtml(data.issuedOn)}</span>
      <span>Ref: ${escapeHtml(data.issueKey)}</span>
    </div>

  </div></div></div>
</body></html>`;
}

// ─── PDF GENERATOR ────────────────────────────────────────────────────────────
async function generateCertificatePDF(data) {
  const html    = buildCertificateHTML(data);
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    return await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" },
    });
  } finally {
    await browser.close();
  }
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
function createTransporter() {
  const config = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    name: "alsalamahospital.com",
    requireTLS: SMTP_PORT === 587,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout:   8000,
    socketTimeout:     10000,
  };
  if (SMTP_USER && SMTP_PASS) config.auth = { user: SMTP_USER, pass: SMTP_PASS };
  return nodemailer.createTransport(config);
}

async function testSmtp() {
  if (!SMTP_HOST) return;
  console.log(`[SMTP] Testing ${SMTP_HOST}:${SMTP_PORT}...`);
  try {
    await createTransporter().verify();
    console.log("[SMTP] ✅ Connection successful.");
  } catch (err) {
    console.warn(`[SMTP] ❌ ${err.message} — check SMTP_HOST / SMTP_PORT in .env`);
  }
}

async function resolveRecipients(issue) {
  const f = issue.fields;
  const [jsmRequesterEmail, participantEmails] = await Promise.all([
    fetchJsmRequester(issue.key),
    fetchParticipants(issue.key),
  ]);

  const reporterEmail = f.reporter?.emailAddress
    || lookupEmailByAccountId(f.reporter?.accountId)
    || lookupEmailByName(f.reporter?.displayName)
    || (await fetchUserEmailByAccountId(f.reporter?.accountId, f.reporter?.displayName));

  const toSet = new Set();
  if (jsmRequesterEmail) toSet.add(jsmRequesterEmail.toLowerCase());
  if (reporterEmail)     toSet.add(reporterEmail.toLowerCase());

  const ccSet = new Set(TRAINING_TEAM_CC.map(e => e.toLowerCase()));
  participantEmails.forEach(e => ccSet.add(e.toLowerCase()));

  const assigneeEmail = f.assignee?.emailAddress
    || lookupEmailByAccountId(f.assignee?.accountId)
    || lookupEmailByName(f.assignee?.displayName);
  if (assigneeEmail) ccSet.add(assigneeEmail.toLowerCase());

  toSet.forEach(e => ccSet.delete(e));

  return { to: [...toSet], cc: [...ccSet] };
}

function buildEmailHTML(data) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#f0f4f8;">
<div style="max-width:620px;margin:20px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.10);">

  <div style="background:linear-gradient(135deg,#16355e,#0e9aa7);padding:22px 32px;color:#ffffff;">
    <div style="font-size:11px;opacity:0.85;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${escapeHtml(HOSPITAL_NAME)} · Academic Affairs &amp; Training</div>
    <div style="font-size:20px;font-weight:800;">🎓 Training Completion Certificate</div>
    <div style="font-size:13px;opacity:0.9;margin-top:5px;">Certificate No. <strong>${escapeHtml(data.certNo)}</strong></div>
  </div>

  <div style="padding:28px 32px;">
    <p style="font-size:14px;color:#1a1a2e;margin:0 0 18px;">Dear ${escapeHtml(data.traineeName)},</p>

    <p style="font-size:14px;color:#1a1a2e;line-height:1.75;margin:0 0 20px;">
      Congratulations on successfully completing your training programme
      <strong>${escapeHtml(data.program)}</strong> at ${escapeHtml(HOSPITAL_NAME)},
      <strong>${escapeHtml(data.department)}</strong> Department.
    </p>

    <p style="font-size:14px;color:#1a1a2e;line-height:1.75;margin:0 0 22px;">
      Your Training Completion Certificate is attached to this email as a PDF, ready to print or share.
    </p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:22px;">
      <tr>
        <td style="padding:8px 12px;background:#16355e;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;width:38%;">Trainee</td>
        <td style="padding:8px 12px;background:#eef3f9;font-size:13px;color:#16355e;font-weight:600;">${escapeHtml(data.traineeName)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#16355e;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">Trainee ID</td>
        <td style="padding:8px 12px;font-size:13px;color:#1a1a2e;border:1px solid #e0e7ef;">${escapeHtml(data.traineeId)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#16355e;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">Institution</td>
        <td style="padding:8px 12px;font-size:13px;color:#1a1a2e;border:1px solid #e0e7ef;background:#f7f9fc;">${escapeHtml(data.institution)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#16355e;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">Programme</td>
        <td style="padding:8px 12px;font-size:13px;color:#1a1a2e;border:1px solid #e0e7ef;">${escapeHtml(data.program)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#16355e;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">Department</td>
        <td style="padding:8px 12px;font-size:13px;color:#1a1a2e;border:1px solid #e0e7ef;background:#f7f9fc;">${escapeHtml(data.department)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#16355e;color:#ffffff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">Issued On</td>
        <td style="padding:8px 12px;font-size:13px;color:#1a1a2e;border:1px solid #e0e7ef;">${escapeHtml(data.issuedOn)}</td>
      </tr>
    </table>

    <div style="background:#e6f6f8;border:1px solid #9ad7de;border-radius:8px;padding:12px 16px;font-size:12px;color:#0e7c87;margin-bottom:20px;">
      📎 Certificate attached · Reference ticket <strong>${escapeHtml(data.issueKey)}</strong>
    </div>

    <p style="font-size:13px;color:#37474f;line-height:1.7;margin:0;">
      Best Regards,<br/>
      <strong>${escapeHtml(HOSPITAL_NAME)} — Academic Affairs &amp; Training</strong>
    </p>
  </div>

  <div style="background:#fff8e1;border-top:1px solid #ffe082;padding:12px 32px;text-align:center;">
    <span style="font-size:11px;color:#f57f17;font-weight:600;">⚠️ This is an automated notification — please do not reply to this email.</span>
  </div>

  <div style="background:#f0f4f8;border-top:2px solid #e0e7ef;padding:12px 32px;display:flex;justify-content:space-between;">
    <span style="font-size:10.5px;font-weight:700;color:#16355e;">🔒 Al Salama Controlled Copy — ICT</span>
    <span style="font-size:10.5px;color:#90a4ae;">For Internal Use Only</span>
  </div>
</div>
</body></html>`;
}

async function sendCertificateEmail(issue, data, pdfBuffer) {
  const { to, cc } = await resolveRecipients(issue);

  if (to.length === 0) {
    throw new Error(`No recipient resolved for ${issue.key} — add the reporter to user-email-map.json`);
  }

  const filename = `Training-Certificate-${data.issueKey}-${data.traineeName.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-")}.pdf`;

  console.log(`[Cert] ${issue.key} → TO: ${to.join(", ")} | CC: ${cc.join(", ") || "none"}`);

  await createTransporter().sendMail({
    from:    `"${HOSPITAL_NAME} — Training" <${SMTP_FROM}>`,
    replyTo: `"Do Not Reply" <noreply@alsalamahospital.com>`,
    to:      to.join(","),
    cc:      cc.length ? cc : undefined,
    subject: `🎓 Training Completion Certificate — ${data.traineeName} (${data.issueKey})`,
    html:    buildEmailHTML(data),
    attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
  });

  console.log(`[Cert] ✅ Certificate emailed for ${issue.key}`);
  return { to, cc, filename };
}

async function alertIncompleteFields(issue, missing) {
  if (incompleteAlerted.has(issue.key) || !SMTP_HOST) return;
  incompleteAlerted.add(issue.key);
  try {
    await createTransporter().sendMail({
      from:    `"${HOSPITAL_NAME} — Training" <${SMTP_FROM}>`,
      to:      NOTIFY_EMAIL,
      subject: `⚠️ [${issue.key}] Certificate not issued — missing fields`,
      html: `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;">
        Ticket <strong>${escapeHtml(issue.key)}</strong> reached status
        <strong>${escapeHtml(CERT_STATUS)}</strong> but the certificate could not be issued
        because these fields are empty:</p>
        <ul style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;">
        ${missing.map(m => `<li>${escapeHtml(m)}</li>`).join("")}</ul>
        <p style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;">
        Fill them in on the ticket — the service will issue the certificate automatically on the next poll.</p>`,
    });
    console.log(`[Cert] ✉️  Incomplete-fields alert sent to ${NOTIFY_EMAIL} for ${issue.key}`);
  } catch (e) {
    console.warn(`[Cert] ⚠️  Alert email failed: ${e.message}`);
  }
}

// ─── ISSUE ONE CERTIFICATE ────────────────────────────────────────────────────
async function issueCertificate(issueKey, { force = false } = {}) {
  if (!force && alreadySentCert(issueKey)) {
    console.log(`[Cert] ⏭️  Already issued: ${issueKey}`);
    return { skipped: true, reason: "already-issued" };
  }

  const issue   = await fetchTicket(issueKey);
  const missing = missingRequiredFields(issue);

  if (missing.length) {
    console.warn(`[Cert] ⚠️  ${issueKey} missing: ${missing.join(", ")} — not issued.`);
    await alertIncompleteFields(issue, missing);
    return { skipped: true, reason: "missing-fields", missing };
  }

  const data      = buildCertificateData(issue);
  const pdfBuffer = await generateCertificatePDF(data);
  const sent      = await sendCertificateEmail(issue, data, pdfBuffer);

  if (ATTACH_TO_JIRA)  await attachCertificateToJira(issueKey, pdfBuffer, sent.filename);
  if (COMMENT_ON_JIRA) {
    await commentOnJira(
      issueKey,
      `Training Completion Certificate ${data.certNo} issued automatically and emailed to: ` +
      `${sent.to.join(", ")}${sent.cc.length ? ` (cc: ${sent.cc.join(", ")})` : ""} on ` +
      `${new Date().toLocaleString("en-GB")}.`
    );
  }

  markCertSent(issueKey, { certNo: data.certNo, to: sent.to, trainee: data.traineeName });
  incompleteAlerted.delete(issueKey);

  return { issued: true, certNo: data.certNo, to: sent.to, cc: sent.cc };
}

// ─── POLLING ENGINE ───────────────────────────────────────────────────────────
async function pollClearanceTickets() {
  if (!SMTP_HOST) {
    console.warn("[CertPoll] ⚠️  SMTP_HOST not set — certificate emails disabled.");
    return;
  }

  console.log(`[CertPoll] 🔍 Checking ${CERT_PROJECT_KEY} tickets in "${CERT_STATUS}"... (${new Date().toLocaleTimeString("en-GB")})`);

  try {
    const windowMinutes = Math.ceil(POLL_INTERVAL / 60000) + 2;
    const minutesBack   = isFirstPoll
      ? Math.max(windowMinutes, Math.round(STARTUP_LOOKBACK_HOURS * 60))
      : windowMinutes;

    if (isFirstPoll && minutesBack > windowMinutes) {
      console.log(`[CertPoll] 🔁 Startup catch-up — looking back ${STARTUP_LOOKBACK_HOURS}h for tickets missed while the service was down.`);
    }

    const jql = `project = "${CERT_PROJECT_KEY}" AND status = "${CERT_STATUS}" ` +
                `AND updated >= "-${minutesBack}m" ORDER BY updated DESC`;

    const POLL_FIELDS = [
      "summary", "status", "reporter", "assignee", "project", "issuetype",
      "created", "updated", "resolutiondate",
      "customfield_10010",                                    // Request Type
      CF_TRAINEE_NAME, CF_TRAINEE_ID, CF_INSTITUTION, CF_PROGRAM, CF_DEPARTMENT,
      CF_START_DATE, CF_END_DATE,
    ].filter(Boolean).join(",");

    const url = `${JIRA_BASE_URL}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${POLL_FIELDS}`;
    const res = await fetch(url, { headers: { Authorization: SYSTEM_AUTH, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jira search failed: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);

    // Only narrow the window once a search has actually succeeded, so a failed
    // first poll still catches up on the next attempt.
    isFirstPoll = false;

    const wanted = CERT_REQUEST_TYPE.toLowerCase();
    const issues = ((await res.json()).issues || []).filter(issue => {
      const reqType = getRequestTypeName(issue.fields).toLowerCase();
      // Tickets with no request type (classic Jira issues) are let through only
      // when CERT_REQUEST_TYPE is blank.
      return wanted ? reqType.includes(wanted) : true;
    });

    if (issues.length === 0) {
      console.log("[CertPoll] ✅ No new tickets awaiting a certificate.");
      return;
    }

    console.log(`[CertPoll] Found ${issues.length} ticket(s).`);

    for (const issue of issues) {
      if (alreadySentCert(issue.key)) {
        console.log(`[CertPoll] ⏭️  Already issued: ${issue.key}`);
        continue;
      }
      try {
        console.log(`[CertPoll] Processing ${issue.key} — ${issue.fields.summary}`);
        await issueCertificate(issue.key);
      } catch (err) {
        console.error(`[CertPoll] ❌ ${issue.key}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[CertPoll] ❌ Poll error: ${err.message}`);
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!CERT_API_KEY) return next();                      // not configured → open (bound to localhost)
  if (req.get("x-api-key") === CERT_API_KEY) return next();
  res.status(401).json({ error: "Invalid or missing x-api-key" });
}

app.get("/health", (req, res) => {
  res.json({
    status:      "ok",
    service:     "training-certificate",
    project:     CERT_PROJECT_KEY,
    watchStatus: CERT_STATUS,
    requestType: CERT_REQUEST_TYPE,
    pollMinutes: POLL_INTERVAL / 60000,
    issued:      Object.keys(loadSentCerts()).length,
    logo:        !!LOGO_DATA_URI,
  });
});

// Preview the certificate in the browser without emailing anything
app.get("/api/cert/preview/:issueKey", requireApiKey, async (req, res) => {
  try {
    const issue   = await fetchTicket(req.params.issueKey);
    const missing = missingRequiredFields(issue);
    if (missing.length) return res.status(422).json({ error: "Missing fields", missing });
    res.send(buildCertificateHTML(buildCertificateData(issue)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download the certificate PDF without emailing anything
app.get("/api/cert/pdf/:issueKey", requireApiKey, async (req, res) => {
  try {
    const issue   = await fetchTicket(req.params.issueKey);
    const missing = missingRequiredFields(issue);
    if (missing.length) return res.status(422).json({ error: "Missing fields", missing });
    const data = buildCertificateData(issue);
    const pdf  = await generateCertificatePDF(data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Certificate-${data.issueKey}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Issue (or re-issue with ?force=true) a certificate manually
app.post("/api/cert/send/:issueKey", requireApiKey, async (req, res) => {
  try {
    const force  = String(req.query.force || "").toLowerCase() === "true";
    const result = await issueCertificate(req.params.issueKey, { force });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/cert/poll-now", requireApiKey, async (req, res) => {
  pollClearanceTickets();
  res.json({ success: true, message: "Poll triggered" });
});

// ─── START ────────────────────────────────────────────────────────────────────
async function start() {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.error("❌ JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN missing in .env — aborting.");
    process.exit(1);
  }

  if (SMTP_HOST) await testSmtp();

  if (SMTP_HOST) {
    console.log(`[CertPoll] ✅ Watching ${CERT_PROJECT_KEY} · status "${CERT_STATUS}" · request type "${CERT_REQUEST_TYPE}"`);
    console.log(`[CertPoll] ⏱️  Polling every ${POLL_INTERVAL / 60000} minutes`);
    pollClearanceTickets();
    setInterval(pollClearanceTickets, POLL_INTERVAL);
  } else {
    console.warn("[CertPoll] ⚠️  SMTP_HOST not set in .env — polling disabled.");
  }

  app.listen(CERT_PORT, CERT_BIND, () => {
    console.log(`\n🎓  Training Certificate Service running at http://${CERT_BIND}:${CERT_PORT}`);
    console.log(`    Hospital:    ${HOSPITAL_NAME}`);
    console.log(`    Jira:        ${JIRA_BASE_URL}`);
    console.log(`    Logo:        ${LOGO_DATA_URI ? "✅ Embedded" : "❌ Missing"}`);
    console.log(`    Seal:        ${SEAL_DATA_URI ? "✅ Embedded" : "— none"}`);
    console.log(`    Preview:     http://${CERT_BIND}:${CERT_PORT}/api/cert/pdf/${CERT_PROJECT_KEY}-123\n`);
  });
}

// Auto-start only when run directly (`node certificate-server.js`), so the
// module can also be required by another script for testing or embedding.
if (require.main === module) start();

module.exports = {
  app,
  start,
  issueCertificate,
  pollClearanceTickets,
  buildCertificateData,
  buildCertificateHTML,
  generateCertificatePDF,
  readFieldValue,
  preferLatinScript,
  buildCertificateNumber,
};
