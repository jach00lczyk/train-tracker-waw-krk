#!/usr/bin/env python3
"""Faza 0 — jednorazowy rekonesans API Otwarte Dane Kolejowe PKP PLK (SPEC 12).

Uruchom z kluczem w zmiennej środowiskowej (nigdy w argumentach ani w plikach):

    cd pipeline
    PDP_API_KEY=… uv run --python 3.12 python recon.py

Wykonuje ≤ 12 zapytań. Wypisuje raport w Markdown (do wklejenia w `docs/api-findings.md`)
i zapisuje zanonimizowane próbki (bez klucza i nagłówków) do:
`pipeline/tests/fixtures/recon/` i `worker/test/fixtures/recon/`.
Raport zapisuje też do `recon-report.md` w bieżącym katalogu (plik w .gitignore).
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Warsaw")
BASE = "https://pdp-api.plk-sa.pl"
ROOT = Path(__file__).resolve().parents[1]
KRAKOW = "Kraków Główny"
WARSAW = ["Warszawa Centralna", "Warszawa Zachodnia", "Warszawa Wschodnia", "Warszawa Gdańska"]
MAX_REQUESTS = 12

_count = 0
_lines: list[str] = []


def out(line: str = "") -> None:
    _lines.append(line)
    print(line)


def get(path: str, params: dict | None = None) -> tuple[int, dict | None, dict, int]:
    """(status, json|None, wybrane nagłówki, rozmiar). Klucz tylko w nagłówku."""
    global _count
    if _count >= MAX_REQUESTS:
        raise SystemExit("Przekroczony budżet zapytań rekonesansu")
    _count += 1
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    key = os.environ["PDP_API_KEY"].strip()
    req = urllib.request.Request(url, headers={
        "X-API-Key": key, "Accept-Encoding": "gzip", "User-Agent": "train-tracker-recon",
        "Origin": "https://jach00lczyk.github.io",
    })
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read()
            raw = len(body)
            if resp.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            status, headers = resp.status, resp.headers
    except urllib.error.HTTPError as e:
        body, raw, status, headers = e.read(), 0, e.code, e.headers
    took = time.monotonic() - t0
    picked = {k: v for k, v in headers.items()
              if k.lower().startswith(("x-ratelimit", "access-control", "retry-after", "x-data-version"))}
    data = None
    try:
        data = json.loads(body) if body else None
    except ValueError:
        pass
    out(f"- `GET {path}` {sorted((params or {}).keys())} → **{status}**, {len(body) / 1e3:.1f} KB"
        f" (gzip {raw / 1e3:.1f} KB), {took:.1f} s")
    return status, data, picked, len(body)


def stations_by_name(data: dict) -> dict[str, list[int]]:
    st = (data.get("dc") or {}).get("st") or {}
    if isinstance(st, list):
        st = {str(s["id"]): s for s in st}
    by: dict[str, list[int]] = {}
    for sid, s in st.items():
        by.setdefault(s.get("nm"), []).append(int(sid))
    return by


def stops(route: dict) -> list[dict]:
    return [s for s in sorted(route.get("st") or (), key=lambda s: s["ord"]) if s.get("atm") or s.get("dtm")]


def save(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    out(f"  zapisano próbkę `{path.relative_to(ROOT)}`")


def main() -> int:
    if not os.environ.get("PDP_API_KEY", "").strip():
        print("Brak PDP_API_KEY w środowisku", file=sys.stderr)
        return 2
    now = dt.datetime.now(TZ)
    today = now.date()
    out(f"# Rekonesans API — {now:%Y-%m-%d %H:%M} (Europe/Warsaw)\n")

    out("## 1. Wersja danych")
    _, ver, hdr, _ = get("/api/v1/data-version")
    out(f"  `{json.dumps(ver, ensure_ascii=False)[:300]}`")
    out(f"  nagłówki: `{hdr}`")

    out("\n## 2. Przewoźnicy")
    _, carriers, _, _ = get("/api/v1/dictionaries/carriers")
    for c in (carriers or {}).get("carriers", [])[:60]:
        out(f"  - `{c.get('code')}` {c.get('name')}")

    out("\n## 3. Jeden dzień, wszyscy przewoźnicy, `fullRoute=true` (bez `stations`)")
    # Bez `stations` całego kraju byłoby za dużo — filtrujemy po mieście `from`/`to`? Nie: to tnie trasę.
    # Używamy `stations=` z ID z poprzedniego zapytania słownikowego.
    _, dict_st, _, _ = get("/api/v1/dictionaries/stations", {"search": "Kraków Główny", "pageSize": 20})
    krk_ids = [s["id"] for s in (dict_st or {}).get("stations", []) if s.get("name") == KRAKOW]
    _, dict_w, _, _ = get("/api/v1/dictionaries/stations", {"search": "Warszawa", "pageSize": 200})
    waw_ids = {s["name"]: s["id"] for s in (dict_w or {}).get("stations", []) if s.get("name") in WARSAW}
    out(f"  Kraków Główny: {krk_ids}; Warszawa: {waw_ids}")
    ids = ",".join(str(i) for i in krk_ids + list(waw_ids.values()))
    status, day, _, size_day = get("/api/v1/schedules/shortened", {
        "dateFrom": today.isoformat(), "dateTo": today.isoformat(), "stations": ids,
        "fullRoute": "true", "dictionaries": "true"})
    if status != 200 or not day:
        out("  **Brak danych — dalsze kroki pominięte**")
        return finish()
    by_name = stations_by_name(day)
    krk = (by_name.get(KRAKOW) or [None])[0]
    waw = {n: (by_name.get(n) or [None])[0] for n in WARSAW}
    out(f"  ze słownika `dc.st`: Kraków={by_name.get(KRAKOW)}, " +
        ", ".join(f"{n}={by_name.get(n)}" for n in WARSAW))
    out(f"  klucze `dc`: {sorted((day.get('dc') or {}).keys())}")

    def links(route: dict) -> str | None:
        ss = stops(route)
        pos_k = next((i for i, s in enumerate(ss) if s["id"] == krk), None)
        pos_w = [i for i, s in enumerate(ss) if s["id"] in waw.values()]
        if pos_k is None or not pos_w:
            return None
        return "krk" if min(pos_w) < pos_k else "waw"

    ours = [r for r in day.get("rt", []) if links(r)]
    out(f"  kursy w odpowiedzi: {len(day.get('rt', []))}, łączące WAW↔KRK: {len(ours)}")
    out(f"  przewoźnicy (WAW↔KRK): {dict(Counter(r.get('cc') for r in ours))}")
    out(f"  kategorie `ccs`: {dict(Counter(r.get('ccs') for r in ours))}")
    out(f"  kierunki: {dict(Counter(links(r) for r in ours))}")
    out(f"  klucze kursu: {sorted(set().union(*(r.keys() for r in ours))) if ours else []}")
    out(f"  klucze postoju: {sorted(set().union(*(s.keys() for r in ours for s in r.get('st', [])))) if ours else []}")
    for r in ours[:8]:
        out(f"  - cc={r.get('cc')} ccs={r.get('ccs')!r} nn={r.get('nn')!r} nm={r.get('nm')!r} "
            f"ian={r.get('ian')!r} idn={r.get('idn')!r} od={len(r.get('od', []))} dni")
    plat_total = plat_have = pv = 0
    for r in ours:
        for s in stops(r):
            if s["id"] == krk or s["id"] in waw.values():
                plat_total += 1
                plat_have += bool(s.get("dpl") or s.get("apl"))
                pv += bool(s.get("pv"))
    if plat_total:
        out(f"  perony na naszych stacjach: {plat_have}/{plat_total} ({plat_have / plat_total:.0%}), z `pv`: {pv}")
    st_waw = Counter(next((n for n, i in waw.items() if i in {s['id'] for s in stops(r)}), None) for r in ours)
    out(f"  pierwsza warszawska stacja (wg preferencji) per kurs: {dict(st_waw)}")
    if ours:
        sample = dict(ours[0])
        names = (day.get("dc") or {}).get("st") or {}
        used = {str(s["id"]) for s in sample.get("st", [])}
        save(ROOT / "pipeline/tests/fixtures/recon/schedules_one_route.json", {
            "ts": day.get("ts"), "pr": day.get("pr"), "rt": [sample],
            "dc": {"st": {k: v for k, v in (names.items() if isinstance(names, dict) else []) if k in used}}})

    out("\n## 4. Okno 5 dni, `carriersInclude=IC`, `fullRoute=true`")
    carriers_seen = ",".join(sorted({r.get("cc") for r in ours if r.get("cc")})) or "IC"
    window = {"dateFrom": (today - dt.timedelta(days=1)).isoformat(),
              "dateTo": (today + dt.timedelta(days=3)).isoformat(),
              "carriersInclude": carriers_seen, "fullRoute": "true", "dictionaries": "true"}
    _, wide, _, size_wide = get("/api/v1/schedules/shortened", window)
    _, narrow, _, size_narrow = get("/api/v1/schedules/shortened", {**window, "stations": ids})
    n_w = len((wide or {}).get("rt", []))
    n_n = len((narrow or {}).get("rt", []))
    out(f"  bez `stations`: {n_w} kursów, {size_wide / 1e6:.2f} MB; ze `stations`: {n_n} kursów, {size_narrow / 1e6:.2f} MB")
    if narrow:
        full = all(len(r.get("st", [])) > 3 for r in narrow.get("rt", []) if links(r))
        out(f"  `stations=` + `fullRoute=true` zachowuje pełną trasę: {full}")

    out("\n## 5. `/operations/train` — kursy dziś")
    now_s = now.hour * 3600 + now.minute * 60

    def first_dep(r: dict) -> int:
        s = stops(r)[0]
        h, m, _ = (s.get("dtm") or s.get("atm")).split(":")
        return int(h) * 3600 + int(m) * 60 + 86400 * (s.get("ddy") or 0)

    def last_arr(r: dict) -> int:
        s = stops(r)[-1]
        h, m, _ = (s.get("atm") or s.get("dtm")).split(":")
        return int(h) * 3600 + int(m) * 60 + 86400 * (s.get("ady") or 0)

    today_s = today.isoformat()
    todays = [r for r in ours if today_s in r.get("od", [])]
    picks = {
        "w drodze": next((r for r in todays if first_dep(r) < now_s < last_arr(r)), None),
        "zakończony": next((r for r in sorted(todays, key=last_arr, reverse=True) if last_arr(r) < now_s - 1800), None),
        "start za 2–5 h": next((r for r in todays if 2 * 3600 < first_dep(r) - now_s < 5 * 3600), None),
    }
    for label, r in picks.items():
        if not r:
            out(f"  {label}: brak kandydata")
            continue
        out(f"  **{label}**: {r.get('ccs')} {r.get('nn')} (start {first_dep(r) // 3600:02d}:{first_dep(r) % 3600 // 60:02d})")
        status, op, hdr, _ = get(f"/api/v1/operations/train/{r['sid']}/{r['oid']}/{today_s}")
        if op and status == 200:
            out(f"  klucze: {sorted(op.keys())}; trainStatus={op.get('trainStatus')!r}")
            sts = op.get("stations") or []
            out(f"  klucze stacji: {sorted(set().union(*(s.keys() for s in sts))) if sts else []}")
            out(f"  stacji: {len(sts)}, potwierdzonych: {sum(bool(s.get('isConfirmed')) for s in sts)}, "
                f"odwołanych: {sum(bool(s.get('isCancelled')) for s in sts)}")
            save(ROOT / f"worker/test/fixtures/recon/operation_{label.split()[0].replace('–', '').replace('ń', 'n')}.json", op)
        out(f"  nagłówki: `{hdr}`")

    out("\n## 6. `/operations/shortened?stations=…&fullRoutes=true`")
    status, ops, hdr, size_ops = get("/api/v1/operations/shortened", {
        "stations": ids, "fullRoutes": "true", "pageSize": 1000})
    if ops:
        trs = ops.get("tr") or []
        out(f"  klucze: {sorted(ops.keys())}; pg={ops.get('pg')}; pociągów: {len(trs)}; {size_ops / 1e3:.0f} KB")
        out(f"  statusy: {dict(Counter(t.get('s') for t in trs))}")
        if trs:
            out(f"  klucze pociągu: {sorted(trs[0].keys())}; klucze stacji: {sorted((trs[0].get('st') or [{}])[0].keys())}")
            ours_keys = {(r["sid"], r["oid"]) for r in todays}
            hit = [t for t in trs if (t.get("sid"), t.get("oid")) in ours_keys]
            out(f"  w tym naszych kursów dziś: {len(hit)} z {len(todays)}")
            save(ROOT / "worker/test/fixtures/recon/operations_shortened_one.json",
                 {k: v for k, v in ops.items() if k != "tr"} | {"tr": hit[:1] or trs[:1]})
    out(f"  nagłówki: `{hdr}`")
    return finish()


def finish() -> int:
    out(f"\nZapytań: {_count}")
    Path("recon-report.md").write_text("\n".join(_lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
