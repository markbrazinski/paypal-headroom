# PayPal REPLAY fixtures

Sanitized PayPal **sandbox** responses (`{status, body}`), used as provider-boundary replays in tests. Ids are remapped deterministically and consistently across files, so the joins still hold: capture ↔ reporting row ↔ invoice. Emails, account ids, payer details and links are redacted.

Evidence label: **REPLAY**. A fixture never stands as payment, receipt or delivery evidence. Tests that alter a fixture, for example to set a capture to PENDING, do so in code and say so in the test name.

| File | What it is |
|---|---|
| `invoice-paid.json` | Invoice GET after a genuine guest payment (one PAYPAL transaction) |
| `capture-completed.json` | Capture GET for that payment (COMPLETED, breakdown 120.00 = 4.68 + 115.32) |
| `invoice-external.json` | Invoice GET carrying only EXTERNAL (record-payment) transactions |
| `balances.json`, `transactions.json` | Reporting balance snapshot and the 2-day transaction listing that reconciles to it |
| `webhook-invoice-paid.json` | `INVOICING.INVOICE.PAID` event (invoice id nested at `resource.invoice.id`) |
| `create-201.json`, `create-422-duplicate.json`, `send-200.json` | Invoice create, same-number replay, send without email |
