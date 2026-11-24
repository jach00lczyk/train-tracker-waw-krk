import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, createState, parseKeys, TTL } from '../src/index.js';

const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/operation_enroute.json', import.meta.url), 'utf8'));
const KEY = '2026/607309466/2026-11-21';
const ORIGIN = 'https://jach00lczyk.github.io';
const SECRET = 'tajny-klucz-123';
const ENV = { ALLOWED_ORIGIN: ORIGIN, MAX_UPSTREAM_PER_HOUR: '30', PDP_API_KEY: SECRET };
const T0 = Date.parse('2026-11-21T07:50:00Z');

function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const body = store.get(req.url);
      return body ? new Response(body) : undefined;
    },
    async put(req, resp) {
      store.set(req.url, await resp.text());
    },
  };
}

/** Upstream: mapa ścieżka (sid/oid/data) → {status, body, headers}; domyślnie próbka dla KEY, inne 404. */
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key, opts) {
      const v = store.get(key);
      return v == null ? null : opts?.type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function setup({ routes = {}, env = ENV, kv = null } = {}) {
  const calls = [];
  const logs = [];
  let now = T0;
  const deps = {
    cache: fakeCache(),
    kv,
    now: () => now,
    log: (m) => logs.push(m),
    fetch: async (url, init) => {
      calls.push({ url, init });
      const key = url.split('/operations/train/')[1];
      const r = routes[key] ?? (key === KEY ? { status: 200, body: SAMPLE } : { status: 404, body: { error: 'x' } });
      if (r.throws) throw new Error('network');
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers ?? {} });
    },
  };
  const state = createState();
  const call = async (keys, origin = ORIGIN) => {
    const headers = origin ? { Origin: origin } : {};
    const resp = await handle(new Request(`https://w.example/live?t=${keys}`, { headers }), env, deps, state);
    return { resp, body: resp.status === 204 ? null : await resp.json() };
  };
  return { call, calls, logs, deps, state, advance: (ms) => (now += ms) };
}

const opBody = (key, status) => {
  const [sid, oid, date] = key.split('/');
  return { scheduleId: Number(sid), orderId: Number(oid), operatingDate: date, trainStatus: status, stations: [] };
};

test('allowed origin gets data with CORS and no-store', async () => {
  const { call, calls } = setup();
  const { resp, body } = await call(KEY);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(resp.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://pdp-api.plk-sa.pl/api/v1/operations/train/${KEY}`);
  assert.equal(calls[0].init.headers['X-API-Key'], SECRET);
  const t = body.trains[KEY];
  assert.equal(t.state, 'ok');
  assert.equal(t.train_status, 'P');
  assert.equal(t.checked_at, '2026-11-21T07:50:00Z');
  assert.deepEqual(t.stops[0], { id: 33605, aa: null, ad: '2026-11-21T08:10:00', cf: true, cx: false });
  assert.equal(t.stops.length, 4);
  assert.equal(body.fetched_at, '2026-11-21T07:50:00Z');
});

test('foreign or missing origin is forbidden', async () => {
  const { call, calls } = setup();
  assert.equal((await call(KEY, 'https://evil.example')).resp.status, 403);
  assert.equal((await call(KEY, null)).resp.status, 403);
  assert.equal(calls.length, 0);
});

test('several allowed origins (local development)', async () => {
  const { call } = setup({ env: { ...ENV, ALLOWED_ORIGIN: `${ORIGIN}, http://localhost:8000` } });
  const { resp } = await call(KEY, 'http://localhost:8000');
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
});

test('404 upstream means none (normal state) and is cached 10 min', async () => {
  const k = '2026/1/2026-11-21';
  const { call, calls, advance } = setup();
  assert.deepEqual((await call(k)).body.trains[k], { state: 'none' });
  advance((TTL.none - 1) * 1000);
  await call(k);
  assert.equal(calls.length, 1);
  advance(2000);
  await call(k);
  assert.equal(calls.length, 2);
});

test('key validation', async () => {
  const { call, calls } = setup();
  for (const bad of ['abc', ',', '2026/1/2026-13-01', '2026/1/2026-02-30', '2026/1', `${KEY},x`, '1/2/2026-01-01/3']) {
    assert.equal((await call(encodeURIComponent(bad))).resp.status, 400, bad);
  }
  const many = Array.from({ length: 31 }, (_, i) => `2026/${i + 1}/2026-11-21`).join(',');
  assert.equal((await call(many)).resp.status, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(parseKeys(`${KEY},${KEY}`), [KEY]);
});

test('other paths 404', async () => {
  const { deps, state } = setup();
  const r = await handle(new Request('https://w.example/x', { headers: { Origin: ORIGIN } }), ENV, deps, state);
  assert.equal(r.status, 404);
});

test('TTL depends on train status', async () => {
  const cases = { C: TTL.done, F: TTL.done, X: TTL.done, P: TTL.running, S: TTL.waiting, N: TTL.waiting };
  for (const [status, ttl] of Object.entries(cases)) {
    const k = `2026/77/2026-11-21`;
    const { call, calls, advance } = setup({ routes: { [k]: { status: 200, body: opBody(k, status) } } });
    await call(k);
    advance((ttl - 1) * 1000);
    await call(k);
    assert.equal(calls.length, 1, `${status} still cached`);
    advance(2000);
    await call(k);
    assert.equal(calls.length, 2, `${status} expired`);
  }
});

test('5xx is an error cached for 30 s', async () => {
  const k = '2026/5/2026-11-21';
  const { call, calls, advance } = setup({ routes: { [k]: { status: 503 } } });
  assert.deepEqual((await call(k)).body.trains[k], { state: 'error', http: 503 });
  advance(29_000);
  await call(k);
  assert.equal(calls.length, 1);
  advance(2000);
  await call(k);
  assert.equal(calls.length, 2);
});

test('network error is reported as http 0', async () => {
  const k = '2026/6/2026-11-21';
  const { call } = setup({ routes: { [k]: { throws: true } } });
  assert.deepEqual((await call(k)).body.trains[k], { state: 'error', http: 0 });
});

test('upstream 429 pauses all upstream calls until Retry-After', async () => {
  const a = '2026/8/2026-11-21';
  const b = '2026/9/2026-11-21';
  const { call, calls, advance } = setup({ routes: { [a]: { status: 429, headers: { 'Retry-After': '120' } } } });
  assert.deepEqual((await call(a)).body.trains[a], { state: 'error', http: 429 });
  assert.deepEqual((await call(b)).body.trains[b], { state: 'error', http: 429 });
  assert.equal(calls.length, 1);
  advance(121_000);
  await call(b);
  assert.equal(calls.length, 2);
});

test('upstream 429 without Retry-After pauses 5 min', async () => {
  const a = '2026/8/2026-11-21';
  const b = '2026/9/2026-11-21';
  const { call, calls, advance } = setup({ routes: { [a]: { status: 429 } } });
  await call(a);
  advance(299_000);
  await call(b);
  assert.equal(calls.length, 1);
  advance(2000);
  await call(b);
  assert.equal(calls.length, 2);
});

test('hourly upstream limit, nearest (first) keys win', async () => {
  const env = { ...ENV, MAX_UPSTREAM_PER_HOUR: '3' };
  const { call, calls, advance } = setup({ env });
  const keys = Array.from({ length: 5 }, (_, i) => `2026/${100 + i}/2026-11-21`);
  const { body } = await call(keys.join(','));
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(body.trains), keys);
  assert.deepEqual(body.trains[keys[0]], { state: 'none' });
  assert.deepEqual(body.trains[keys[3]], { state: 'error', http: 429 });
  assert.deepEqual(body.trains[keys[4]], { state: 'error', http: 429 });
  // cache nie zużywa limitu
  await call(keys.slice(0, 3).join(','));
  assert.equal(calls.length, 3);
  advance(3600_001);
  await call(keys[4]);
  assert.equal(calls.length, 4);
});

test('when limited, last good data is returned instead of an error', async () => {
  const env = { ...ENV, MAX_UPSTREAM_PER_HOUR: '1' };
  const { call, calls, advance } = setup({ env });
  await call(KEY);
  advance((TTL.running + 1) * 1000);
  const { body } = await call(KEY);
  assert.equal(calls.length, 1);
  assert.equal(body.trains[KEY].state, 'ok');
  assert.equal(body.trains[KEY].checked_at, '2026-11-21T07:50:00Z');
  const other = '2026/1/2026-11-21';
  assert.deepEqual((await call(other)).body.trains[other], { state: 'error', http: 429 });
});

test('default hourly limit is 30 (key shared with karoo-kolejka)', async () => {
  const { call, calls } = setup({ env: { ALLOWED_ORIGIN: ORIGIN, PDP_API_KEY: SECRET } });
  const keys = Array.from({ length: 30 }, (_, i) => `2026/${200 + i}/2026-11-21`);
  await call(keys.join(','));
  await call('2026/999/2026-11-21');
  assert.equal(calls.length, 30);
});

test('response about another train is rejected', async () => {
  const k = '2026/555/2026-11-21';
  const wrongOrder = { ...opBody(k, 'P'), orderId: 556 };
  const wrongDate = { ...opBody(k, 'P'), operatingDate: '2026-11-20' };
  for (const body of [wrongOrder, wrongDate]) {
    const { call } = setup({ routes: { [k]: { status: 200, body } } });
    assert.deepEqual((await call(k)).body.trains[k], { state: 'error', http: 502 });
  }
});

test('API key never in responses or logs, upstream headers not forwarded', async () => {
  const k404 = '2026/1/2026-11-21';
  const { call, logs } = setup({
    routes: { [KEY]: { status: 200, body: SAMPLE, headers: { 'X-RateLimit-Hourly-Remaining': '42', 'Set-Cookie': 'a=b' } } },
  });
  const { resp, body } = await call(`${KEY},${k404}`);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(SECRET));
  for (const [name, value] of resp.headers) {
    assert.ok(!value.includes(SECRET), name);
    assert.ok(!/ratelimit|set-cookie/i.test(name), name);
  }
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !l.includes(SECRET)));
});

test('preflight OPTIONS', async () => {
  const { deps, state } = setup();
  const r = await handle(new Request(`https://w.example/live`, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), ENV, deps, state);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('real recon sample: omitted isConfirmed/isCancelled mean false', async () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/recon/operation_w.json', import.meta.url), 'utf8'));
  const key = `${real.scheduleId}/${real.orderId}/${real.operatingDate}`;
  const { call } = setup({ routes: { [key]: { status: 200, body: real } } });
  const t = (await call(key)).body.trains[key];
  assert.equal(t.state, 'ok');
  assert.equal(t.train_status, 'P');
  assert.equal(t.stops.length, real.stations.length);
  assert.deepEqual(t.stops[0], { id: 80416, aa: null, ad: '2026-11-21T13:43:00', cf: true, cx: false });
  assert.ok(t.stops.slice(1).every((s) => s.cf === false && s.cx === false));
});

// --------------------------------------------------------------------------- wspólne przypięte pociągi (SPEC 5.5)

const putPin = (deps, state, body, origin = ORIGIN) =>
  handle(new Request('https://w.example/pin', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), ENV, deps, state);

test('pins: empty t returns only the shared pins, no upstream calls', async () => {
  const kv = fakeKv();
  const { call, calls } = setup({ kv });
  let { resp, body } = await call('');
  assert.equal(resp.status, 200);
  assert.deepEqual(body.trains, {});
  assert.deepEqual(body.pins, { krk: null, waw: null });
  kv.store.set('pin:waw', JSON.stringify({ key: KEY, at: '2026-11-21T07:00:00Z' }));
  ({ body } = await call(KEY));
  assert.deepEqual(body.pins, { krk: null, waw: { key: KEY, at: '2026-11-21T07:00:00Z' } });
  assert.equal(calls.length, 1);
});

test('pins: without KV binding the field is omitted and PUT is unavailable', async () => {
  const { call, deps, state } = setup();
  const { body } = await call('');
  assert.equal('pins' in body, false);
  assert.equal((await putPin(deps, state, { dir: 'krk', key: KEY })).status, 503);
});

test('pins: PUT stores key per direction with server time, null clears; validation and CORS', async () => {
  const kv = fakeKv();
  const { call, deps, state } = setup({ kv });
  const r = await putPin(deps, state, { dir: 'krk', key: KEY });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await r.json(), { dir: 'krk', pin: { key: KEY, at: '2026-11-21T07:50:00Z' } });
  const KEY2 = '2026/607300001/2026-11-21';
  assert.equal((await putPin(deps, state, { dir: 'waw', key: KEY2 })).status, 200);
  assert.deepEqual((await call('')).body.pins, {
    krk: { key: KEY, at: '2026-11-21T07:50:00Z' },
    waw: { key: KEY2, at: '2026-11-21T07:50:00Z' },
  });
  // odpięcie jednego kierunku nie rusza drugiego
  assert.equal((await putPin(deps, state, { dir: 'krk', key: null })).status, 200);
  const { pins } = (await call('')).body;
  assert.equal(pins.krk.key, null);
  assert.equal(pins.waw.key, KEY2);
  for (const bad of [{ dir: 'krk', key: 'abc' }, { dir: 'krk', key: 5 }, { key: KEY }, { dir: 'gdy', key: KEY },
    'nie-json', JSON.stringify({ dir: 'krk', key: 'x'.repeat(300) })]) {
    assert.equal((await putPin(deps, state, bad)).status, 400);
  }
  assert.equal((await putPin(deps, state, { dir: 'krk', key: KEY }, 'https://evil.example')).status, 403);
  const get = await handle(new Request('https://w.example/pin', { headers: { Origin: ORIGIN } }), ENV, deps, state);
  assert.equal(get.status, 405);
});

test('pins: writes limited per hour (both directions together)', async () => {
  const { deps, state, advance } = setup({ kv: fakeKv() });
  for (let i = 0; i < 60; i++) assert.equal((await putPin(deps, state, { dir: i % 2 ? 'krk' : 'waw', key: KEY })).status, 200);
  assert.equal((await putPin(deps, state, { dir: 'krk', key: KEY })).status, 429);
  advance(3600_000);
  assert.equal((await putPin(deps, state, { dir: 'krk', key: KEY })).status, 200);
});

test('preflight allows PUT with JSON', async () => {
  const { deps, state } = setup();
  const r = await handle(new Request('https://w.example/pin', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), ENV, deps, state);
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Methods'), /PUT/);
  assert.equal(r.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
});
