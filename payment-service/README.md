# Moyasar ↔ Jira payments (ASAC) — no Jira Automation rules

`payment-service.js` plugs into the existing certificate service and talks to
Jira and Moyasar directly. Both Automation rules (Send web request + incoming
webhook) can be switched off.

## Flow

1. **Every 2 min** it searches `project = ASAC AND status = "Waiting for Payment"`
   and keeps only the **Trainee Requests** request type.
2. For each ticket with no open invoice it creates a Moyasar invoice:
   - amount = Total Cost (`customfield_11636`) × 100 (halalas)
   - description = `Alsalama Academy training fee — ASAC-2 — <Trainee Name> (<Trainee ID>)`
   - metadata = `issue_key`, `trainee_name` (`customfield_13434`), `trainee_id` (`customfield_13457`)
   - saves `invoice_id ↔ issue_key ↔ amount` in `payments-db.json`
   - writes the link to **Payment Link** (`customfield_14189`) and posts it as a **public comment**,
     so the trainee gets the JSM email
3. It gets the result in one of two ways (either one is enough):
   - **Webhook** `POST /payments/moyasar/webhook`: checks `secret_token` (timing-safe),
     accepts only `payment_paid` / `payment_failed`, skips duplicate event ids,
     **re-fetches the payment from Moyasar**, and checks amount and currency against the DB.
   - **Polling**: each cycle re-reads every open invoice from Moyasar. This works with
     no public URL. The webhook only makes updates instant.
4. **paid** → transition to **Paid** (looked up by target status name, currently id 5).
   **failed** → internal comment only; staff transition the ticket manually
   (`PAY_ON_FAILED=transition` moves it to **Failed Payment** automatically instead).

Safety rules:
- One invoice per ticket. It is never charged twice.
- If Total Cost changes, the old invoice is cancelled and a new one is created.
- If Total Cost is empty, the service adds an internal comment and creates no invoice.
- If the amount doesn't match, the ticket is **not** marked Paid and an internal comment is added.
- If a payment arrives after the ticket is already in Failed Payment, the service adds an
  internal comment asking for a manual move, because Failed Payment is a Done-category status.

## Wire-up (3 lines in `certificate-server.js`)

```js
// after: app.use(express.json());
const payments = require("./payment-service");
payments.mount(app);

// inside start(), before app.listen(...) — independent of SMTP_HOST:
payments.start();
```

Copy `payment-service.js` next to `certificate-server.js`. Then add the keys from
`.env.payments.example` to `.env`. It needs no new npm packages.

## Rollout

1. `PAY_DRY_RUN=true`: check the logs to confirm it finds ASAC-2 and computes the right amount.
2. Add `MOYASAR_SECRET_KEY=sk_test_…` and set `PAY_DRY_RUN=false`. Pay the link on ASAC-2
   with test card 4111 1111 1111 1111. Within 2 min ASAC-2 moves to Paid through polling.
3. Optional: add the webhook for instant updates. Expose **only** the webhook path through the reverse proxy:
   ```nginx
   location = /payments/moyasar/webhook {
       proxy_pass http://127.0.0.1:3006;
       proxy_set_header X-Forwarded-For $remote_addr;
       client_max_body_size 64k;
   }
   ```
   In Moyasar → Webhooks, set the URL `https://<host>/payments/moyasar/webhook`, the events
   *payment_paid* and *payment_failed*, and a Secret Token equal to `MOYASAR_WEBHOOK_SECRET`.
4. Turn off both Jira Automation rules. Switch to `sk_live_…` once finance signs off.
   Webhooks whose live/test mode doesn't match the key are ignored.

## Admin

- `GET  /payments/health`: mode, open/paid counts
- `GET  /payments/issue/ASAC-2`: invoices stored for a ticket (x-api-key)
- `POST /payments/poll-now`: run a cycle immediately (x-api-key)
