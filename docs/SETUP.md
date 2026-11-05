# Headroom setup reference

The [README](../README.md) covers install, the recorded journey, tests, live sandbox mode and deploy. This page lists
every setting, command and route in one place.

## Processes and ports

| Process | Command | Port | Notes |
|---|---|---|---|
| Web app (Vite) | `npm run dev -w web` | 5173 | Proxies `/v1` to `127.0.0.1:8787` |
| Local API + worker | `npm run dev:api` | 8787 (`PORT`) | One process: router, webhook route, operator routes, sweep and job loop every 2 s, in-memory store saved to `.headroom-local/store.json` |
| Both | `npm run dev` | 5173 + 8787 | One Ctrl-C stops both |
| Payout replay server | `node scripts/verify/s6-replay-server.ts` | 8796 (`--port`) | Built app + real router on the acceptance harness with recorded PayPal responses |
| Delegation replay server | `node scripts/verify/s7-replay-server.ts` | 8797 (`--port`) | Same design, with a simulated mailbox |

The local API binds `127.0.0.1` only and uses one fixed local identity (`owner@local.test`, tenant `tenant-local`).
Deployed stages read identity and role from Cognito.

## Environment variables

Local values live in `.env` (git-ignored; template [`.env.example`](../.env.example)). Variables already set in the
shell win over `.env`.

| Variable | Default | Read by | Effect |
|---|---|---|---|
| `PAYPAL_ENV` | — | local API, setup | Must be `sandbox`; anything else stops startup |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | — | local API, setup | Sandbox REST app credentials; required by the local API |
| `PAYPAL_MERCHANT_EMAIL` | — | local API, setup | Sandbox business account that issues invoices |
| `PAYPAL_WEBHOOK_ID` | unset | local API | Enables webhook signature verification for that webhook |
| `HEADROOM_GRANT` | unset | local API | Provider call budget: `SANDBOX` (invoices, payments, payouts). Unset refuses every PayPal and Plaid call |
| `HEADROOM_GRANT_EXPIRES_AT` | `2026-12-31T23:59:59Z` | local API, CDK | Overrides the budget expiry (ISO UTC) |
| `PLAID_ENV` | — | local API, setup | Must be `sandbox` when Plaid keys are set |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | unset | local API, setup | Enables read-only bank visibility; unset leaves the bank not connected |
| `HEADROOM_MODEL` | unset | local API | Bedrock model for bills, plan and drafts, e.g. `us.amazon.nova-2-lite-v1:0`; unset uses Headroom's template |
| `AWS_PROFILE`, `AWS_REGION` | chain, `us-east-1` | Bedrock, operator scripts | Operator and setup scripts default `AWS_PROFILE` to `headroom-admin` |
| `MAIL_CHANNEL` | unset | local API | `simulated` = labelled in-app mailbox; otherwise Gmail when the trio below is set, else no channel |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_TEST_INBOX`, `GMAIL_TEST_SENDER` | unset | local API, `mail:connect` | Gmail; every message is routed to `GMAIL_TEST_INBOX` (lowercase `google_oauth_client_id`, `google_oauth_client_secret`, `gmail_test_recipient`, `gmail_test_sender` also work) |
| `PAYPAL_PAYER_EMAIL`, `PAYPAL_PAYER_PASSWORD` | unset | local API, setup | Sandbox personal account for the automated payer on PayPal's hosted page (local Google Chrome) |
| `PAYPAL_BUYER_EMAIL` | unset | local API, setup | Registered sandbox receiver for supplier payouts |
| `PAYPAL_REVIEW_CLIENT_ID`, `PAYPAL_REVIEW_CLIENT_SECRET`, `PAYPAL_REVIEW_MERCHANT_EMAIL` | unset | setup | Second sandbox merchant for the review stage |
| `PORT` | `8787` | local API, operator scripts | Local API port |
| `HEADROOM_LOCAL_ROLE` | unset | local API | `JUDGE` or `OPERATOR` shows the Sandbox controls drawer locally |
| `HEADROOM_LOCAL_EMAIL` | `owner@local.test` | local API | Local identity's email |
| `CHROMIUM_PATH` | Playwright's Chromium | browser tests | Browser binary for `scripts/verify/browser-s6.mjs` and `browser-s7.mjs` |
| `EVIDENCE_BUCKET` | — | `scripts/live/*-races.ts` | The stage's evidence bucket (stack output `EvidenceBucket`) |
| `CDK_DEFAULT_ACCOUNT` | from credentials | CDK | Target account; any 12-digit value works for an offline `cdk synth` |

Deployed Lambdas get their settings from the CDK stack, not from `.env`: table names (`HR_TABLE_CORE`, `HR_TABLE_WORK`,
`HR_TABLE_AUDIT`, `HR_TABLE_PROVIDER`), `HR_QUEUE_URL`, `EVIDENCE_BUCKET`, the Secrets Manager ids for PayPal, Plaid,
Gmail and the payer (`HR_*_SECRET_ID`), the Plaid token KMS key (`HR_PLAID_KEY_ID`), `HR_CONNECTION_ID`,
`HEADROOM_STAGE` (`dev` or `review`) and, on the worker only, `HEADROOM_MODEL`.

## npm scripts

| Script | What it does |
|---|---|
| `typecheck` | `tsc -b` over every workspace |
| `test` | Unit tests: contracts, backend, infra (Node test runner) |
| `test:acceptance` | End-to-end domain scenarios on recorded provider responses |
| `build` | Builds the web app to `web/dist` |
| `dev` / `dev:api` | Local API and web app / local API alone |
| `openapi` | Regenerates `contracts/openapi/api.yaml` from the route table |
| `reset` (also `demo:reset`) | `-- --stage local\|dev\|review [--bank seed\|none] [--dispute seeded\|email]`: fresh run of the sample business; waits until `READY` |
| `demo:bill` | Brings in Keller's original bill through normal ingestion |
| `demo:inject-bill` | Injects a sample bill PDF (`--variant`) |
| `demo:collect` | Pays a collection on PayPal's hosted page with the automated payer |
| `demo:checkout` / `demo:pay` | Opens or pays a sandbox invoice's hosted checkout |
| `demo:status` | `-- --stage dev\|review [--watch]`: run, lease and reset progress of a deployed stage |
| `demo:get-run` | Prints the current local run |
| `demo:golden` | Rebuilds the web app and re-records the walkthrough in `web/public/golden/` (Nova on Bedrock) |
| `mail:connect` | Connects Gmail to a stage |
| `test:live`, `test:live:s2` | Sandbox journeys against a deployed dev stage |
| `manifest` | SHA-256 of every tracked source file, for pinning a reviewed revision |

## Other scripts

- `scripts/verify/browser-s6.mjs`, `browser-s7.mjs`: browser scenarios against the replay servers. They take `--base`,
  `--out`, `--only <names>` and `--failed <prevDir>`.
- `scripts/verify/browser*.mjs` (other), `dev-*.mjs`: browser scenarios against a local live API or a deployed stage
  (Cognito sign-in).
- `scripts/live/*.ts`: sandbox journeys and race tests against a deployed dev stage.
- `scripts/dev/setup.ts secret|plaid|users|bootstrap|webhook|gmail|payer|all [--stage dev|review]`: post-deploy setup.
  Values from `.env` are never printed.

## Local state (`.headroom-local/`, git-ignored)

| File | Contents |
|---|---|
| `store.json` | The local in-memory store, saved on change |
| `vault-key` | Local key that seals Plaid tokens (mode 600) |
| `operator-token` | Token for the local operator routes (mode 600) |
| `paypal-calls.json` | Provider call counters, written on shutdown |
| `<stage>-users.json` | Cognito user passwords written by `setup.ts users` |

## Local operator routes

Local only, on the API port, with header `x-operator-token: $(cat .headroom-local/operator-token)`.

| Route | Effect |
|---|---|
| `POST /__operator/reset` | Fresh run (`{"bank":"seed"\|"none","dispute":"SEEDED"\|"EMAIL"}`) |
| `GET /__operator/run?runId=` | Run state |
| `POST /__operator/inject-bill` | Bring in a bill PDF (`fileName`, `contentBase64`) |
| `POST /__operator/clock` | Local clock offset (`offsetMs`) for scheduling tests |
| `POST /__operator/run-action` | Run a due action now (`actionId`) |
| `GET /__operator/calls` | Provider call counters |
| `/__operator/mail/*` | Gmail token, status, inject and fault helpers |

## API routes

Every route is defined once in [`contracts/src/api.ts`](../contracts/src/api.ts) with its body, response and error
codes. The OpenAPI file is [`contracts/openapi/api.yaml`](../contracts/openapi/api.yaml). Commands take an
`idempotency-key` header, and versioned updates take `if-match`.

| Method | Path | Operation | Caller | Summary |
|---|---|---|---|---|
| `GET` | `/v1/demo/run` | `getDemoRun` | sandbox controls (judge, operator) | Sandbox controls: my run, lease, reset progress, sandbox clock and the collections the payer may pay |
| `POST` | `/v1/demo/view` | `setDemoView` | sandbox controls (judge, operator) | Switch between my run and the finished showcase run (read-only) |
| `POST` | `/v1/demo/start` | `startDemoRun` | sandbox controls (judge, operator) | Start a fresh run on the sandbox merchant (takes the lease; returns the rail to the opening first) |
| `POST` | `/v1/demo/end` | `endDemoRun` | sandbox controls (judge, operator) | End my run: release the merchant (refused while PayPal work is in flight) |
| `POST` | `/v1/demo/bill` | `demoBill` | sandbox controls (judge, operator) | Bring in Keller's original bill through normal ingestion |
| `POST` | `/v1/demo/collect` | `demoCollect` | sandbox controls (judge, operator) | The customer pays on PayPal's hosted page (automated payer, sandbox); the receipt still comes only from PayPal's GETs |
| `POST` | `/v1/demo/advance` | `demoAdvance` | sandbox controls (judge, operator) | Advance the sandbox clock to the next scheduled step and run it (due times only; provider times stay real) |
| `POST` | `/v1/demo/reconcile` | `demoReconcile` | sandbox controls (judge, operator) | Refresh from PayPal and the bank now (invoice, capture and balance GETs) |
| `GET` | `/v1/demo/effects` | `getDemoEffects` | sandbox controls (judge, operator) | Every provider effect of the run with its ids and as-of (read-only) |
| `POST` | `/v1/demo/live` | `takeLiveRun` | sandbox controls (judge, operator) | Take the shared live run when it is fresh, or keep the one you hold |
| `POST` | `/v1/demo/golden-mail` | `goldenMail` | sandbox controls (judge, operator) | Recorded walkthrough: send its asks as real emails to the test inbox (operator) |
| `GET` | `/v1/demo/golden-mail/{id}` | `getGoldenMail` | sandbox controls (judge, operator) | Recorded walkthrough: whether Gmail confirmed those emails |
| `POST` | `/v1/demo/keller-reply` | `demoKellerReply` | sandbox controls (judge, operator) | Keller replies to Headroom's ask from the test inbox, agreeing to the split; it arrives through normal mail intake |
| `POST` | `/v1/operator/release` | `operatorRelease` | operator | Operator: release the merchant lease (refused while PayPal work is in flight) |
| `GET` | `/v1/session` | `getSession` | signed-in owner | Signed-in owner, tenant and active run |
| `GET` | `/v1/overview` | `getOverview` | signed-in owner | Overview strip, status line and recent activity |
| `GET` | `/v1/cash/position` | `getCashPosition` | signed-in owner | Reported, estimated and forecast cash, kept separate |
| `POST` | `/v1/cash/paypal/refresh` | `refreshPayPalBalance` | signed-in owner | Queue a PayPal balance read |
| `GET` | `/v1/receivables` | `listReceivables` | signed-in owner | Invoices, incoming receipts and customers |
| `GET` | `/v1/invoices/{id}` | `getInvoice` | signed-in owner | Invoice, effect, receipts, allocations and audit |
| `POST` | `/v1/invoices` | `createInvoiceDraft` | signed-in owner | Save a draft invoice (no provider call) |
| `POST` | `/v1/invoices/{id}/send` | `sendInvoice` | signed-in owner | Issue the draft on PayPal through the effect executor (no email) |
| `POST` | `/v1/invoices/{id}/refresh` | `refreshInvoice` | signed-in owner | Queue an immediate PayPal read of this invoice |
| `GET` | `/v1/activity` | `getActivity` | signed-in owner | Audit trail for the active run, newest first |
| `POST` | `/v1/cash/bank/link-token` | `createPlaidLinkToken` | signed-in owner | Short-lived Plaid Link token (connect, or update mode to reconnect). Creates no Item |
| `POST` | `/v1/cash/bank/exchange` | `exchangePlaidToken` | signed-in owner | Claim a bank connection; the worker exchanges the sealed public token through the effect executor |
| `POST` | `/v1/cash/bank/refresh` | `refreshPlaid` | signed-in owner | Queue a bank sync and real-time balance read |
| `POST` | `/v1/cash/bank/disconnect` | `disconnectPlaid` | signed-in owner | Stop counting the bank now and ask Plaid to remove the connection (executor effect) |
| `POST` | `/v1/cash/bank/connect/abandon` | `abandonBankConnect` | signed-in owner | Owner gives up on a connect whose outcome cannot be determined, so a new one can start |
| `GET` | `/v1/cash/forecast` | `getForecast` | signed-in owner | 42-day forecast (Expected, Ideal or Downside): daily closes, states, summary, not-in-forecast, comparisons |
| `GET` | `/v1/payables` | `listPayables` | signed-in owner | Payment plan (obligations), bills and commitments |
| `GET` | `/v1/bills/{id}` | `getBill` | signed-in owner | Bill panel: checks, grounded fields, impact, candidates and actions |
| `GET` | `/v1/bills/{id}/document` | `getBillDocument` | signed-in owner | The original document, as received (base64 over the authenticated JSON API) |
| `POST` | `/v1/documents` | `uploadDocument` | signed-in owner | Upload an original bill PDF; it is stored immutably and read by the worker |
| `POST` | `/v1/bills/{id}/retry` | `retryBill` | signed-in owner | Read a bill again after it could not be read |
| `POST` | `/v1/bills/{id}/verify` | `verifyBill` | signed-in owner | Owner verifies the document is a genuine bill for an occurrence. Changes no terms; permits no payment |
| `POST` | `/v1/bills/{id}/accept-terms` | `acceptBillTerms` | signed-in owner | Owner accepts exactly the bill's changed fields (date and/or amount) for the obligation |
| `POST` | `/v1/bills/{id}/add-obligation` | `addBillAsObligation` | signed-in owner | Owner verifies a known supplier's bill and adds it as one new outflow (separate obligation) |
| `POST` | `/v1/commitments` | `createCommitment` | signed-in owner | Add a commitment (one-time or monthly); occurrences enter the forecast as the horizon reaches them |
| `GET` | `/v1/inbox` | `getInbox` | signed-in owner | Documents received (uploaded or operator-injected), newest first |
| `GET` | `/v1/plan` | `getPlan` | signed-in owner | Plan: build state, current revision (running, else draft; a draft beside a running revision is `proposed`), outlook, schedule, actions, considered, trail |
| `POST` | `/v1/plan/revisions` | `buildRevision` | signed-in owner | Build a plan revision for the current basis (idempotent per basis; retry a failed build by generation) |
| `GET` | `/v1/plan/revisions/{id}` | `getRevision` | signed-in owner | One revision with its actions, outlook and approval dialog |
| `POST` | `/v1/plan/revisions/{id}/edit` | `editRevision` | signed-in owner | Edit, remove, restore, include or swap one action; rechecked against delegation |
| `POST` | `/v1/plan/revisions/{id}/approve` | `approveRevision` | signed-in owner | Approve the actions waiting in a revision; records each needed permission separately. Nothing is sent or paid |
| `POST` | `/v1/plan/revisions/{id}/reject` | `rejectRevision` | signed-in owner | Reject a draft revision; the running revision is untouched |
| `GET` | `/v1/delegation` | `getDelegation` | signed-in owner | Rules, tiers, precedence, hard stops, pauses and Approved once |
| `POST` | `/v1/delegation/preview` | `previewPolicyChange` | signed-in owner | What a rule change would affect now (no write) |
| `POST` | `/v1/delegation/rules` | `changePolicy` | signed-in owner | Save an owner rule change reviewed through its preview |
| `POST` | `/v1/delegation/pauses` | `setPause` | signed-in owner | Pause or resume all outreach or all payment preparation |
| `POST` | `/v1/grants/{id}/revoke` | `revokeGrant` | signed-in owner | Revoke a permission that has not been acted on; its action needs approval again |
| `GET` | `/v1/relationships` | `listRelationships` | signed-in owner | Customers and suppliers with relationship labels (rules, not scores) |
| `GET` | `/v1/relationships/{id}` | `getRelationship` | signed-in owner | One relationship: evidence behind its label, how Headroom treats it, open items and active work |
| `GET` | `/v1/reconciliation` | `getReconciliation` | signed-in owner | Bank PayPal-transfer candidates with your answers, captures awaiting PayPal’s report, money toward disputed amounts, holds |
| `POST` | `/v1/plan/actions/{id}/decide` | `decideFallback` | signed-in owner | Your decision on a fallback offer still unproven at its decide-by time: send it once, or not |
| `POST` | `/v1/receivables/threads/{id}/owner` | `setThreadOwner` | signed-in owner | Take over a customer (Headroom sends and changes nothing for them) or hand back |
| `POST` | `/v1/payables/asks/{id}/accept` | `acceptSupplierAnswer` | signed-in owner | Accept the supplier’s answer: one of the offered options becomes the bill’s terms. Paying still needs payout authority |
| `POST` | `/v1/payables/asks/{id}/decline` | `declineSupplierAnswer` | signed-in owner | Decline the supplier’s answer; the accepted terms stay |
| `POST` | `/v1/receivables/invoices/{id}/dispute/confirm` | `confirmDispute` | signed-in owner | Confirm the split of a dispute read from the customer’s email; decides what may be collected. Creates no permission |
| `POST` | `/v1/receivables/invoices/{id}/dispute/dismiss` | `dismissDispute` | signed-in owner | Not a dispute: release what the pending dispute held |
| `POST` | `/v1/inbox/promises/{id}/accept` | `acceptPromise` | signed-in owner | Count a promised date that is beyond your new-date limit in Expected (never cash, never skips a fallback) |
| `POST` | `/v1/inbox/messages/{id}/hold` | `holdMessage` | signed-in owner | Hold or release one action's message; a held message never sends |
| `POST` | `/v1/inbox/messages/{id}/send` | `sendNow` | signed-in owner | Run the message's scheduled send now (same job, same Message-ID; still checked) |
| `POST` | `/v1/reconciliation/bank/{id}/answer` | `answerMatch` | signed-in owner | Label a bank PayPal-transfer candidate (no receipt, no cash moves) |
| `GET` | `/v1/payables/payouts/{id}` | `getPayout` | signed-in owner | One PayPal payout obligation: rail and company readiness, authority checks and the payment result (masked address) |
| `POST` | `/v1/payables/payees/{id}/confirm` | `confirmPayee` | signed-in owner | Owner confirms a supplier's PayPal address by typing it; only the hash is compared. Identity only: permits no payment |
| `GET` | `/v1/payables/payees/{id}/reveal` | `revealPayee` | signed-in owner | Owner-only: the exact PayPal address Headroom would pay (audited, hash only) |
| `POST` | `/v1/webhooks/paypal` | `paypalWebhook` | PayPal (signature verified) | PayPal webhook ingress; stored raw, verified asynchronously |
