# PayOnProof

**An AI accounts-payable agent that pays subcontractors only for work it can prove, through PayPal.**

AI reads the messy documents. A deterministic engine proves every invoice line against signed timesheets, delivery notes and contract rates. A person approves the exact payment. PayPal Payouts pays only the proven amount, and the payout is read back from PayPal as proof.

![Proof view: claimed €6,338.00, payable €5,035.00, every line with its verdict](docs/img/desktop-light-proof.png)

Built for the PayPal AI Hackathon (Best Use of PayPal + AI, agentic commerce). Uses the PayPal developer platform (Payouts, sandbox), any LLM (Gemini or OpenAI-compatible), AG Grid Community and runs on Render.

---

## Why

A general contractor on a German building site receives invoices from subcontractor crews (often from Poland or Ukraine) that claim hours and materials. The site manager has the signed timesheets, the delivery notes and the contract rates, but cross-checking them is manual. Payments are either slow or overpaid: repeated lines, hours nobody signed, rates above the contract, more concrete than was delivered, simple arithmetic errors.

AI agents could pay these invoices automatically. An agent that pays without proof is dangerous. PayOnProof lets the AI do the reading and keeps the money decisions in rules that can be checked, a person's explicit approval and PayPal's own records.

## 60-second demo

```bash
npm install
npm run demo          # offline sample parser + MOCK PayPal, no keys needed
# open http://127.0.0.1:4410
```

1. Keep **Overbilled invoice** selected and click **Verify against evidence**.
2. The grid shows each line: a duplicate, a day without the site manager's signature, two foreman hours too many, 22 m³ of concrete invoiced where 18 m³ arrived. **€6,338.00 claimed, €5,035.00 payable.**
3. Click line 7 to see its proof chain (delivery notes LS-4471 and LS-4472, 9 m³ each).
4. Read the message to the subcontractor. Try **Polish invoice, German site papers** for a message in Polish, or **Rate drift** for Ukrainian.
5. Tick the confirmation and click **Approve exactly this payment**. The preview hash and a single-use, 10-minute approval appear.
6. Click **Pay with PayPal (sandbox)**. The receipt shows the PayPal batch id, item and transaction ids, statuses and **PAID & VERIFIED**, read back from PayPal.
7. Click Pay again: refused. Edit the message: the approval is withdrawn because the preview hash changed.

With real sandbox credentials (see [PayPal sandbox setup](#paypal-sandbox-setup)) the same flow pays a sandbox account through `api-m.sandbox.paypal.com`.

| Phone, dark | Receipt |
| --- | --- |
| ![Phone, dark theme](docs/img/phone-dark-start.png) | ![PayPal receipt, paid and verified](docs/img/desktop-light-receipt.png) |

## How it works

```
 contract / rate sheet ─┐
 invoice ───────────────┼─► AI extraction, one call per document ─► strict validator ─► integer cents
 timesheets ────────────┤   (Gemini | OpenAI-compatible | offline        (schema.mjs)      and thousandths
 delivery notes ────────┘    sample parser, never trusted for math)
                                                   │
                                                   ▼
                         verification engine (verify.mjs, pure functions, no AI)
                         verdict + reason + evidence ids + payable cents per line
                                                   │
                     ┌─────────────────────────────┴─────────────────────────────┐
                     ▼                                                           ▼
     message to the subcontractor (en/de/pl/uk)                proposal: payee, currency, cents,
     AI phrasing is fact-checked, else template                paid lines, message hash, documents hash
                     └─────────────────────────────┬─────────────────────────────┘
                                                   ▼
                              previewHash = SHA-256(canonical JSON of the proposal)
                                                   ▼
                person approves in the UI ─► single-use token bound to previewHash, 10 min
                                                   ▼
     PayPal Payouts  POST /v1/payments/payouts   sender_batch_id = "POP-" + previewHash
                                                   ▼
     read back       GET  /v1/payments/payouts/{payout_batch_id}   (polled with backoff)
                                                   ▼
     receipt JSON + SHA-256; "PAID & VERIFIED" only if PayPal says SUCCESS and the readback
     matches the approved amount, currency, receiver, sender_batch_id and sender_item_id
```

## Verification rules

All money is integer cents; quantities are integer thousandths. Each line gets one verdict (the first that applies, in this order) and lists every finding.

| Verdict | Rule | Paid |
| --- | --- | --- |
| `DUPLICATE` | Same worker or item, date, quantity and price as an earlier line, and the remaining evidence cannot cover it again | 0 |
| `UNPROVEN` | No timesheet entry or delivery note for that worker or item on that date; no contract rate for the role or item; unit differs from the contract; evidence already used by earlier lines | 0 |
| `UNSIGNED` | Timesheet entries exist but none is signed by the site manager | 0 |
| `PARTIAL` | Signed hours or delivered quantity below the claim | proven quantity × allowed rate |
| `RATE_ABOVE_CONTRACT` | Unit price above the contract rate | at the contract rate |
| `MATH_ERROR` | Printed line total differs from quantity × price by one cent or more | the correct product |
| `OVER_CAP` | The contract's payment cap per invoice is reached | up to the cap |
| `PROVEN` | Fully evidenced at or below the contract rate, arithmetic correct | as invoiced |

- **Evidence is consumed line by line**: one signed day or one delivery note can never prove two lines. Two identical lines are both paid when the evidence really covers both (two concrete trucks on the same day).
- **Matching is deterministic**: names are compared order-independently with diacritics folded (`Kordecki, Adam` = `Adam Kordecki`, `Paweł` = `Pawel`), materials by article code or name, roles by name or the aliases written in the contract (`Dachdecker` / `Dekarz`), units through a fixed table (`Std.`, `godz.`, `h`; `m³`, `m3`; `Rolle`, `rol.`).
- **Rounding**: a line amount is quantity × unit price rounded half-up to the cent, per line. Totals are sums of rounded lines and are never rounded again. A printed line total within one cent of the exact product is correct (any rounding convention) and is paid exactly as printed; otherwise the correct product is paid.
- **Case checks**: a currency that differs from the contract blocks payment. A different PayPal address on the invoice is flagged and ignored: the payee always comes from the contract. A printed invoice total that does not add up is flagged.

## PayPal integration

| Step | Call | Details |
| --- | --- | --- |
| Token | `POST /v1/oauth2/token` | Client credentials, Basic auth with `PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET`, cached until 60 s before expiry, refreshed once on any 401 |
| Pay | `POST /v1/payments/payouts` | One `EMAIL` item, `amount.value` from integer cents (`"5035.00"`), `note` with a short reference, `sender_item_id` = case id, `sender_batch_id` = `POP-<previewHash>`, `PayPal-Request-Id` = the same value |
| Read back | `GET /v1/payments/payouts/{payout_batch_id}` | Polled until the batch or item reaches a final state (`SUCCESS`, `DENIED`, `CANCELED`, `UNCLAIMED`, `FAILED`, `RETURNED`, …) |

**No double payment, by construction:**

1. The approval token is single-use and bound to one exact `previewHash`.
2. A case sends at most one payout; a second pay request is refused.
3. `sender_batch_id` is derived from the approved `previewHash`. PayPal processes a `sender_batch_id` at most once in 30 days and answers a repeat with an error that links to the existing batch. PayOnProof then reads that batch instead of paying again.

**Errors are reported honestly:**

- Connection refused or credentials rejected: `NOT_SENT`, nothing was paid, approve again to retry.
- Timeout, lost connection or a 5xx after the request left: `UNKNOWN_AFTER_SEND`. Nothing is retried automatically. **Reconcile with PayPal** presents the identical approved request with the same `sender_batch_id`; PayPal either creates the single approved batch (if the first request never arrived) or points to the existing one, which is then read back. This is PayPal's documented safe retry for payouts.
- Validation or business errors (for example insufficient funds): `REJECTED` with PayPal's error name, message and debug id.
- Readback: `PAID & VERIFIED` only when the batch and the item are `SUCCESS` and PayPal's amount, currency, receiver, `sender_batch_id` and `sender_item_id` match what was approved. `UNCLAIMED` (the receiver has no PayPal account yet) and `PENDING` are shown as such, a mismatch as `MISMATCH`.

The receipt is canonical JSON with its own SHA-256, downloadable from the page.

**Sandbox only.** The PayPal base URL must be `https://api-m.sandbox.paypal.com`; the server refuses to start with any other value. Live PayPal would need both `PAYPAL_BASE_URL=https://api-m.paypal.com` and `PAYPAL_ALLOW_LIVE=I_UNDERSTAND`, and stays disabled in this project. Secrets and tokens are never logged; each PayPal call logs only method, path, status, PayPal debug id and duration.

**MOCK PayPal** (`PAYPAL_MOCK=1` or `npm run demo`) swaps only the network layer for an in-process fake of the sandbox API (`src/paypal-mock.mjs`): OAuth, request validation, duplicate `sender_batch_id`, `PENDING → PROCESSING → SUCCESS`, `UNCLAIMED`. The same client code runs against it, and the UI labels it **MOCK PayPal**.

## What the AI does, and what it never decides

| AI does | AI never decides |
| --- | --- |
| Turns each document (English, German, Polish, Ukrainian) into strict JSON | Any amount, total or verdict |
| Phrases the explanation to the subcontractor in their language | Who gets paid (the payee comes from the contract) |
| | Whether to pay (only a person's approval can) |

- **Providers** (`AI_PROVIDER`): `gemini` calls `POST https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` (default `gemini-2.5-flash`) with the key in the `x-goog-api-key` header and `generationConfig: { responseMimeType: 'application/json', temperature: 0 }`. `openai` calls any OpenAI-compatible `/chat/completions` endpoint (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, for example local Ollama at `http://127.0.0.1:11434/v1`) with `response_format: {type: 'json_object'}`, dropped automatically if the server rejects it. `offline` (the default without keys) is a deterministic parser for the bundled sample layout only, labelled **Offline sample parser — no AI used** everywhere.
- **Isolation**: each document is extracted in its own call and wrapped as untrusted data, so text in the subcontractor's invoice cannot influence how the site manager's timesheets are read. The claimant can never create evidence.
- **Validation**: a hand-written validator (`src/schema.mjs`) rejects missing fields, non-numbers, localised number strings (`"1.040,00"`), negative values, impossible dates, duplicate ids and over-precise values; plain numeric strings are converted with a visible warning. A rejected document blocks payment.
- **No model arithmetic**: printed totals are kept only as the claim; every payable amount is recomputed in integer cents.
- **Provenance**: every extraction records provider, model, prompt version, duration and the SHA-256 of the input documents, shown on screen.
- **Messages**: AI drafts must contain the totals and every disputed line with its exact paid amount; otherwise the fixed template is used and the page says so. A person can edit the text before approving, which changes the preview hash.
- **Cost guard**: `AI_MAX_CALLS_PER_HOUR` caps model calls for the whole server; identical documents are served from a cache.

## Agentic commerce over MCP

`POST /mcp` speaks MCP over Streamable HTTP (stateless, JSON responses), protocol version **2025-11-25** (`@modelcontextprotocol/sdk` 1.32.1, which also accepts 2025-06-18 and older clients).

| Tool | What it does |
| --- | --- |
| `payonproof_verify_case` | Documents (or a `sampleId`) in, verdicts and a `caseId` out |
| `payonproof_propose_payment` | Returns the exact preview, its `previewHash`, status `AWAITING_HUMAN_APPROVAL` and an `approvalUrl` for the person |
| `payonproof_pay_approved` | Pays only with a valid approval token from the person; without one it returns `HUMAN_APPROVAL_REQUIRED` |
| `payonproof_payout_status` | Reads the payout back from PayPal and returns the receipt |

There is no approval tool. An agent verifies and proposes, hands the person the `approvalUrl`, the person approves in the page and gives the agent the single-use token (**Copy token for an MCP agent**), and the agent pays. Try it with the MCP Inspector (`npx @modelcontextprotocol/inspector`, transport Streamable HTTP, URL `http://127.0.0.1:4410/mcp`, connected through the Inspector's proxy). Set `MCP_BEARER_TOKEN` to require `Authorization: Bearer …` on `/mcp`.

## Safety model

- Money logic is pure, deterministic and tested; the AI cannot change an amount or a verdict.
- Evidence and claims come from different parties and are read separately.
- The payee is taken from the contract, never from the invoice; a different address on the invoice raises a warning.
- Approval is explicit, exact (hash-bound), single-use, short-lived and withdrawn by any change. It can only be given from the page: the endpoint requires a same-origin browser request, and `APPROVER_PASSCODE` can add a passcode.
- Three independent layers prevent double payment (see above); unknown outcomes are reconciled, never blindly retried.
- Sandbox only; startup refuses unsafe PayPal settings.
- HTTP hardening: strict Content-Security-Policy (scripts only from the same origin, no inline scripts; `<style>` elements need a per-request nonce, which the grid uses), Host allow-list against DNS rebinding, same-origin checks on state-changing requests, JSON-only bodies, 768 KB body limit, per-IP rate limits, no `innerHTML` with data in the client.
- Secrets are read from the environment or `.env` and are never printed, logged or sent anywhere except their own API.

## PayPal sandbox setup

1. Sign in at [developer.paypal.com](https://developer.paypal.com) with any PayPal account.
2. Open **Apps & Credentials**, switch to **Sandbox** and open the **Default Application** (or create an app of type Merchant). Copy the **Client ID** and **Secret**.
3. In that app's features, make sure **Payouts** is enabled.
4. Open **Testing Tools > Sandbox Accounts** and copy the email of the **Personal** sandbox account (it looks like `sb-xxxxxxxx@personal.example.com`). The sample payees are fictional `example.com` addresses that PayPal cannot pay, so every payout goes to this account instead.
5. Create `.env` (copy `.env.example`):
   ```dotenv
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-secret
   PAYEE_EMAIL_OVERRIDE=sb-xxxxxxxx@personal.example.com
   ```
   Leave `PAYPAL_MOCK` empty.
6. `npm start`, open `http://127.0.0.1:4410`, run a sample, approve and pay. The approval panel states that the sandbox override replaces the contract payee. Check the payment in the sandbox Personal account at [sandbox.paypal.com](https://www.sandbox.paypal.com).
7. The samples are in EUR. If the payout is rejected because of currency or funds, create a sandbox **Business** account with country Germany (EUR), create a sandbox app linked to it and use that app's credentials.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm start            # 127.0.0.1:4410; offline AI; PayPal as configured in .env
npm run demo         # same, but with MOCK PayPal (no network at all)
```

Use Gemini by adding `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) to `.env`, or a local model with `AI_PROVIDER=openai`, `AI_BASE_URL=http://127.0.0.1:11434/v1`, `AI_MODEL=<model>`. With an AI provider you can paste any plain-text documents on the **Your documents** tab; offline mode reads only the sample layout (start from a sample and change numbers to watch the verdicts move). Every variable is documented in [`.env.example`](.env.example).

## Deploy on Render

1. Push the repository to GitHub.
2. In Render: **New > Web Service**, connect the repository. Runtime **Node**, build command `npm ci`, start command `npm start`, instance type **Free**, health check path `/health`. (Or **New > Blueprint** with the included `render.yaml`.)
3. Environment variables: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYEE_EMAIL_OVERRIDE` (or `PAYPAL_MOCK=1` for a mock-only demo), optionally `GEMINI_API_KEY`, `AI_MAX_CALLS_PER_HOUR`, `APPROVER_PASSCODE`, `MCP_BEARER_TOKEN`.
4. Render sets `PORT` and `RENDER_EXTERNAL_HOSTNAME`; the server then listens on `0.0.0.0`, allows that host name and trusts the proxy headers. Add custom domains to `ALLOWED_HOSTS`.

Free instances sleep when idle; cases, approvals and receipts live in memory and are gone after a restart.

## Tests

```bash
npm test             # node --test: 117 tests, no network
npm run e2e          # real Chromium: picks a sample, approves, pays via MOCK PayPal, writes docs/img/*.png
```

The unit and integration tests cover every verdict and the rounding rules, the extraction validator (missing fields, numbers as strings, localised strings, negatives), the offline parser on all samples against fixtures in `test/fixtures/`, proposal hash stability and invalidation, approval single use, expiry and hash binding, the PayPal client against mocked responses (token, exact payout body and `sender_batch_id`, duplicate batch, 401 refresh, timeout to `UNKNOWN_AFTER_SEND` and reconciliation, rejections, readback), the MCP tools through a real MCP client (`HUMAN_APPROVAL_REQUIRED` without approval), the HTTP server (CSP, Host and Origin checks, limits) and the UI files. External APIs are only ever reached through an injectable `fetch`; tests use `127.0.0.1` only. The e2e script needs a Chromium for `playwright-core` 1.56 (for example `npx playwright install chromium`, or `PLAYWRIGHT_BROWSERS_PATH` pointing at an existing one) and fails on console errors, CSP violations or horizontal scrolling at 390 px.

## Project layout

```
server.mjs              HTTP server, API, static files, security headers
mcp.mjs                 MCP tools over Streamable HTTP
src/ai.mjs              Gemini, OpenAI-compatible and offline providers
src/extract.mjs         per-document extraction, provenance, cache
src/offline-parser.mjs  deterministic reader for the sample layout (not AI)
src/schema.mjs          strict validator, normalises to cents and thousandths
src/verify.mjs          verification engine (pure)
src/message.mjs         message to the subcontractor, templates in en/de/pl/uk
src/proposal.mjs        payment proposal and previewHash
src/approval.mjs        single-use, hash-bound approval tokens
src/paypal.mjs          PayPal OAuth2, Payouts, readback, error classes
src/paypal-mock.mjs     MOCK PayPal (in-process sandbox fake)
src/receipt.mjs         receipt, readback checks, SHA-256
src/service.mjs         the flow shared by the API and MCP
public/                 UI (index.html, app.js, styles.css, vendor/, fonts/)
samples/                four fictional cases
test/                   node --test suites and expected-verdict fixtures
docs/img/               screenshots (desktop 1280×800 and phone 390×844, light and dark)
```

## Scope and limitations

- Documents are plain text (paste or `.txt` upload). PDFs and photos would need an OCR or PDF-to-text step first.
- Offline mode reads only the bundled sample layout; real documents need an AI provider. The AI adapters are tested against recorded response shapes; a live Gemini or sandbox run happens outside this repository's tests.
- Cases, approvals and receipts are kept in memory on a single instance. A production system needs a database, user accounts and strong approver authentication (SSO or passkeys) instead of the optional passcode; in this demo anyone who can open the page can approve.
- Duplicate detection works within one invoice; the same invoice submitted again as a new case is not detected across cases.
- Matching after normalisation is exact by design (no fuzzy matching). Roles and items in other languages need an alias or article code in the contract.
- Amounts are net. VAT and reverse charge are out of scope. Only currencies with two decimals are accepted.
- The MOCK PayPal reports a fee of 0.00; the sandbox reports its own values.
- All companies, people, addresses and email addresses in the samples are fictional.

## License

MIT, see [LICENSE](LICENSE). Third-party components and their licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). PayPal is a trademark of PayPal, Inc.; this project is not affiliated with PayPal.
