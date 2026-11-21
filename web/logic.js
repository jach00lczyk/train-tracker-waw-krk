// Czysta logika domenowa strony (SPEC 5) — bez DOM, bez zegara systemowego.
// Każda funkcja zależna od czasu dostaje `now` (epoch ms). Strefa wyświetlania: Europe/Warsaw.
// Czasy z trains.json to epoch w sekundach; dane z Workera — czas lokalny bez offsetu.

export const TZ = 'Europe/Warsaw';
export const LIVE_MAX_AGE_MS = 35 * 60_000;
export const YESTERDAY_GRACE_MS = 30 * 60_000;
export const PIN_AFTER_ARRIVAL_MS = 15 * 60_000;
export const LIVE_SOON_MS = 3 * 3600_000;
export const LIVE_HORIZON_MS = 4 * 3600_000;
export const LIVE_RECENT_ARRIVAL_MS = 30 * 60_000;
export const MAX_LIVE_KEYS = 30;
export const STALE_REFRESH_MS = 60 * 60_000;

const MIN = 60_000;
const pad = (n) => String(n).padStart(2, '0');

// --------------------------------------------------------------------------- czas

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Składowe zegara w Warszawie dla chwili `ms`. */
export function warsawParts(ms) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

export function warsawDate(ms) {
  const p = warsawParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function offsetMs(ms) {
  const p = warsawParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** „2026-11-21T08:10:00" (czas lokalny Europe/Warsaw, bez offsetu) → epoch ms; null przy złym formacie. */
export function localToMs(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(str || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = guess - offsetMs(guess);
  const o2 = offsetMs(t);
  if (o2 !== guess - t) t = guess - o2;
  return t;
}

export function fmtTime(ms) {
  const p = warsawParts(ms);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

const DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const DAYS_SHORT = ['ndz', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob'];
const MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia',
  'września', 'października', 'listopada', 'grudnia'];

function weekday(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** „środa, 18 listopada" */
export function dateLong(isoDate) {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${DAYS[weekday(isoDate)]}, ${d} ${MONTHS_GEN[m - 1]}`;
}

/** „śr 18.11" */
export function dateShort(isoDate) {
  const [, m, d] = isoDate.split('-');
  return `${DAYS_SHORT[weekday(isoDate)]} ${d}.${m}`;
}

// --------------------------------------------------------------------------- kierunek (5.2)

export function autoDir(now) {
  return warsawParts(now).h < 12 ? 'krk' : 'waw';
}

/** Ręczny wybór `{date, dir}` obowiązuje tylko w dniu, w którym go zrobiono. */
export function effectiveDir(stored, now) {
  if (stored && stored.date === warsawDate(now) && (stored.dir === 'krk' || stored.dir === 'waw')) return stored.dir;
  return autoDir(now);
}

// --------------------------------------------------------------------------- dane na żywo (5.3)

/** Świeży wpis Workera dla kursu albo null (brak, błąd, starszy niż 35 min). */
export function freshLive(entry, now) {
  if (!entry || (entry.state !== 'ok' && entry.state !== 'none')) return null;
  const at = entry.state === 'ok' ? Date.parse(entry.checked_at) : entry.at;
  if (!Number.isFinite(at) || now - at > LIVE_MAX_AGE_MS) return null;
  return entry;
}

const roundMin = (ms) => Math.round(ms / MIN);

/**
 * Stan pociągu: status, oczekiwane czasy, opóźnienia, ostatnia stacja, postęp.
 * `entry` — wpis z Workera (już przefiltrowany przez freshLive albo surowy — filtrujemy tu).
 */
export function trainState(train, entry, now, stations = {}) {
  const planDep = train.from.dep * 1000;
  const planArr = train.to.arr * 1000;
  const live = freshLive(entry, now);
  const base = { key: train.key, train, planDep, planArr, lastStation: null };

  if (!live || live.state === 'none') {
    const status = now >= planArr ? 'arrived' : now >= planDep ? 'enroute' : 'upcoming';
    return {
      ...base,
      status,
      source: live ? 'none-yet' : 'schedule',
      cancelled: false,
      expDep: planDep,
      expArr: planArr,
      depDelay: 0,
      arrDelay: 0,
      progress: status === 'enroute' ? progress(planDep, planArr, now) : null,
    };
  }

  const stops = Array.isArray(live.stops) ? live.stops : [];
  const fi = stops.findIndex((s) => s.id === train.from.id);
  const fromStop = fi >= 0 ? stops[fi] : null;
  const toStop = fi >= 0 ? stops.slice(fi + 1).find((s) => s.id === train.to.id) || null : null;
  const ts = live.train_status;

  const cancelled = ts === 'X' || !!fromStop?.cx || !!toStop?.cx;
  const liveDep = localToMs(fromStop?.ad) ?? localToMs(fromStop?.aa);
  const expDep = liveDep != null ? Math.max(planDep, liveDep) : planDep;
  const depDelay = Math.max(0, roundMin(expDep - planDep));
  const liveArr = localToMs(toStop?.aa) ?? localToMs(toStop?.ad);
  const expArr = liveArr ?? planArr + depDelay * MIN;
  const arrDelay = roundMin(expArr - planArr);

  let status;
  if (cancelled) status = 'cancelled';
  else if ((toStop?.aa && toStop.cf) || ts === 'C' || ts === 'F') status = 'arrived';
  else if ((fromStop?.ad && fromStop.cf) || (ts === 'P' && now >= expDep)) status = 'enroute';
  else status = 'upcoming';

  let lastStation = null;
  for (const s of stops) {
    if (s.cf && (s.aa || s.ad)) lastStation = stations[String(s.id)] ?? null;
  }

  return {
    ...base,
    status,
    source: 'live',
    cancelled,
    expDep,
    expArr,
    depDelay,
    arrDelay,
    lastStation: status === 'enroute' ? lastStation : null,
    progress: status === 'enroute' ? progress(expDep, expArr, now) : null,
  };
}

export function progress(dep, arr, now) {
  if (!(arr > dep)) return 0.5;
  return Math.min(0.97, Math.max(0.03, (now - dep) / (arr - dep)));
}

// --------------------------------------------------------------------------- listy (5.1)

export function hasToday(schedule, now) {
  const today = warsawDate(now);
  return !!schedule && Array.isArray(schedule.trains) && schedule.trains.some((t) => t.date === today);
}

/**
 * Lista „Dziś" w kierunku: pociągi z dziś + wczorajsze, które jeszcze jadą (przyjazd ≥ now − 30 min).
 * Zwraca grupy: arrived (schowane), enroute, upcoming (odwołane w miejscu wg planowego odjazdu).
 */
export function todayLists(schedule, dir, live, now) {
  const today = warsawDate(now);
  const yesterday = addDays(today, -1);
  const stations = schedule?.stations || {};
  const out = { arrived: [], enroute: [], upcoming: [] };
  for (const t of schedule?.trains || []) {
    if (t.dir !== dir || (t.date !== today && t.date !== yesterday)) continue;
    const st = trainState(t, live?.[t.key], now, stations);
    if (t.date === yesterday && st.expArr < now - YESTERDAY_GRACE_MS) continue;
    if (st.status === 'arrived') out.arrived.push(st);
    else if (st.status === 'enroute') out.enroute.push(st);
    else if (st.status === 'cancelled') (now < st.planDep ? out.upcoming : out.arrived).push(st);
    else out.upcoming.push(st);
  }
  const byPlan = (a, b) => a.planDep - b.planDep || a.key.localeCompare(b.key);
  out.arrived.sort(byPlan);
  out.enroute.sort(byPlan);
  out.upcoming.sort(byPlan);
  return out;
}

export function tomorrowList(schedule, dir, now) {
  const tomorrow = addDays(warsawDate(now), 1);
  return (schedule?.trains || [])
    .filter((t) => t.dir === dir && t.date === tomorrow)
    .sort((a, b) => a.from.dep - b.from.dep);
}

// --------------------------------------------------------------------------- przypięty (5.5)

export function canPin(st) {
  return !!st && !st.cancelled && (st.status === 'upcoming' || st.status === 'enroute');
}

/** Stan przypiętego pociągu do kafelka albo null (nieznany, za stary, 15 min po przyjeździe). */
export function pinnedState(pinKey, schedule, live, now) {
  if (!pinKey || !schedule) return null;
  const t = (schedule.trains || []).find((x) => x.key === pinKey);
  if (!t) return null;
  if (t.date < addDays(warsawDate(now), -1)) return null;
  const st = trainState(t, live?.[t.key], now, schedule.stations || {});
  if (st.status === 'arrived' && now >= st.expArr + PIN_AFTER_ARRIVAL_MS) return null;
  if (st.cancelled && now >= st.planArr + PIN_AFTER_ARRIVAL_MS) return null;
  return st;
}

// --------------------------------------------------------------------------- zapytania (5.6)

/** Kursy do Workera: przypięty, w drodze, nadchodzące ≤ 4 h, dojechane < 30 min; maks. 30, najbliższe pierwsze. */
export function liveKeys(schedule, dir, live, now, pinKey) {
  const lists = todayLists(schedule, dir, live, now);
  const enroute = [...lists.enroute].sort((a, b) => a.expArr - b.expArr);
  const upcoming = lists.upcoming.filter((s) => s.expDep <= now + LIVE_HORIZON_MS);
  const arrived = lists.arrived.filter((s) => s.expArr >= now - LIVE_RECENT_ARRIVAL_MS).sort((a, b) => b.expArr - a.expArr);
  const keys = [];
  const pin = pinnedState(pinKey, schedule, live, now);
  if (pin) keys.push(pin.key);
  for (const s of [...enroute, ...upcoming, ...arrived]) if (!keys.includes(s.key)) keys.push(s.key);
  return keys.slice(0, MAX_LIVE_KEYS);
}

/** Scala odpowiedź Workera z poprzednimi danymi; błąd dla kursu nie kasuje ostatnich dobrych danych. */
export function mergeLive(prev, response, now) {
  const merged = { ...(prev || {}) };
  const at = Date.parse(response?.fetched_at);
  for (const [key, entry] of Object.entries(response?.trains || {})) {
    if (!entry || entry.state === 'error') continue;
    merged[key] = entry.state === 'none' ? { state: 'none', at: Number.isFinite(at) ? at : now } : entry;
  }
  // Sprzątanie: wpisy starsze niż doba.
  for (const [key, entry] of Object.entries(merged)) {
    const t = entry.state === 'ok' ? Date.parse(entry.checked_at) : entry.at;
    if (!Number.isFinite(t) || now - t > 24 * 3600_000) delete merged[key];
  }
  return merged;
}

// --------------------------------------------------------------------------- etykiety (5.4)

export function trainLabel(train) {
  return [train.cat, train.no].filter(Boolean).join(' ');
}

/** Pastylka statusu na liście. Dla nadchodzących liczy się odjazd, dla pozostałych przyjazd. */
export function statusPill(st) {
  if (st.cancelled) return { text: 'odwołany', kind: 'cancelled' };
  if (st.source !== 'live') return { text: 'rozkładowo', kind: 'schedule' };
  const d = st.status === 'upcoming' ? st.depDelay : st.arrDelay;
  if (d >= 1) return { text: `+${d} min`, kind: 'late' };
  return { text: 'planowo', kind: 'ontime' };
}

/** Pastylka w kafelku „Twój pociąg". */
export function pinPill(st) {
  if (st.cancelled) return { text: 'odwołany', kind: 'cancelled' };
  if (st.source !== 'live') return { text: 'rozkładowo', kind: 'schedule' };
  const d = st.status === 'upcoming' ? st.depDelay : st.arrDelay;
  if (d >= 1) return { text: `opóźniony +${d} min`, kind: 'late' };
  return { text: 'planowo', kind: 'ontime' };
}

export function platformLabel(end) {
  if (!end) return null;
  if (end.bus) return 'autobus zastępczy';
  if (!end.platform) return null;
  return end.track ? `peron ${end.platform} · tor ${end.track}` : `peron ${end.platform}`;
}

/** Podpis pod nadchodzącym pociągiem. */
export function upcomingNote(st, now) {
  if (st.cancelled) return 'sprawdź komunikat przewoźnika';
  if (st.source === 'live') return platformLabel(st.train.from) ?? 'peron jeszcze nieznany';
  if (st.planDep - now > LIVE_SOON_MS) return 'dane na żywo ok. 3 h przed odjazdem';
  return 'dane na żywo jeszcze niedostępne';
}

const GENITIVE = { Gdańska: 'Gdańskiej', Zachodnia: 'Zachodniej', Wschodnia: 'Wschodniej', Centralna: 'Centralnej' };

/** Flaga stacji innej niż Warszawa Centralna: „z W-wy Gdańskiej" / „do W-wy Gdańskiej"; null, gdy Centralna. */
export function stationFlag(train, schedule) {
  const main = schedule?.warsaw?.[0];
  if (main == null || train.waw_station === main) return null;
  const name = schedule?.stations?.[String(train.waw_station)] || '';
  const suffix = name.replace(/^Warszawa\s+/, '');
  const gen = GENITIVE[suffix] ?? suffix;
  return `${train.dir === 'krk' ? 'z' : 'do'} W-wy ${gen}`.trim();
}

const SHORT = [
  [/^Warszawa\s/, 'W-wa '],
  [/\sPółnoc$/, ' Płn.'],
  [/\sPołudnie$/, ' Płd.'],
  [/\sGłówn[ya]$/, ' Gł.'],
  [/\sMazowiecki$/, ' Maz.'],
];

/** Skrót nazwy stacji do „ostatnio: …" (Włoszczowa Północ → Włoszczowa Płn.). */
export function shortStation(name) {
  let s = name || '';
  for (const [re, rep] of SHORT) s = s.replace(re, rep);
  return s;
}

function hm(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** „za 20 min", „za 1 h 15 min"; poniżej minuty „za chwilę". */
export function countdown(targetMs, now) {
  const min = Math.floor((targetMs - now) / MIN);
  if (min < 1) return 'za chwilę';
  return `za ${hm(min)}`;
}

/** Czas jazdy „2 h 18 min". */
export function duration(depMs, arrMs) {
  return hm(Math.round((arrMs - depMs) / MIN));
}

/** Wiek ostatniego udanego odświeżenia; czerwone ≥ 60 min. */
export function refreshAge(lastMs, now) {
  if (!Number.isFinite(lastMs)) return { text: 'jeszcze nie odświeżono', stale: false };
  const min = Math.max(0, Math.floor((now - lastMs) / MIN));
  const text = min < 1 ? 'odśw. przed chwilą' : `odśw. ${hm(min)} temu`;
  return { text, stale: now - lastMs >= STALE_REFRESH_MS };
}

/** Wiek rozkładu wg daty `generated_at` w Warszawie; czerwone, gdy nie z dziś. */
export function scheduleAge(generatedAt, now) {
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return { text: 'rozkład nieznany', stale: true };
  const today = warsawDate(now);
  const gen = warsawDate(t);
  const days = Math.round((Date.parse(today) - Date.parse(gen)) / 86400_000);
  if (days <= 0) return { text: 'rozkład z dziś', stale: false };
  if (days === 1) return { text: 'rozkład z wczoraj', stale: true };
  return { text: `rozkład sprzed ${days} dni`, stale: true };
}

export function noTrainsText(dir) {
  return `Dziś nie ma już bezpośrednich pociągów do ${dir === 'krk' ? 'Krakowa' : 'Warszawy'}`;
}
