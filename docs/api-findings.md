# Faza 0 — ustalenia o API PKP PLK

> Dalsze fazy opierają się na tym pliku, nie na zgadywaniu (SPEC 12).
> **Status: rekonesans na żywo wykonany 21.11.2026 14:06 (sobota), 11 zapytań** — wyniki w sekcji D.
> (A) fakty z karoo-kolejka, (B) z dokumentacji API (Swagger v1.3.2), (C) decyzje — potwierdzone w D.
>
> Uruchomienie (≤ 12 zapytań, raport + zanonimizowane próbki):
> `cd pipeline && PDP_API_KEY=… uv run --python 3.12 python recon.py`
> Wynik wkleić do sekcji D, a próbki z `*/fixtures/recon/` porównać z fixture'ami testów.

## A. Potwierdzone w karoo-kolejka (prawdziwe odpowiedzi, X–XI 2026)

| Fakt | Źródło |
|---|---|
| `GET /api/v1/schedules/shortened?dateFrom&dateTo&carriersInclude&fullRoute=true&dictionaries=true` zwraca całe okno w jednym zapytaniu (16 dni KM+SKM+ŁKA+WKD ≈ 23 MB JSON). Odpowiedź gzip. | `build_timetable.py` |
| `rt[]`: `sid`, `oid`, `toid`, `cc`, `nn`, `ccs`, `od[]` (daty ISO), `st[]`. `st[]`: `id`, `ord`, `atm`/`dtm` (`HH:MM:SS`), `ady`/`ddy`, `apl`/`dpl`, `atr`/`dtr`, `pv[]` (`od`, `apl`, `atr`, `dpl`, `dtr`), `sti`. Postój bez `atm` i `dtm` = przejazd. | fixture `pdp_schedules.json` |
| `dc.st` — mapa `"<id>": {id, nm, lat, lon}`. | j.w. |
| Peron `BUS` = komunikacja zastępcza. | j.w. |
| `sti`: 1 = tylko wsiadanie, 2 = tylko wysiadanie. | `/dictionaries/stop-types` |
| `GET /api/v1/operations/train/{sid}/{oid}/{data}` ≈ 3–6 KB: `scheduleId`, `orderId`, `operatingDate`, `trainStatus`, `stations[]` z `stationId`, `actualArrival`, `actualDeparture` (czas lokalny bez offsetu), `isConfirmed`, `isCancelled`. | `TrainRun.kt` |
| **404** = PLK nie założył jeszcze wykonania kursu; dane pojawiają się ok. **3 h przed startem kursu** (jedna obserwacja: 404 na 176 min, 200 na 170 min). | karoo `docs/device-findings.md` |
| Czas odpowiedzi `/operations/train`: 2,4–6,4 s (mediana ~3,5 s). | j.w. |

## B. Z dokumentacji API (Swagger v1.3.2)

- Kurs ma też **`nm` — nazwa pociągu** (np. „Ogończyk"), `ian`/`idn` — numery międzynarodowe.
- `schedules`: parametry `stations` (dowolny postój z listy), `fromStations`/`toStations`, `carriersInclude`,
  `fullRoute` (domyślnie false — tnie trasę do odcinka), `dictionaries`. Bez stronicowania. Okno ≤ 31 dni.
- `dc` ma klucze `st`, `sv`, `ct`, `cr` (przewoźnicy), `cc` (kategorie handlowe), `sty` (typy postojów).
- `trainStatus`: **S** = nie wyruszył, **P** = w drodze, **C** = zakończony, **X** = odwołany,
  **Q** = częściowo odwołany. (karoo-kolejka traktuje też `N` i `F` jak S i C — zostawiamy.)
- `OperationStationDto` ma dodatkowo `plannedArrival`/`plannedDeparture`, `arrivalDelayMinutes`/
  `departureDelayMinutes`, `plannedSequenceNumber`/`actualSequenceNumber`. **Brak pól peronu/toru** —
  perony tylko z rozkładu (SPEC 13).
- Zbiorczo: `GET /api/v1/operations[/shortened]?stations&carriersInclude&fullRoutes&withPlanned&page&pageSize&since`
  (stronicowanie, `pageSize` ≤ 10 000, `since` = różnice od `dataVersion`). Skrócone pola stacji:
  `id`, `psn`, `asn`, `pa`, `pd`, `aa`, `ad`, `adm`, `ddm`, `cf`, `cn`.
- Kody przewoźników: przykłady w dokumentacji `IC` = PKP Intercity, `KM`, `KS`, `KD`. Pełna lista:
  `/api/v1/dictionaries/carriers`.
- Limity: nagłówki `X-RateLimit-Hourly-Remaining`, `X-RateLimit-Daily-Remaining`; przekroczenie → 429.
- CORS: dokumentacja milczy. Dokumentacja zakazuje publicznego udostępniania klucza → pośrednik (SPEC 1.2).
- `/api/v1/data-version`: `dataVersion`, `schedulesVersion`, `operationsVersion`, `timestamp`.

## C. Decyzje podjęte na tej podstawie (do weryfikacji rekonesansem)

1. **Przewoźnicy:** `carriersInclude=IC` (stała `CARRIERS` w `build_trains.py`). Jeśli rekonesans
   pokaże inne bezpośrednie pociągi WAW↔KRK — SPEC 15.3 (rozstrzygnięte: patrz D.1).
2. **Etykieta pociągu:** `ccs` + `nn` (np. „EIP 1300"); `nm` przenosimy jako `name` (strona go na razie
   nie pokazuje). Jeśli `ccs` okaże się czymś innym niż `EIP`/`IC`/`TLK`/`EIC` — poprawić `train_category`.
3. **Stacje:** po nazwie ze słownika `dc.st`; ID nie są wpisane na sztywno.
4. **`stations=`:** nie używamy, dopóki rekonesans nie potwierdzi, że z `fullRoute=true` zwraca pełne trasy
   (kod jest przygotowany — `USE_STATIONS_FILTER`).
5. **Strategia Workera: B** (`/operations/train` per kurs, sprawdzona w karoo-kolejka). A wymaga potwierdzenia
   pkt 6 rekonesansu (pociągi w drodze i zakończone, czasy na każdej stacji, 1–2 strony).
6. **„Ostatnio: …"**: ostatni postój z `isConfirmed=true` i czasem (`actualDeparture ?? actualArrival`).
   Czy PLK potwierdza stacje pośrednie — pkt 5 rekonesansu.

## D. Wynik rekonesansu (21.11.2026, 14:06)

Próbki: `pipeline/tests/fixtures/recon/`, `worker/test/fixtures/recon/` (bez klucza i nagłówków).

1. **Przewoźnicy WAW ↔ KRK (jeden dzień, wszyscy przewoźnicy, 70 kursów):** `IC` — 62, **`Leo Express` — 8**
   (`ccs` = `Ex`). Kod przewoźnika zawiera spację. **Decyzja właściciela (SPEC 15.3): pokazujemy** —
   `carriersInclude=IC,Leo Express` sprawdzone na żywo (23 rozkłady Leo w oknie 5 dni, kod `LEO` nic nie zwraca).
   Etykieta „Leo Express <nn>” zamiast `Ex`. Wynik: 344 pociągi (34–35 na kierunek dziennie), 141 KB.
   Słownik przewoźników ma też m.in. `PR` (POLREGIO), `KMŁ`, `RJ` (RegioJet), `LEO`.
2. **Etykieta:** `ccs` ∈ {`EIP`, `IC`, `TLK`, `EIC`} (Leo: `Ex`), `nn` = numer krajowy (`3504`, `13102`).
   `nm` — nazwa pociągu wersalikami (np. `MARSZAŁEK PIŁSUDSKI`), zwykle null. Etykieta `ccs nn` (C.2) — **potwierdzone**.
3. **Stacje (po nazwie z `dc.st`):** Kraków Główny 80416, Warszawa Centralna 33605, Zachodnia 33506,
   **Wschodnia 38653**, Gdańska 36103 — jednoznaczne. `dc` ma klucze `cc`, `cr`, `ct`, `st`, `sty`.
   **`stations=` z `fullRoute=true` NIE zachowuje pełnej trasy** → nie używamy (`USE_STATIONS_FILTER = False`).
4. **Rozmiar:** okno 5 dni, `carriersInclude=IC`, `fullRoute=true`: 1143 kursy, 3,95 MB JSON (854 KB gzip), 0,7 s.
   Wynikowy `trains.json`: 304 pociągi (30–31 na kierunek dziennie), 124 KB.
5. **`/operations/train`:** klucze `scheduleId`, `orderId`, `trainOrderId`, `operatingDate`, `trainStatus`,
   `stations[]` (`stationId`, `plannedSequenceNumber`, `actualSequenceNumber`, `actualArrival`, `actualDeparture`,
   `isConfirmed`, `isCancelled`). **`isConfirmed`/`isCancelled` są pomijane, gdy false.** Lista stacji = tylko postoje.
   Kurs w drodze (`P`, start 13:43, bez postojów do Warszawy): potwierdzony tylko odjazd z Krakowa — reszta to prognoza;
   „ostatnio: …” dla EIP bez postojów pokaże stację początkową aż do przyjazdu. Kurs zakończony (`C`): 17/17 potwierdzonych.
   404 dla kursu startującego za 4,5 h (zgodnie z A: dane ok. 3 h przed startem). Odpowiedzi ~0,1 s, 2–3 KB.
6. **`/operations/shortened?stations=…&fullRoutes=true`:** 4257 pociągów, 5 stron po 1000 (2 MB na stronę), statusy
   S/P/C/Q/X; tylko 43 z 70 naszych kursów na pierwszej stronie → **strategia B** (per kurs) — potwierdzone.
7. **Limity:** nagłówki `X-RateLimit-Hourly-Limit` (100), `X-RateLimit-Hourly-Remaining`, `X-RateLimit-Daily-Limit`
   (1000), `X-RateLimit-Daily-Remaining`; `/operations` zwraca też `X-Data-Version`. Klucz jest wspólny z karoo-kolejka
   (SPEC 15.1) — Worker ma limit 30/h.
8. **Perony:** 276/277 postojów na naszych stacjach z peronem (100%), `pv` — 0 przypadków tego dnia.
9. **Pociągi międzynarodowe** (np. IC 13000 Wilno → Kraków): stacje zagraniczne mają `ord` < 0 i **czas lokalny
   swojej strefy** (Litwa UTC+2), więc na granicy czas się „cofa”. Pipeline sprawdza rosnące czasy tylko na odcinku
   Warszawa–Kraków (4 takie kursy w oknie 5 dni).
10. **Lokalnie (macOS):** Python z `uv` nie ufa łańcuchowi Certum serwera API (`CERTIFICATE_VERIFY_FAILED`); działa z
    `SSL_CERT_FILE` wskazującym na certyfikaty systemowe (`security find-certificate -a -p …`). Weryfikacji TLS nie wyłączamy.
    W GitHub Actions (Ubuntu) problem nie występuje — karoo-kolejka pobiera z tego hosta od 3.11.2026.
