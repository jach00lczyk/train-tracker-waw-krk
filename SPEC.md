# SPEC — „Pociągi Warszawa ↔ Kraków" (PWA dla Kai)

> Dokument dla Claude Code. Przeczytaj w całości przed pierwszą zmianą w repo.
> Projekt na własny użytek (2 osoby: Kaja i właściciel), repo publiczne. Wzorowany na
> [karoo-kolejka](https://github.com/jach00lczyk/karoo-kolejka): ten sam pipeline rozkładu, to samo API,
> te same zasady. **Prostota i stabilność mają priorytet nad liczbą funkcji.**
> Stan wiedzy: listopad 2026. Wersja specu: 1 (po decyzjach właściciela z 21.11.2026).

---

## 0. TL;DR

Strona (PWA dodana do ekranu głównego iPhone'a), która:

1. Pokazuje **bezpośrednie pociągi Warszawa ↔ Kraków Główny na dziś i jutro** — także te, które już
   odjechały (w drodze: przewidywany przyjazd, ostatnia stacja) i te, które dojechały (schowane).
2. Rozkład bierze z **małego pliku JSON**, który codziennie buduje pipeline w GitHub Actions
   (jak w karoo-kolejka) i publikuje na `gh-pages` razem ze stroną.
3. Przy otwarciu (i co 60 s, gdy strona jest widoczna) pobiera **opóźnienia na żywo** przez
   **mały pośrednik** (Cloudflare Worker), który trzyma klucz API. Klucz nigdy nie trafia do przeglądarki.
4. Na górze **duży przełącznik kierunku**: przed południem automatycznie „Do Krakowa", po południu
   „Do Warszawy"; ręczny wybór pamiętany do końca dnia. Po przewinięciu nagłówek zwija się do
   „Do KRK" / „Do WAW".
5. Gwiazdka przypina pociąg w kafelku „Twój pociąg" (godziny, odliczanie, peron, opóźnienie).

Wygląd jest uzgodniony z właścicielem — sekcja 8 i `docs/design/mockup.dc.html`.

---

## 1. Decyzje architektoniczne

### 1.1 Dane: preprocessing w chmurze, jak w karoo-kolejka

Źródło: **API Otwarte Dane Kolejowe PKP PLK** (`https://pdp-api.plk-sa.pl`, klucz w nagłówku
`X-API-Key`). Pakiet Basic: **100 zapytań/h, 1000/dobę**; przekroczenie → HTTP 429.

**Decyzja:** codzienny job w GitHub Actions pobiera rozkład planowy (1–2 zapytania), zostawia
**wyłącznie pociągi łączące Warszawę z Krakowem Głównym** (filtr po przystankach, sekcja 3.3)
i publikuje `data/trains.json` (kilkadziesiąt KB) na `gh-pages` obok strony.
Okno: **wczoraj … dziś+3**. Wczoraj — dla kursów po północy, a dziś+3 to zapas, żeby jeden
nieudany przebieg nie zostawił pustego „jutra". Zmiana rozkładu (np. grudniowa) wchodzi sama.

Format to JSON, nie SQLite: przeglądarka czyta go bez bibliotek, a danych jest mało.

### 1.2 Opóźnienia: mały pośrednik

Przeglądarka nie może pytać API PLK bezpośrednio: klucz byłby publiczny (regulamin zabrania
udostępniania), a dokumentacja zaleca kierowanie zapytań z przeglądarki przez własny backend.
**Cloudflare Worker** (plan darmowy) z jednym endpointem: przyjmuje listę kursów, pyta PLK
z kluczem z sekretu, zwraca zwięzły JSON. Worker nie ma bazy, ma tylko cache (sekcja 4).

### 1.3 Jedno publiczne repozytorium

- Kod, pipeline, worker i strona w jednym publicznym repo (Actions za darmo, Pages za darmo).
- `gh-pages` jako **orphan, force-push jednym commitem** (strona + `data/trains.json`),
  jak w karoo-kolejka. Codzienny push to też „aktywność repo" (GitHub wyłącza crony po 60 dniach bez niej).
- Strona: `https://jach00lczyk.github.io/train-tracker-waw-krk/`.

### 1.4 Klucz API

- Tylko w sekrecie repo `PDP_API_KEY` (workflow) i w sekrecie Workera (`wrangler secret put PDP_API_KEY`).
  Nigdy w plikach, logach, URL-ach ani odpowiedziach Workera.
- **Klucz wspólny z karoo-kolejka** (decyzja właściciela 21.11.2026): limit 100/h liczy się per klucz,
  a karoo-kolejka sama zużywa do 60/h, więc Worker ma limit 30/h (4.3). → 15.1.

### 1.5 Stos

- **Pipeline:** Python 3.12, wyłącznie biblioteka standardowa (testy: `pytest`). Jak w karoo-kolejka.
- **Worker:** JavaScript (ES modules), zero zależności runtime; `wrangler` tylko jako devDependency.
- **Strona:** czysty HTML + CSS + JS (ES modules), **bez frameworka i bez kroku budowania**.
  Logika domenowa w osobnym module bez DOM (`web/logic.js`), testy przez `node --test`.

---

## 2. Repozytorium

```
/
├── SPEC.md
├── CLAUDE.md
├── CHANGELOG.md
├── README.md                    # instalacja na iPhonie, wdrożenie Workera, sekrety
├── docs/
│   ├── api-findings.md          # wynik fazy 0 — fakty z prawdziwych odpowiedzi API
│   └── design/mockup.dc.html    # makieta (referencja wyglądu, sekcja 8)
├── pipeline/                    # Python 3.12, stdlib
│   ├── build_trains.py
│   ├── recon.py                 # faza 0: rekonesans API (jednorazowy)
│   ├── requirements.txt         # tylko pytest
│   └── tests/ (+ fixtures/)
├── worker/
│   ├── src/index.js
│   ├── test/                    # node --test, fetch mockowany
│   ├── wrangler.toml
│   └── package.json             # devDependencies: wrangler
├── web/
│   ├── index.html
│   ├── styles.css
│   ├── config.js                # LIVE_URL (adres Workera) — nie jest sekretem
│   ├── logic.js                 # czysta logika (bez DOM), w pełni testowana
│   ├── app.js                   # stan, pobieranie, render, zdarzenia
│   ├── manifest.webmanifest
│   ├── icons/                   # apple-touch-icon 180×180, 192, 512
│   ├── demo/                    # fixtures scenariuszy demo (sekcja 9)
│   └── test/                    # node --test dla logic.js
└── .github/workflows/
    ├── pages.yml                # cron + push: testy → budowa danych → gh-pages
    └── ci.yml                   # PR/push: pytest + node --test (web, worker)
```

---

## 3. Pipeline (`pipeline/build_trains.py`)

Punkt wyjścia: `build_timetable.py` z karoo-kolejka (wywołania API, `api_get` z ponowieniami,
`BuildError`, `set_output`, czas w Europe/Warsaw, walidacja przed publikacją). Kopiuj
sprawdzone fragmenty zamiast pisać od zera; schemat wyjścia jest inny (JSON, sekcja 3.4).

### 3.1 Wejście

- `GET /api/v1/schedules/shortened` z `dateFrom` = wczoraj, `dateTo` = dziś+3,
  `carriersInclude=IC,Leo Express` (faza 0 i 15.3), `fullRoute=true`, `dictionaries=true`
  (tak działa w karoo-kolejka). Jeżeli faza 0 pokaże, że `stations=` zmniejsza odpowiedź bez
  utraty pełnej trasy — użyj go.
- Zawsze buduj i publikuj (plik jest mały, a okno dat przesuwa się codziennie). `/data-version`
  tylko do zalogowania `schedulesVersion` w `trains.json`.
- `--schedules <plik>` zamiast API (testy, praca offline), `--today` do testów — jak w karoo-kolejka.
- 4xx bez ponowień; 5xx/timeout — 2 ponowienia z backoffem.

### 3.2 Pola odpowiedzi (skrócone, potwierdzone w karoo-kolejka)

`rt[]` — kursy: `sid` (scheduleId), `oid` (orderId), `cc` (przewoźnik), `nn` (numer krajowy),
`ccs` (kategoria handlowa), `od[]` (daty kursowania), `st[]` (postoje).
`st[]`: `id` (stacja), `ord`, `atm`/`dtm` (HH:MM:SS, czas lokalny), `ady`/`ddy` (przesunięcie dnia),
`apl`/`dpl` (peron), `atr`/`dtr` (tor), `pv[]` (warianty peronów per data, `od`), `sti` (typ postoju:
1 = tylko wsiadanie, 2 = tylko wysiadanie). Postój bez `atm` i `dtm` = przejazd bez zatrzymania.
`dc.st` — słownik stacji (`nm`, `lat`, `lon`). Pola dla IC (np. nazwa pociągu, format `ccs`)
**potwierdza faza 0**.

### 3.3 Filtrowanie: „stricte Warszawa ↔ Kraków"

1. Stacje rozwiązywane **po nazwie** ze słownika `dc.st` (jak `resolve_default_targets` w karoo-kolejka):
   - Kraków: `Kraków Główny` (oczekiwane ID 80416 — potwierdzić),
   - Warszawa, w kolejności preferencji: `Warszawa Centralna`, `Warszawa Zachodnia`,
     `Warszawa Wschodnia`, `Warszawa Gdańska` (stała `WARSAW_STATIONS`; patrz 15.2).
   Brak którejkolwiek lub niejednoznaczność → `BuildError`.
2. Dla każdego kursu i każdej daty z okna: pociąg musi **zatrzymywać się** (nie przejeżdżać)
   w Krakowie Głównym i w ≥ 1 stacji warszawskiej. **O kierunku decyduje kolejność postojów (`ord`),
   a nie stacja początkowa ani końcowa.** Pociągi przelotowe (np. Gdynia → Kraków przez Warszawę) wchodzą.
3. Kierunek `krk`: stacja warszawska **przed** Krakowem; wybierz pierwszą z `WARSAW_STATIONS`,
   na której pociąg się zatrzymuje z możliwością wsiadania (`sti` ≠ 2) i która leży przed Krakowem
   (z możliwością wysiadania, `sti` ≠ 1). Kierunek `waw` — symetrycznie.
4. Kurs, w którym jedyną stacją warszawską jest inna niż Centralna (np. objazd na Gdańską przy
   remoncie), zostaje — z polem `waw_station` ≠ Centralna; strona pokazuje wtedy flagę (8.6).
5. Peron i tor: z wariantu `pv` dla danej daty, jeśli jest, inaczej z postoju (funkcja
   `stop_platform` z karoo-kolejka). Wartość `BUS` = komunikacja zastępcza → `bus: true`.
   **API nie podaje peronów na żywo** — zmiana peronu w dniu kursowania nie będzie widoczna (sekcja 13).
6. Czasy: zegar ścienny + `ady`/`ddy` → **epoch (UTC, sekundy)** liczony w `zoneinfo("Europe/Warsaw")`.
   Przeglądarka nie robi już żadnej arytmetyki stref. Dni zmiany czasu — test.

### 3.4 Wyjście: `data/trains.json`

```json
{
  "schema_version": 1,
  "generated_at": "2026-11-21T01:31:12Z",
  "service_today": "2026-11-21",
  "valid_from": "2026-11-20",
  "valid_to": "2026-11-24",
  "source": {"schedules_version": "…"},
  "attribution": "Dane: PKP Polskie Linie Kolejowe S.A. — Otwarte Dane Kolejowe (https://pdp-api.plk-sa.pl)",
  "stations": {"80416": "Kraków Główny", "…": "Warszawa Centralna"},
  "krakow": 80416,
  "warsaw": [/* ID w kolejności WARSAW_STATIONS */],
  "trains": [
    {
      "key": "2026/607309466/2026-11-21",
      "sid": 2026, "oid": 607309466, "date": "2026-11-21",
      "dir": "krk",
      "cat": "IC", "no": "3504", "name": null,
      "from": {"id": 0, "dep": 1763709900, "platform": "4", "track": "2", "bus": false},
      "to":   {"id": 80416, "arr": 1763719440, "platform": "3", "track": "5", "bus": false},
      "waw_station": 0,
      "route": [/* ID stacji z postojami, w kolejności, od początku kursu */]
    }
  ]
}
```

- `stations` zawiera nazwy **wszystkich stacji z `route`** naszych pociągów (do „ostatnio: …").
- `route` jest potrzebne do ustalenia ostatniej minionej stacji i do dopasowania danych na żywo.
- Sortowanie: `date`, `dir`, `from.dep`.
- Rozmiar < 300 KB (walidacja).

### 3.5 Walidacja (błąd → brak publikacji, poprzednie dane zostają)

- Wszystkie stacje z 3.3 znalezione.
- Dla **dziś i jutra**: ≥ 5 pociągów w każdym kierunku (próg konfigurowalny).
- `valid_to ≥ dziś+2`.
- Czasy rosną wzdłuż kursu; `to.arr > from.dep`.
- Rozmiar < 300 KB.
- Logi: liczba pociągów per dzień i kierunek, liczba z `waw_station` ≠ Centralna, pokrycie peronów (%).

### 3.6 Testy (`pytest`, fixture w formacie `/schedules/shortened`)

Fixture ręczny (jak `pdp_schedules.json` w karoo-kolejka), z komentarzem `_` przy każdym kursie:
pociąg Warszawa Wschodnia → Centralna → Zachodnia → Kraków (wybór Centralnej); kurs przelotowy
Gdynia → Warszawa → Kraków; objazd tylko przez Gdańską (flaga); kurs Kraków → Warszawa po północy
(`ady`); przejazd bez postoju w Krakowie (odrzucony); kurs bez Krakowa (odrzucony); `sti` 1/2;
warianty `pv` per data; peron `BUS`; dzień zmiany czasu (epoch poprawny); inny przewoźnik (odrzucony);
brak stacji w słowniku (`BuildError`); za mało pociągów (`BuildError`).

---

## 4. Worker (opóźnienia na żywo)

### 4.1 Kontrakt dla strony (niezależny od strategii upstream)

```
GET {LIVE_URL}/live?t=<sid>/<oid>/<date>,<sid>/<oid>/<date>,…     (max 30 kursów)
```
Zwykłe żądanie GET bez własnych nagłówków (bez preflightu CORS).

```json
{
  "fetched_at": "2026-11-21T07:50:02Z",
  "trains": {
    "2026/607309466/2026-11-21": {
      "state": "ok",
      "checked_at": "2026-11-21T07:49:40Z",
      "train_status": "P",
      "stops": [
        {"id": 0, "aa": "2026-11-21T08:09:00", "ad": "2026-11-21T08:10:00", "cf": true, "cx": false}
      ]
    },
    "2026/607309999/2026-11-21": {"state": "none"},
    "2026/607300001/2026-11-21": {"state": "error", "http": 503}
  }
}
```

- `state: "none"` = API nie ma jeszcze danych (HTTP 404; z doświadczenia karoo-kolejka zwykle
  > ~3 h przed odjazdem, ale nie zawsze). To **normalny stan**, nie błąd.
- `stops` przenosi tylko pola potrzebne stronie: `aa`/`ad` = `actualArrival`/`actualDeparture`
  (czas lokalny bez offsetu, Europe/Warsaw), `cf` = `isConfirmed` (false = prognoza PLK),
  `cx` = `isCancelled`. `train_status` jak w `TrainRun.kt` z karoo-kolejka:
  S/N = nie wyruszył, P = w drodze, C/F = zakończony, X = odwołany, Q = częściowo odwołany.
- Klucze nieznane / zły format → 400. Wynik zawsze bez klucza API i bez nagłówków upstream.

### 4.2 Strategia upstream (wybór w fazie 0)

**B (domyślna, sprawdzona w karoo-kolejka):** dla każdego kursu
`GET /api/v1/operations/train/{sid}/{oid}/{date}` (3–6 KB). Parser jak `TrainRun.parse`
(sprawdź zgodność `scheduleId`, `orderId`, `operatingDate`).

**A (jeśli faza 0 potwierdzi):** jedno zapytanie zbiorcze
`GET /api/v1/operations/shortened?stations=<Kraków>,<Warszawa…>&fullRoutes=true` na wszystkie
kursy naraz, cache 60 s, filtr do żądanych kluczy. Warunki: obejmuje pociągi w drodze i niedawno
zakończone, ma czasy na każdej stacji trasy (do „ostatnio: …"), mieści się w 1–2 stronach.
Kontrakt 4.1 bez zmian — strona nie wie, którą strategię wybrano.

### 4.3 Cache i limity (dla strategii B)

- Cache API Workera, klucz syntetyczny per kurs. TTL wg stanu:
  zakończony (C/F) lub odwołany (X) → 6 h; w drodze (P) → 60 s; nie wyruszył (S/N) → 120 s;
  404 → 10 min; błąd 5xx → 30 s.
- Limit **30 zapytań upstream na godzinę** (klucz wspólny z karoo-kolejka, która zużywa do 60/h — 15.1).
  Liczony w pamięci izolatu (best effort — przy 2 użytkownikach wystarczy). Po wyczerpaniu:
  kurs dostaje ostatnie udane dane z cache (do 6 h, z prawdziwym `checked_at` — strona odrzuca
  starsze niż 35 min), a gdy ich brak — `state: "error", "http": 429`; strona pokazuje stare dane.
- Upstream 429 → przestań pytać do `Retry-After` (domyślnie 5 min).
- Kolejność przy niedoborze: najbliższe odjazdy pierwsze (jak `DelayPolicy` w karoo-kolejka).

### 4.4 Dostęp i CORS

- `Access-Control-Allow-Origin: https://jach00lczyk.github.io` (zmienna `ALLOWED_ORIGIN`);
  żądania z innym `Origin` → 403. Brak logowania: dane i tak są publiczne, a limit chroni
  budżet API. Bez tokenów w URL (iOS PWA ma osobny storage i psuje takie schematy).
- `Cache-Control: no-store` na odpowiedziach do przeglądarki.

### 4.5 Konfiguracja i wdrożenie

`wrangler.toml`: nazwa `train-tracker-waw-krk`, `ALLOWED_ORIGIN`, `MAX_UPSTREAM_PER_HOUR=30`.
Sekret: `wrangler secret put PDP_API_KEY`. Wdrożenie ręczne z komputera właściciela
(`npx wrangler deploy`), opisane w README. W CI tylko testy.

### 4.6 Testy (`node --test`, mock `fetch`)

Origin dozwolony / obcy; 404 → `none`; 429 upstream → wstrzymanie; limit godzinowy; TTL wg statusu;
walidacja kluczy; klucz API nigdy w odpowiedzi ani w logach; odpowiedź niedotycząca kursu
(inne `orderId`) odrzucona.

---

## 5. Logika domenowa (`web/logic.js`, czysta, pełne testy)

Wszystkie funkcje dostają `now` (epoch ms) z zewnątrz — **zegar wstrzykiwany** (`?now=` w trybie demo).
Strefa wyświetlania: `Intl.DateTimeFormat('pl-PL', {timeZone: 'Europe/Warsaw'})`.

### 5.1 Dzień i listy

- `today` = data w Europe/Warsaw dla `now`.
- **Dziś** = pociągi z `date == today` w wybranym kierunku **plus** pociągi z `date == wczoraj`,
  których oczekiwany przyjazd ≥ `now − 30 min` (kursy po północy).
- **Jutro** = `date == today+1`, sam rozkład.
- Brak `today` w `trains.json` (stare dane) → stan `DataMissing` (8.9).

### 5.2 Kierunek

- Auto: godzina w Warszawie < 12 → `krk`, inaczej `waw`.
- Ręczny wybór: `localStorage["dir"] = {date: today, dir}`; obowiązuje tylko, gdy `date == today`
  (następnego dnia wraca automat). Bez przycisku „wróć do auto".

### 5.3 Dane na żywo → stan pociągu

Dla pociągu z `from`/`to` i odpowiedzi Workera (`stops`). Dane starsze niż **35 min** są ignorowane
(jak w karoo-kolejka: wraca rozkład planowy).

1. `fromStop` = pierwszy postój o `id == from.id`; `toStop` = pierwszy po nim o `id == to.id`
   (API potrafi zdublować postój — tak robi `TrainRun.liveFor`).
2. **Odwołany**: `train_status == "X"` lub `fromStop.cx` lub `toStop.cx`.
3. **Oczekiwany odjazd** = max(planowy, `fromStop.ad ?? fromStop.aa`) — pociąg nie odjeżdża przed czasem.
   **Oczekiwany przyjazd** = `toStop.aa ?? toStop.ad`, a gdy brak — planowy + opóźnienie odjazdu.
4. Opóźnienie = zaokrąglone minuty (oczekiwany − planowy); pokazywane, gdy ≥ 1.
5. Status:
   - `arrived` — `toStop.aa` z `cf` albo `train_status ∈ {C, F}`;
     bez danych na żywo: `now ≥ planowy przyjazd`,
   - `enroute` — `fromStop.ad` z `cf` albo `train_status == "P"` i minięty odjazd;
     bez danych: `now ≥ planowy odjazd`,
   - `upcoming` — pozostałe,
   - `cancelled` — z pkt 2 (na liście w miejscu wg planowego odjazdu).
6. Źródło: `live` (są dane) / `schedule` („rozkładowo") / `none-yet` (Worker zwrócił `none`).
7. Ostatnia stacja (w drodze): ostatni postój z potwierdzonym (`cf`) czasem → nazwa z `stations`.
8. Postęp (pasek): `(now − oczekiwany odjazd) / (oczekiwany przyjazd − oczekiwany odjazd)`,
   przycięty do 3–97%.

### 5.4 Pochodne etykiety (testowane jako czyste funkcje)

- Pastylka statusu: `+N min` / `planowo` / `rozkładowo` / `odwołany`.
- Podpis pod pociągiem nadchodzącym: `peron 4 · tor 2` (cyfry arabskie), `peron jeszcze nieznany`,
  `dane na żywo ok. 3 h przed odjazdem` (odjazd > now+3 h, brak danych),
  `dane na żywo jeszcze niedostępne` (≤ 3 h, brak danych), `sprawdź komunikat przewoźnika` (odwołany).
- Flaga stacji: gdy `waw_station` ≠ Warszawa Centralna — `z W-wy Gdańskiej` (kierunek `krk`) /
  `do W-wy Gdańskiej` (`waw`); nazwa w dopełniaczu z mapy (`Gdańska → Gdańskiej`, `Zachodnia → Zachodniej`,
  `Wschodnia → Wschodniej`).
- Odliczanie: `za 20 min`, `za 1 h 15 min`; w kafelku z prefiksem `odjazd` / `przyjazd`.
- Czas trwania (Jutro): `2 h 18 min`.
- Wiek odświeżenia: `odśw. przed chwilą` (< 1 min), `odśw. 7 min temu`, `odśw. 1 h 12 min temu`;
  **czerwone, gdy ≥ 60 min**.
- Wiek rozkładu: `rozkład z dziś` / `rozkład z wczoraj` / `rozkład sprzed N dni` (wg daty
  `generated_at` w Europe/Warsaw); **czerwone, gdy nie „dziś"**.

### 5.5 Przypięty pociąg

- Jeden naraz. `localStorage["pin"] = key`. Gwiazdka na innym pociągu zastępuje poprzedni.
- Kafelek pokazuje się **niezależnie od wybranego kierunku** (to „jej" pociąg).
- Znika samoczynnie 15 min po przyjeździe albo gdy data kursu jest starsza niż wczoraj.
- Przypinać można pociągi z listy „Dziś" (nadchodzące i w drodze); odwołanego nie.

### 5.6 Które kursy wysyłać do Workera

Przy każdym odświeżeniu: pociągi z listy „Dziś" w **wybranym kierunku**, które są w drodze,
nadchodzą w ciągu 4 h lub dojechały < 30 min temu, plus przypięty. Maks. 30, najbliższe pierwsze.
Zmiana kierunku → natychmiastowe odświeżenie dla nowego kierunku.

---

## 6. Odświeżanie (jedyny polling)

- Przy otwarciu, przy powrocie do karty (`visibilitychange` → visible, jeśli ostatnie > 60 s temu),
  przy zmianie kierunku, po przycisku i **co 60 s, tylko gdy strona jest widoczna**.
- Karta w tle → zero zapytań. Żadnych innych timerów poza tikiem 30 s, który przelicza etykiety
  (wiek odświeżenia, odliczanie, statusy wg `now`) bez sieci.
- Przycisk odświeżania: zawsze wysyła zapytanie (Worker i tak ma cache); w trakcie ikona się kręci
  (`prefers-reduced-motion` → bez animacji).
- Błąd sieci / Workera: zostają poprzednie dane, wiek odświeżenia rośnie (i robi się czerwony ≥ 60 min);
  przez 4 s komunikat `aria-live`: „Nie udało się odświeżyć".
- Ostatnia udana odpowiedź Workera i jej czas w `localStorage` — po ponownym otwarciu od razu
  widać ostatni stan, zanim przyjdzie nowy.
- `trains.json`: zwykły `fetch` z `cache: "no-cache"` przy otwarciu i raz na godzinę.

---

## 7. Strona: struktura i stan

- `index.html` — szkielet, `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
  `apple-mobile-web-app-capable`, `theme-color` = kolor tła (`#55630F`), `manifest.webmanifest`
  (`display: standalone`, `lang: pl`), `apple-touch-icon`.
- `app.js` — stan w jednym obiekcie, render całego widoku do kontenera po każdej zmianie stanu
  (lista jest mała — bez wirtualnego DOM i bez frameworka). Zdarzenia przez delegację.
- Safe area: `padding-top: env(safe-area-inset-top)` w przyklejonym nagłówku.
- Bez service workera w v1 (świeżość danych > offline; ostatni stan i tak jest w `localStorage`).

---

## 8. UI (zgodnie z makietą)

Makieta: `docs/design/mockup.dc.html` — format Claude Design, **nie renderuje się samodzielnie**;
traktuj ją jako źródło kolorów, rozmiarów i układu (style inline + logika w `<script>`).
Właściciel ma podgląd na claude.ai (ekrany: rano 07:50, wieczór 18:40 z nieaktualnymi danymi,
po przewinięciu).

### 8.1 Tokeny

| Token | Wartość | Użycie |
|---|---|---|
| `--bg` | `#55630F` | tło strony i nagłówka (oliwka z grafiki Kai) |
| `--bg-deep` | `#47530C` | tło przełącznika, kafelki „dojechały", przycisk odświeżania |
| `--line` | `#6B7A1E` | obramowanie przycisku odświeżania |
| `--lime` | `#BEF264` | aktywny kierunek, kafelek „Twój pociąg", nagłówki sekcji, linia „Teraz" |
| `--lime-soft` | `#D9F99D` | drugorzędny tekst na oliwce |
| `--ink-lime` | `#1F2708` / `#3F4A12` | tekst na limonce / drugorzędny |
| `--card` | `#A9C6D8` | karty pociągów i kafelki „Jutro" (stalowy niebieski) |
| `--card-ink` | `#0F2533` / `#2B4252` | tekst na karcie / drugorzędny |
| `--late` | `#8A2E0F` | godziny po opóźnieniu |
| `--track` / `--progress` | `#C7DAE6` / `#55630F` | pasek postępu |
| `--flag` | `#D8B4FE` / tekst `#3B0764` | flaga stacji innej niż Centralna (liliowa) |
| `--stale` | `#DC2626` / tekst `#FFFFFF` | nieaktualne odświeżenie / rozkład |
| pastylka planowo | `#DCE9F1` / `#1F4A63` | |
| pastylka +N min | `#FFE4D2` / `#8A2E0F` | |
| pastylka rozkładowo | `#E4E5E2` / `#3F4038` | |
| pastylka odwołany | `#1F2708` / `#FFFFFF` | |
| kafelek: peron | `#1F2708` / `#BEF264` | |
| kafelek: opóźniony | `#C2410C` / `#FFFFFF` | „opóźniony +5 min" |
| kafelek: planowo | `#1F4A63` / `#FFFFFF` | |

Czcionka: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
godziny z `font-variant-numeric: tabular-nums`. Promienie: karty 16 px, kafelek 20 px, pastylki 999 px.
Kontrast tekstu ≥ 4.5:1 (sprawdzone w makiecie — nie zmieniaj par kolorów bez ponownego sprawdzenia).

### 8.2 Nagłówek (przyklejony, `position: sticky`)

**Rozwinięty** (scroll ≤ 60 px):
- Wiersz 1: „Pociągi" (24 px, 700, limonka) + data („środa, 18 listopada"); po prawej dwa małe
  napisy jeden pod drugim (`odśw. X min temu`, `rozkład z dziś`) i okrągły przycisk odświeżania 44 px.
  Nieaktualne → czerwona pastylka (5.4).
- Wiersz 2: przełącznik — dwa przyciski w siatce 2 kolumn, min. 68 px wysokości: mały podpis
  („z Warszawy" / „z Krakowa Gł.") + „Do Krakowa" / „Do Warszawy" (21 px, 700). Aktywny: limonka,
  nieaktywny: przezroczysty z limonkowym tekstem. `role="group"`, `aria-pressed`.
- **Bez** tekstu o trybie automatycznym i bez „Wróć do auto".

**Zwinięty** (scroll > 60 px): jeden wiersz — limonkowy przycisk „Do KRK" / „Do WAW" z ikoną ⇄
(stuknięcie przełącza kierunek; `aria-label` z pełną nazwą), po prawej te same napisy wieku i przycisk
odświeżania. Przejście bez skoku treści (wysokość nagłówka zmienia się, ale lista nie „podskakuje" —
zachowaj pozycję przewinięcia).

### 8.3 Kafelek „Twój pociąg" (limonka)

- Góra: „TWÓJ POCIĄG" (12 px, wersaliki) + „IC 3504".
- Godziny: `08:10 → 10:49` — odjazd 40 px, przyjazd 30 px, strzałka 24 px. Przy opóźnieniu godziny
  już przesunięte, pod spodem przekreślone `plan 08:05 → 10:44`.
- Odliczanie: `odjazd za 20 min` (przed odjazdem) / `przyjazd za 1 h 5 min` (w drodze), 18 px, 700.
- Pastylki: `peron 4` (ciemna pastylka) + `tor 2` (tekst) + `opóźniony +5 min` / `planowo`;
  w drodze zamiast peronu `ostatnio: Opoczno Płd.`.
- Flaga stacji (8.6), jeśli dotyczy.

### 8.4 Sekcja „Dziś"

Nagłówek „Dziś" + `śr 18.11`. Kolejno:
1. Przycisk (przerywana ramka) `Pokaż pociągi, które już dojechały (N)` / `Ukryj pociągi, które już dojechały`
   — domyślnie zwinięte, `aria-expanded`. Wiersz dojechanego: `05:20 → 07:41`, `EIP 1300`, pastylka.
2. Etykieta „W DRODZE" i karty w drodze: `06:23 → 09:10` (odjazd 22 px, przyjazd 18 px; rdzawe przy
   opóźnieniu), przekreślone `plan 06:15 → 08:58`, `IC 3502 · ostatnio: Włoszczowa Płn.`, flaga,
   pastylka statusu w prawym górnym rogu, pasek postępu.
3. Linia „Teraz 07:50" (limonkowa pastylka + kreska).
4. Karty nadchodzące: `08:10 → 10:49` (jak wyżej; odwołany — przekreślony, szary), przekreślony plan,
   wiersz `IC 3504` + pastylka + podpis (5.4), flaga; gwiazdka 44 px po prawej
   (`aria-pressed`, `aria-label` „Przypnij IC 3504" / „Odepnij…"). Przypięty: limonkowa ramka 2 px.
   **Wszystkie** pozostałe pociągi dnia, bez limitu.
5. Brak pociągów w kierunku → komunikat „Dziś nie ma już bezpośrednich pociągów do Krakowa".

### 8.5 Sekcja „Jutro"

Nagłówek „Jutro" + `czw 19.11 · rozkładowo`. Siatka 2 kolumn kafelków: `05:20 → 07:38` (18/15 px),
`EIP · 2 h 18 min`, flaga stacji (mała), jeśli dotyczy. Pod siatką: „Opóźnienia i perony pojawią się
ok. 3 h przed odjazdem." Wszystkie pociągi jutra w wybranym kierunku.

### 8.6 Flaga stacji

Liliowa pastylka z ikoną chorągiewki (inline SVG, `aria-hidden`) i tekstem `z W-wy Gdańskiej` /
`do W-wy Gdańskiej` (5.4). Na kartach „Dziś", na kafelku „Twój pociąg" i na kafelkach „Jutro".

### 8.7 Stopka

„Źródło: PKP PLK" (12 px) — atrybucja z `trains.json` (wymóg warunków ponownego wykorzystania).

### 8.8 Dostępność

Prawdziwe `<button>`, cele dotyku ≥ 44 px, `aria-label` na przyciskach z ikoną, ikony dekoracyjne
`aria-hidden`, `lang="pl"`, strzałki `→` w godzinach `aria-hidden` (czytnik czyta „8:10, 10:49"),
widoczny `:focus-visible`.

### 8.9 Stany inne niż „Ok"

`Loading` (pierwsze otwarcie bez danych — szkielet kart), `DataMissing` („Brak rozkładu na dziś —
sprawdź workflow"), `DataStale` (czerwone „rozkład z wczoraj", lista działa na starych danych),
`LiveError` (stare dane + rosnący wiek odświeżenia), `NoTrainsLeft` (8.4 pkt 5).

---

## 9. Tryb demo (jak `DemoScenarios` w karoo-kolejka)

- `?demo=rano` / `?demo=wieczor` / `?demo=awarie` — strona czyta `web/demo/<scenariusz>.json`
  (rozkład + odpowiedź Workera) zamiast prawdziwych źródeł i ustawia zegar (`?now=` nadpisuje).
- `rano` = ekran 1 makiety (07:50, przypięty IC 3504 +5, odwołany IC 3506, objazd przez Gdańską),
  `wieczor` = ekran 2 (18:40, odświeżone 1 h 12 min temu, rozkład z wczoraj, TLK po północy),
  `awarie` = wszystkie stany z 8.9 po kolei (parametr `&stan=`).
- Demo nie wysyła żadnych zapytań. Służy do pracy nad UI i do testu na iPhonie bez czekania na pociągi.

---

## 10. GitHub Actions

### 10.1 `pages.yml` (wzorowany na `timetable.yml` z karoo-kolejka)

- Wyzwalacze: `schedule: "30 1 * * *"` (≈ 02:30–03:30 w Warszawie) i `"30 5 * * *"` (zapas, gdyby
  pierwszy padł), `push` na `main` (`pipeline/**`, `web/**`, workflow), `workflow_dispatch`.
- `concurrency: gh-pages`, `permissions: contents: write`.
- Kroki: checkout → Python 3.12 → `pytest` → Node 22 → `node --test web/test/*.test.js` →
  pobranie poprzedniego `data/trains.json` z `gh-pages` → `build_trains.py --out dist/data`
  (z `PDP_API_KEY` z sekretu) → **gdy budowa się nie uda: przy `push` użyj poprzedniego
  `trains.json` (żeby wdrożenie kodu strony działało), przy `schedule` zakończ bez publikacji** →
  skopiuj `web/` do `dist/` (bez `test/`) → `.nojekyll` → orphan commit → force-push `gh-pages`.

### 10.2 `ci.yml`

PR i push: `pytest`, `node --test web/test/*.test.js`, `node --test worker/test/*.test.js`. Bez sekretów.

---

## 11. Stabilność i oszczędność — reguły twarde

1. Jedyny polling: sekcja 6. Karta w tle → zero zapytań.
2. Zero zależności runtime (pipeline: stdlib; strona: vanilla; worker: brak). Nowa zależność tylko
   z uzasadnieniem w commit message.
3. Klucz API: tylko sekrety (Actions, Worker). Nigdy w repo, logach, URL ani odpowiedziach.
4. Każdy brak danych (null, 404, brak peronu, brak stacji w słowniku) obsłużony widocznym, spokojnym stanem,
   nigdy wyjątkiem w konsoli i pustym ekranem.
5. Budżet API (klucz wspólny z karoo-kolejka): pipeline ≤ 3 zapytania/dobę; Worker ≤ 30/h (4.3).
6. Czas: zawsze przez wstrzykiwane `now`; daty i godziny zawsze w Europe/Warsaw.

---

## 12. Plan prac (fazy dla Claude Code)

Każda faza kończy się zielonymi testami (`pytest`, `node --test`) i wpisem w `CHANGELOG.md`.

**Faza 0 — Rekonesans API.** `pipeline/recon.py` (klucz z `PDP_API_KEY`, ≤ 15 zapytań) sprawdza
i zapisuje do `docs/api-findings.md`:
1. kody przewoźników pociągów Warszawa ↔ Kraków (jeden dzień bez `carriersInclude`, statystyka),
2. format `ccs`, `nn` i ewentualnej nazwy pociągu dla IC — z czego zrobić etykietę „EIP 1300",
3. ID stacji z 3.3 (po nazwie) i czy `stations=` działa z `fullRoute=true`,
4. rozmiar odpowiedzi dla okna 5 dni,
5. `/operations/train/...`: pola, wartości `trainStatus`, znaczenie `isConfirmed`, reprezentacja odwołania,
   od ilu godzin przed odjazdem przestaje być 404, jak długo po przyjeździe dane są dostępne,
6. `/operations/shortened?stations=…&fullRoutes=true`: czy zawiera pociągi w drodze i zakończone,
   czasy na każdej stacji, rozmiar, stronicowanie → **decyzja A czy B (4.2)**,
7. nagłówki limitów (`X-RateLimit-*`) i obecność CORS (informacyjnie),
8. pokrycie peronów IC na naszych stacjach, obecność `pv`.
Zanonimizowane próbki → `pipeline/tests/fixtures/` i `worker/test/fixtures/` (bez klucza, bez nagłówków).
Dalsze fazy opierają się na tym pliku, nie na zgadywaniu.

**Faza 1 — Pipeline + publikacja.** `build_trains.py`, testy z 3.6, `pages.yml` publikujący
`data/trains.json` i stronę-zaślepkę. Kryterium: plik dostępny pod adresem Pages.

**Faza 2 — Worker.** Kontrakt 4.1, strategia z fazy 0, cache, limity, CORS, testy z 4.6, README
z wdrożeniem.

**Faza 3 — Logika strony.** `logic.js` z sekcji 5 + testy (w tym: kurs po północy, dzień zmiany
czasu, dane > 35 min, zdublowany postój, odwołanie częściowe, ręczny kierunek z wczoraj ignorowany,
pin wygasający). Fixtures demo z sekcji 9.

**Faza 4 — UI.** Sekcja 8 piksel w piksel z makietą, tryb demo, nagłówek zwijany, stany 8.9.

**Faza 5 — Na telefonie.** Test na iPhonie (Safari i z ekranu głównego), poprawki safe area,
README: „jak dodać do ekranu głównego". Tydzień prawdziwych dojazdów, poprawki na bieżąco.

### Backlog (świadomie nie teraz)
Powiadomienia push o opóźnieniu przypiętego pociągu; live peron z innego źródła;
service worker / offline; inne relacje.

---

## 13. Znane ograniczenia (powiedz o nich właścicielowi, nie obchodź ich)

- **Perony tylko z rozkładu** — API nie podaje zmian peronu na żywo.
- Dane na żywo pojawiają się zwykle ~3 h przed odjazdem (nie zawsze) — do tego czasu „rozkładowo".
- „Ostatnio: …" zależy od tego, czy PLK potwierdza czasy na stacjach pośrednich (faza 0).
- Worker liczy limit godzinowy w pamięci — przy restarcie izolatu licznik się zeruje (akceptowalne).

---

## 14. Kryteria akceptacji

1. Rano (przed 12:00) strona otwiera się na „Do Krakowa", po południu na „Do Warszawy"; ręczny wybór
   trzyma się do północy.
2. Lista „Dziś" pokazuje wszystkie bezpośrednie pociągi dnia w kierunku; w drodze — przewidywany
   przyjazd, ostatnią stację i pasek; dojechane — po rozwinięciu.
3. Pociąg przez Warszawę Gdańską (objazd) ma flagę `z W-wy Gdańskiej` / `do W-wy Gdańskiej`.
4. Kurs po północy (np. 21:35 → 00:58) jest widoczny jako „w drodze" po północy.
5. Opóźnienie +5 min: godziny przesunięte i rdzawe, plan przekreślony, pastylka `+5 min`;
   w kafelku „opóźniony +5 min".
6. Otwarcie strony → dane na żywo w < 3 s (przy działającym API); karta w tle nie wysyła zapytań.
7. Brak odświeżenia > 60 min albo rozkład nie z dziś → czerwone oznaczenie w nagłówku.
8. Po przewinięciu nagłówek zwija się do „Do KRK"/„Do WAW" z działającym przełączaniem i odświeżaniem.
9. Przypięty pociąg widoczny w kafelku w obu kierunkach i znika po przyjeździe.
10. Klucz API nie występuje w repo, na `gh-pages`, w odpowiedziach Workera ani w logach Actions.
11. Tydzień pracy: pipeline publikuje codziennie, budżet API nie przekroczony.

---

## 15. Otwarte kwestie (zapytaj właściciela, jeśli faza ich dotyczy)

1. ~~**Klucz API:** osobny czy wspólny z karoo-kolejka?~~ **Rozstrzygnięte 21.11.2026: wspólny** →
   limit Workera 30/h. Gdyby to nie wystarczało — pakiet Standard (`/api/v1/apikey/limit-request`).
2. **Stacje warszawskie:** domyślnie preferowana Centralna, flaga przy każdej innej. Czy Kaja
   wsiada też na Zachodniej / Wschodniej i czy tam flaga ma się pokazywać?
3. ~~Przewoźnicy inni niż PKP Intercity?~~ **Rozstrzygnięte 21.11.2026:** faza 0 znalazła Leo Express
   (ok. 4 kursy dziennie w każdym kierunku) — pokazujemy, z etykietą „Leo Express 3114” (inne bilety niż IC).

---

## Źródła

- API Otwarte Dane Kolejowe PKP PLK: https://pdp-api.plk-sa.pl/api-documentation (Swagger: `/swagger/index.html`)
- karoo-kolejka (pipeline, parser opóźnień, zasady): https://github.com/jach00lczyk/karoo-kolejka —
  `pipeline/build_timetable.py`, `domain/.../delay/TrainRun.kt`, `DelayPolicy.kt`, `SPEC.md` 3, 6.8a, 7.3
- Podobny projekt (Poznań ⇄ Kraków, informacje o peronach i limitach): https://github.com/mprzybyl1/Train-pa-krk
- Cloudflare Workers (Cache API, secrets, wrangler): https://developers.cloudflare.com/workers/
