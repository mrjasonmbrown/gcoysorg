// Hostname routing test (no network). Run: node test/routing.mjs
import worker from '../src/worker.js';
let fails = 0;
const seen = [];
const env = { ASSETS: { fetch: (req) => { const u = new URL(req.url); seen.push(u.pathname + u.search); return new Response('asset:' + u.pathname + u.search); } } };
async function check(url, want) {
  seen.length = 0;
  const res = await worker.fetch(new Request(url), env, { waitUntil() {} });
  const got = res.status === 301 ? '301 ' + res.headers.get('location') : await res.text();
  const pass = got === want;
  if (!pass) fails++;
  console.log((pass ? '  ok  ' : '  FAIL ') + url + ' -> ' + got + (pass ? '' : '   (wanted ' + want + ')'));
}
await check('https://tcffl.gcoys.org/', 'asset:/tcffl/');
await check('https://tcffl.gcoys.org/register', 'asset:/tcffl-registration/');
await check('https://tcffl.gcoys.org/register/?returned=1&ref=TCFFL-2026-ABC', 'asset:/tcffl-registration/?returned=1&ref=TCFFL-2026-ABC');
await check('https://tcffl.gcoys.org/img/gcys-logo.png', 'asset:/img/gcys-logo.png');
await check('https://tcffl.gcoys.org/tcffl-registration/?returned=1', '301 /register/?returned=1');
await check('https://tcffl.gcoys.org/tcffl/', '301 /');
await check('https://gcoys.org/', 'asset:/');
await check('https://gcoys.org/tcffl-registration/', '301 https://tcffl.gcoys.org/register/');
await check('https://www.gcoys.org/tcffl-registration/?returned=1&ref=X', '301 https://tcffl.gcoys.org/register/?returned=1&ref=X');
await check('https://gcoys.org/tcffl/', '301 https://tcffl.gcoys.org/');
await check('https://gcoysorg.mrjasonmbrown.workers.dev/tcffl-registration/', 'asset:/tcffl-registration/');
const api = await worker.fetch(new Request('https://tcffl.gcoys.org/api/nope'), env, {});
if (api.status !== 404) { fails++; console.log('  FAIL api 404'); } else console.log('  ok  tcffl.gcoys.org/api/* still reaches the backend');
console.log(fails ? `\n${fails} failed` : '\nall routing checks passed');
process.exit(fails ? 1 : 0);
