#!/usr/bin/env python3
"""Buduje `trains.json` — bezpośrednie pociągi Warszawa ↔ Kraków Główny (SPEC 3).

Wejście: rozkład planowy z API Otwarte Dane Kolejowe PKP PLK (`/api/v1/schedules/shortened`,
jedno zapytanie na okno wczoraj … dziś+3) albo plik `--schedules` z zapisaną odpowiedzią.
Klucz API w zmiennej `PDP_API_KEY` — tylko w nagłówku, nigdy w URL ani w logach.
Wyjście: `<out>/trains.json` (schemat w SPEC 3.4). Czasy jako epoch UTC (sekundy),
liczone w Europe/Warsaw — przeglądarka nie robi arytmetyki stref.

Wzorowane na `pipeline/build_timetable.py` z karoo-kolejka (api_get, BuildError, set_output,
stop_platform). Kod korzysta wyłącznie z biblioteki standardowej.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

log = logging.getLogger("build_trains")

SCHEMA_VERSION = 1
TZ = ZoneInfo("Europe/Warsaw")

PDP_BASE = "https://pdp-api.plk-sa.pl"
API_KEY_ENV = "PDP_API_KEY"

# Przewoźnicy bezpośrednich pociągów WAW ↔ KRK (docs/api-findings.md, D.1; SPEC 15.3).
CARRIERS = ["IC", "Leo Express"]
# Etykieta kategorii zamiast `ccs` (Leo Express ma `Ex` — „Leo Express 3114" mówi więcej, inne bilety).
CARRIER_CATEGORY = {"Leo Express": "Leo Express"}
# `stations=` zmniejszyłby odpowiedź, ale nie wiadomo jeszcze, czy z `fullRoute=true`
# zachowuje pełne trasy (docs/api-findings.md, C.4).
USE_STATIONS_FILTER = False

KRAKOW_NAME = "Kraków Główny"
# Kolejność = preferencja przy wyborze stacji warszawskiej (SPEC 3.3, 15.2).
WARSAW_STATIONS = ["Warszawa Centralna", "Warszawa Zachodnia", "Warszawa Wschodnia", "Warszawa Gdańska"]
BUS_PLATFORM = "BUS"

WINDOW_BEFORE_DAYS = 1
WINDOW_AFTER_DAYS = 3
MIN_VALID_AHEAD_DAYS = 2
MIN_TRAINS_PER_DIRECTION = 5
MAX_BYTES = 300 * 1024

STI_BOARDING_ONLY = 1  # tylko wsiadanie
STI_ALIGHTING_ONLY = 2  # tylko wysiadanie

ATTRIBUTION = "Dane: PKP Polskie Linie Kolejowe S.A. — Otwarte Dane Kolejowe (https://pdp-api.plk-sa.pl)"


class BuildError(Exception):
    """Błąd danych — nic nie jest publikowane."""


# --------------------------------------------------------------------------- pomocnicze


def parse_hms(value: str | None) -> int | None:
    if not value:
        return None
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def wall_to_epoch(date: dt.date, wall_seconds: int) -> int:
    """Zegar ścienny w Europe/Warsaw (s od północy dnia kursowania, z przesunięciem dnia) → epoch UTC."""
    days, rest = divmod(wall_seconds, 86400)
    d = date + dt.timedelta(days=days)
    local = dt.datetime(d.year, d.month, d.day, rest // 3600, rest % 3600 // 60, rest % 60, tzinfo=TZ)
    return int(local.timestamp())


def stop_platform(st: dict, date: str, kind: str) -> tuple[str | None, str | None]:
    """Peron i tor odjazdu (`kind="d"`) albo przyjazdu (`"a"`), z wariantem `pv` dla daty, jeśli jest."""
    src = st
    for variant in st.get("pv") or ():
        if date in variant.get("od", ()):
            src = variant
            break
    other = "a" if kind == "d" else "d"
    platform = src.get(f"{kind}pl") or src.get(f"{other}pl")
    track = src.get(f"{kind}tr") or src.get(f"{other}tr")
    return platform or None, track or None


def resolve_stations(dict_stations: dict) -> tuple[int, list[int]]:
    by_name: dict[str, list[int]] = {}
    for sid, info in dict_stations.items():
        by_name.setdefault(info.get("nm"), []).append(int(sid))

    def one(name: str) -> int:
        found = by_name.get(name)
        if not found:
            raise BuildError(f"Nie znaleziono stacji „{name}\" w słowniku")
        if len(found) > 1:
            raise BuildError(f"Niejednoznaczna stacja „{name}\": {sorted(found)}")
        return found[0]

    return one(KRAKOW_NAME), [one(n) for n in WARSAW_STATIONS]


# --------------------------------------------------------------------------- model


@dataclass
class Stop:
    id: int
    arr: int  # zegar ścienny w s od północy dnia kursowania
    dep: int
    sti: int
    raw: dict

    @property
    def can_board(self) -> bool:
        return self.sti != STI_ALIGHTING_ONLY

    @property
    def can_alight(self) -> bool:
        return self.sti != STI_BOARDING_ONLY


def route_stops(route: dict) -> list[Stop]:
    stops = []
    for st in sorted(route.get("st") or (), key=lambda s: s["ord"]):
        arr = parse_hms(st.get("atm"))
        dep = parse_hms(st.get("dtm"))
        if arr is None and dep is None:
            continue  # przejazd bez zatrzymania
        if arr is not None:
            arr += 86400 * (st.get("ady") or 0)
        if dep is not None:
            dep += 86400 * (st.get("ddy") or 0)
        arr = dep if arr is None else arr
        dep = arr if dep is None else dep
        stops.append(Stop(int(st["id"]), arr, dep, int(st.get("sti") or 0), st))
    return stops


def pick_direction(stops: list[Stop], krakow: int, warsaw: list[int]) -> tuple[str, int, int] | None:
    """(kierunek, indeks postoju „z", indeks postoju „do") albo None — SPEC 3.3.

    O kierunku decyduje kolejność postojów, nie stacje krańcowe. Stacja warszawska: pierwsza
    z listy preferencji, na której da się wsiąść (krk) / wysiąść (waw).
    """
    krk_idx = [i for i, s in enumerate(stops) if s.id == krakow]
    if not krk_idx:
        return None
    # Do Krakowa: postój warszawski z wsiadaniem przed postojem w Krakowie z wysiadaniem.
    for k in krk_idx:
        if not stops[k].can_alight:
            continue
        for wid in warsaw:
            w = next((i for i in range(k) if stops[i].id == wid and stops[i].can_board), None)
            if w is not None:
                return "krk", w, k
    # Do Warszawy: postój w Krakowie z wsiadaniem przed postojem warszawskim z wysiadaniem.
    for k in krk_idx:
        if not stops[k].can_board:
            continue
        for wid in warsaw:
            w = next((i for i in range(k + 1, len(stops)) if stops[i].id == wid and stops[i].can_alight), None)
            if w is not None:
                return "waw", k, w
    return None


def endpoint(stop: Stop, date: dt.date, kind: str) -> dict:
    platform, track = stop_platform(stop.raw, date.isoformat(), kind)
    bus = platform == BUS_PLATFORM
    if bus:
        platform = track = None
    out = {"id": stop.id}
    if kind == "d":
        out["dep"] = wall_to_epoch(date, stop.dep)
    else:
        out["arr"] = wall_to_epoch(date, stop.arr)
    out.update({"platform": platform, "track": track, "bus": bus})
    return out


def train_category(route: dict) -> str:
    """Kategoria handlowa do etykiety („EIP 1300"). Format `ccs` — docs/api-findings.md, D.2."""
    if route.get("cc") in CARRIER_CATEGORY:
        return CARRIER_CATEGORY[route["cc"]]
    return (route.get("ccs") or "").split("/")[0].strip() or str(route.get("cc") or "")


def build(data: dict, today: dt.date) -> dict:
    window = (today - dt.timedelta(days=WINDOW_BEFORE_DAYS), today + dt.timedelta(days=WINDOW_AFTER_DAYS))
    dict_stations = (data.get("dc") or {}).get("st") or {}
    if isinstance(dict_stations, list):
        dict_stations = {str(s["id"]): s for s in dict_stations}
    krakow, warsaw = resolve_stations(dict_stations)

    trains = []
    used_stations: set[int] = set()
    skipped = Counter()
    foreign_times = 0
    for route in data.get("rt") or ():
        if route.get("cc") not in CARRIERS:
            skipped["przewoźnik"] += 1
            continue
        dates = sorted({dt.date.fromisoformat(d) for d in route.get("od") or ()})
        dates = [d for d in dates if window[0] <= d <= window[1]]
        if not dates:
            continue
        stops = route_stops(route)
        picked = pick_direction(stops, krakow, warsaw)
        if picked is None:
            skipped["bez relacji WAW↔KRK"] += 1
            continue
        direction, fi, ti = picked
        # Czasy muszą rosnąć na odcinku, którego używamy. Poza nim mogą się „cofać": pociągi
        # międzynarodowe (np. Wilno → Kraków) podają czas lokalny strefy kraju (docs/api-findings.md, D).
        for i in range(fi, ti + 1):
            s = stops[i]
            if s.dep < s.arr or (i > fi and s.arr < stops[i - 1].dep):
                raise BuildError(f"Czasy nie rosną w kursie {route['sid']}/{route['oid']}")
        if any(s.dep < s.arr or (i and s.arr < stops[i - 1].dep) for i, s in enumerate(stops)):
            foreign_times += 1
        route_ids = [s.id for s in stops]
        for sid in route_ids:
            if str(sid) not in dict_stations:
                raise BuildError(f"Stacja {sid} kursu {route['sid']}/{route['oid']} nie ma nazwy w słowniku")
        waw_station = stops[fi if direction == "krk" else ti].id
        for d in dates:
            frm = endpoint(stops[fi], d, "d")
            to = endpoint(stops[ti], d, "a")
            if to["arr"] <= frm["dep"]:
                raise BuildError(f"Przyjazd nie po odjeździe w kursie {route['sid']}/{route['oid']} {d}")
            # Postoje odcinka WAW–KRK: [id, przyjazd, odjazd] w s względem from.dep (zwarte; strona dodaje from.dep).
            segment = [[s.id, wall_to_epoch(d, s.arr) - frm["dep"], wall_to_epoch(d, s.dep) - frm["dep"]]
                       for s in stops[fi:ti + 1]]
            trains.append({
                "key": f"{route['sid']}/{route['oid']}/{d.isoformat()}",
                "sid": int(route["sid"]), "oid": int(route["oid"]), "date": d.isoformat(),
                "dir": direction,
                "cat": train_category(route), "no": str(route.get("nn") or ""), "name": route.get("nm") or None,
                "from": frm, "to": to,
                "waw_station": waw_station,
                "route": route_ids,
                "stops": segment,
            })
        used_stations.update(route_ids)
    for reason, n in sorted(skipped.items()):
        log.info("Pominięto kursów (%s): %d", reason, n)
    if foreign_times:
        log.info("Kursy z czasem „cofającym się” poza odcinkiem WAW–KRK (np. strefa za granicą): %d", foreign_times)

    trains.sort(key=lambda t: (t["date"], t["dir"], t["from"]["dep"], t["key"]))
    dates_ok = [d for d in sorted({t["date"] for t in trains})
                if {t["dir"] for t in trains if t["date"] == d} == {"krk", "waw"}]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "service_today": today.isoformat(),
        "valid_from": window[0].isoformat(),
        "valid_to": dates_ok[-1] if dates_ok else None,
        "source": {},
        "attribution": ATTRIBUTION,
        "stations": {str(s): dict_stations[str(s)]["nm"] for s in sorted(used_stations | {krakow, *warsaw})},
        "krakow": krakow,
        "warsaw": warsaw,
        "trains": trains,
    }


def serialize(result: dict) -> bytes:
    return (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def validate(result: dict, today: dt.date, min_trains: int) -> None:
    trains = result["trains"]
    counts = Counter((t["date"], t["dir"]) for t in trains)
    for d in sorted({t["date"] for t in trains}):
        log.info("%s: do Krakowa %d, do Warszawy %d", d, counts[(d, "krk")], counts[(d, "waw")])
    for offset in (0, 1):
        d = (today + dt.timedelta(days=offset)).isoformat()
        for direction in ("krk", "waw"):
            if counts[(d, direction)] < min_trains:
                raise BuildError(f"Za mało pociągów {d} ({direction}): {counts[(d, direction)]} < {min_trains}")
    if not result["valid_to"] or dt.date.fromisoformat(result["valid_to"]) < today + dt.timedelta(days=MIN_VALID_AHEAD_DAYS):
        raise BuildError(f"valid_to {result['valid_to']} < dziś+{MIN_VALID_AHEAD_DAYS}")
    other = sum(1 for t in trains if t["waw_station"] != result["warsaw"][0])
    log.info("Pociągi ze stacją warszawską inną niż Centralna: %d", other)
    ends = [e for t in trains for e in (t["from"], t["to"]) if not e["bus"]]
    if ends:
        log.info("Pokrycie peronów: %.1f%% (%d)", 100 * sum(1 for e in ends if e["platform"]) / len(ends), len(ends))
    size = len(serialize(result))
    log.info("Rozmiar trains.json: %.1f KB", size / 1024)
    if size > MAX_BYTES:
        raise BuildError(f"trains.json za duży: {size} B")


# --------------------------------------------------------------------------- API PDP


def api_get(path: str, params: dict[str, str], api_key: str, attempts: int = 3) -> dict:
    """GET z kluczem w nagłówku (nigdy w URL ani w logach), gzip, 2 ponowienia z backoffem."""
    url = f"{PDP_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"X-API-Key": api_key, "Accept-Encoding": "gzip", "User-Agent": "train-tracker-waw-krk-pipeline"}
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=180) as resp:
                body = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
            log.info("GET %s → %.1f MB", url, len(body) / 1e6)
            return json.loads(body)
        except urllib.error.HTTPError as e:
            # 4xx (zły klucz, limit) nie minie od ponowienia.
            if e.code < 500 or attempt == attempts:
                raise BuildError(f"API PDP: HTTP {e.code} dla {path}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == attempts:
                raise BuildError(f"API PDP niedostępne ({path}): {e}") from None
        log.warning("Ponawiam %s (próba %d)", path, attempt + 1)
        time.sleep(10 * attempt)
    raise AssertionError("nieosiągalne")


def fetch_schedules(api_key: str, today: dt.date) -> dict:
    params = {
        "dateFrom": (today - dt.timedelta(days=WINDOW_BEFORE_DAYS)).isoformat(),
        "dateTo": (today + dt.timedelta(days=WINDOW_AFTER_DAYS)).isoformat(),
        "carriersInclude": ",".join(CARRIERS),
        "fullRoute": "true",
        "dictionaries": "true",
    }
    return api_get("/api/v1/schedules/shortened", params, api_key)


# --------------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--schedules", type=Path, default=None,
                   help="zapisana odpowiedź /schedules/shortened zamiast zapytania do API")
    p.add_argument("--out", type=Path, required=True, help="katalog wyjściowy (powstanie trains.json)")
    p.add_argument("--today", type=dt.date.fromisoformat, default=None, help="data „dziś\" (Europe/Warsaw)")
    p.add_argument("--previous", type=Path, default=None, help="poprzednio opublikowany trains.json")
    p.add_argument("--skip-if-fresh", action="store_true",
                   help="nie buduj, gdy poprzedni plik jest już z dziś (zapasowy cron)")
    p.add_argument("--min-trains", type=int, default=MIN_TRAINS_PER_DIRECTION)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    today = args.today or dt.datetime.now(TZ).date()
    try:
        if args.skip_if_fresh and args.previous and args.previous.exists():
            prev = json.loads(args.previous.read_text(encoding="utf-8"))
            if prev.get("schema_version") == SCHEMA_VERSION and prev.get("service_today") == today.isoformat():
                log.info("Poprzedni trains.json jest z dziś — pomijam budowę")
                set_output("publish", "false")
                set_output("fresh", "true")
                return 0
        if args.schedules:
            data = json.loads(args.schedules.read_text(encoding="utf-8"))
            source = {"file": args.schedules.name}
        else:
            api_key = os.environ.get(API_KEY_ENV, "").strip()
            if not api_key:
                raise BuildError(f"Brak klucza API w zmiennej {API_KEY_ENV}")
            version = api_get("/api/v1/data-version", {}, api_key).get("schedulesVersion", "")
            source = {"schedules_version": str(version)}
            data = fetch_schedules(api_key, today)
        result = build(data, today)
        result["source"] = source
        validate(result, today, args.min_trains)
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "trains.json").write_bytes(serialize(result))
        log.info("Zapisano %s (%d pociągów)", args.out / "trains.json", len(result["trains"]))
        set_output("publish", "true")
        return 0
    except BuildError as e:
        log.error("Błąd danych, brak publikacji: %s", e)
        set_output("publish", "false")
        return 1


def set_output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")


if __name__ == "__main__":
    sys.exit(main())
