// Stan, pobieranie, render i zdarzenia (SPEC 6–9). Logika domenowa: logic.js.
import * as L from './logic.js';
import { LIVE_URL } from './config.js';

const REFRESH_EVERY_MS = 60_000; // SPEC 6: jedyny polling, tylko gdy strona widoczna
const TICK_MS = 30_000; // przeliczenie etykiet bez sieci
const SCHEDULE_EVERY_MS = 3600_000;
const TOAST_MS = 4000;
const LIVE_TIMEOUT_MS = 15_000;
const COMPACT_AT = 60;

// --------------------------------------------------------------------------- tryb demo i pamięć

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo');

/** localStorage z obsługą błędów; w demo — pamięć tylko w karcie (nie psuje prawdziwego stanu). */
const store = (() => {
  const mem = new Map();
  const ls = (() => {
    if (DEMO) return null;
    try {
      const k = '__t';
      localStorage.setItem(k, k);
      localStorage.removeItem(k);
      return localStorage;
    } catch {
      return null;
    }
  })();
  return {
    get(key) {
      try {
        const raw = ls ? ls.getItem(key) : mem.get(key);
        return raw == null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      try {
        if (ls) ls.setItem(key, raw);
        else mem.set(key, raw);
      } catch {
        // pełny storage — trudno, działa bez pamięci
      }
    },
    del(key) {
      try {
        if (ls) ls.removeItem(key);
        else mem.delete(key);
      } catch {
        // j.w.
      }
    },
  };
})();

let demoNow = null;
const now = () => demoNow ?? Date.now();

// --------------------------------------------------------------------------- stan

const state = {
  schedule: null,
  scheduleAt: 0,
  scheduleFailed: false,
  loading: true,
  live: {},
  liveAt: NaN,
  lastAttempt: 0,
  refreshing: false,
  showEarlier: false, // rozwinięty wiersz „Wcześniejsze" (dojechały, odwołane, w drodze)
  earlierSum: null,
  open: new Set(), // klucze kafelków rozwiniętych do listy stacji
  compact: false,
  demo: null,
};

const hdr = document.getElementById('hdr');
const main = document.getElementById('main');
const toast = document.getElementById('toast');

function currentDir() {
  return L.effectiveDir(store.get('dir'), now());
}

// --------------------------------------------------------------------------- przypięte pociągi (SPEC 5.5)
// Osobno dla każdego kierunku, wspólne dla wszystkich urządzeń: zapis PUT /pin w Workerze, odczyt w odpowiedzi /live.
// Lokalnie {krk: {key, at, pending}, waw: …}; `pending` = zmiana jeszcze niezapisana w Workerze (ponowienie przy odświeżeniu).

const DIR_NAME = { krk: 'Do Krakowa', waw: 'Do Warszawy' };

/** Stary zapis jednego pociągu (`pin`) jest czytany tylko do pierwszego zapisu w nowym formacie. */
function getPins() {
  return L.loadPins(store.get('pins'), store.get('pin'), state.schedule);
}

function savePins(pins) {
  store.set('pins', pins);
  store.del('pin');
}

const pinKeys = () => L.PIN_DIRS.map((d) => getPins()[d].key).filter(Boolean);
const currentPinned = () => L.pinnedStates(getPins(), state.schedule, state.live, now());

const liveBase = () => LIVE_URL.replace(/\/$/, '');

function timeoutOpts(extra = {}) {
  const opts = { cache: 'no-store', ...extra };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(LIVE_TIMEOUT_MS);
  return opts;
}

function setPin(dir, key) {
  const pins = getPins();
  pins[dir] = { key, at: null, pending: !state.demo && !!LIVE_URL };
  savePins(pins);
  pushPins();
}

async function pushPins() {
  if (!LIVE_URL || state.demo) return;
  for (const dir of L.PIN_DIRS) {
    const p = getPins()[dir];
    if (!p.pending) continue;
    try {
      const r = await fetch(`${liveBase()}/pin`, timeoutOpts({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, key: p.key }),
      }));
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      // w międzyczasie mogło być kolejne stuknięcie — wtedy ono wygrywa
      const pins = getPins();
      if (pins[dir].key === p.key) {
        pins[dir] = { key: body?.pin?.key ?? null, at: body?.pin?.at ?? null, pending: false };
        savePins(pins);
      }
    } catch {
      flash('Nie udało się zapisać przypięcia — spróbuję przy odświeżeniu');
      return;
    }
  }
}

function setDir(dir) {
  store.set('dir', { date: L.warsawDate(now()), dir });
  render();
  refreshLive();
}

// --------------------------------------------------------------------------- render

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const t = (ms) => L.fmtTime(ms);

const ICON_REFRESH = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"></path><path d="M20 4v5h-5"></path></svg>';
const ICON_SWAP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4"></path><path d="M3 8h14"></path><path d="M17 20l4-4-4-4"></path><path d="M21 16H7"></path></svg>';
const ICON_FLAG = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"></path><path d="M5 4h12l-2 4 2 4H5"></path></svg>`;
// Pinezka: wypełnienie główki w CSS (.hd), żeby zmiana przypięcia była płynna.
const ICON_PIN = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path class="hd" d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2z"></path></svg>';
const ICON_CHEV = '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';
const ICON_CHECK = '<span class="st-ico" role="img" aria-label="dojechał"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg></span>';
const ICON_X = '<span class="st-ico" role="img" aria-label="odwołany"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"></path></svg></span>';

function ages() {
  const n = now();
  const ref = LIVE_URL || state.demo ? L.refreshAge(state.liveAt, n) : { text: 'na żywo wyłączone', stale: false };
  const sch = state.schedule ? L.scheduleAge(state.schedule.generated_at, n) : null;
  return `<div class="ages">
    <span class="age${ref.stale ? ' stale' : ''}">${esc(ref.text)}</span>
    ${sch ? `<span class="age${sch.stale ? ' stale' : ''}">${esc(sch.text)}</span>` : ''}
  </div>`;
}

function refreshButton() {
  return `<button type="button" class="refresh${state.refreshing ? ' busy' : ''}" data-action="refresh" data-fid="refresh"
    aria-label="Odśwież opóźnienia"${state.refreshing ? ' aria-busy="true"' : ''}>${ICON_REFRESH}</button>`;
}

function renderHeader() {
  const dir = currentDir();
  const onKrk = dir === 'krk';
  const c = state.compact;
  // Oba układy są zawsze w DOM; zwijanie to tylko klasa `compact` (płynne przejście w CSS),
  // a niewidoczna część jest `inert` (niedostępna dla fokusu i czytników).
  hdr.classList.toggle('compact', c);
  hdr.innerHTML = `<div class="hdr-in">
    <div class="hdr-row">
      <div class="lead">
        <div class="title"${c ? ' inert' : ''}><h1>Pociągi</h1><p>${esc(L.dateLong(L.warsawDate(now())))}</p></div>
        <button type="button" class="swap" data-action="swap" data-fid="swap"${c ? '' : ' inert'}
          aria-label="Zmień kierunek, teraz ${onKrk ? 'Do Krakowa' : 'Do Warszawy'}">
          <span>${onKrk ? 'Do KRK' : 'Do WAW'}</span>${ICON_SWAP}</button>
      </div>
      <div class="status">${ages()}${refreshButton()}</div>
    </div>
    <div class="dirs-wrap"${c ? ' inert' : ''}><div class="dirs-clip">
      <div class="dirs" role="group" aria-label="Kierunek jazdy">
        <button type="button" class="dir" data-action="dir" data-dir="krk" data-fid="dir-krk" aria-pressed="${onKrk}">
          <span class="sub">z Warszawy</span><span class="big">Do Krakowa</span></button>
        <button type="button" class="dir" data-action="dir" data-dir="waw" data-fid="dir-waw" aria-pressed="${!onKrk}">
          <span class="sub">z Krakowa Gł.</span><span class="big">Do Warszawy</span></button>
      </div>
    </div></div>
  </div>`;
  measureHeader();
}

/** Treść ma stały odstęp = wysokość ROZWINIĘTEGO nagłówka (liczona także w trakcie zwijania), więc lista nie skacze. */
function measureHeader() {
  const row = hdr.querySelector('.hdr-row');
  const dirs = hdr.querySelector('.dirs');
  const wrap = hdr.querySelector('.dirs-wrap');
  if (!row || !dirs || !wrap) return;
  const cs = getComputedStyle(hdr);
  const gap = parseFloat(getComputedStyle(wrap).getPropertyValue('--gap')) || 12;
  const h = row.offsetHeight + gap + dirs.offsetHeight
    + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
  if (h > 0) document.documentElement.style.setProperty('--hdr-h', `${Math.round(h)}px`);
}

/** Zwinięcie/rozwinięcie bez przerysowania — żeby przejście CSS mogło się odegrać. */
function setCompact(c) {
  if (c === state.compact) return;
  state.compact = c;
  hdr.classList.toggle('compact', c);
  const title = hdr.querySelector('.title');
  const swap = hdr.querySelector('.swap');
  const wrap = hdr.querySelector('.dirs-wrap');
  const active = document.activeElement;
  const lostFocus = active && ((c && (title?.contains(active) || wrap?.contains(active))) || (!c && swap?.contains(active)));
  if (title) title.inert = c;
  if (wrap) wrap.inert = c;
  if (swap) swap.inert = !c;
  if (lostFocus) (c ? swap : hdr.querySelector('.dir[aria-pressed="true"]'))?.focus({ preventScroll: true });
}

function pillHtml(p) {
  return `<span class="pill pill-${p.kind}">${esc(p.text)}</span>`;
}

function flagHtml(train, size = 12) {
  const f = L.stationFlag(train, state.schedule);
  return f ? `<span class="flag">${ICON_FLAG(size)}${esc(f)}</span>` : '';
}

function timesHtml(st, { depLate, arrLate }) {
  return `<div class="times num">
    <span class="dep${depLate ? ' late' : ''}">${t(st.expDep)}</span><span class="arrow" aria-hidden="true">→</span><span class="arr${arrLate ? ' late' : ''}">${t(st.expArr)}</span>
  </div>`;
}

function planHtml(st) {
  if (st.depDelay < 1 && st.arrDelay < 1) return '';
  return `<span class="plan num">plan ${t(st.planDep)} → ${t(st.planArr)}</span>`;
}

const pinLabel = (on, train) => `${on ? 'Odepnij' : 'Przypnij'} ${L.trainLabel(train)}`;

function pinBtn(st, pinKey) {
  if (!L.canPin(st)) return '<span class="pinbtn" aria-hidden="true"></span>';
  const on = st.key === pinKey;
  return `<button type="button" class="pinbtn" data-action="pin" data-key="${esc(st.key)}" data-pdir="${esc(st.train.dir)}"
    data-fid="pin-${esc(st.key)}" aria-pressed="${on}" aria-label="${esc(pinLabel(on, st.train))}">${ICON_PIN}</button>`;
}

/** Przezroczysty przycisk na całym kafelku: stuknięcie rozwija/zwija listę stacji (pinezka leży nad nim). */
function openHtml(train, id = train.key) {
  if (!Array.isArray(train.stops) || train.stops.length < 2) return '';
  const on = state.open.has(id);
  return `<button type="button" class="open" data-action="stops" data-key="${esc(id)}" data-fid="open-${esc(id)}"
    aria-expanded="${on}" aria-label="${on ? 'Zwiń' : 'Pokaż'} stacje: ${esc(L.trainLabel(train))}"></button>`;
}

function stopsHtml(train, id = train.key) {
  if (!state.open.has(id)) return '';
  const rows = L.stopsView(train, state.live[train.key], now(), state.schedule?.stations || {});
  if (!rows.length) return '';
  const nextIdx = rows.findIndex((r) => !r.passed);
  return `<ol class="stops" aria-label="Stacje">${rows
    .map((r, i) => {
      const late = r.delay >= 1;
      const cls = [r.kind, r.passed ? 'passed' : '', i === nextIdx && nextIdx > 0 ? 'next' : ''].filter(Boolean).join(' ');
      return `<li class="${cls}">
        <span class="st-t num"><span class="${late ? 'late' : ''}">${t(r.exp)}</span>${late ? `<s>${t(r.plan)}</s>` : ''}</span>
        <span class="st-dot" aria-hidden="true"></span>
        <span class="st-n">${esc(r.name)}${r.passed ? '<span class="vh"> (miniona)</span>' : ''}</span>
      </li>`;
    })
    .join('')}</ol>`;
}

/** Duża forma przypiętego (kierunek wybrany): godziny + numer, plan + odliczanie, peron/ostatnio + pastylka. */
function pinBig(st) {
  const n = now();
  const id = `pin:${st.key}`;
  let chips = '';
  if (st.cancelled) chips = '<span class="txt">sprawdź komunikat przewoźnika</span>';
  else if (st.status === 'upcoming') {
    const f = st.train.from;
    if (f.bus) chips = '<span class="peron">autobus zastępczy</span>';
    else if (f.platform) chips = `<span class="peron">peron ${esc(f.platform)}</span>${f.track ? `<span class="txt">tor ${esc(f.track)}</span>` : ''}`;
    else chips = '<span class="txt">peron jeszcze nieznany</span>';
  } else if (st.status === 'enroute' && st.lastStation) {
    chips = `<span class="txt">ostatnio: ${esc(L.shortStation(st.lastStation))}</span>`;
  }
  const late = !st.cancelled && (st.depDelay >= 1 || st.arrDelay >= 1);
  const pct = Math.round((st.progress ?? 0.5) * 100);
  return `<section class="pin" aria-label="Przypięty pociąg ${esc(DIR_NAME[st.train.dir].toLowerCase())}: ${esc(L.trainLabel(st.train))}">
    ${openHtml(st.train, id)}
    <div class="r">${timesHtml(st, {})}<span class="n">${esc(L.trainLabel(st.train))}</span></div>
    <div class="r r2">${late ? `<span class="plan num">plan ${t(st.planDep)} → ${t(st.planArr)}</span>` : ''}<span class="count">${esc(L.pinCountdown(st, n))}</span></div>
    <div class="chips">${chips}${pillHtml(L.pinPill(st))}${flagHtml(st.train, 12)}</div>
    ${st.status === 'enroute' ? `<div class="pbar" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ''}
    ${stopsHtml(st.train, id)}
  </section>`;
}

/** Mała forma (drugi kierunek): stuknięcie przełącza kierunek. */
function pinSmall(st, dir) {
  const label = L.trainLabel(st.train);
  return `<button type="button" class="pin2" data-action="dir" data-dir="${dir}" data-fid="goto-${dir}"
    aria-label="${esc(`Przełącz na kierunek ${DIR_NAME[dir]}: przypięty ${label}, ${t(st.expDep)} do ${t(st.expArr)}`)}">
    <span class="grow"><span class="k">${DIR_NAME[dir]}</span><span>${esc(label)} · ${esc(L.pinCountdown(st, now()))}</span></span>
    <span class="t num">${t(st.expDep)} → ${t(st.expArr)}</span>
  </button>`;
}

const pinsHtmlCache = new WeakMap();
function setHtml(el, html) {
  if (pinsHtmlCache.get(el) === html) return;
  el.innerHTML = html;
  pinsHtmlCache.set(el, html);
}

/**
 * Kontener przypiętych aktualizowany w miejscu (stałe węzły, KRK u góry, WAW na dole), żeby przejścia CSS
 * mogły się odegrać: wybrany kierunek `big`, drugi `small`, nieprzypięty `none` (wysokość → 0, treść zostaje
 * na czas zwijania).
 */
function renderPins(pinned) {
  const wrap = document.getElementById('pins-wrap');
  if (!wrap) return;
  const dir = currentDir();
  let any = false;
  for (const d of L.PIN_DIRS) {
    const el = document.getElementById(`pi-${d}`);
    const st = pinned?.[d] ?? null;
    const mode = !st ? 'none' : d === dir ? 'big' : 'small';
    el.classList.remove('none', 'big', 'small');
    el.classList.add(mode);
    const [fs, fb] = el.querySelectorAll('.f > div');
    if (st) {
      any = true;
      setHtml(fs, pinSmall(st, d));
      setHtml(fb, pinBig(st));
    }
    fs.parentElement.inert = mode !== 'small';
    fb.parentElement.inert = mode !== 'big';
  }
  wrap.classList.toggle('empty', !any);
  wrap.inert = !any;
}

/** Pinezki i obwódki na liście zmieniane w miejscu — bez przerysowania, więc przejścia CSS się odgrywają. */
function syncListPins() {
  const pins = getPins();
  for (const b of main.querySelectorAll('[data-action="pin"]')) {
    const on = pins[b.dataset.pdir]?.key === b.dataset.key;
    const train = state.schedule?.trains?.find((x) => x.key === b.dataset.key);
    b.setAttribute('aria-pressed', on);
    if (train) b.setAttribute('aria-label', pinLabel(on, train));
    b.closest('[data-card]')?.classList.toggle('pinned', on);
  }
}

/**
 * Trzyma element w tym samym miejscu ekranu, gdy kontener przypiętych nad nim rośnie lub maleje
 * (kafelek nie odjeżdża spod palca). Tylko na czas przejścia CSS (SPEC 6), bez sieci: działa co najmniej `ms`,
 * potem do ustabilizowania pozycji (3 klatki bez korekty), najdłużej 2 s. Palec lub kółko przerywa.
 */
function keepInPlace(el, ms = 600) {
  const sc = document.scrollingElement || document.documentElement;
  const y0 = el.getBoundingClientRect().top;
  const t0 = performance.now();
  let stopped = false;
  let still = 0;
  const stop = () => (stopped = true);
  addEventListener('touchstart', stop, { once: true, passive: true });
  addEventListener('wheel', stop, { once: true, passive: true });
  const step = () => {
    if (stopped || !el.isConnected) return; // lista przerysowana w trakcie — nie ma już czego trzymać
    const d = el.getBoundingClientRect().top - y0;
    if (Math.abs(d) >= 0.5) {
      sc.scrollTop += d;
      still = 0;
    } else still++;
    const t = performance.now() - t0;
    if (t < 2000 && (t < ms || still < 3)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function pastRow(st) {
  const cx = st.cancelled;
  return `<div class="row2 past${cx ? ' cx' : ''}">
    <span class="t num">${t(cx ? st.planDep : st.expDep)} → ${t(cx ? st.planArr : st.expArr)}</span>
    <span class="nm"><span>${esc(L.trainLabel(st.train))}</span></span>
    ${pillHtml(L.statusPill(st))}
    ${cx ? ICON_X : ICON_CHECK}
  </div>`;
}

function goRow(st, pinKey) {
  const pct = Math.round((st.progress ?? 0.5) * 100);
  const last = st.lastStation ? `<span class="last">ostatnio: ${esc(L.shortStation(st.lastStation))}</span>` : '';
  return `<div class="row2 go${st.key === pinKey ? ' pinned' : ''}" data-card="${esc(st.key)}">
    ${openHtml(st.train)}
    <span class="t num">${t(st.expDep)} → ${t(st.expArr)}</span>
    <span class="nm"><span>${esc(L.trainLabel(st.train))}</span></span>
    ${pillHtml(L.statusPill(st))}
    ${pinBtn(st, pinKey)}
    ${last}
    ${stopsHtml(st.train)}
    <span class="mb" aria-hidden="true"><i style="width:${pct}%"></i></span>
  </div>`;
}

function earlierText(sum, open) {
  if (open) return '<b>Ukryj wcześniejsze pociągi</b>';
  return `<b>${esc(sum.text)}</b>${sum.next ? `<span class="num">${esc(sum.next)}</span>` : ''}`;
}

/** Wiersze są zawsze w DOM; rozwijanie to tylko klasa `is-open` (płynne przejście w CSS), ukryta część jest `inert`. */
function earlierHtml(lists, pinKey) {
  const sum = L.earlierSummary(lists);
  state.earlierSum = sum;
  if (!sum) return '';
  const open = state.showEarlier;
  return `<div class="earlier${open ? ' is-open' : ''}" id="earlier">
    <button type="button" class="sum" data-action="earlier" data-fid="earlier" aria-expanded="${open}">
      <span class="txt" id="earlier-txt">${earlierText(sum, open)}</span>${ICON_CHEV}</button>
    <div class="ex"${open ? '' : ' inert'}><div><div class="rows">${
      [...lists.arrived.map(pastRow), ...lists.enroute.map((s) => goRow(s, pinKey))].join('')
    }</div></div></div>
  </div>`;
}

function toggleEarlier() {
  const box = document.getElementById('earlier');
  if (!box || !state.earlierSum) return;
  state.showEarlier = !state.showEarlier;
  const open = state.showEarlier;
  box.classList.toggle('is-open', open);
  box.querySelector('.ex').inert = !open;
  box.querySelector('.sum').setAttribute('aria-expanded', open);
  document.getElementById('earlier-txt').innerHTML = earlierText(state.earlierSum, open);
}

function upcomingCard(st, pinKey) {
  const late = !st.cancelled && st.depDelay >= 1;
  return `<article class="card up${st.key === pinKey ? ' pinned' : ''}${st.cancelled ? ' cancelled' : ''}" data-card="${esc(st.key)}">
    ${openHtml(st.train)}
    <div class="row"><div class="body">
      <div class="tt">
        ${timesHtml(st, { depLate: late, arrLate: late })}
        ${st.cancelled ? '' : planHtml(st)}
      </div>
      <div class="meta">
        <span class="tl">${esc(L.trainLabel(st.train))}</span>
        ${pillHtml(L.statusPill(st))}
        <span class="sub">${esc(L.upcomingNote(st, now()))}</span>
      </div>
      ${flagHtml(st.train)}
    </div>
    ${pinBtn(st, pinKey)}</div>
    ${stopsHtml(st.train)}
  </article>`;
}

function tomorrowTile(train) {
  const dep = train.from.dep * 1000;
  const arr = train.to.arr * 1000;
  return `<div class="tile${state.open.has(train.key) ? ' is-open' : ''}">
    ${openHtml(train)}
    <span class="num"><span class="dep">${t(dep)}</span> <span class="arr"><span aria-hidden="true">→ </span>${t(arr)}</span></span>
    <span class="info">${esc(train.cat)} · ${esc(L.duration(dep, arr))}</span>
    ${flagHtml(train, 11)}
    ${stopsHtml(train)}
  </div>`;
}

function footer() {
  const attr = state.schedule?.attribution || 'Dane: PKP Polskie Linie Kolejowe S.A.';
  return `<p class="footer"><a href="https://pdp-api.plk-sa.pl" title="${esc(attr)}" rel="noopener">Źródło: PKP PLK</a></p>`;
}

/** Stały szkielet: kontener przypiętych (przejścia CSS) + treść przerysowywana przy każdym renderze. */
function mainShell() {
  const slot = (d) => `<div class="pi none" id="pi-${d}"><div class="f f-small"><div></div></div><div class="f f-big"><div></div></div></div>`;
  main.innerHTML = `<div class="pins-wrap empty" id="pins-wrap" inert><div class="pw-in">
      <p class="pins-l" id="pins-l">Przypięte</p>
      <section class="pins" aria-labelledby="pins-l">${L.PIN_DIRS.map(slot).join('')}</section>
    </div></div>
    <div class="content" id="content"></div>`;
}

function renderMain() {
  const n = now();
  const content = document.getElementById('content');
  if (state.loading && !state.schedule) {
    renderPins(null);
    content.innerHTML = `<div class="sec" aria-busy="true" aria-label="Ładowanie rozkładu">
      <div class="skel s"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>
    </div>`;
    return;
  }
  if (!L.hasToday(state.schedule, n)) {
    renderPins(null);
    content.innerHTML = `<p class="msg box"><strong>Brak rozkładu na dziś</strong>${
      state.schedule ? 'Plik z rozkładem jest nieaktualny — sprawdź workflow w GitHub Actions.' : 'Nie udało się pobrać rozkładu. Sprawdź połączenie i odśwież stronę.'
    }</p>${footer()}`;
    return;
  }

  const dir = currentDir();
  const today = L.warsawDate(n);
  const tomorrow = L.addDays(today, 1);
  const lists = L.todayLists(state.schedule, dir, state.live, n);
  const pinned = currentPinned();
  const activePin = pinned[dir]?.key ?? null;
  renderPins(pinned);

  const parts = [];
  const today_ = [];
  today_.push(`<div class="sec-h"><h2>Dziś</h2><span>${esc(L.dateShort(today))}</span></div>`);
  today_.push(earlierHtml(lists, activePin));
  today_.push(`<div class="now"><span class="num">Teraz ${t(n)}</span><span aria-hidden="true"></span></div>`);
  if (lists.upcoming.length) {
    today_.push(`<div class="list">${lists.upcoming.map((s) => upcomingCard(s, activePin)).join('')}</div>`);
  }
  if (!lists.upcoming.length && !lists.enroute.length) {
    today_.push(`<p class="msg">${esc(L.noTrainsText(dir))}</p>`);
  }
  parts.push(`<section class="sec" aria-label="Dziś">${today_.join('')}</section>`);

  const tl = L.tomorrowList(state.schedule, dir, n);
  parts.push(`<section class="sec" aria-label="Jutro">
    <div class="sec-h"><h2>Jutro</h2><span>${esc(L.dateShort(tomorrow))} · rozkładowo</span></div>
    ${tl.length ? `<div class="grid">${tl.map(tomorrowTile).join('')}</div>` : '<p class="msg">Brak rozkładu na jutro.</p>'}
    <p class="note">Opóźnienia i perony pojawią się ok. 3 h przed odjazdem.</p>
  </section>`);
  parts.push(footer());
  content.innerHTML = parts.join('');
}

function render() {
  const fid = document.activeElement?.dataset?.fid;
  renderHeader();
  renderMain();
  if (fid) document.querySelector(`[data-fid="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
}

let toastTimer = 0;
function flash(text) {
  toast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.textContent = ''), TOAST_MS);
}

// --------------------------------------------------------------------------- dane

async function loadSchedule() {
  if (state.demo) return;
  try {
    const r = await fetch('data/trains.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    if (data?.schema_version !== 1 || !Array.isArray(data.trains)) throw new Error('schema');
    state.schedule = data;
    state.scheduleAt = Date.now();
    store.set('schedule', data);
  } catch {
    state.scheduleFailed = true;
    if (!state.schedule) state.schedule = store.get('schedule');
  } finally {
    state.loading = false;
  }
}

async function refreshLive() {
  if (state.refreshing) return;
  state.lastAttempt = now();
  if (state.demo) {
    if (state.demo.live_error) flash('Nie udało się odświeżyć');
    else state.liveAt = now();
    render();
    return;
  }
  if (!LIVE_URL || !state.schedule) return;
  state.refreshing = true;
  renderHeader();
  try {
    if (L.PIN_DIRS.some((d) => getPins()[d].pending)) await pushPins();
    const keys = L.liveKeys(state.schedule, currentDir(), state.live, now(), pinKeys());
    // Także bez kursów (np. w nocy): odpowiedź niesie wspólny przypięty pociąg.
    const r = await fetch(`${liveBase()}/live?t=${keys.join(',')}`, timeoutOpts());
    if (!r.ok) throw new Error(String(r.status));
    const body = await r.json();
    if (body && ('pins' in body || 'pin' in body)) savePins(L.adoptServerPins(getPins(), body, state.schedule));
    const entries = Object.values(body?.trains || {});
    if (entries.length && entries.every((e) => e?.state === 'error')) throw new Error('all-errors');
    state.live = L.mergeLive(state.live, body, now());
    state.liveAt = now();
    store.set('live', { live: state.live, at: state.liveAt });
  } catch {
    flash('Nie udało się odświeżyć');
  } finally {
    state.refreshing = false;
    render();
  }
}

async function loadDemo(name) {
  const r = await fetch(`demo/${encodeURIComponent(name)}.json`, { cache: 'no-cache' });
  let d = await r.json();
  if (d.states) {
    const names = Object.keys(d.states);
    d = d.states[params.get('stan')] || d.states[names[0]];
  }
  state.demo = d;
  const nowParam = params.get('now');
  const nowLocal = nowParam
    ? (/^\d{1,2}:\d{2}$/.test(nowParam) ? `${d.now.slice(0, 10)}T${nowParam.padStart(5, '0')}:00` : nowParam)
    : d.now;
  demoNow = L.localToMs(nowLocal) ?? Date.now();
  if (d.pins) store.set('pins', { krk: { key: d.pins.krk ?? null }, waw: { key: d.pins.waw ?? null } });
  if (d.loading) return; // stan „ładowanie" — rozkład nie przychodzi
  state.schedule = d.schedule;
  state.live = d.live || {};
  state.liveAt = Date.parse(d.live_at);
  state.loading = false;
}

// --------------------------------------------------------------------------- zdarzenia

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === 'refresh') refreshLive();
  else if (a === 'dir') {
    const d = btn.dataset.dir;
    if (d !== currentDir()) setDir(d);
    // pasek przypiętego, w który stuknięto, staje się nieaktywny (inert) — fokus na przełącznik kierunku
    if (btn.classList.contains('pin2')) hdr.querySelector(state.compact ? '.swap' : `.dir[data-dir="${d}"]`)?.focus({ preventScroll: true });
  } else if (a === 'swap') setDir(currentDir() === 'krk' ? 'waw' : 'krk');
  else if (a === 'earlier') toggleEarlier();
  else if (a === 'stops') {
    const key = btn.dataset.key;
    if (state.open.has(key)) state.open.delete(key);
    else state.open.add(key);
    render();
  } else if (a === 'pin') {
    const { key, pdir } = btn.dataset;
    keepInPlace(btn); // pozycja zapamiętana przed zmianą
    setPin(pdir, getPins()[pdir].key === key ? null : key);
    syncListPins();
    renderPins(currentPinned());
  }
});

window.addEventListener('scroll', () => setCompact(window.scrollY > COMPACT_AT), { passive: true });

// Obrót telefonu / zmiana szerokości → nowa wysokość rozwiniętego nagłówka.
window.addEventListener('resize', measureHeader);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  render();
  if (DEMO) return; // demo: odświeżanie tylko przyciskiem
  if (Date.now() - state.scheduleAt > SCHEDULE_EVERY_MS) loadSchedule().then(render);
  if (now() - state.lastAttempt > REFRESH_EVERY_MS) refreshLive();
});

// --------------------------------------------------------------------------- start

async function start() {
  document.documentElement.classList.add('booting'); // pierwszy obraz bez animacji
  mainShell();
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('booting')));
  if (DEMO) {
    try {
      await loadDemo(DEMO);
    } catch {
      state.loading = false;
    }
    render();
    return; // demo: bez sieci i bez pollingu
  }
  const cached = store.get('live');
  if (cached && typeof cached === 'object') {
    state.live = cached.live || {};
    state.liveAt = cached.at;
  }
  state.schedule = store.get('schedule');
  if (state.schedule) state.loading = false;
  render();
  await loadSchedule();
  render();
  refreshLive();

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshLive();
    if (Date.now() - state.scheduleAt > SCHEDULE_EVERY_MS) loadSchedule().then(render);
  }, REFRESH_EVERY_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') render();
  }, TICK_MS);
}

start();
