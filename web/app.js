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
  showArrived: false,
  compact: false,
  demo: null,
};

const hdr = document.getElementById('hdr');
const main = document.getElementById('main');
const toast = document.getElementById('toast');

function currentDir() {
  return L.effectiveDir(store.get('dir'), now());
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
const ICON_STAR = (fill) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"></path></svg>`;

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
  if (state.compact) {
    hdr.innerHTML = `<div class="hdr-in"><div class="hdr-row">
      <button type="button" class="swap" data-action="swap" data-fid="swap"
        aria-label="Zmień kierunek, teraz ${onKrk ? 'Do Krakowa' : 'Do Warszawy'}">
        <span>${onKrk ? 'Do KRK' : 'Do WAW'}</span>${ICON_SWAP}</button>
      <div class="status">${ages()}${refreshButton()}</div>
    </div></div>`;
    return;
  }
  hdr.innerHTML = `<div class="hdr-in">
    <div class="hdr-row">
      <div class="title"><h1>Pociągi</h1><p>${esc(L.dateLong(L.warsawDate(now())))}</p></div>
      <div class="status">${ages()}${refreshButton()}</div>
    </div>
    <div class="dirs" role="group" aria-label="Kierunek jazdy">
      <button type="button" class="dir" data-action="dir" data-dir="krk" data-fid="dir-krk" aria-pressed="${onKrk}">
        <span class="sub">z Warszawy</span><span class="big">Do Krakowa</span></button>
      <button type="button" class="dir" data-action="dir" data-dir="waw" data-fid="dir-waw" aria-pressed="${!onKrk}">
        <span class="sub">z Krakowa Gł.</span><span class="big">Do Warszawy</span></button>
    </div>
  </div>`;
  // Treść ma stały odstęp = wysokość rozwiniętego nagłówka, więc zwijanie nie przesuwa listy.
  const h = hdr.offsetHeight;
  if (h > 0) document.documentElement.style.setProperty('--hdr-h', `${h}px`);
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

function starHtml(st, pinKey) {
  if (!L.canPin(st)) return '<span class="star" aria-hidden="true"></span>';
  const on = st.key === pinKey;
  const label = `${on ? 'Odepnij' : 'Przypnij'} ${L.trainLabel(st.train)}`;
  return `<button type="button" class="star" data-action="pin" data-key="${esc(st.key)}" data-fid="pin-${esc(st.key)}"
    aria-pressed="${on}" aria-label="${esc(label)}">${ICON_STAR(on ? 'currentColor' : 'none')}</button>`;
}

function pinTile(st) {
  const n = now();
  const p = L.pinPill(st);
  let count;
  if (st.cancelled) count = 'pociąg odwołany';
  else if (st.status === 'upcoming') count = `odjazd ${L.countdown(st.expDep, n)}`;
  else if (st.status === 'enroute') count = `przyjazd ${L.countdown(st.expArr, n)}`;
  else count = `dojechał o ${t(st.expArr)}`;

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
  return `<section class="pin" aria-label="Przypięty pociąg">
    <div class="head"><span class="k">Twój pociąg</span><span class="n">${esc(L.trainLabel(st.train))}</span></div>
    <div class="tt">
      ${timesHtml(st, {})}
      ${late ? `<span class="plan num">plan ${t(st.planDep)} → ${t(st.planArr)}</span>` : ''}
      <span class="count">${esc(count)}</span>
    </div>
    <div class="chips">${chips}${pillHtml(p)}</div>
    ${flagHtml(st.train, 13)}
  </section>`;
}

function arrivedRow(st) {
  return `<div class="done">
    <span class="t num"><span class="dep">${t(st.expDep)}</span><span class="arrow" aria-hidden="true">→</span><span class="arr">${t(st.cancelled ? st.planArr : st.expArr)}</span></span>
    <span class="name">${esc(L.trainLabel(st.train))}</span>
    ${pillHtml(L.statusPill(st))}
  </div>`;
}

function enrouteCard(st, pinKey) {
  const last = st.lastStation ? ` <span class="last">· ostatnio: ${esc(L.shortStation(st.lastStation))}</span>` : '';
  const pct = Math.round((st.progress ?? 0.5) * 100);
  return `<article class="card go${st.key === pinKey ? ' pinned' : ''}">
    <div class="top">
      <div class="body">
        ${timesHtml(st, { depLate: st.depDelay >= 1, arrLate: st.arrDelay >= 1 })}
        ${planHtml(st)}
        <span class="tl">${esc(L.trainLabel(st.train))}${last}</span>
        ${flagHtml(st.train)}
      </div>
      <div class="side">${pillHtml(L.statusPill(st))}${starHtml(st, pinKey)}</div>
    </div>
    <div class="bar" aria-hidden="true"><div style="width:${pct}%"></div></div>
  </article>`;
}

function upcomingCard(st, pinKey) {
  const late = !st.cancelled && st.depDelay >= 1;
  return `<article class="card up${st.key === pinKey ? ' pinned' : ''}${st.cancelled ? ' cancelled' : ''}">
    <div class="body">
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
    ${starHtml(st, pinKey)}
  </article>`;
}

function tomorrowTile(train) {
  const dep = train.from.dep * 1000;
  const arr = train.to.arr * 1000;
  return `<div class="tile">
    <span class="num"><span class="dep">${t(dep)}</span> <span class="arr"><span aria-hidden="true">→ </span>${t(arr)}</span></span>
    <span class="info">${esc(train.cat)} · ${esc(L.duration(dep, arr))}</span>
    ${flagHtml(train, 11)}
  </div>`;
}

function footer() {
  const attr = state.schedule?.attribution || 'Dane: PKP Polskie Linie Kolejowe S.A.';
  return `<p class="footer"><a href="https://pdp-api.plk-sa.pl" title="${esc(attr)}" rel="noopener">Źródło: PKP PLK</a></p>`;
}

function renderMain() {
  const n = now();
  if (state.loading && !state.schedule) {
    main.innerHTML = `<div class="sec" aria-busy="true" aria-label="Ładowanie rozkładu">
      <div class="skel s"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>
    </div>`;
    return;
  }
  if (!L.hasToday(state.schedule, n)) {
    main.innerHTML = `<p class="msg box"><strong>Brak rozkładu na dziś</strong>${
      state.schedule ? 'Plik z rozkładem jest nieaktualny — sprawdź workflow w GitHub Actions.' : 'Nie udało się pobrać rozkładu. Sprawdź połączenie i odśwież stronę.'
    }</p>${footer()}`;
    return;
  }

  const dir = currentDir();
  const pinKey = store.get('pin');
  const today = L.warsawDate(n);
  const tomorrow = L.addDays(today, 1);
  const lists = L.todayLists(state.schedule, dir, state.live, n);
  const pinned = L.pinnedState(pinKey, state.schedule, state.live, n);
  if (pinKey && !pinned) store.del('pin');
  const activePin = pinned ? pinKey : null;

  const parts = [];
  if (pinned) parts.push(pinTile(pinned));

  const today_ = [];
  today_.push(`<div class="sec-h"><h2>Dziś</h2><span>${esc(L.dateShort(today))}</span></div>`);
  if (lists.arrived.length) {
    today_.push(`<button type="button" class="toggle" data-action="arrived" data-fid="arrived" aria-expanded="${state.showArrived}">${
      state.showArrived ? 'Ukryj pociągi, które już dojechały' : `Pokaż pociągi, które już dojechały (${lists.arrived.length})`
    }</button>`);
    if (state.showArrived) today_.push(`<div class="list">${lists.arrived.map(arrivedRow).join('')}</div>`);
  }
  if (lists.enroute.length) {
    today_.push('<p class="label-up">W drodze</p>');
    today_.push(`<div class="list">${lists.enroute.map((s) => enrouteCard(s, activePin)).join('')}</div>`);
  }
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
  main.innerHTML = parts.join('');
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
  const keys = L.liveKeys(state.schedule, currentDir(), state.live, now(), store.get('pin'));
  state.refreshing = true;
  renderHeader();
  try {
    if (keys.length) {
      const opts = { cache: 'no-store' };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(LIVE_TIMEOUT_MS);
      const r = await fetch(`${LIVE_URL.replace(/\/$/, '')}/live?t=${keys.join(',')}`, opts);
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      const entries = Object.values(body?.trains || {});
      if (entries.length && entries.every((e) => e?.state === 'error')) throw new Error('all-errors');
      state.live = L.mergeLive(state.live, body, now());
    }
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
  if (d.pin) store.set('pin', d.pin);
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
    if (btn.dataset.dir !== currentDir()) setDir(btn.dataset.dir);
  } else if (a === 'swap') setDir(currentDir() === 'krk' ? 'waw' : 'krk');
  else if (a === 'arrived') {
    state.showArrived = !state.showArrived;
    renderMain();
  } else if (a === 'pin') {
    const key = btn.dataset.key;
    if (store.get('pin') === key) store.del('pin');
    else store.set('pin', key);
    render();
  }
});

window.addEventListener(
  'scroll',
  () => {
    const c = window.scrollY > COMPACT_AT;
    if (c !== state.compact) {
      state.compact = c;
      const fid = document.activeElement?.dataset?.fid;
      renderHeader();
      if (fid) document.querySelector(`[data-fid="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
    }
  },
  { passive: true },
);

// Obrót telefonu / zmiana szerokości → nowa wysokość rozwiniętego nagłówka.
window.addEventListener('resize', () => {
  if (!state.compact) renderHeader();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  render();
  if (DEMO) return; // demo: odświeżanie tylko przyciskiem
  if (Date.now() - state.scheduleAt > SCHEDULE_EVERY_MS) loadSchedule().then(render);
  if (now() - state.lastAttempt > REFRESH_EVERY_MS) refreshLive();
});

// --------------------------------------------------------------------------- start

async function start() {
  render();
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
