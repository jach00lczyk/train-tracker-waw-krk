import datetime as dt
import io
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_trains as bt  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "pdp_schedules.json"
TODAY = dt.date(2026, 10, 24)  # sobota; 25.10 zmiana czasu
TZ = ZoneInfo("Europe/Warsaw")
KRK, CEN, ZACH, WSCH, GDA = 80416, 33605, 33506, 34868, 36103


@pytest.fixture
def schedules():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def run(data: dict, tmp_path: Path, *extra: str) -> tuple[int, dict | None]:
    path = tmp_path / "schedules.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "out"
    code = bt.main(["--schedules", str(path), "--out", str(out), "--today", TODAY.isoformat(),
                    "--min-trains", "1", *extra])
    f = out / "trains.json"
    return code, (json.loads(f.read_text(encoding="utf-8")) if f.exists() else None)


@pytest.fixture
def built(schedules, tmp_path):
    code, result = run(schedules, tmp_path)
    assert code == 0
    return result


def trains(result, oid, date=None):
    return [t for t in result["trains"] if t["oid"] == oid and (date is None or t["date"] == date)]


def epoch(y, mo, d, h, mi):
    return int(dt.datetime(y, mo, d, h, mi, tzinfo=TZ).timestamp())


# --------------------------------------------------------------------------- filtrowanie


def test_only_direct_trains_of_selected_carrier(built):
    oids = {t["oid"] for t in built["trains"]}
    assert oids == {101, 102, 103, 106, 108, 201, 202, 203, 401}


def test_international_train_with_foreign_time_zone_kept(built):
    t = trains(built, 108)[0]
    assert t["dir"] == "krk" and t["from"]["id"] == CEN
    assert t["from"]["dep"] == epoch(2026, 10, 24, 19, 28)
    assert t["route"][0] == 95000


def test_decreasing_times_on_our_segment_fail(schedules, tmp_path):
    route = next(r for r in schedules["rt"] if r["oid"] == 108)
    route["st"][-1]["atm"] = "19:20:00"
    assert run(schedules, tmp_path)[0] == 1


def test_leo_express_included_with_readable_category(built):
    t = trains(built, 401)[0]
    assert (t["cat"], t["no"]) == ("Leo Express", "3114")
    assert t["dir"] == "waw" and t["to"]["id"] == CEN and t["waw_station"] == CEN
    assert t["to"]["arr"] == epoch(2026, 10, 24, 18, 36)


def test_dates_clipped_to_window(built):
    assert {t["date"] for t in trains(built, 101)} == {"2026-10-23", "2026-10-24", "2026-10-25",
                                                       "2026-10-26", "2026-10-27"}
    assert built["valid_from"] == "2026-10-23"
    assert built["valid_to"] == "2026-10-27"
    assert built["service_today"] == "2026-10-24"


def test_prefers_centralna_and_direction_from_stop_order(built):
    t = trains(built, 101, "2026-10-24")[0]
    assert t["dir"] == "krk"
    assert t["from"]["id"] == CEN and t["to"]["id"] == KRK
    assert t["waw_station"] == CEN
    assert t["from"]["dep"] == epoch(2026, 10, 24, 5, 20)
    assert t["to"]["arr"] == epoch(2026, 10, 24, 7, 38)
    assert t["key"] == "2026/101/2026-10-24"
    assert (t["cat"], t["no"], t["name"]) == ("EIP", "1300", None)


def test_route_skips_pass_through_and_starts_at_origin(built):
    t = trains(built, 101, "2026-10-24")[0]
    assert t["route"] == [WSCH, CEN, ZACH, 62000, KRK]


def test_through_train_included_with_arrival_platform(built):
    t = trains(built, 102, "2026-10-24")[0]
    assert t["dir"] == "krk" and t["name"] == "Ogończyk"
    assert t["to"] == {"id": KRK, "arr": epoch(2026, 10, 24, 8, 58), "platform": "3", "track": "5", "bus": False}
    assert t["route"][0] == 7500 and t["route"][-1] == 90000


def test_detour_via_gdanska_kept_with_flag_and_bus(built):
    t = trains(built, 103)[0]
    assert t["waw_station"] == GDA
    assert t["from"]["bus"] is True
    assert t["from"]["platform"] is None and t["from"]["track"] is None


def test_stop_types_respected(built):
    t = trains(built, 106)[0]
    assert t["from"]["id"] == ZACH and t["waw_station"] == ZACH
    assert (t["from"]["platform"], t["from"]["track"]) == ("7", "9")
    assert not trains(built, 107)


def test_platform_variant_per_date(built):
    assert (trains(built, 101, "2026-10-24")[0]["from"]["platform"]) == "4"
    t = trains(built, 101, "2026-10-25")[0]
    assert (t["from"]["platform"], t["from"]["track"]) == ("6", "12")


def test_direction_waw_after_midnight(built):
    t = trains(built, 201, "2026-10-24")[0]
    assert t["dir"] == "waw"
    assert t["from"]["id"] == KRK and t["to"]["id"] == CEN
    assert t["to"]["arr"] == epoch(2026, 10, 25, 0, 58)
    assert t["waw_station"] == CEN


def test_dst_night_epoch(built):
    t = trains(built, 202)[0]
    assert t["from"]["dep"] == epoch(2026, 10, 24, 23, 30)
    assert t["to"]["arr"] - t["from"]["dep"] == 5 * 3600  # 4 h zegara + godzina „cofnięta"
    assert dt.datetime.fromtimestamp(t["to"]["arr"], TZ).strftime("%H:%M") == "03:30"


def test_dst_day_departure_epoch(built):
    t = trains(built, 101, "2026-10-25")[0]
    assert t["from"]["dep"] == int(dt.datetime(2026, 10, 25, 4, 20, tzinfo=dt.timezone.utc).timestamp())


def test_stations_cover_routes_and_sorting(built):
    used = {s for t in built["trains"] for s in t["route"]}
    assert used <= {int(k) for k in built["stations"]}
    assert built["stations"][str(62000)] == "Włoszczowa Północ"
    assert built["krakow"] == KRK
    assert built["warsaw"] == [CEN, ZACH, WSCH, GDA]
    keys = [(t["date"], t["dir"], t["from"]["dep"]) for t in built["trains"]]
    assert keys == sorted(keys)


def test_meta(built):
    assert built["schema_version"] == 1
    assert built["attribution"].startswith("Dane: PKP Polskie Linie Kolejowe")
    assert built["generated_at"].endswith("Z")
    assert built["source"] == {"file": "schedules.json"}


# --------------------------------------------------------------------------- błędy


def test_missing_station_in_dictionary_fails(schedules, tmp_path):
    del schedules["dc"]["st"][str(GDA)]
    code, result = run(schedules, tmp_path)
    assert code == 1 and result is None


def test_ambiguous_station_fails(schedules, tmp_path):
    schedules["dc"]["st"]["99999"] = {"id": 99999, "nm": "Kraków Główny", "lat": 0, "lon": 0}
    assert run(schedules, tmp_path)[0] == 1


def test_route_station_without_name_fails(schedules, tmp_path):
    del schedules["dc"]["st"]["62000"]
    assert run(schedules, tmp_path)[0] == 1


def test_too_few_trains_fails(schedules, tmp_path):
    code, result = run(schedules, tmp_path, "--min-trains", "5")
    assert code == 1 and result is None


def test_decreasing_times_fail(schedules, tmp_path):
    route = next(r for r in schedules["rt"] if r["oid"] == 101)
    route["st"][4]["atm"] = "05:00:00"
    assert run(schedules, tmp_path)[0] == 1


def test_short_validity_fails(schedules, tmp_path):
    for r in schedules["rt"]:
        r["od"] = [d for d in r["od"] if d <= "2026-10-25"]
    assert run(schedules, tmp_path)[0] == 1


def test_skip_if_fresh(schedules, tmp_path, monkeypatch):
    prev = tmp_path / "prev.json"
    prev.write_text(json.dumps({"schema_version": 1, "service_today": TODAY.isoformat()}), encoding="utf-8")
    out_file = tmp_path / "gh_out"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out_file))
    code, result = run(schedules, tmp_path, "--previous", str(prev), "--skip-if-fresh")
    assert code == 0 and result is None
    assert "publish=false" in out_file.read_text()


def test_not_fresh_builds(schedules, tmp_path):
    prev = tmp_path / "prev.json"
    prev.write_text(json.dumps({"schema_version": 1, "service_today": "2026-10-23"}), encoding="utf-8")
    code, result = run(schedules, tmp_path, "--previous", str(prev), "--skip-if-fresh")
    assert code == 0 and result is not None


# --------------------------------------------------------------------------- API


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes):
        super().__init__(body)
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def fake_api(monkeypatch, schedules):
    calls = []

    def urlopen(req, timeout):
        calls.append(req)
        if "/data-version" in req.full_url:
            return FakeResponse(json.dumps({"schedulesVersion": "v-42"}).encode())
        return FakeResponse(json.dumps(schedules).encode())

    monkeypatch.setattr(bt.urllib.request, "urlopen", urlopen)
    monkeypatch.setenv(bt.API_KEY_ENV, "tajny-klucz")
    return calls


def test_api_build_sends_key_only_in_header(fake_api, tmp_path, caplog):
    out = tmp_path / "out"
    caplog.set_level("INFO")
    assert bt.main(["--out", str(out), "--today", TODAY.isoformat(), "--min-trains", "1"]) == 0
    assert len(fake_api) == 2
    for req in fake_api:
        assert req.get_header("X-api-key") == "tajny-klucz"
        assert "tajny-klucz" not in req.full_url
    sched = fake_api[1].full_url
    assert "carriersInclude=IC%2CLeo+Express" in sched and "fullRoute=true" in sched
    assert "dateFrom=2026-10-23" in sched and "dateTo=2026-10-27" in sched
    text = (out / "trains.json").read_text(encoding="utf-8")
    assert "tajny-klucz" not in text and "tajny-klucz" not in caplog.text
    assert json.loads(text)["source"] == {"schedules_version": "v-42"}


def test_api_without_key_fails(monkeypatch, tmp_path):
    monkeypatch.delenv(bt.API_KEY_ENV, raising=False)
    assert bt.main(["--out", str(tmp_path / "out"), "--today", TODAY.isoformat()]) == 1


def test_api_client_error_not_retried(monkeypatch, tmp_path):
    calls = []

    def urlopen(req, timeout):
        calls.append(req)
        raise bt.urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(bt.urllib.request, "urlopen", urlopen)
    monkeypatch.setenv(bt.API_KEY_ENV, "zly-klucz")
    assert bt.main(["--out", str(tmp_path / "out"), "--today", TODAY.isoformat()]) == 1
    assert len(calls) == 1


def test_wall_to_epoch_spring_dst():
    # 29.03.2026: 02:00 CET → 03:00 CEST
    d = dt.date(2026, 3, 29)
    assert bt.wall_to_epoch(d, 3 * 3600 + 30 * 60) - bt.wall_to_epoch(d, 1 * 3600 + 30 * 60) == 3600
