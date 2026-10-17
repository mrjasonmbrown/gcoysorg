// TCFFL registration backend for gcoys.org (Cloudflare Worker).
//
//   POST /api/register          validate -> save to D1 -> create Square checkout -> {registration_id, checkout_url}
//   POST /api/square-webhook    verified Square webhooks mark registrations paid / failed / refunded
//   GET  /api/admin/registrations   protected export (JSON or ?format=csv)
//   GET  /api/status            lets the form know whether registration is open
//
// Everything else is served from the static site (index.html, /tcffl-registration/, /admin/ ...).
// Secrets live in the Cloudflare dashboard (never in this repo). See docs/SETUP.md.

const FEE_CENTS = 12500; // $125. Set here on the server; the browser is never trusted for price.
const ID_PREFIX = 'TCFFL-2026-';
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
const ITEM_NAME = 'TCFFL Player Registration - Fall 2026';
const DEFAULT_ADMIN_EMAIL = 'info@gcoys.org';

// OWNER ITEM: replace with the version label of the approved waiver / medical authorization /
// code of conduct / media release / privacy text once Michael supplies it. Stored with every registration.
const CONSENT_VERSION = 'DRAFT-NOT-APPROVED';

// OWNER ITEM: sanity range only. The real birth-date cutoff per division is still to be confirmed.
const MIN_AGE = 4;
const MAX_AGE = 17;

const MAX_BODY_BYTES = 20000;
const RATE_LIMIT = 10;                 // registrations attempts per IP ...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ... per 10 minutes
const ADMIN_FAIL_LIMIT = 20;

const DIVISIONS = ['6U', '7U', '8U', '9U', '10U', '11U', '12U', '13U', '14U'];
const GRADES = ['Kindergarten', '1st Grade', '2nd Grade', '3rd Grade', '4th Grade', '5th Grade', '6th Grade', '7th Grade', '8th Grade', '9th Grade'];
const JERSEY_SIZES = ['YS', 'YM', 'YL', 'AS', 'AM', 'AL', 'AXL'];
const EXPERIENCE = ['none', '1year', '2years', '3plus'];
const POSITIONS = ['Quarterback', 'Wide Receiver', 'Running Back', 'Center', 'Linebacker', 'Cornerback', 'Safety', 'No preference'];

const encoder = new TextEncoder();

// ---------------------------------------------------------------- routing

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/api/status': return handleStatus(request, env);
        case '/api/register': return await handleRegister(request, env, ctx, url);
        case '/api/square-webhook': return await handleWebhook(request, env, ctx, url);
        case '/api/admin/registrations': return await handleAdmin(request, env, url);
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (err) {
      // Never leak internals. Nothing is reported as saved unless the database write succeeded.
      console.error('Unhandled error', url.pathname, err && err.message);
      return json({ error: 'Something went wrong on our end. Please try again, or contact info@gcoys.org.' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------- responses

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function handleStatus(request, env) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
  return json({
    open: env.REGISTRATION_OPEN === 'true',
    mode: env.SQUARE_ENV === 'production' ? 'production' : 'sandbox',
    fee: FEE_CENTS / 100,
  });
}

// ---------------------------------------------------------------- crypto helpers

async function sha256Bytes(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
}
async function sha256Hex(s) {
  return [...(await sha256Bytes(s))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Bytes(String(a)), sha256Bytes(String(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
async function hmacBase64(key, message) {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}
function newRegistrationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return ID_PREFIX + s;
}

// ---------------------------------------------------------------- validation

function cleanText(v, multiline) {
  let s = String(v);
  s = s.replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  return multiline ? s.trim() : s.replace(/\s+/g, ' ').trim();
}

function isRealDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function ageYears(dob, now) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function validate(b, now = new Date()) {
  const errors = {};
  const c = {};

  const text = (key, { max, required = true, multiline = false }) => {
    const raw = b[key];
    if (raw === undefined || raw === null || raw === '') {
      if (required) errors[key] = 'This field is required.';
      c[key] = '';
      return;
    }
    if (typeof raw !== 'string') { errors[key] = 'Invalid value.'; return; }
    const v = cleanText(raw, multiline);
    if (required && !v) { errors[key] = 'This field is required.'; return; }
    if (v.length > max) { errors[key] = `Please keep this under ${max} characters.`; return; }
    c[key] = v;
  };
  const oneOf = (key, list, required = true) => {
    const raw = b[key];
    if (raw === undefined || raw === null || raw === '') {
      if (required) errors[key] = 'Please choose an option.';
      c[key] = '';
      return;
    }
    if (typeof raw !== 'string' || !list.includes(raw)) { errors[key] = 'Please choose a valid option.'; return; }
    c[key] = raw;
  };
  const phone = (key) => {
    text(key, { max: 30 });
    if (errors[key]) return;
    const digits = c[key].replace(/\D/g, '');
    if (!/^[\d\s().+-]+$/.test(c[key]) || digits.length < 10 || digits.length > 15) errors[key] = 'Please enter a valid phone number.';
  };

  // player
  text('first_name', { max: 60 });
  text('last_name', { max: 60 });
  oneOf('division', DIVISIONS);
  oneOf('grade', GRADES);
  text('school', { max: 120 });
  oneOf('jersey_size', JERSEY_SIZES);

  const dobRaw = typeof b.dob === 'string' ? b.dob.trim() : '';
  const dob = isRealDate(dobRaw);
  if (!dob) errors.dob = 'Please enter a valid date of birth.';
  else {
    const age = ageYears(dob, now);
    if (dob > now || age < MIN_AGE || age > MAX_AGE) errors.dob = 'Please check the date of birth.';
    else c.dob = dobRaw;
  }

  // guardian
  text('guardian', { max: 100 });
  text('email', { max: 254 });
  if (!errors.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) errors.email = 'Please enter a valid email address.';
  phone('phone');
  text('address', { max: 250 });

  // emergency + medical
  text('emergency_name', { max: 100 });
  text('relationship', { max: 60 });
  phone('emergency_phone');
  text('medical', { max: 1000, required: false, multiline: true });
  text('accommodations', { max: 1000, required: false, multiline: true });

  // league
  oneOf('experience', EXPERIENCE, false);
  oneOf('position', POSITIONS, false);
  text('team_request', { max: 200, required: false });

  // scholarship
  oneOf('scholarship', ['yes', 'no']);

  // agreements (all four required; media permission stays optional)
  for (const key of ['guardian_confirmation', 'waiver', 'medical_authorization', 'code_of_conduct']) {
    if (b[key] !== true) errors[key] = 'This agreement is required to register.';
    c[key] = b[key] === true;
  }
  c.media_permission = b.media_permission === true;

  // signature
  text('signature', { max: 120 });
  if (!errors.signature && c.signature.length < 2) errors.signature = 'Please type your full name.';
  const signedRaw = typeof b.signed_date === 'string' ? b.signed_date.trim() : '';
  const signed = isRealDate(signedRaw);
  if (!signed) errors.signed_date = 'Please enter a valid date.';
  else if (Math.abs(signed.getTime() - now.getTime()) > 3 * 86400000) errors.signed_date = "Please use today's date.";
  else c.signed_date = signedRaw;

  // idempotency key (generated by the browser)
  if (typeof b.idempotency_key !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(b.idempotency_key)) errors.idempotency_key = 'Invalid request. Please refresh the page and try again.';
  else c.idempotency_key = b.idempotency_key;

  return { errors, clean: c };
}

// ---------------------------------------------------------------- registration

async function handleRegister(request, env, ctx, url) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
  if (env.REGISTRATION_OPEN !== 'true') {
    return json({ error: 'Online registration is not open right now. Please contact info@gcoys.org.' }, 503);
  }

  const origin = request.headers.get('origin');
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* ignore */ }
    if (originHost !== url.host) return json({ error: 'Forbidden' }, 403);
  }
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return json({ error: 'Unsupported content type' }, 415);
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request' }, 400);

  // Abuse protection: hidden honeypot + per-IP throttle (hashed IP, never stored raw).
  if (body.website) return json({ error: 'Unable to process this request.' }, 400);
  const ipHash = await sha256Hex((request.headers.get('cf-connecting-ip') || 'unknown') + ':reg');
  const limited = await throttle(env, ipHash, RATE_LIMIT);
  if (limited) return json({ error: 'Too many attempts. Please wait a few minutes and try again.' }, 429, { 'retry-after': '600' });

  const { errors, clean } = validate(body);
  if (Object.keys(errors).length) {
    return json({ error: 'Please fix the highlighted fields.', fields: errors }, 422);
  }

  const dupKey = [clean.first_name, clean.last_name, clean.dob, clean.email].map((s) => s.toLowerCase()).join('|');

  // Idempotent retry (same browser key) -> return the same result, never a second entry.
  let existing = await env.DB.prepare('SELECT * FROM registrations WHERE idempotency_key = ?1').bind(clean.idempotency_key).first();
  // Same player + guardian email submitted again (e.g. page reloaded) -> reuse unless already paid.
  if (!existing) {
    const dup = await env.DB.prepare('SELECT * FROM registrations WHERE dup_key = ?1 ORDER BY created_at DESC LIMIT 1').bind(dupKey).first();
    if (dup) {
      if (dup.payment_status === 'paid') {
        return json({ error: 'A paid registration already exists for this player. If you need help, contact info@gcoys.org and include your reference number.' }, 409);
      }
      existing = dup;
    }
  }
  if (existing) {
    existing = await ensureCheckout(env, existing, baseUrlFor(env, url));
    return json(publicResult(existing), 201);
  }

  const now = new Date().toISOString();
  const scholarship = clean.scholarship === 'yes';
  let reg = null;
  for (let attempt = 0; attempt < 3 && !reg; attempt++) {
    const row = {
      id: newRegistrationId(),
      idempotency_key: clean.idempotency_key,
      dup_key: dupKey,
      created_at: now,
      updated_at: now,
      first_name: clean.first_name,
      last_name: clean.last_name,
      dob: clean.dob,
      division: clean.division,
      grade: clean.grade,
      school: clean.school,
      jersey_size: clean.jersey_size,
      guardian_name: clean.guardian,
      email: clean.email,
      phone: clean.phone,
      address: clean.address,
      emergency_name: clean.emergency_name,
      emergency_relationship: clean.relationship,
      emergency_phone: clean.emergency_phone,
      medical: clean.medical,
      accommodations: clean.accommodations,
      experience: clean.experience,
      position: clean.position,
      team_request: clean.team_request,
      consent_version: CONSENT_VERSION,
      waiver: 1,
      medical_authorization: 1,
      code_of_conduct: 1,
      guardian_confirmation: 1,
      media_permission: clean.media_permission ? 1 : 0,
      signature: clean.signature,
      signed_date: clean.signed_date,
      scholarship_requested: scholarship ? 1 : 0,
      payment_status: scholarship ? 'scholarship_review' : 'pending_payment',
      fee_cents: FEE_CENTS,
    };
    const cols = Object.keys(row);
    try {
      await env.DB
        .prepare(`INSERT INTO registrations (${cols.join(',')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(',')})`)
        .bind(...cols.map((k) => row[k]))
        .run();
      reg = row;
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) {
        // Either a concurrent duplicate of this same request, or (very rarely) an ID collision.
        const again = await env.DB.prepare('SELECT * FROM registrations WHERE idempotency_key = ?1').bind(clean.idempotency_key).first();
        if (again) return json(publicResult(again), 201);
        continue;
      }
      throw err; // storage failure -> top-level handler returns 500; we never claim success
    }
  }
  if (!reg) throw new Error('Could not allocate registration id');

  // Saved durably. Now (for non-scholarship) start the hosted Square checkout.
  reg = await ensureCheckout(env, reg, baseUrlFor(env, url));

  ctx.waitUntil(notifyNewRegistration(env, reg));
  return json(publicResult(reg), 201);
}

function baseUrlFor(env, url) {
  return (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, '');
}

function publicResult(reg) {
  const out = { registration_id: reg.id, payment_status: reg.payment_status };
  if (reg.payment_status === 'pending_payment' || reg.payment_status === 'failed') {
    if (reg.checkout_url) out.checkout_url = reg.checkout_url;
    else out.payment_notice = 'Your registration is saved, but we could not open the payment page. Our team will email you a payment link.';
  }
  return out;
}

async function ensureCheckout(env, reg, baseUrl) {
  if (reg.scholarship_requested) return reg;
  if (reg.payment_status !== 'pending_payment' && reg.payment_status !== 'failed') return reg;
  if (reg.checkout_url) return reg;

  const result = await createPaymentLink(env, reg, baseUrl);
  const now = new Date().toISOString();
  if (result.ok) {
    await env.DB
      .prepare('UPDATE registrations SET checkout_url=?1, square_payment_link_id=?2, square_order_id=?3, payment_error=NULL, updated_at=?4 WHERE id=?5')
      .bind(result.url, result.linkId, result.orderId, now, reg.id)
      .run();
    return { ...reg, checkout_url: result.url, square_payment_link_id: result.linkId, square_order_id: result.orderId, payment_error: null };
  }
  await env.DB.prepare('UPDATE registrations SET payment_error=?1, updated_at=?2 WHERE id=?3').bind(result.error, now, reg.id).run();
  return { ...reg, payment_error: result.error };
}

async function throttle(env, ipHash, limit) {
  const since = Date.now() - RATE_WINDOW_MS;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE ip_hash=?1 AND at>?2').bind(ipHash, since).first();
  if (row && row.n >= limit) return true;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rate_events (ip_hash, at) VALUES (?1, ?2)').bind(ipHash, Date.now()),
    env.DB.prepare('DELETE FROM rate_events WHERE at < ?1').bind(since - RATE_WINDOW_MS),
  ]);
  return false;
}

// ---------------------------------------------------------------- Square

function squareBase(env) {
  if (env.SQUARE_API_BASE) return env.SQUARE_API_BASE; // used only by local tests
  return env.SQUARE_ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
}
function squareHeaders(env) {
  return {
    authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
    'content-type': 'application/json',
    'square-version': env.SQUARE_VERSION || '2024-12-18',
  };
}

async function createPaymentLink(env, reg, baseUrl) {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return { ok: false, error: 'Square is not configured' };
  try {
    let result = await requestPaymentLink(env, reg, baseUrl, true);
    // Square refuses some email addresses. Never let that block a family from paying: retry without prefilling it.
    if (!result.ok && result.code === 'INVALID_EMAIL_ADDRESS') {
      result = await requestPaymentLink(env, reg, baseUrl, false);
    }
    return result;
  } catch (err) {
    console.error('Square request error', err && err.message);
    return { ok: false, error: 'Square request failed' };
  }
}

async function requestPaymentLink(env, reg, baseUrl, prefillEmail) {
  const body = {
    // A different key for the retry, because Square rejects one key reused with a changed request.
    idempotency_key: prefillEmail ? reg.id : `${reg.id}-b`,
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      reference_id: reg.id,
      line_items: [{
        name: ITEM_NAME,
        quantity: '1',
        note: reg.id,
        // Price comes from the server constant, never from the browser.
        base_price_money: { amount: FEE_CENTS, currency: 'USD' },
      }],
    },
    checkout_options: {
      redirect_url: `${baseUrl}/tcffl-registration/?returned=1&ref=${encodeURIComponent(reg.id)}`,
      ask_for_shipping_address: false,
    },
    payment_note: `TCFFL ${reg.id}`,
  };
  if (prefillEmail) body.pre_populated_data = { buyer_email: reg.email };
  const res = await fetch(`${squareBase(env)}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: squareHeaders(env),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment_link) {
    const code = data.errors && data.errors[0] && data.errors[0].code;
    console.error('Square payment link failed', res.status, code);
    return { ok: false, code, error: `Square ${res.status}${code ? ' ' + code : ''}` };
  }
  const link = data.payment_link;
  return { ok: true, url: link.url || link.long_url, linkId: link.id, orderId: link.order_id };
}

async function squareGet(env, path) {
  const res = await fetch(`${squareBase(env)}${path}`, { headers: squareHeaders(env) });
  if (!res.ok) throw new Error(`Square GET ${path} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- Square webhooks

async function handleWebhook(request, env, ctx, url) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) return json({ error: 'Webhook not configured' }, 503);

  const raw = await request.text();
  const signature = request.headers.get('x-square-hmacsha256-signature') || '';
  // Square signs: notification URL (exactly as registered in Square) + raw body.
  const notificationUrl = env.SQUARE_WEBHOOK_URL || `${url.origin}${url.pathname}`;
  const expected = await hmacBase64(env.SQUARE_WEBHOOK_SIGNATURE_KEY, notificationUrl + raw);
  if (!signature || !(await safeEqual(signature, expected))) return json({ error: 'Invalid signature' }, 401);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Invalid body' }, 400); }
  if (!event || !event.event_id || !event.type) return json({ error: 'Invalid event' }, 400);

  // Square retries; process each event only once.
  const ins = await env.DB
    .prepare('INSERT OR IGNORE INTO webhook_events (event_id, type, received_at) VALUES (?1, ?2, ?3)')
    .bind(event.event_id, event.type, new Date().toISOString())
    .run();
  if (ins.meta && ins.meta.changes === 0) return json({ ok: true, duplicate: true });

  try {
    const note = await processSquareEvent(env, ctx, event);
    if (note) await env.DB.prepare('UPDATE webhook_events SET note=?1 WHERE event_id=?2').bind(note, event.event_id).run();
  } catch (err) {
    // Let Square retry later: forget the dedupe row and return 500.
    await env.DB.prepare('DELETE FROM webhook_events WHERE event_id=?1').bind(event.event_id).run();
    console.error('Webhook processing failed', event.type, err && err.message);
    return json({ error: 'Processing failed' }, 500);
  }
  return json({ ok: true });
}

async function processSquareEvent(env, ctx, event) {
  const now = new Date().toISOString();

  if (event.type === 'payment.created' || event.type === 'payment.updated') {
    const paymentId = (event.data && event.data.id) || (event.data && event.data.object && event.data.object.payment && event.data.object.payment.id);
    if (!paymentId) return 'no payment id';
    // Do not trust the webhook body for money: re-read the payment from Square.
    const { payment } = await squareGet(env, `/v2/payments/${encodeURIComponent(paymentId)}`);
    if (!payment || !payment.order_id) return 'payment without order';
    const reg = await env.DB.prepare('SELECT * FROM registrations WHERE square_order_id=?1').bind(payment.order_id).first();
    if (!reg) return 'no matching registration';
    if (env.SQUARE_LOCATION_ID && payment.location_id && payment.location_id !== env.SQUARE_LOCATION_ID) return 'location mismatch';

    if (payment.status === 'COMPLETED') {
      const amount = payment.amount_money || {};
      if (amount.amount !== FEE_CENTS || amount.currency !== 'USD') return `amount mismatch ${amount.amount} ${amount.currency}`;
      const r = await env.DB
        .prepare("UPDATE registrations SET payment_status='paid', square_payment_id=?1, paid_at=?2, updated_at=?2 WHERE id=?3 AND payment_status NOT IN ('paid','refunded','partial_refund')")
        .bind(payment.id, now, reg.id)
        .run();
      if (r.meta && r.meta.changes > 0) ctx.waitUntil(notifyPaid(env, { ...reg, payment_status: 'paid' }));
      return 'paid';
    }
    if (payment.status === 'FAILED' || payment.status === 'CANCELED') {
      await env.DB
        .prepare("UPDATE registrations SET payment_status='failed', updated_at=?1 WHERE id=?2 AND payment_status='pending_payment'")
        .bind(now, reg.id)
        .run();
      return `payment ${payment.status}`;
    }
    return `ignored status ${payment.status}`;
  }

  if (event.type === 'refund.created' || event.type === 'refund.updated') {
    const refund = event.data && event.data.object && event.data.object.refund;
    if (!refund || refund.status !== 'COMPLETED' || !refund.payment_id) return 'refund not completed';
    const full = refund.amount_money && refund.amount_money.amount >= FEE_CENTS;
    await env.DB
      .prepare('UPDATE registrations SET payment_status=?1, updated_at=?2 WHERE square_payment_id=?3')
      .bind(full ? 'refunded' : 'partial_refund', now, refund.payment_id)
      .run();
    return full ? 'refunded' : 'partial refund';
  }

  return 'ignored event type';
}

// ---------------------------------------------------------------- email (optional, via Resend)

async function sendEmail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.log('Email not configured; skipped:', subject);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, reply_to: env.ADMIN_NOTIFY_EMAIL || DEFAULT_ADMIN_EMAIL }),
    });
    if (!res.ok) console.error('Email send failed', res.status);
    return res.ok;
  } catch (err) {
    console.error('Email error', err && err.message);
    return false;
  }
}

const FOOTER = '\nQuestions? Reply to this email or contact info@gcoys.org / 404-483-6378.\nGeorgia Council of Youth Sports - TCFFL';

// Emails carry only the reference and basic contact details - never medical information.
async function notifyNewRegistration(env, reg) {
  const adminTo = env.ADMIN_NOTIFY_EMAIL || DEFAULT_ADMIN_EMAIL;
  await sendEmail(env, {
    to: adminTo,
    subject: `New TCFFL registration ${reg.id}`,
    text: [
      `Reference: ${reg.id}`,
      `Player: ${reg.first_name} ${reg.last_name} (${reg.division})`,
      `Guardian: ${reg.guardian_name} <${reg.email}> ${reg.phone}`,
      `Status: ${reg.payment_status}${reg.scholarship_requested ? ' (scholarship requested - needs review)' : ''}`,
      reg.payment_error ? `PAYMENT LINK PROBLEM: ${reg.payment_error} - send the family a payment link manually.` : '',
      '',
      'Full details are in the admin export.',
    ].filter(Boolean).join('\n'),
  });

  const lines = [
    `Hello ${reg.guardian_name},`,
    '',
    `We received the TCFFL registration for ${reg.first_name} ${reg.last_name} (${reg.division}).`,
    `Your reference number is ${reg.id}. Please keep it for your records.`,
    '',
  ];
  if (reg.scholarship_requested) {
    lines.push('You asked about scholarship assistance. Our team will review your request and contact you.');
  } else if (reg.checkout_url) {
    lines.push(`The $${FEE_CENTS / 100} registration fee is due to complete registration. If you have not paid yet, use this secure link:`, reg.checkout_url);
  } else {
    lines.push(`The $${FEE_CENTS / 100} registration fee is due. We will email you a secure payment link shortly.`);
  }
  await sendEmail(env, { to: reg.email, subject: `TCFFL registration received (${reg.id})`, text: lines.join('\n') + '\n' + FOOTER });
}

async function notifyPaid(env, reg) {
  await sendEmail(env, {
    to: reg.email,
    subject: `TCFFL payment received (${reg.id})`,
    text: [`Hello ${reg.guardian_name},`, '', `We received your $${FEE_CENTS / 100} payment for ${reg.first_name} ${reg.last_name}. Registration reference: ${reg.id}.`, FOOTER].join('\n'),
  });
  await sendEmail(env, {
    to: env.ADMIN_NOTIFY_EMAIL || DEFAULT_ADMIN_EMAIL,
    subject: `TCFFL payment received ${reg.id}`,
    text: `Payment confirmed by Square for ${reg.id} (${reg.first_name} ${reg.last_name}).`,
  });
}

// ---------------------------------------------------------------- admin export

const ADMIN_COLUMNS = [
  'id', 'created_at', 'payment_status', 'scholarship_requested', 'paid_at', 'payment_error',
  'first_name', 'last_name', 'dob', 'division', 'grade', 'school', 'jersey_size',
  'guardian_name', 'email', 'phone', 'address',
  'emergency_name', 'emergency_relationship', 'emergency_phone',
  'experience', 'position', 'team_request',
  'media_permission', 'signature', 'signed_date', 'consent_version',
];
const MEDICAL_COLUMNS = ['medical', 'accommodations'];

async function handleAdmin(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });

  const ipHash = await sha256Hex((request.headers.get('cf-connecting-ip') || 'unknown') + ':admin');
  const since = Date.now() - RATE_WINDOW_MS;
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE ip_hash=?1 AND at>?2').bind(ipHash, since).first();
  if (fails && fails.n >= ADMIN_FAIL_LIMIT) return json({ error: 'Too many attempts' }, 429, { 'retry-after': '600' });

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const isAdmin = !!(env.ADMIN_TOKEN && token && (await safeEqual(token, env.ADMIN_TOKEN)));
  const isMedical = !!(env.MEDICAL_ADMIN_TOKEN && token && (await safeEqual(token, env.MEDICAL_ADMIN_TOKEN)));
  if (!isAdmin && !isMedical) {
    await env.DB.prepare('INSERT INTO rate_events (ip_hash, at) VALUES (?1, ?2)').bind(ipHash, Date.now()).run();
    return json({ error: 'Unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }

  const columns = isMedical ? [...ADMIN_COLUMNS, ...MEDICAL_COLUMNS] : ADMIN_COLUMNS;
  const { results } = await env.DB
    .prepare(`SELECT ${columns.join(',')} FROM registrations ORDER BY created_at DESC LIMIT 5000`)
    .all();

  if (url.searchParams.get('format') === 'csv') {
    return new Response(toCsv(results, columns), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="tcffl-registrations.csv"',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  return json({ count: results.length, includes_medical: isMedical, columns, registrations: results });
}

function toCsv(rows, columns) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
