// Donation flow test with an in-memory database and a fake Square. No network.
// Run: node test/donate.mjs
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';

// Cloudflare Workers provide crypto.subtle.timingSafeEqual; plain Node does not.
if (!crypto.webcrypto.subtle.timingSafeEqual) {
  crypto.webcrypto.subtle.timingSafeEqual = (a, b) => crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

let fails = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ok  ' + m); } else { fails++; console.log('  FAIL ' + m); } };

// --- tiny D1 stand-in on top of node:sqlite
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
});
const DB = { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };

// --- fake Square
const SIGKEY = 'sig';
let links = 0, lastLinkBody = null, payments = {};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith('/v2/online-checkout/payment-links')) {
    lastLinkBody = JSON.parse(init.body); links++;
    return new Response(JSON.stringify({ payment_link: { id: 'PL' + links, order_id: 'ORD-' + lastLinkBody.order.reference_id, url: 'https://square.link/u/' + links } }), { status: 200 });
  }
  const m = u.match(/\/v2\/payments\/(.+)$/);
  if (m) return new Response(JSON.stringify({ payment: payments[m[1]] }), { status: 200 });
  return new Response('{}', { status: 404 });
};

const env = { DB, SQUARE_ACCESS_TOKEN: 't', SQUARE_LOCATION_ID: 'LOC', SQUARE_ENV: 'sandbox', SQUARE_WEBHOOK_SIGNATURE_KEY: SIGKEY, ADMIN_TOKEN: 'admin-x', ASSETS: { fetch: () => new Response('asset') } };
const ctx = { waitUntil() {} };
const BASE = 'https://gcoys.org';
const call = (path, init) => worker.fetch(new Request(BASE + path, init), env, ctx);
const donate = (body, headers = {}) => call('/api/donate', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...headers }, body: JSON.stringify(body) });
const hook = async (ev) => {
  const raw = JSON.stringify(ev);
  const sig = crypto.createHmac('sha256', SIGKEY).update(BASE + '/api/square-webhook' + raw).digest('base64');
  return call('/api/square-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sig }, body: raw });
};
const key = () => crypto.randomUUID();

console.log('validation');
ok((await donate({ amount: 2, fund: 'general', idempotency_key: key() })).status === 422, 'under $5 rejected');
ok((await donate({ amount: 20000, fund: 'general', idempotency_key: key() })).status === 422, 'over $10,000 rejected');
ok((await donate({ amount: 'abc', fund: 'general', idempotency_key: key() })).status === 422, 'non-number rejected');
ok((await donate({ amount: 25, fund: 'general', idempotency_key: key(), website: 'bot' })).status === 400, 'honeypot rejected');
ok((await donate({ amount: 25, fund: 'general', idempotency_key: key() }, { origin: 'https://evil.example' })).status === 403, 'other website rejected');
ok((await donate({ amount: 25, fund: 'general' })).status === 400, 'missing key rejected');

console.log('checkout');
const k1 = key();
let r = await donate({ amount: 50, fund: 'harvest', idempotency_key: k1 });
let j = await r.json();
ok(r.status === 201 && j.checkout_url && /^GCOYS-GIFT-/.test(j.donation_id), 'creates donation + Square checkout');
ok(lastLinkBody.order.line_items[0].base_price_money.amount === 5000, 'Square charged the server-checked amount ($50)');
ok(/Harvest in the Park/.test(lastLinkBody.order.line_items[0].name), 'program name on the Square order');
ok(lastLinkBody.checkout_options.redirect_url.startsWith('https://gcoys.org/donate/?thanks=1&ref=' + j.donation_id), 'returns donor to the thank-you page');
const id1 = j.donation_id;
const before = links;
r = await donate({ amount: 50, fund: 'harvest', idempotency_key: k1 }); j = await r.json();
ok(j.donation_id === id1 && links === before, 'same request again reuses the checkout (no duplicate)');
r = await donate({ amount: 12.5, fund: 'nonsense', idempotency_key: key() }); j = await r.json();
ok(r.status === 201 && /Where it is needed most/.test(lastLinkBody.order.line_items[0].name) && lastLinkBody.order.line_items[0].base_price_money.amount === 1250, 'unknown program falls back to general; cents handled');

console.log('payment webhook');
payments.P1 = { id: 'P1', order_id: 'ORD-' + id1, status: 'COMPLETED', location_id: 'LOC', amount_money: { amount: 5000, currency: 'USD' } };
r = await hook({ event_id: 'e1', type: 'payment.updated', data: { id: 'P1' } });
ok(r.status === 200, 'webhook accepted');
let row = db.prepare('SELECT * FROM donations WHERE id=?').get(id1);
ok(row.status === 'paid' && row.square_payment_id === 'P1', 'donation marked paid');
payments.P2 = { id: 'P2', order_id: 'ORD-' + id1, status: 'COMPLETED', location_id: 'LOC', amount_money: { amount: 100, currency: 'USD' } };
const k3 = key(); r = await donate({ amount: 30, fund: 'repath', idempotency_key: k3 }); const id3 = (await r.json()).donation_id;
payments.P3 = { id: 'P3', order_id: 'ORD-' + id3, status: 'COMPLETED', location_id: 'LOC', amount_money: { amount: 100, currency: 'USD' } };
await hook({ event_id: 'e3', type: 'payment.updated', data: { id: 'P3' } });
ok(db.prepare('SELECT status FROM donations WHERE id=?').get(id3).status === 'pending', 'wrong amount is not marked paid');
const bad = await call('/api/square-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': 'nope' }, body: '{"event_id":"x","type":"payment.updated"}' });
ok(bad.status === 401, 'unsigned webhook rejected');

console.log('refund');
await hook({ event_id: 'e4', type: 'refund.updated', data: { object: { refund: { status: 'COMPLETED', payment_id: 'P1', amount_money: { amount: 5000 } } } } });
ok(db.prepare('SELECT status FROM donations WHERE id=?').get(id1).status === 'refunded', 'refund recorded');

console.log('admin export');
ok((await call('/api/admin/donations')).status === 401, 'no token -> 401');
r = await call('/api/admin/donations', { headers: { authorization: 'Bearer admin-x' } }); j = await r.json();
ok(r.status === 200 && j.count === 3 && j.columns.includes('fund'), 'admin sees donations');
r = await call('/api/admin/donations?format=csv', { headers: { authorization: 'Bearer admin-x' } });
ok(r.status === 200 && (await r.text()).startsWith('id,created_at'), 'CSV export');

console.log(`\n${passed} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
