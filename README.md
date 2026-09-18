# Your Soul Animal Personality

A real, sellable MVP: a fun 16-question personality quiz ("Which Soul Animal are you?") that is free to take and costs **$0.38** to unlock the full result.

- **Frontend:** `index.html` (plain HTML/CSS/JS, no frameworks) → hosted on **GitHub Pages**
- **Backend:** `worker.js` (Cloudflare Worker, zero dependencies) → hosts the quiz questions, scoring engine, all paid result content, and all payment verification
- **Storage:** Cloudflare **D1** (primary), with an automatic **KV** fallback
- **Payments:** **PayPal** (see the reality check below)

---

## A. Full technical architecture

```
TikTok / Instagram / direct link
        │
        ▼
  GitHub Pages (index.html) ───── static, public, contains NO secrets
        │
        │ 1. POST /api/session            → creates anonymous session
        │ 2. GET  /api/questions          → 16 questions (no scoring weights)
        │ 3. POST /api/answers            → server scores, computes result (not revealed)
        │ 4. POST /api/payment/create     → PayPal.Me link  OR  PayPal Orders API order
        │ 5. POST /api/payment/verify     → server checks payment status
        │ 6. GET  /api/result             → full result ONLY after verification
        ▼
  Cloudflare Worker (worker.js / D1)
        │
        ├─ PayPal Orders API (automatic verification, requires credentials)
        └─ PayPal.Me   (payment entry only; manual server-side confirmation via ADMIN_SECRET)
```

**Security model**
- The frontend holds **no** secrets, **no** scoring weights, **no** full result text.
- The scoring algorithm and every paid result lives only in `worker.js`.
- `localStorage` is used only for resume state (session id, answers, step). It is **never** trusted for payment.
- "I've Paid" clicks are never trusted. Unlock only happens server-side after verification.
- Sessions are anonymous UUIDs with a server-side TTL; results can never be fetched for another session.

**⭐ The PayPal.Me reality check (please read carefully)**
`PayPal.Me` is *only a payment redirect page*. It returns no order id, no token, and no webhook, so **a browser (or a Worker) cannot automatically confirm a PayPal.Me payment**. Nothing in this project fakes that.

- **MVP mode (default, no PayPal API needed):** the worker keeps PayPal.Me as the payment entry point. After the user pays, you (the seller) see the payment in your PayPal.Me inbox and confirm it with one server call using `ADMIN_SECRET` (`POST /api/admin/manual-unlock`). The result stays locked until then.
- **Automatic, safe verification:** requires the **PayPal Orders API (PayPal Checkout)**. When `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` are set, the worker automatically switches to "checkout" mode, creates orders server-side with the exact `$0.38` amount and binds them to the session, and unlocks only after the order reports `COMPLETED` on PayPal's servers. Add `PAYPAL_WEBHOOK_ID` to also unlock instantly via `PAYPAL.CAPTURE.COMPLETED`.

So: **automatic safe payment verification requires PayPal Checkout / Orders API. PayPal.Me alone cannot do it.** This project supports both, and it does not pretend otherwise.

---

## B. Project structure

```
/
├── index.html      # GitHub Pages frontend (mobile-first, dopamine aesthetic)
├── worker.js       # Cloudflare Worker API (questions, scoring, results, payment)
├── schema.sql      # D1 database schema
├── wrangler.toml   # Cloudflare config (D1 + KV bindings, vars)
└── README.md       # this file
```

---

## C. Frontend — `index.html`

Everything is inline (CSS + JS, no third-party libraries, no CDNs). What it does:

- Cover → quiz (1 question at a time, 4 colored option cards, paw-print progress trail) → "done + locked" → payment → verified result → full report + affinity bars + confetti + share/copy.
- Maintains a backend session in `localStorage` so a refresh/close/reopen never loses the quiz.
- Auto-handles: payment success, cancelled, failed, pending, verification failure, network errors, session expiry, duplicate/returning payments.
- Shows a **developer-mode simulation panel only when the backend reports it is in DEVELOPMENT_MODE** (never in production).

### Configure the API URL
1. In `index.html`, set the constant near the top of the script:
   ```js
   var API_BASE = "https://your-worker-name.workers.dev";
   ```
2. Or pass it per visit for testing: `https://your-page.github.io/?api=https://your-worker-name.workers.dev`
   (the value is remembered locally in the browser for that visitor).

Update `CONFIG.supportEmail` with a real contact address.

---

## D. Backend — `worker.js`

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/info` | product, price, mode, devMode (no session) |
| POST | `/api/session` | create anonymous session (UUID, TTL) |
| GET | `/api/questions?sessionId=` | 16 questions, shuffled per session, **no weights** |
| POST | `/api/answers` | validate + score answers, store result (not returned) |
| POST | `/api/payment/create` | dev → checkouts → paypalme mode output |
| POST | `/api/payment/verify` | server-side verification; returns full result only when paid |
| GET | `/api/result?sessionId=` | `{"success":false,"locked":true}` until paid, then full result |
| POST | `/api/verify-webhook` | PayPal webhook signature verification + unlock |
| POST | `/api/admin/manual-unlock` | seller confirms a PayPal.Me payment (needs `ADMIN_SECRET`) |
| POST | `/api/admin/status` | seller checks a session status (needs `ADMIN_SECRET`) |

Scoring details
- Each answer gives +2 to a primary animal and +1 to a secondary animal.
- Affinity % = raw score ÷ that animal's maximum possible score (so the winner is **not** always 100%).
- Winner = highest raw score. Tie-break: more 2-point contributions, then a fixed alphabetical order.
- All paid result copy is stored only in the worker.

---

## E. Database structure

D1 `sessions` table (see `schema.sql`):

`id`, `created_at`, `expires_at`, `answers` (JSON), `scores` (JSON), `big_pts` (JSON), `result_type`, `payment_status`, `payment_id`, `payment_method`, `order_id`, `unlocked_at`, `verify_count`, `last_verify_at`, `question_order` (JSON)

No emails, no names, no accounts. Sessions auto-expire server-side.

---

## F. PayPal configuration

Manual-unlock mode (PayPal.Me, works immediately):
1. Set a strong secret: `wrangler secret put ADMIN_SECRET` (≥16 random chars).
2. On the cover page the payment button already points to `https://www.paypal.com/paypalme/gardenia2099/0.38`.
3. When a payment appears in your PayPal.Me inbox, run the manual unlock with the session id:
   ```
   curl -X POST https://your-worker.workers.dev/api/admin/manual-unlock \
        -H "Content-Type: application/json" \
        -d '{"adminToken":"YOUR_ADMIN_SECRET","sessionId":"...","paypalTxnId":"optional-txn-id"}'
   ```
4. Check a session's state:
   ```
   curl -X POST https://your-worker.workers.dev/api/admin/status \
        -H "Content-Type: application/json" \
        -d '{"adminToken":"YOUR_ADMIN_SECRET","sessionId":"..."}'
   ```

Automatic mode (PayPal Checkout / Orders API — recommended before launch):
1. In the PayPal Developer Dashboard (http://developer.paypal.com), create/copy a **REST app** to get `Client ID` and `Secret`.
2. Set them as Cloudflare secrets:
   `wrangler secret put PAYPAL_CLIENT_ID`
   `wrangler secret put PAYPAL_CLIENT_SECRET`
3. Create a **Webhook** in the dashboard → URL `https://your-worker.workers.dev/api/verify-webhook`, event `Payment capture completed` → keep the **Webhook ID** → `wrangler secret put PAYPAL_WEBHOOK_ID`.
4. Set `PAYPAL_MODE` to `sandbox` while testing, `live` at launch.
5. After these are set, `GET /api/info` reports `autoVerify: true` and the worker switches to "checkout" mode automatically. The $0.38 amount and currency are validated server-side against the session.

Note on $0.38: PayPal transaction-fee math makes this a low-margin product by design. If you later raise the price, just change `PAYMENT_PRICE_USD`.

### Environment variables summary

| Variable | Where | Purpose |
|---|---|---|
| `PAYMENT_PRICE_USD` | vars | price (default 0.38) |
| `SESSION_TTL_MINUTES` | vars | session lifetime (default 1440) |
| `PAYPAL_ME_USER` | vars | PayPal.Me handle (default gardenia2099) |
| `PAYPAL_MODE` | vars | sandbox / live |
| `ALLOWED_ORIGIN` | vars | `*` or your GitHub Pages origin |
| `DEVELOPMENT_MODE` | vars/secret | "true" for tests, **"false" at launch** |
| `ADMIN_SECRET` | secret | manual-unlock key (≥16 chars) |
| `PAYPAL_CLIENT_ID` | secret | Orders API (non-empty switches to checkout mode) |
| `PAYPAL_CLIENT_SECRET` | secret | Orders API |
| `PAYPAL_WEBHOOK_ID` | secret | webhook signature verification |

---

## G. GitHub Pages deployment

1. Push the repo (root must contain `index.html`), e.g. `git init && git add . && git commit -m "soul animal quiz" && git push`.
2. GitHub → repo → **Settings → Pages** → Source → **Deploy from a branch** → branch `main` / root → Save.
3. Your address: `https://<username>.github.io/<repo>/` (or `https://<username>.github.io` for `username.github.io` repos).
4. Set `ALLOWED_ORIGIN` to that origin (or keep `*`).

---

## H. Cloudflare Worker deployment

1. `npm i -g wrangler` (or use `npx wrangler`), then `wrangler login`.
2. `wrangler d1 create soul-animal` → copy the returned **database_id** into `wrangler.toml`.
3. `wrangler kv namespace create SESSION_BACKUP` → copy the **id** into `wrangler.toml`.
4. Apply the schema: `wrangler d1 execute soul-animal --remote --file=schema.sql`.
5. Set secrets (see section F).
6. `wrangler deploy` → copy the `*.workers.dev` URL into `API_BASE` in `index.html`.
7. Test. Before going live: `DEVELOPMENT_MODE = "false"`, `PAYPAL_MODE = "live"`, real PayPal credentials, real `ALLOWED_ORIGIN`.

---

## I. Testing

Local API test (no frontend needed):
```bash
# create a session
curl -s -X POST https://your-worker.workers.dev/api/session | jq

# grab the session id, then fetch questions
curl -s "https://your-worker.workers.dev/api/questions?sessionId=SSID" | jq

# submit 16 answers (a..p are 0-3 values)
curl -s -X POST https://your-worker.workers.dev/api/answers \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"SSID","answers":[0,1,2,3,0,1,2,3,0,1,2,3,0,1,2,3]}' | jq

# before payment, result must be locked
curl -s "https://your-worker.workers.dev/api/result?sessionId=SSID" | jq
# -> {"success":false,"locked":true}

# manual unlock as the seller
curl -s -X POST https://your-worker.workers.dev/api/admin/manual-unlock \
  -H "Content-Type: application/json" \
  -d '{"adminToken":"YOUR_ADMIN_SECRET","sessionId":"SSID"}' | jq

# now the full result is returned
curl -s "https://your-worker.workers.dev/api/result?sessionId=SSID" | jq
```

Frontend tests
1. Put `DEVELOPMENT_MODE=true` (wrangler vars) and redeploy.
2. Open the site (`https://your-page.github.io/?api=YOUR_WORKER`).
3. Take the quiz → locked page shows the **Developer mode** panel → test:
   - `Simulate payment_success` → full result + confetti + affinity bars.
   - `Simulate payment_cancelled / pending / failed` → correct banners, result stays locked.
4. Refresh mid-quiz / close the browser and reopen → the quiz resumes where it left off.
5. In `checkout` mode (real PayPal sandbox credentials), complete a sandbox payment → automatic unlock.
6. Also test wrong answers payloads, expired sessions, and re-verifying an already-paid session (returns result, no double charge).

DEVELOPMENT_MODE is only for testing. In production the worker **ignores** simulated success values (mode is "checkout"/"paypalme"), so no URL/query trick can unlock a result — there is no such code path.

---

## J. Pre-launch safety checklist

- [ ] `DEVELOPMENT_MODE` is `"false"` (not set / not "true").
- [ ] `PAYPAL_MODE` is `"live"` and real PayPal credentials are set (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`), or you commit to checking PayPal.Me payments manually with `ADMIN_SECRET`.
- [ ] `ADMIN_SECRET` is set, long, random, and never committed.
- [ ] `ALLOWED_ORIGIN` is your real GitHub Pages origin.
- [ ] `API_BASE` in index.html points to your deployed worker (and support email is real).
- [ ] `schema.sql` applied remotely (`wrangler d1 execute ... --remote --file=schema.sql`).
- [ ] Verify a real $0.38 payment end-to-end on a test device.
- [ ] Verify `GET /api/result` still returns `locked:true` with a guessable/modified session id.
- [ ] Confirm no secrets appear in any committed file (grep for `Client_Secret`, `ADMIN_SECRET`, `Webhook_ID`).
- [ ] Confirm the results text exists only in `worker.js`, never in `index.html`.
- [ ] Test on 375px/390px/414px (iPhone/Android) and confirm no horizontal scroll.
- [ ] Confirm sessions auto-expire (default 24h) and that root `z/` info doesn't leak answers.
- [ ] Entertainment disclaimer shows on the page (it does — footer).

---

See `index.html` and `worker.js` for the complete, runnable code.