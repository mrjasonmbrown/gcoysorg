// Local end-to-end test: mock Square + wrangler dev + local D1.  Run: npm test
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

const PORT = 8788, BASE = `http://127.0.0.1:${PORT}`, SIGKEY = 'test-sig-key';
let fails = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ok  ' + m); } else { fails++; console.log('  FAIL ' + m); } };

let mockPayment = null, linkCount = 0, squareDown = false;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/online-checkout/payment-links') {
      if (squareDown) { res.statusCode = 500; return res.end('{}'); }
      const j = JSON.parse(b); linkCount++;
      return res.end(JSON.stringify({ payment_link: { id: 'PL' + linkCount, order_id: 'ORD-' + j.order.reference_id, url: 'https://sandbox.square.link/u/' + linkCount } }));
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/payments/') && mockPayment) return res.end(JSON.stringify({ payment: mockPayment }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(8799);

const valid = (o = {}) => ({
  idempotency_key: crypto.randomUUID(), website: '',
  first_name: 'Ava', last_name: 'Test', dob: '2016-05-04', division: '10U', grade: '4th Grade', school: 'Test Elementary', jersey_size: 'YM',
  guardian: 'Pat Test', email: 'pat@example.com', phone: '404-555-0100', address: '1 Main St, Atlanta, GA 30301',
  emergency_name: 'Sam Test', relationship: 'Aunt', emergency_phone: '404-555-0111', medical: 'peanut allergy', accommodations: '',
  experience: 'none', position: 'Center', team_request: '',
  guardian_confirmation: true, waiver: true, medical_authorization: true, code_of_conduct: true, media_permission: false,
  scholarship: 'no', signature: 'Pat Test', signed_date: '2026-10-16', ...o,
});
const post = (body, headers = {}) => fetch(BASE + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...headers }, body: JSON.stringify(body) });
const sign = (raw) => crypto.createHmac('sha256', SIGKEY).update(`${BASE}/api/square-webhook` + raw).digest('base64');
const hook = (ev, sig) => { const raw = JSON.stringify(ev); return fetch(BASE + '/api/square-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sig ?? sign(raw) }, body: raw }); };
const admin = (t, q = '') => fetch(BASE + '/api/admin/registrations' + q, { headers: t ? { authorization: 'Bearer ' + t } : {} });

execSync('npx wrangler d1 execute gcoys-registrations --local --file=schema.sql', { stdio: 'ignore' });
// Start every run from an empty LOCAL database (leftovers would trip the rate limiter).
execSync(`npx wrangler d1 execute gcoys-registrations --local --command="DELETE FROM rate_events; DELETE FROM registrations; DELETE FROM webhook_events;"`, { stdio: 'ignore' });
const dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { stdio: 'ignore' });
const stop = () => { dev.kill(); mock.close(); };
process.on('exit', stop);

for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/status')).ok) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }

try {
  console.log('status');
  let r = await fetch(BASE + '/api/status'); let j = await r.json();
  ok(r.status === 200 && j.open === true && j.mode === 'sandbox', 'status open/sandbox');

  console.log('validation');
  r = await post(valid({ email: 'bad', waiver: false, division: '99U' })); j = await r.json();
  ok(r.status === 422 && j.fields.email && j.fields.waiver && j.fields.division, '422 with field errors');
  r = await post(valid({ website: 'bot' })); ok(r.status === 400, 'honeypot rejected');
  r = await post(valid(), { origin: 'https://evil.example' }); ok(r.status === 403, 'cross-origin rejected');
  r = await post(valid({ fee: 1, payment_status: 'paid' })); j = await r.json();
  ok(r.status === 201 && j.payment_status === 'pending_payment', 'client cannot set payment_status/fee');

  console.log('register');
  const a = valid({ first_name: 'Zed', email: 'zed@example.com' });
  r = await post(a); j = await r.json();
  ok(r.status === 201 && /^TCFFL-2026-[A-Z0-9]{6}$/.test(j.registration_id) && j.checkout_url.startsWith('https://'), '201 with id + checkout_url');
  const id1 = j.registration_id; const links = linkCount;
  r = await post(a); j = await r.json();
  ok(r.status === 201 && j.registration_id === id1 && linkCount === links, 'idempotent retry returns same registration, no new link');
  r = await post(valid({ first_name: 'Zed', email: 'zed@example.com' })); j = await r.json();
  ok(r.status === 201 && j.registration_id === id1, 'duplicate player+guardian returns existing');

  r = await post(valid({ first_name: 'Schol', email: 'schol@example.com', scholarship: 'yes' })); j = await r.json();
  ok(r.status === 201 && j.payment_status === 'scholarship_review' && !j.checkout_url, 'scholarship path has no checkout');

  squareDown = true;
  r = await post(valid({ first_name: 'Down', email: 'down@example.com' })); j = await r.json();
  ok(r.status === 201 && !j.checkout_url && j.registration_id, 'Square outage: registration still saved, no checkout');
  squareDown = false;

  console.log('webhook');
  mockPayment = { id: 'PAY1', status: 'COMPLETED', order_id: 'ORD-' + id1, location_id: 'LTEST', amount_money: { amount: 12500, currency: 'USD' } };
  const ev = { event_id: 'ev1', type: 'payment.updated', data: { id: 'PAY1' } };
  r = await hook(ev, 'bogus'); ok(r.status === 401, 'bad signature -> 401');
  r = await hook(ev); ok(r.status === 200, 'valid event accepted');
  r = await hook(ev); j = await r.json(); ok(r.status === 200 && j.duplicate, 'replay deduped');

  mockPayment = { ...mockPayment, id: 'PAY2', amount_money: { amount: 100, currency: 'USD' }, order_id: 'ORD-' + id1 };
  await hook({ event_id: 'ev2', type: 'payment.updated', data: { id: 'PAY2' } });

  console.log('admin');
  ok((await admin()).status === 401, 'no token -> 401');
  ok((await admin('wrong')).status === 401, 'wrong token -> 401');
  r = await admin('admin-test'); j = await r.json();
  const row = j.registrations.find(x => x.id === id1);
  ok(r.status === 200 && row && row.payment_status === 'paid' && !('medical' in row), 'admin sees paid, no medical column');
  r = await admin('med-test'); j = await r.json();
  ok(j.registrations.find(x => x.id === id1).medical === 'peanut allergy', 'medical token sees medical');
  const csv = await (await admin('admin-test', '?format=csv')).text();
  ok(csv.startsWith('id,') && !csv.includes('peanut'), 'CSV omits medical');
  r = await post(valid({ first_name: '=cmd', email: 'f@example.com' }));
  const csv2 = await (await admin('admin-test', '?format=csv')).text();
  ok(csv2.includes("'=cmd"), 'CSV formula guard');

  console.log('static');
  for (const p of ['/', '/tcffl-registration/', '/admin/']) ok((await fetch(BASE + p)).status === 200, 'serves ' + p);
  for (const p of ['/src/worker.js', '/schema.sql', '/wrangler.jsonc', '/.dev.vars']) { const s = await fetch(BASE + p); const t = await s.text(); ok(s.status === 404 || !t.includes('CREATE TABLE') && !t.includes('ADMIN_TOKEN'), 'not exposed ' + p); }

  console.log('rate limit');
  let limited = false; for (let i = 0; i < 15; i++) { if ((await post(valid({ email: `r${i}@example.com` }))).status === 429) limited = true; }
  ok(limited, 'rate limit triggers 429');
} finally { stop(); }
console.log(`\n${passed} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
