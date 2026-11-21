// Pośrednik opóźnień na żywo (SPEC 4): GET /live?t=<sid>/<oid>/<data>,…
// oraz wspólny przypięty pociąg (SPEC 5.5): pole `pin` w odpowiedzi /live, zapis PUT /pin (Workers KV).
// Trzyma klucz PDP_API_KEY (sekret Workera) — klucz nigdy nie trafia do odpowiedzi ani logów.
// Strategia upstream B: /api/v1/operations/train/{sid}/{oid}/{data} per kurs, z cache i limitem.
// Zero zależności runtime.

const UPSTREAM = 'https://pdp-api.plk-sa.pl/api/v1/operations/train';
const MAX_KEYS = 30;
const HOUR_MS = 3600_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const KEY_RE = /^(\d{1,6})\/(\d{1,12})\/(\d{4}-\d{2}-\d{2})$/;

// TTL cache (s) wg stanu kursu — SPEC 4.3.
export const TTL = {
  done: 6 * 3600, // C/F zakończony, X odwołany
  running: 60, // P w drodze (i Q)
  waiting: 120, // S/N nie wyruszył
  none: 600, // 404 — brak wykonania w PLK
  error: 30, // 5xx, sieć, inne
};
const DEFAULT_RETRY_AFTER_S = 300;
const PIN_KV_KEY = 'pin';
const MAX_PIN_WRITES_PER_HOUR = 60; // limit KV (darmowy: 1000 zapisów/dobę) — z zapasem
const MAX_PIN_BODY = 200;

export function ttlFor(entry) {
  if (entry.state === 'none') return TTL.none;
  if (entry.state === 'error') return TTL.error;
  const s = entry.train_status;
  if (s === 'C' || s === 'F' || s === 'X') return TTL.done;
  if (s === 'S' || s === 'N') return TTL.waiting;
  return TTL.running;
}

/** Stan izolatu: limit godzinowy i wstrzymanie po 429 (best effort, SPEC 13). */
export function createState() {
  return { requests: [], pausedUntil: 0, pinWrites: [] };
}

export function validKey(k) {
  const m = KEY_RE.exec(k);
  if (!m) return false;
  const d = new Date(m[3] + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === m[3];
}

/** Lista kursów z `t`; brak/pusty `t` = [] (strona pyta tylko o przypięty pociąg); null = błędne. */
export function parseKeys(param) {
  if (param == null || param === '') return [];
  const keys = [...new Set(param.split(','))];
  if (keys.length === 0 || keys.length > MAX_KEYS) return null;
  return keys.every(validKey) ? keys : null;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function json(body, status, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Odpowiedź PLK → wpis kontraktu 4.1; null, gdy dotyczy innego kursu albo jest nieczytelna. */
export function parseOperation(body, key, nowMs) {
  const [sid, oid, date] = key.split('/');
  if (!body || typeof body !== 'object') return null;
  if (String(body.scheduleId) !== sid || String(body.orderId) !== oid) return null;
  if (body.operatingDate != null && String(body.operatingDate).slice(0, 10) !== date) return null;
  const stations = Array.isArray(body.stations) ? body.stations : [];
  return {
    state: 'ok',
    checked_at: iso(nowMs),
    train_status: typeof body.trainStatus === 'string' ? body.trainStatus : null,
    stops: stations
      .filter((s) => s && Number.isFinite(Number(s.stationId)))
      .map((s) => ({
        id: Number(s.stationId),
        aa: typeof s.actualArrival === 'string' ? s.actualArrival : null,
        ad: typeof s.actualDeparture === 'string' ? s.actualDeparture : null,
        cf: s.isConfirmed === true,
        cx: s.isCancelled === true,
      })),
  };
}

function cacheRequest(key) {
  return new Request(`https://cache.train-tracker.internal/op/${key}`);
}

async function cacheRead(cache, name, nowMs) {
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheRequest(name));
    if (!hit) return null;
    const stored = await hit.json();
    return stored.expires > nowMs ? stored.entry : null;
  } catch {
    return null;
  }
}

async function cacheWrite(cache, name, entry, ttl, nowMs) {
  if (!cache) return;
  try {
    await cache.put(
      cacheRequest(name),
      new Response(JSON.stringify({ expires: nowMs + ttl * 1000, entry }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    );
  } catch {
    // cache to tylko optymalizacja
  }
}

const cacheGet = (cache, key, nowMs) => cacheRead(cache, key, nowMs);
// Ostatnie udane dane kursu — zwracane zamiast błędu, gdy limit zapytań się wyczerpie
// (strona sama odrzuca dane starsze niż 35 min po `checked_at`).
const lastGoodGet = (cache, key, nowMs) => cacheRead(cache, `last/${key}`, nowMs);

async function cachePut(cache, key, entry, nowMs) {
  await cacheWrite(cache, key, entry, ttlFor(entry), nowMs);
  if (entry.state === 'ok') await cacheWrite(cache, `last/${key}`, entry, TTL.done, nowMs);
}

function budgetLeft(state, env, nowMs) {
  const max = Number.parseInt(env.MAX_UPSTREAM_PER_HOUR, 10) || 30;
  state.requests = state.requests.filter((t) => nowMs - t < HOUR_MS);
  return Math.max(0, max - state.requests.length);
}

async function fetchUpstream(key, env, deps, state) {
  const nowMs = deps.now();
  let resp;
  try {
    resp = await deps.fetch(`${UPSTREAM}/${key}`, {
      headers: { 'X-API-Key': env.PDP_API_KEY || '', Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { entry: { state: 'error', http: 0 }, cache: true };
  }
  if (resp.status === 404) return { entry: { state: 'none' }, cache: true };
  if (resp.status === 429) {
    const ra = Number.parseInt(resp.headers.get('Retry-After') || '', 10);
    state.pausedUntil = nowMs + (Number.isFinite(ra) && ra > 0 ? ra : DEFAULT_RETRY_AFTER_S) * 1000;
    return { entry: { state: 'error', http: 429 }, cache: false };
  }
  if (!resp.ok) return { entry: { state: 'error', http: resp.status }, cache: true };
  let body;
  try {
    body = await resp.json();
  } catch {
    return { entry: { state: 'error', http: 502 }, cache: true };
  }
  const entry = parseOperation(body, key, nowMs);
  if (!entry) return { entry: { state: 'error', http: 502 }, cache: true };
  return { entry, cache: true };
}

// --------------------------------------------------------------------------- przypięty pociąg

/** {key, at} albo null; brak KV (np. testy lokalne bez wiązania) → undefined = pole pomijane. */
async function pinRead(kv) {
  if (!kv) return undefined;
  try {
    const v = await kv.get(PIN_KV_KEY, { type: 'json' });
    return v && (v.key === null || validKey(v.key)) ? { key: v.key, at: v.at } : null;
  } catch {
    return undefined;
  }
}

async function handlePin(request, env, deps, state, origin) {
  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405, origin);
  if (!deps.kv) return json({ error: 'unavailable' }, 503, origin);
  const nowMs = deps.now();
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_PIN_BODY) throw new Error('size');
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  const key = body?.key ?? null;
  if (key !== null && (typeof key !== 'string' || !validKey(key))) return json({ error: 'bad_request' }, 400, origin);
  state.pinWrites = state.pinWrites.filter((t) => nowMs - t < HOUR_MS);
  if (state.pinWrites.length >= MAX_PIN_WRITES_PER_HOUR) return json({ error: 'rate_limited' }, 429, origin);
  state.pinWrites.push(nowMs);
  const pin = { key, at: iso(nowMs) };
  try {
    await deps.kv.put(PIN_KV_KEY, JSON.stringify(pin));
  } catch {
    return json({ error: 'storage' }, 502, origin);
  }
  deps.log(`pin ${key ? 'set' : 'cleared'}`);
  return json({ pin }, 200, origin);
}

// --------------------------------------------------------------------------- wejście

export async function handle(request, env, deps, state) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);
  const okOrigin = origin && allowed.includes(origin) ? origin : null;

  if (request.method === 'OPTIONS') {
    if (!okOrigin) return json({ error: 'forbidden' }, 403, null);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': okOrigin,
        'Access-Control-Allow-Methods': 'GET, PUT',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    });
  }
  if (!okOrigin) return json({ error: 'forbidden' }, 403, null);
  if (url.pathname === '/pin') return handlePin(request, env, deps, state, okOrigin);
  if (url.pathname !== '/live') return json({ error: 'not_found' }, 404, okOrigin);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, okOrigin);

  const keys = parseKeys(url.searchParams.get('t'));
  if (!keys) return json({ error: 'bad_request' }, 400, okOrigin);

  const nowMs = deps.now();
  const trains = {};
  const missing = [];
  for (const key of keys) {
    const hit = await cacheGet(deps.cache, key, nowMs);
    if (hit) trains[key] = hit;
    else missing.push(key);
  }

  // Kolejność od strony = najbliższe odjazdy pierwsze; przy niedoborze obcinamy najdalsze.
  const toFetch = [];
  for (const key of missing) {
    if (state.pausedUntil > nowMs || budgetLeft(state, env, nowMs) === 0) {
      trains[key] = (await lastGoodGet(deps.cache, key, nowMs)) || { state: 'error', http: 429 };
      continue;
    }
    state.requests.push(nowMs);
    toFetch.push(key);
  }
  const results = await Promise.all(toFetch.map((key) => fetchUpstream(key, env, deps, state)));
  for (let i = 0; i < toFetch.length; i++) {
    const { entry, cache } = results[i];
    trains[toFetch[i]] = entry;
    if (cache) await cachePut(deps.cache, toFetch[i], entry, nowMs);
  }

  deps.log(
    `live keys=${keys.length} cached=${keys.length - missing.length} upstream=${toFetch.length} ` +
      `budget=${budgetLeft(state, env, nowMs)}${state.pausedUntil > nowMs ? ' paused' : ''}`,
  );
  const ordered = {};
  for (const key of keys) ordered[key] = trains[key];
  const out = { fetched_at: iso(nowMs), trains: ordered };
  const pin = await pinRead(deps.kv);
  if (pin !== undefined) out.pin = pin;
  return json(out, 200, okOrigin);
}

const isolateState = createState();

export default {
  async fetch(request, env) {
    const deps = {
      fetch: (...a) => fetch(...a),
      cache: typeof caches !== 'undefined' ? caches.default : null,
      now: () => Date.now(),
      log: (msg) => console.log(msg),
      kv: env.STATE || null, // Workers KV na wspólny przypięty pociąg (wrangler.toml)
    };
    try {
      return await handle(request, env, deps, isolateState);
    } catch {
      return json({ error: 'internal' }, 500, null);
    }
  },
};
