import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const CEN = 33605;
const ZACH = 33506;
const GDA = 36103;
const WLO = 62000;
const KRK = 80416;
const STATIONS = {
  [CEN]: 'Warszawa Centralna', [ZACH]: 'Warszawa Zachodnia', [GDA]: 'Warszawa Gdańska',
  [WLO]: 'Włoszczowa Północ', [KRK]: 'Kraków Główny', 34868: 'Warszawa Wschodnia',
};

// 18.11.2026 (środa), CET = UTC+1
const at = (hhmm, date = '2026-11-18') => L.localToMs(`${date}T${hhmm}:00`);
const sec = (hhmm, date) => at(hhmm, date) / 1000;

function train({ oid, date = '2026-11-18', dir = 'krk', dep, arr, arrDate = date, waw = CEN, platform = '4', track = '2', bus = false }) {
  const from = dir === 'krk' ? waw : KRK;
  const to = dir === 'krk' ? KRK : waw;
  return {
    key: `2026/${oid}/${date}`, sid: 2026, oid, date, dir, cat: 'IC', no: String(3500 + oid), name: null,
    from: { id: from, dep: sec(dep, date), platform, track, bus },
    to: { id: to, arr: sec(arr, arrDate), platform: '3', track: '5', bus: false },
    waw_station: waw,
    route: dir === 'krk' ? [from, ZACH, WLO, to] : [from, WLO, ZACH, to],
  };
}

function schedule(trains, generated = '2026-11-18T01:30:00Z') {
  return { schema_version: 1, generated_at: generated, service_today: '2026-11-18', stations: STATIONS,
    krakow: KRK, warsaw: [CEN, ZACH, 34868, GDA], trains };
}

const okEntry = (stops, status = 'P', checked = '2026-11-18T06:49:00Z') =>
  ({ state: 'ok', checked_at: checked, train_status: status, stops });
const stop = (id, aa, ad, cf = false, cx = false) => ({ id, aa: aa ?? null, ad: ad ?? null, cf, cx });
const t18 = (hhmm) => `2026-11-18T${hhmm}:00`;

// --------------------------------------------------------------------------- czas

test('warsaw date and time across midnight and DST', () => {
  assert.equal(L.warsawDate(Date.parse('2026-11-18T23:30:00Z')), '2026-11-19');
  assert.equal(L.fmtTime(Date.parse('2026-11-18T06:50:00Z')), '07:50');
  assert.equal(L.fmtTime(Date.parse('2026-07-01T06:50:00Z')), '08:50');
  assert.equal(L.localToMs('2026-11-18T07:50:00'), Date.parse('2026-11-18T06:50:00Z'));
  assert.equal(L.localToMs('2026-07-01T08:50:00'), Date.parse('2026-07-01T06:50:00Z'));
  // 25.10.2026: 03:00 CEST → 02:00 CET; 29.03.2026: 02:00 CET → 03:00 CEST
  assert.equal(L.localToMs('2026-10-25T04:00:00'), Date.parse('2026-10-25T03:00:00Z'));
  assert.equal(L.localToMs('2026-10-25T01:00:00'), Date.parse('2026-10-24T23:00:00Z'));
  assert.equal(L.localToMs('2026-03-29T03:30:00'), Date.parse('2026-03-29T01:30:00Z'));
  assert.equal(L.localToMs('2026-03-29T01:30:00'), Date.parse('2026-03-29T00:30:00Z'));
  assert.equal(L.localToMs('bzdura'), null);
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
});

test('polish date labels', () => {
  assert.equal(L.dateLong('2026-11-18'), 'środa, 18 listopada');
  assert.equal(L.dateShort('2026-11-18'), 'śr 18.11');
  assert.equal(L.dateShort('2026-11-19'), 'czw 19.11');
  assert.equal(L.dateLong('2026-03-01'), 'niedziela, 1 marca');
});

// --------------------------------------------------------------------------- kierunek

test('auto direction by Warsaw hour', () => {
  assert.equal(L.autoDir(at('11:59')), 'krk');
  assert.equal(L.autoDir(at('12:00')), 'waw');
  assert.equal(L.autoDir(at('00:10')), 'krk');
});

test('manual direction holds only on its day', () => {
  assert.equal(L.effectiveDir({ date: '2026-11-18', dir: 'waw' }, at('07:50')), 'waw');
  assert.equal(L.effectiveDir({ date: '2026-11-17', dir: 'waw' }, at('07:50')), 'krk');
  assert.equal(L.effectiveDir({ date: '2026-11-18', dir: 'xyz' }, at('07:50')), 'krk');
  assert.equal(L.effectiveDir(null, at('18:40')), 'waw');
});

// --------------------------------------------------------------------------- stan pociągu

test('schedule-only status', () => {
  const t = train({ oid: 1, dep: '08:05', arr: '10:44' });
  assert.equal(L.trainState(t, null, at('08:00')).status, 'upcoming');
  const s = L.trainState(t, null, at('09:00'));
  assert.equal(s.status, 'enroute');
  assert.equal(s.source, 'schedule');
  assert.ok(s.progress > 0.3 && s.progress < 0.4);
  assert.equal(L.trainState(t, null, at('10:44')).status, 'arrived');
});

test('live delay shifts departure and arrival', () => {
  const t = train({ oid: 4, dep: '08:05', arr: '10:44' });
  const e = okEntry([stop(CEN, null, t18('08:10')), stop(WLO, t18('09:50'), t18('09:51')), stop(KRK, t18('10:49'))], 'S');
  const s = L.trainState(t, e, at('07:50'), STATIONS);
  assert.equal(s.status, 'upcoming');
  assert.equal(s.source, 'live');
  assert.equal(s.depDelay, 5);
  assert.equal(s.arrDelay, 5);
  assert.equal(L.fmtTime(s.expDep), '08:10');
  assert.equal(L.fmtTime(s.expArr), '10:49');
  assert.deepEqual(L.statusPill(s), { text: '+5 min', kind: 'late' });
  assert.deepEqual(L.pinPill(s), { text: 'opóźniony +5 min', kind: 'late' });
});

test('train never departs early; missing arrival uses departure delay', () => {
  const t = train({ oid: 5, dep: '08:05', arr: '10:44' });
  const s = L.trainState(t, okEntry([stop(CEN, null, t18('08:01'))], 'S'), at('07:50'));
  assert.equal(L.fmtTime(s.expDep), '08:05');
  assert.equal(s.depDelay, 0);
  assert.deepEqual(L.statusPill(s), { text: 'planowo', kind: 'ontime' });
  const s2 = L.trainState(t, okEntry([stop(CEN, null, t18('08:12'))], 'S'), at('07:50'));
  assert.equal(L.fmtTime(s2.expArr), '10:51');
});

test('enroute with confirmed departure, last station and progress', () => {
  const t = train({ oid: 2, dep: '06:15', arr: '08:58' });
  const e = okEntry([
    stop(CEN, null, t18('06:23'), true), stop(ZACH, t18('06:29'), t18('06:31'), true),
    stop(WLO, t18('07:45'), t18('07:46'), true), stop(KRK, t18('09:10'), null, false)]);
  const s = L.trainState(t, e, at('07:50'), STATIONS);
  assert.equal(s.status, 'enroute');
  assert.equal(s.lastStation, 'Włoszczowa Północ');
  assert.equal(L.shortStation(s.lastStation), 'Włoszczowa Płn.');
  assert.equal(s.arrDelay, 12);
  assert.deepEqual(L.statusPill(s), { text: '+12 min', kind: 'late' });
  const expected = (at('07:50') - at('06:23')) / (at('09:10') - at('06:23'));
  assert.ok(Math.abs(s.progress - expected) < 1e-9);
});

test('status P before expected departure stays upcoming', () => {
  const t = train({ oid: 3, dep: '08:05', arr: '10:44' });
  const e = okEntry([stop(7500, null, t18('05:00'), true), stop(CEN, t18('08:00'), t18('08:07')), stop(KRK, t18('10:46'))], 'P');
  assert.equal(L.trainState(t, e, at('07:50')).status, 'upcoming');
  // bez potwierdzenia odjazdu: „w drodze" dopiero 10 min po oczekiwanym odjeździe
  assert.equal(L.trainState(t, e, at('08:08')).status, 'upcoming');
  assert.equal(L.trainState(t, e, at('08:17')).status, 'enroute');
});

test('through train: arrival at our station confirmed, departure still a forecast → upcoming', () => {
  // IC z Przemyśla stoi w Krakowie: przyjazd potwierdzony (cf), odjazd 20:15 to prognoza (plan 20:13)
  const t = train({ oid: 30, dir: 'waw', dep: '20:13', arr: '23:08' });
  const e = okEntry([
    stop(90000, null, t18('16:10'), true), stop(KRK, t18('20:05'), t18('20:15'), true),
    stop(CEN, t18('23:09'))], 'P', '2026-11-18T19:00:00Z');
  const s = L.trainState(t, e, at('20:01'), STATIONS);
  assert.equal(s.status, 'upcoming');
  assert.equal(s.depDelay, 2);
  assert.equal(L.trainState(t, e, at('20:16'), STATIONS).status, 'enroute');
  // potwierdzony postój za naszą stacją = na pewno odjechał
  const later = okEntry([stop(KRK, t18('20:05'), t18('20:20'), true), stop(WLO, t18('21:00'), t18('21:01'), true),
    stop(CEN, t18('23:09'))], 'P', '2026-11-18T19:00:00Z');
  assert.equal(L.trainState(t, later, at('20:10'), STATIONS).status, 'enroute');
});

test('stops view: plan from offsets, live delays, passed stations, duplicated stop', () => {
  const t = train({ oid: 40, dep: '06:15', arr: '08:58' });
  t.stops = [[CEN, -180, 0], [ZACH, 360, 480], [WLO, 5400, 5460], [KRK, 9780, 9780]];
  const plain = L.stopsView(t, null, at('06:00'), STATIONS);
  assert.deepEqual(plain.map((r) => [r.kind, r.name, L.fmtTime(r.plan), r.passed]), [
    ['from', 'Warszawa Centralna', '06:15', false], ['mid', 'Warszawa Zachodnia', '06:21', false],
    ['mid', 'Włoszczowa Północ', '07:45', false], ['to', 'Kraków Główny', '08:58', false]]);
  // bez danych na żywo: miniona wg rozkładu
  assert.deepEqual(L.stopsView(t, null, at('07:00'), STATIONS).map((r) => r.passed), [true, true, false, false]);

  const e = okEntry([
    stop(KRK, t18('04:00'), t18('04:01'), true), // przed naszą stacją — nie myli dopasowania
    stop(CEN, null, t18('06:23'), true), stop(ZACH, t18('06:29'), t18('06:31'), true),
    stop(WLO, t18('07:52'), t18('07:53')), stop(KRK, t18('09:06'))], 'P', '2026-11-18T06:49:00Z');
  const rows = L.stopsView(t, e, at('07:50'), STATIONS);
  assert.deepEqual(rows.map((r) => [L.fmtTime(r.exp), r.delay, r.passed, r.confirmed]), [
    ['06:23', 8, true, true], ['06:29', 8, true, true], ['07:52', 7, false, false], ['09:06', 8, false, false]]);
  assert.deepEqual(L.stopsView({ ...t, stops: undefined }, e, at('07:50')), []);
});

test('arrived by confirmed arrival or status C', () => {
  const t = train({ oid: 6, dep: '05:20', arr: '07:38' });
  const e = okEntry([stop(CEN, null, t18('05:20'), true), stop(KRK, t18('07:41'), null, true)]);
  const s = L.trainState(t, e, at('07:50'));
  assert.equal(s.status, 'arrived');
  assert.equal(L.fmtTime(s.expArr), '07:41');
  assert.equal(L.trainState(t, okEntry([], 'C'), at('07:00')).status, 'arrived');
});

test('duplicated stop: first from, first to after it', () => {
  const t = train({ oid: 7, dep: '08:05', arr: '10:44' });
  const e = okEntry([
    stop(KRK, t18('06:00'), t18('06:01'), true), // przed stacją odjazdu — ignorowany
    stop(CEN, null, t18('08:05')), stop(CEN, t18('08:06'), t18('08:30')),
    stop(KRK, t18('10:54')), stop(KRK, t18('11:30'))], 'S');
  const s = L.trainState(t, e, at('07:50'));
  assert.equal(s.depDelay, 0);
  assert.equal(s.arrDelay, 10);
});

test('cancellation: whole train or on our stops (partial)', () => {
  const t = train({ oid: 8, dep: '09:05', arr: '11:47' });
  assert.equal(L.trainState(t, okEntry([], 'X'), at('07:50')).status, 'cancelled');
  const partial = okEntry([stop(CEN, null, t18('09:05')), stop(WLO, t18('10:30'), t18('10:31')), stop(KRK, null, null, false, true)], 'Q');
  const s = L.trainState(t, partial, at('07:50'));
  assert.equal(s.status, 'cancelled');
  assert.deepEqual(L.statusPill(s), { text: 'odwołany', kind: 'cancelled' });
  assert.equal(L.upcomingNote(s, at('07:50')), 'sprawdź komunikat przewoźnika');
  assert.equal(L.canPin(s), false);
  const otherPart = okEntry([stop(7500, null, null, false, true), stop(CEN, null, t18('09:05')), stop(KRK, t18('11:47'))], 'Q');
  assert.equal(L.trainState(t, otherPart, at('07:50')).status, 'upcoming');
});

test('live data older than 35 min is ignored', () => {
  const t = train({ oid: 9, dep: '08:05', arr: '10:44' });
  const e = okEntry([stop(CEN, null, t18('08:20')), stop(KRK, t18('11:00'))], 'S', '2026-11-18T06:14:00Z'); // 07:14
  assert.equal(L.trainState(t, e, at('07:49')).source, 'live');
  const s = L.trainState(t, e, at('07:50'));
  assert.equal(s.source, 'schedule');
  assert.equal(s.depDelay, 0);
  assert.deepEqual(L.statusPill(s), { text: 'rozkładowo', kind: 'schedule' });
});

test('state none = no live data yet', () => {
  const t = train({ oid: 10, dep: '10:40', arr: '13:22' });
  const s = L.trainState(t, { state: 'none', at: at('07:49') }, at('07:50'));
  assert.equal(s.source, 'none-yet');
  assert.equal(L.upcomingNote(s, at('07:50')), 'dane na żywo jeszcze niedostępne');
  const far = L.trainState(train({ oid: 11, dep: '11:05', arr: '13:47' }), null, at('07:50'));
  assert.equal(L.upcomingNote(far, at('07:50')), 'dane na żywo ok. 3 h przed odjazdem');
});

// --------------------------------------------------------------------------- listy

test('today lists: groups, direction, yesterday after-midnight train', () => {
  const tlk = train({ oid: 20, date: '2026-11-17', dir: 'waw', dep: '21:35', arr: '00:58', arrDate: '2026-11-18' });
  const trains = [
    train({ oid: 1, dep: '05:20', arr: '07:38' }),
    train({ oid: 2, dep: '06:15', arr: '08:58' }),
    train({ oid: 3, dep: '08:05', arr: '10:44' }),
    train({ oid: 4, dep: '09:05', arr: '11:47' }),
    train({ oid: 5, dir: 'waw', dep: '05:00', arr: '07:18' }),
    train({ oid: 6, date: '2026-11-17', dep: '08:05', arr: '10:44' }),
    tlk,
    train({ oid: 7, date: '2026-11-19', dep: '05:20', arr: '07:38' }),
  ];
  const s = schedule(trains);
  const live = { [trains[3].key]: okEntry([], 'X') };
  const l = L.todayLists(s, 'krk', live, at('07:50'));
  assert.deepEqual(l.arrived.map((x) => x.train.oid), [1]);
  assert.deepEqual(l.enroute.map((x) => x.train.oid), [2]);
  assert.deepEqual(l.upcoming.map((x) => x.train.oid), [3, 4]);
  assert.equal(l.upcoming[1].status, 'cancelled');

  // Kurs po północy: widoczny jako „w drodze" o 00:30, znika 30 min po przyjeździe.
  const night = L.todayLists(s, 'waw', {}, at('00:30'));
  assert.deepEqual(night.enroute.map((x) => x.train.oid), [20]);
  assert.deepEqual(L.todayLists(s, 'waw', {}, at('01:20')).arrived.map((x) => x.train.oid), [20]);
  assert.equal(L.todayLists(s, 'waw', {}, at('01:28')).arrived.length, 1);
  assert.equal(L.todayLists(s, 'waw', {}, at('01:29')).arrived.length, 0);

  assert.deepEqual(L.tomorrowList(s, 'krk', at('07:50')).map((t) => t.oid), [7]);
  assert.equal(L.hasToday(s, at('07:50')), true);
  assert.equal(L.hasToday(s, at('07:50', '2026-11-21')), false);
});

test('cancelled train after its planned departure goes to the hidden group', () => {
  const t = train({ oid: 4, dep: '07:05', arr: '09:47' });
  const l = L.todayLists(schedule([t]), 'krk', { [t.key]: okEntry([], 'X') }, at('07:50'));
  assert.equal(l.arrived.length, 1);
  assert.equal(l.upcoming.length, 0);
});

// --------------------------------------------------------------------------- przypięty

test('pin shows in any direction and expires 15 min after arrival', () => {
  const t = train({ oid: 3, dep: '08:05', arr: '10:44' });
  const s = schedule([t]);
  assert.equal(L.pinnedState(t.key, s, {}, at('07:50')).status, 'upcoming');
  assert.equal(L.pinnedState(t.key, s, {}, at('10:58')).status, 'arrived');
  assert.equal(L.pinnedState(t.key, s, {}, at('10:59')), null);
  assert.equal(L.pinnedState('2026/999/2026-11-18', s, {}, at('07:50')), null);
  assert.equal(L.pinnedState(null, s, {}, at('07:50')), null);
});

test('pin older than yesterday is dropped', () => {
  const t = train({ oid: 3, date: '2026-11-16', dep: '23:05', arr: '03:44', arrDate: '2026-11-17' });
  assert.equal(L.pinnedState(t.key, schedule([t]), {}, at('00:10')), null);
});

test('pin with live delay follows expected arrival', () => {
  const t = train({ oid: 3, dep: '08:05', arr: '10:44' });
  const live = { [t.key]: okEntry([stop(CEN, null, t18('08:10'), true), stop(KRK, t18('11:20'))], 'P', '2026-11-18T09:50:00Z') };
  assert.equal(L.pinnedState(t.key, schedule([t]), live, at('10:59')).status, 'enroute');
});

// --------------------------------------------------------------------------- zapytania

test('live keys: pin first, enroute, upcoming ≤ 4 h, recently arrived; max 30', () => {
  const trains = [
    train({ oid: 1, dep: '05:20', arr: '07:38' }), // dojechał 12 min temu
    train({ oid: 2, dep: '04:20', arr: '07:10' }), // dojechał 40 min temu
    train({ oid: 3, dep: '06:15', arr: '08:58' }), // w drodze
    train({ oid: 4, dep: '08:05', arr: '10:44' }),
    train({ oid: 5, dep: '11:45', arr: '14:20' }),
    train({ oid: 6, dep: '11:55', arr: '14:30' }), // > 4 h
    train({ oid: 7, dir: 'waw', dep: '13:00', arr: '15:20' }), // przypięty, inny kierunek
  ];
  const keys = L.liveKeys(schedule(trains), 'krk', {}, at('07:50'), trains[6].key);
  assert.deepEqual(keys.map((k) => +k.split('/')[1]), [7, 3, 4, 5, 1]);

  const many = Array.from({ length: 40 }, (_, i) => train({ oid: 100 + i, dep: '08:00', arr: '10:30' }));
  assert.equal(L.liveKeys(schedule(many), 'krk', {}, at('07:50')).length, 30);
});

test('merge live keeps last good data on error', () => {
  const prev = { a: okEntry([], 'P', '2026-11-18T06:40:00Z') };
  const resp = { fetched_at: '2026-11-18T06:50:00Z', trains: {
    a: { state: 'error', http: 503 }, b: { state: 'none' }, c: okEntry([], 'S', '2026-11-18T06:49:00Z') } };
  const m = L.mergeLive(prev, resp, at('07:50'));
  assert.equal(m.a.checked_at, '2026-11-18T06:40:00Z');
  assert.deepEqual(m.b, { state: 'none', at: Date.parse('2026-11-18T06:50:00Z') });
  assert.equal(m.c.train_status, 'S');
  const later = L.mergeLive(m, { fetched_at: '2026-11-19T07:00:00Z', trains: {} }, at('08:00', '2026-11-19'));
  assert.deepEqual(Object.keys(later), []);
});

// --------------------------------------------------------------------------- etykiety

test('platform note for live upcoming train', () => {
  const t = train({ oid: 4, dep: '08:05', arr: '10:44' });
  const live = okEntry([stop(CEN, null, t18('08:05')), stop(KRK, t18('10:44'))], 'S');
  assert.equal(L.upcomingNote(L.trainState(t, live, at('07:50')), at('07:50')), 'peron 4 · tor 2');
  const noPl = train({ oid: 5, dep: '08:05', arr: '10:44', platform: null, track: null });
  assert.equal(L.upcomingNote(L.trainState(noPl, live, at('07:50')), at('07:50')), 'peron jeszcze nieznany');
  assert.equal(L.platformLabel({ platform: '4', track: null, bus: false }), 'peron 4');
  assert.equal(L.platformLabel({ platform: null, track: null, bus: true }), 'autobus zastępczy');
});

test('station flag for non-Centralna Warsaw station', () => {
  const s = schedule([]);
  assert.equal(L.stationFlag(train({ oid: 1, dep: '09:35', arr: '11:53', waw: GDA }), s), 'z W-wy Gdańskiej');
  assert.equal(L.stationFlag(train({ oid: 1, dir: 'waw', dep: '09:35', arr: '11:53', waw: GDA }), s), 'do W-wy Gdańskiej');
  assert.equal(L.stationFlag(train({ oid: 1, dep: '09:35', arr: '11:53', waw: ZACH }), s), 'z W-wy Zachodniej');
  assert.equal(L.stationFlag(train({ oid: 1, dir: 'waw', dep: '09:35', arr: '11:53', waw: 34868 }), s), 'do W-wy Wschodniej');
  assert.equal(L.stationFlag(train({ oid: 1, dep: '09:35', arr: '11:53' }), s), null);
});

test('countdown, duration, short names, label', () => {
  assert.equal(L.countdown(at('08:10'), at('07:50')), 'za 20 min');
  assert.equal(L.countdown(at('09:05'), at('07:50')), 'za 1 h 15 min');
  assert.equal(L.countdown(at('09:50'), at('07:50')), 'za 2 h');
  assert.equal(L.countdown(at('07:50') + 30_000, at('07:50')), 'za chwilę');
  assert.equal(L.duration(at('05:20'), at('07:38')), '2 h 18 min');
  assert.equal(L.duration(at('21:35'), at('00:58', '2026-11-19')), '3 h 23 min');
  assert.equal(L.shortStation('Warszawa Zachodnia'), 'W-wa Zachodnia');
  assert.equal(L.shortStation('Opoczno Południe'), 'Opoczno Płd.');
  assert.equal(L.shortStation('Grodzisk Mazowiecki'), 'Grodzisk Maz.');
  assert.equal(L.trainLabel({ cat: 'EIP', no: '1300' }), 'EIP 1300');
  assert.equal(L.noTrainsText('krk'), 'Dziś nie ma już bezpośrednich pociągów do Krakowa');
});

test('refresh age turns red at 60 min', () => {
  const now = at('18:40');
  assert.deepEqual(L.refreshAge(now - 30_000, now), { text: 'odśw. przed chwilą', stale: false });
  assert.deepEqual(L.refreshAge(now - 7 * 60_000, now), { text: 'odśw. 7 min temu', stale: false });
  assert.deepEqual(L.refreshAge(now - 59 * 60_000, now), { text: 'odśw. 59 min temu', stale: false });
  assert.deepEqual(L.refreshAge(now - 60 * 60_000, now), { text: 'odśw. 1 h temu', stale: true });
  assert.deepEqual(L.refreshAge(now - 72 * 60_000, now), { text: 'odśw. 1 h 12 min temu', stale: true });
  assert.equal(L.refreshAge(undefined, now).stale, false);
});

test('schedule age by Warsaw date of generated_at', () => {
  const now = at('07:50');
  assert.deepEqual(L.scheduleAge('2026-11-18T01:31:12Z', now), { text: 'rozkład z dziś', stale: false });
  assert.deepEqual(L.scheduleAge('2026-11-17T23:30:00Z', now), { text: 'rozkład z dziś', stale: false }); // 00:30 w Warszawie
  assert.deepEqual(L.scheduleAge('2026-11-17T01:31:12Z', now), { text: 'rozkład z wczoraj', stale: true });
  assert.deepEqual(L.scheduleAge('2026-11-15T01:31:12Z', now), { text: 'rozkład sprzed 3 dni', stale: true });
});

test('real recon sample (EIP Kraków → Warszawa, nonstop, in progress)', async () => {
  const { readFileSync } = await import('node:fs');
  const real = JSON.parse(readFileSync(new URL('../../worker/test/fixtures/recon/operation_w.json', import.meta.url), 'utf8'));
  const entry = okEntry(real.stations.map((s) => stop(s.stationId, s.actualArrival, s.actualDeparture, s.isConfirmed === true, s.isCancelled === true)),
    real.trainStatus, '2026-11-21T13:06:00Z');
  const t = train({ oid: real.orderId, date: '2026-11-21', dir: 'waw', dep: '13:43', arr: '16:20' });
  const now = at('14:06', '2026-11-21');
  const s = L.trainState(t, entry, now, STATIONS);
  assert.equal(s.status, 'enroute');
  assert.equal(s.lastStation, 'Kraków Główny');
  assert.equal(L.fmtTime(s.expArr), '16:20');
  assert.deepEqual(L.statusPill(s), { text: 'planowo', kind: 'ontime' });
});
