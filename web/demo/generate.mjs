// Generator fixtures trybu demo (SPEC 9): node web/demo/generate.mjs
// Scenariusze odwzorowują ekrany makiety (docs/design/mockup.dc.html). Wynik: rano.json, wieczor.json, awarie.json.
import { writeFileSync } from 'node:fs';
import { localToMs, addDays } from '../logic.js';

const CEN = 33605, ZACH = 33506, WSCH = 34868, GDA = 36103;
const GRODZ = 33100, OPO = 61000, WLO = 62000, MIE = 63000, KRK = 80416;
const STATIONS = {
  [CEN]: 'Warszawa Centralna', [ZACH]: 'Warszawa Zachodnia', [WSCH]: 'Warszawa Wschodnia', [GDA]: 'Warszawa Gdańska',
  [GRODZ]: 'Grodzisk Mazowiecki', [OPO]: 'Opoczno Południe', [WLO]: 'Włoszczowa Północ', [MIE]: 'Miechów', [KRK]: 'Kraków Główny',
};
const BY_SHORT = { 'Włoszczowa Płn.': WLO, 'Opoczno Płd.': OPO, 'W-wa Zachodnia': ZACH, 'Grodzisk Maz.': GRODZ, 'Miechów': MIE };
const FRACTIONS = [0, 0.04, 0.12, 0.4, 0.62, 0.85, 1];
const DATE = '2026-11-18';

const ms = (date, hhmm) => localToMs(`${date}T${hhmm}:00`);
const local = (t) => {
  const d = new Date(t + 3600_000); // listopad: CET = UTC+1
  return d.toISOString().slice(0, 19);
};
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

function route(dir, wg) {
  const r = [wg ? GDA : CEN, ZACH, GRODZ, OPO, WLO, MIE, KRK];
  return dir === 'krk' ? r : r.reverse();
}

function makeTrain(def, dir, date, oid) {
  const dep = ms(date, def.dep);
  let arr = ms(date, def.arr);
  if (arr <= dep) arr += 86400_000;
  const r = route(dir, def.wg);
  return {
    key: `2026/${oid}/${date}`, sid: 2026, oid, date, dir, cat: def.cat, no: def.no, name: null,
    from: { id: r[0], dep: dep / 1000, platform: def.peron != null ? String(def.peron) : null, track: def.tor != null ? String(def.tor) : null, bus: false },
    to: { id: r[r.length - 1], arr: arr / 1000, platform: '3', track: '5', bus: false },
    waw_station: def.wg ? GDA : CEN,
    route: r,
    // jak w pipeline: [id, przyjazd, odjazd] w s względem from.dep
    stops: r.map((id, i) => {
      const a = Math.round((FRACTIONS[i] * (arr - dep)) / 1000);
      return [id, a, i === 0 || i === r.length - 1 ? a : a + 60];
    }),
  };
}

function liveEntry(def, train, group, checkedAt) {
  const r = train.route;
  const dep = train.from.dep * 1000;
  const arr = train.to.arr * 1000;
  const base = { state: 'ok', checked_at: iso(checkedAt) };
  if (def.cancelled) return { ...base, train_status: 'X', stops: r.map((id) => ({ id, aa: null, ad: null, cf: false, cx: true })) };
  if (def.delay == null) return def.note === 'none' ? { state: 'none', at: checkedAt } : null;
  const depDelay = (def.depDelay ?? def.delay) * 60_000;
  const arrDelay = def.delay * 60_000;
  const lastIdx = group === 'enroute' ? r.indexOf(BY_SHORT[def.last]) : group === 'arrived' ? r.length - 1 : -1;
  const stops = r.map((id, i) => {
    const f = FRACTIONS[i];
    const t = dep + f * (arr - dep) + depDelay + f * (arrDelay - depDelay);
    const cf = i <= lastIdx;
    return {
      id,
      aa: i === 0 ? null : local(t),
      ad: i === r.length - 1 ? null : local(t + (i === 0 ? 0 : 60_000)),
      cf, cx: false,
    };
  });
  const status = group === 'arrived' ? 'C' : group === 'enroute' ? 'P' : 'S';
  return { ...base, train_status: status, stops };
}

function scenario({ now, liveAt, generatedAt, lists, tomorrow, pins = {} }) {
  const trains = [];
  const live = {};
  let oid = 600000;
  const pinKeys = { krk: null, waw: null };
  for (const dir of ['krk', 'waw']) {
    for (const group of ['arrived', 'enroute', 'upcoming']) {
      for (const def of lists[dir][group]) {
        const t = makeTrain(def, dir, DATE, ++oid);
        trains.push(t);
        const e = liveEntry(def, t, group, liveAt);
        if (e) live[t.key] = e;
        if (def.id === pins[dir]) pinKeys[dir] = t.key;
      }
    }
    for (const [dep, arr, cat, wg] of tomorrow[dir]) {
      trains.push(makeTrain({ dep, arr, cat, no: String(1400 + (oid % 97)), wg }, dir, addDays(DATE, 1), ++oid));
    }
  }
  trains.sort((a, b) => a.date.localeCompare(b.date) || a.dir.localeCompare(b.dir) || a.from.dep - b.from.dep);
  return {
    now: `${DATE}T${now}:00`,
    live_at: iso(liveAt),
    pins: pinKeys,
    schedule: {
      schema_version: 1, generated_at: generatedAt, service_today: generatedAt.slice(0, 10),
      valid_from: addDays(DATE, -1), valid_to: addDays(DATE, 2), source: { demo: true },
      attribution: 'Dane: PKP Polskie Linie Kolejowe S.A. — Otwarte Dane Kolejowe (https://pdp-api.plk-sa.pl)',
      stations: STATIONS, krakow: KRK, warsaw: [CEN, ZACH, WSCH, GDA], trains,
    },
    live,
  };
}

const TOMORROW = {
  krk: [['05:20', '07:38', 'EIP'], ['06:15', '08:58', 'IC'], ['06:50', '09:08', 'EIP'], ['07:35', '09:53', 'EIP'], ['08:05', '10:44', 'IC'], ['08:35', '10:53', 'EIP'], ['09:05', '11:47', 'IC'], ['09:35', '11:53', 'EIP', true], ['10:35', '12:53', 'EIP'], ['11:05', '13:47', 'IC'], ['12:35', '14:53', 'EIP'], ['14:35', '16:53', 'EIP'], ['15:35', '17:53', 'EIP'], ['16:05', '18:44', 'IC'], ['17:35', '19:53', 'EIP'], ['18:35', '20:53', 'EIP']],
  waw: [['05:00', '07:18', 'EIP'], ['06:00', '08:18', 'EIP'], ['06:40', '09:22', 'IC'], ['08:00', '10:18', 'EIP'], ['09:00', '11:18', 'EIP'], ['10:40', '13:22', 'IC', true], ['12:00', '14:18', 'EIP'], ['13:50', '16:08', 'EIP'], ['15:00', '17:18', 'EIP'], ['15:50', '18:08', 'EIP'], ['16:40', '19:25', 'IC'], ['17:50', '20:08', 'EIP'], ['18:20', '20:38', 'EIP'], ['18:50', '21:08', 'EIP'], ['19:50', '22:08', 'EIP'], ['21:35', '00:58', 'TLK']],
};

const RANO_LISTS = {
  krk: {
    arrived: [{ id: 'k0', dep: '05:20', arr: '07:38', cat: 'EIP', no: '1300', delay: 3, peron: 4, tor: 2 }],
    enroute: [
      { id: 'k1', dep: '06:15', arr: '08:58', cat: 'IC', no: '3502', delay: 12, depDelay: 8, last: 'Włoszczowa Płn.' },
      { id: 'k2', dep: '06:50', arr: '09:08', cat: 'EIP', no: '1302', delay: 0, depDelay: 0, last: 'Opoczno Płd.' },
      { id: 'k3', dep: '07:35', arr: '09:53', cat: 'EIP', no: '1304', delay: 3, depDelay: 3, last: 'W-wa Zachodnia' },
    ],
    upcoming: [
      { id: 'k4', dep: '08:05', arr: '10:44', cat: 'IC', no: '3504', delay: 5, peron: 4, tor: 2 },
      { id: 'k5', dep: '08:35', arr: '10:53', cat: 'EIP', no: '1306', delay: 0, peron: 3, tor: 4 },
      { id: 'k6', dep: '09:05', arr: '11:47', cat: 'IC', no: '3506', cancelled: true },
      { id: 'k7', dep: '09:35', arr: '11:53', cat: 'EIP', no: '1308', delay: 0, peron: 2, tor: 3, wg: true },
      { id: 'k8', dep: '10:35', arr: '12:53', cat: 'EIP', no: '1310', delay: null, note: 'soon' },
      { id: 'k9', dep: '11:05', arr: '13:47', cat: 'IC', no: '3508', delay: null, note: 'soon' },
    ],
  },
  waw: {
    arrived: [{ id: 'w0', dep: '05:00', arr: '07:18', cat: 'EIP', no: '1301', delay: 0 }],
    enroute: [
      { id: 'w1', dep: '06:00', arr: '08:18', cat: 'EIP', no: '1303', delay: 4, depDelay: 2, last: 'Grodzisk Maz.' },
      { id: 'w2', dep: '06:40', arr: '09:22', cat: 'IC', no: '3501', delay: 0, depDelay: 0, last: 'Włoszczowa Płn.' },
    ],
    upcoming: [
      { id: 'w3', dep: '08:00', arr: '10:18', cat: 'EIP', no: '1305', delay: 0, peron: 4, tor: 8 },
      { id: 'w4', dep: '09:00', arr: '11:18', cat: 'EIP', no: '1307', delay: 0, peron: 3, tor: 6 },
      { id: 'w5', dep: '10:40', arr: '13:22', cat: 'IC', no: '3503', delay: null, note: 'none', wg: true },
      { id: 'w6', dep: '12:00', arr: '14:18', cat: 'EIP', no: '1309', delay: null, note: 'soon' },
      { id: 'w7', dep: '13:50', arr: '16:08', cat: 'EIP', no: '1311', delay: null, note: 'soon' },
    ],
  },
};

const WIECZOR_LISTS = {
  waw: {
    arrived: [
      { id: 'v0', dep: '15:00', arr: '17:18', cat: 'EIP', no: '1313', delay: 0 },
      { id: 'v1', dep: '15:50', arr: '18:08', cat: 'EIP', no: '1315', delay: 7 },
    ],
    enroute: [
      { id: 'v2', dep: '16:40', arr: '19:25', cat: 'IC', no: '3513', delay: 25, depDelay: 10, last: 'Opoczno Płd.' },
      { id: 'v3', dep: '17:50', arr: '20:08', cat: 'EIP', no: '1317', delay: 6, depDelay: 4, last: 'Włoszczowa Płn.', wg: true },
      { id: 'v4', dep: '18:20', arr: '20:38', cat: 'EIP', no: '1319', delay: 0, depDelay: 0, last: 'Miechów' },
    ],
    upcoming: [
      { id: 'v5', dep: '18:50', arr: '21:08', cat: 'EIP', no: '1321', delay: 0, peron: 4, tor: 8 },
      { id: 'v6', dep: '19:20', arr: '22:06', cat: 'IC', no: '3515', delay: 10, peron: 2, tor: 4 },
      { id: 'v7', dep: '19:50', arr: '22:08', cat: 'EIP', no: '1323', delay: 0, peron: 3, tor: 6, wg: true },
      { id: 'v8', dep: '20:50', arr: '23:08', cat: 'EIP', no: '1325', delay: 0 },
      { id: 'v9', dep: '21:35', arr: '00:58', cat: 'TLK', no: '31101', delay: null, note: 'none' },
    ],
  },
  krk: {
    arrived: [{ id: 'q0', dep: '15:35', arr: '17:53', cat: 'EIP', no: '1320', delay: 2 }],
    enroute: [
      { id: 'q1', dep: '16:05', arr: '18:44', cat: 'IC', no: '3520', delay: 3, depDelay: 0, last: 'Miechów' },
      { id: 'q2', dep: '17:35', arr: '19:53', cat: 'EIP', no: '1322', delay: 0, depDelay: 0, last: 'Opoczno Płd.' },
      { id: 'q3', dep: '18:35', arr: '20:53', cat: 'EIP', no: '1324', delay: 2, depDelay: 2, last: 'W-wa Zachodnia' },
    ],
    upcoming: [
      { id: 'q4', dep: '19:05', arr: '21:47', cat: 'IC', no: '3522', delay: 0, peron: 2, tor: 3 },
      { id: 'q5', dep: '19:35', arr: '21:53', cat: 'EIP', no: '1326', delay: 0, peron: 3, tor: 4 },
      { id: 'q6', dep: '20:35', arr: '22:53', cat: 'EIP', no: '1328', delay: 0 },
      { id: 'q7', dep: '21:05', arr: '23:47', cat: 'IC', no: '3524', delay: null, note: 'none' },
    ],
  },
};

const rano = scenario({
  now: '07:50', liveAt: ms(DATE, '07:47'), generatedAt: '2026-11-18T01:31:12Z',
  lists: RANO_LISTS, tomorrow: TOMORROW, pins: { krk: 'k4', waw: 'w7' },
});
// Wieczór: ostatnie udane odświeżenie 1 h 12 min temu (dane > 35 min → rozkładowo), rozkład z wczoraj.
const wieczor = scenario({
  now: '18:40', liveAt: ms(DATE, '17:28'), generatedAt: '2026-11-17T01:31:12Z',
  lists: WIECZOR_LISTS, tomorrow: TOMORROW,
});

const stary = { ...rano, schedule: { ...rano.schedule, generated_at: '2026-11-17T01:31:12Z' } };
const brak = {
  ...rano, live: {}, pins: null,
  schedule: { ...rano.schedule, generated_at: '2026-11-14T01:31:12Z', trains: rano.schedule.trains.map((t) => ({ ...t, date: '2026-11-15', key: t.key.replace(DATE, '2026-11-15') })) },
};
const blad = { ...rano, live_at: iso(ms(DATE, '06:20')), live_error: true };
const koniec = { ...rano, now: `${DATE}T23:50:00`, pins: null };
const awarie = {
  states: {
    ladowanie: { ...rano, loading: true },
    brak,
    stary,
    blad,
    koniec,
  },
};

const out = (name, data) => writeFileSync(new URL(`./${name}.json`, import.meta.url), JSON.stringify(data) + '\n');
out('rano', rano);
out('wieczor', wieczor);
out('awarie', awarie);
console.log('demo: rano, wieczor, awarie');
