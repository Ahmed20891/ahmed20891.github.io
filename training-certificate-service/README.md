# Training Completion Certificate Service — ASAC

Standalone companion to the OCC `server.js`. It watches the **ASAC** Jira Service
Management project and, when a **Trainee Requests** ticket reaches the clearance
status, it:

1. reads the trainee details from the ticket's custom fields,
2. renders a branded **A4 landscape PDF certificate** (Puppeteer),
3. **emails it** to the portal requester / reporter, CC the training team,
4. **attaches** the PDF back to the Jira ticket and adds an **internal comment**,
5. records the ticket in `sent-certificates.json` so it never sends twice.

It runs in its own process on its own port, so restarting it never touches the
OCC application.

---

## Install

Drop this folder next to `server.js`, then:

```bash
cd training-certificate-service
npm install
cp .env.example .env      # then fill it in
npm start
```

Node.js 18 or newer is required (`fetch`, `FormData`, `Blob` are used as globals).

If Chrome is already installed for the OCC service, reuse the same
`PUPPETEER_EXECUTABLE_PATH` value and run
`npm install --ignore-scripts` (or set `PUPPETEER_SKIP_DOWNLOAD=1`) to skip the
second Chromium download.

---

## Confirm before going live

These three values are **exact matches** against Jira and are the only things
likely to need changing:

| `.env` key | Default | Where to check in Jira |
|---|---|---|
| `CERT_PROJECT_KEY` | `ASAC` | Project settings → Details |
| `CERT_STATUS` | `Clearance` | Board → the exact status name on the column |
| `CERT_REQUEST_TYPE` | `Trainee Requests` | Project settings → Request types |

`CERT_STATUS` must be spelled exactly as Jira shows it (it is quoted inside the
JQL). `CERT_REQUEST_TYPE` is matched case-insensitively as a substring, so
`Trainee Requests` also matches `Trainee Requests (New)`.

Field IDs live in `.env` too, so a field change in Jira never requires a code
change. Values are read shape-agnostically — plain text, number, date, single
or multi select, cascading select, user picker and rich text all resolve
correctly.

---

## Endpoints

The service binds to `127.0.0.1` by default. Set `CERT_BIND=0.0.0.0` **only**
together with `CERT_API_KEY` (sent as the `x-api-key` header).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | status, config, number of certificates issued |
| `GET` | `/api/cert/preview/:issueKey` | certificate as HTML in the browser — nothing is sent |
| `GET` | `/api/cert/pdf/:issueKey` | certificate as a PDF download — nothing is sent |
| `POST` | `/api/cert/send/:issueKey` | issue and email now; add `?force=true` to re-issue |
| `POST` | `/api/cert/poll-now` | run the poll immediately |

Quickest way to check the layout against a real ticket:

```
http://127.0.0.1:3004/api/cert/pdf/ASAC-123
```

---

## The certificate

The printed statement is:

> This is to certify that **{Trainee Name}**, holder of ID **{Trainee ID}**, from
> **{Institution Name}**, has successfully completed the training program
> **{Preferred Program}** at **Al Salama Hospital**, **{Training Department}**
> Department.

The wording lives in `buildCertificateHTML()` in `certificate-server.js`, under
the `<div class="statement">` block.

Each certificate carries a deterministic number — `ASH/TRN/{year}/{ticket
number}`, e.g. `ASH/TRN/2026/01274` — so re-issuing the same ticket always
produces the same number.

The hospital logo is embedded from `assets/alsalama-logo.png`. To add a seal or
stamp, drop the image in `assets/` and set `CERT_SEAL_PATH=assets/seal.png`.

### Accreditation marks (JCI / CBAHI)

An accreditation strip prints between the signatures and the footer. Drop the
hospital's approved artwork into `assets/`:

```
assets/jci-logo.png       →  prints on the left of the strip
assets/cbahi-logo.png     →  prints on the right
```

PNG (transparent background preferred), JPG, WEBP, GIF and SVG all work, and any
height is fine — the JCI seal prints at `CERT_JCI_HEIGHT_MM` (13 mm) and the
CBAHI wordmark at `CERT_CBAHI_HEIGHT_MM` (10 mm), which makes the round seal and
the wide wordmark read as the same size. Alternative locations can be set
with `CERT_JCI_LOGO_PATH` / `CERT_CBAHI_LOGO_PATH`, and the wording changed with
`CERT_ACCREDITATION_LABEL` (default "Accredited by").

The strip renders only for the files that are actually present: with one mark it
prints that one, with neither it is hidden entirely and the layout closes up. Use
the official artwork issued to the hospital by JCI and CBAHI — both marks are
trademarks and may only be displayed while the accreditation is current.

---

## Recipients

* **TO** — the JSM portal requester (`/rest/servicedeskapi/request/{key}`), plus
  the Jira reporter as a fallback. Unresolvable users are looked up in
  `user-email-map.json` (copy the OCC service's file in next to this one).
* **CC** — `CERT_CC_EMAILS` from `.env`, plus the ticket's request participants
  and the assignee. Anyone already in TO is removed from CC.

If no recipient at all can be resolved, nothing is sent, the ticket is **not**
marked as done, and the error is logged — it retries on the next poll.

## Bilingual field values

Some ASAC select lists carry both scripts in one option, e.g. the Training
Department value `ICT قسم تقنية المعلومات`. The certificate is English, so the
Arabic half is dropped and it prints as `ICT` — the substitution is logged each
time it happens. Values that are Arabic-only are left exactly as they are, and
setting `CERT_ENGLISH_ONLY_FIELDS=false` turns the behaviour off entirely.

## Restarts and missed tickets

Each poll only looks at tickets updated since the previous one, so a service that
is down during a clearance would otherwise miss it. The first poll after startup
therefore looks back `CERT_STARTUP_LOOKBACK_HOURS` (default 24) instead, and
`sent-certificates.json` keeps that from re-sending anything already issued. The
wider window is used again on the next attempt if that first search fails.

## Missing fields

If any of the five required fields is empty when the ticket hits the clearance
status, the service does **not** issue a certificate. It emails `NOTIFY_EMAIL`
once naming the empty fields and leaves the ticket unmarked, so the certificate
goes out automatically on the next poll once the fields are filled.
