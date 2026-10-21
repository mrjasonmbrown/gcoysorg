# TCFFL registration: setup guide (about 20 minutes)

The code is finished and tested locally (`npm test`, 27 checks). These steps need your logins, so you do them; never paste a secret into chat or into a file in this repo.

## 0. Do not merge to `main` yet
`wrangler.jsonc` contains `REPLACE_WITH_D1_DATABASE_ID`. Merging before step 1 is finished would break the live site's auto-deploy.

## 1. Create the database (Cloudflare dashboard)
1. Storage & Databases → D1 → Create database → name `gcoys-registrations`.
2. Copy its **Database ID** (not a secret) and put it in `wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID`.
3. Open the database → Console → paste the whole of `schema.sql` → Execute.

## 2. Secrets (Workers & Pages → gcoysorg → Settings → Variables and Secrets → type "Secret")
| Name | Value |
|---|---|
| `REGISTRATION_OPEN` | `true` (anything else closes registration) |
| `SQUARE_ENV` | `sandbox` for testing, later `production` |
| `SQUARE_ACCESS_TOKEN` | Square Developer Dashboard → your app → Credentials (sandbox first) |
| `SQUARE_LOCATION_ID` | Sandbox: Locations tab in sandbox. Production: `LPYP1HHDZQ28P` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | from step 3 |
| `ADMIN_TOKEN` | a long random string you invent (20+ characters) |
| `MEDICAL_ADMIN_TOKEN` | optional, a different long random string; only this one shows medical info |
| `ADMIN_NOTIFY_EMAIL`, `RESEND_API_KEY`, `MAIL_FROM` | optional email; needs a verified sending domain |

## 3. Square webhook
Developer Dashboard → Webhooks → Add subscription: URL `https://gcoysorg.mrjasonmbrown.workers.dev/api/square-webhook` (use `https://gcoys.org/...` after DNS moves; if you change it, also set `SQUARE_WEBHOOK_URL` to match exactly). Events: `payment.created`, `payment.updated`, `refund.created`, `refund.updated`. Copy the Signature Key into the secret above. Do this once for sandbox and once for production.

## 4. Sandbox test
Submit the form with dummy data, pay with Square's test card 4111 1111 1111 1111, then open `/admin/` with `ADMIN_TOKEN` and confirm the row says `paid`.

## 5. Go live
Replace the `[APPROVED ... REQUIRED]` placeholder blocks in `tcffl-registration/index.html` with the real documents and set `CONSENT_VERSION` in `src/worker.js`. Then set `SQUARE_ENV=production` with the production token and location, merge to `main`. While placeholders remain, the production form refuses submissions on purpose.

## Still needed from the league
Waiver, medical authorization, code of conduct, media release, privacy notice; refund and scholarship policy; birth-date cutoffs per division; real registration and season dates; e-signature wording sign-off.

Optional hardening: protect `/admin/*` and `/api/admin/*` with Cloudflare Access.

## Donations (gcoys.org/donate)
- Uses the same Square account, location and webhook as TCFFL registrations. No new Cloudflare settings are needed.
- The `donations` table is created automatically on first use (also listed in schema.sql).
- Amounts are checked on the server ($5 to $10,000). Programs: general, tcffl, repath, harvest. Link with `?fund=tcffl` to preselect one.
- Paid / refunded status comes only from verified Square webhooks.
- Export: /admin/ → "Download donations CSV" (same admin token).
- While `SQUARE_ENV` is not `production`, the page shows a "test mode" notice and no real money moves.
- Test: `node --no-warnings test/donate.mjs`
