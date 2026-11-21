# Changelog

## [Unreleased]

### CI: Node 22 (21.11.2026)
- `node --test <katalog>` działa dopiero od Node 23 — w Actions (Node 22) testy strony padały
  „Cannot find module …/web/test”. Komendy wszędzie zmienione na `node --test <katalog>/*.test.js`.

### Leo Express (21.11.2026)
- Decyzja właściciela (SPEC 15.3): pociągi Leo Express WAW ↔ KRK są pokazywane (ok. 4 dziennie w każdym
  kierunku). `CARRIERS = ["IC", "Leo Express"]`, filtr sprawdzony na żywo (1 zapytanie). Etykieta
  „Leo Express 3114” zamiast kategorii `Ex` — od razu widać innego przewoźnika (inne bilety).
- Prawdziwe dane: 344 pociągi, 141 KB. 28 testów pipeline'u.

### Rekonesans API na żywo (21.11.2026)
- `recon.py` wykonany (11 zapytań) — wyniki w `docs/api-findings.md`, sekcja D; próbki w `*/fixtures/recon/`.
  Potwierdzone: przewoźnik `IC`, etykieta `ccs nn`, strategia B Workera, brak `stations=`.
- Pipeline na prawdziwych danych wywracał się na pociągu Wilno → Kraków (czas litewski na odcinku zagranicznym).
  Rosnące czasy sprawdzane teraz tylko na odcinku Warszawa–Kraków; test i przypadek w fixture.
  Budowa z prawdziwej odpowiedzi: 304 pociągi, 124 KB, perony 99,5%.
- Testy na prawdziwych próbkach `/operations/train` (pominięte `isConfirmed`/`isCancelled` = false).
- Znalezione 8 kursów Leo Express WAW ↔ KRK (SPEC 15.3 — patrz wyżej).

### Klucz API wspólny z karoo-kolejka (21.11.2026)
- Decyzja właściciela (SPEC 15.1): ten sam klucz `PDP_API_KEY` co w karoo-kolejka. Limit Workera
  obniżony z 80 do 30 zapytań/h (karoo-kolejka zużywa do 60/h z 100/h pakietu Basic).
- Worker po wyczerpaniu limitu albo przy wstrzymaniu po 429 oddaje ostatnie udane dane kursu z cache
  (do 6 h, z oryginalnym `checked_at`) zamiast błędu — strona sama odrzuca dane starsze niż 35 min.
  17 testów Workera.

### Faza 4 — UI (21.11.2026)
- `web/index.html`, `styles.css`, `app.js`: widok wg SPEC 8 i makiety — nagłówek z przełącznikiem kierunku,
  zwijany po przewinięciu do „Do KRK”/„Do WAW” (nagłówek `fixed` + stały odstęp, więc lista nie podskakuje),
  kafelek „Twój pociąg”, sekcje „Dziś” (dojechane schowane, w drodze z paskiem, linia „Teraz”, nadchodzące)
  i „Jutro”, flaga stacji, stany 8.9 (ładowanie, brak rozkładu, nieaktualne dane, błąd odświeżania, koniec dnia).
- Odświeżanie wg SPEC 6: przy otwarciu, powrocie do karty, zmianie kierunku, przyciskiem i co 60 s tylko przy
  widocznej karcie; tik 30 s bez sieci. Ostatnia odpowiedź Workera i rozkład w `localStorage`.
- Tryb demo `?demo=rano|wieczor|awarie[&stan=…][&now=HH:MM]` bez zapytań do API.
- Manifest PWA i ikony (180/192/512, maskable). Gwiazdka także na kartach „w drodze” (SPEC 5.5 pozwala
  przypinać pociągi w drodze; makieta jej tam nie miała).
- Sprawdzone w przeglądarce (390×844): scenariusze rano, wieczór, awarie; przełączanie kierunku, pin, odświeżanie.

### Faza 3 — logika strony
- `web/logic.js` (bez DOM, zegar wstrzykiwany): dzień i listy, kierunek auto/ręczny, stan pociągu z danych
  na żywo, etykiety, pin, wybór kursów do Workera. 26 testów (`node --test web/test`), m.in. kurs po północy,
  zmiana czasu, dane > 35 min, zdublowany postój, odwołanie częściowe, ręczny kierunek z wczoraj, wygasający pin.
- Fixtures demo z generatora `web/demo/generate.mjs` (ekrany makiety).

### Faza 2 — Worker
- `worker/src/index.js`: `GET /live?t=…` (≤ 30 kursów), strategia B (`/operations/train` per kurs),
  cache z TTL wg statusu, limit 80/h z pierwszeństwem najbliższych, wstrzymanie po 429, CORS tylko dla
  `ALLOWED_ORIGIN`, odrzucanie odpowiedzi o innym kursie. 15 testów z mockiem `fetch`.
  `wrangler` tylko jako devDependency (wdrożenie z komputera właściciela).

### Faza 1 — pipeline i publikacja
- `pipeline/build_trains.py` (stdlib): filtr WAW ↔ KRK po kolejności postojów, wybór stacji warszawskiej
  wg preferencji i typów postoju, perony z wariantów `pv`, `BUS`, epoch w Europe/Warsaw, walidacja 3.5,
  `--skip-if-fresh` dla zapasowego crona. 25 testów (`pytest`).
- `.github/workflows/pages.yml` (testy → dane → gh-pages; przy pushu awaryjnie poprzedni `trains.json`)
  i `ci.yml`.

### Faza 0 — rekonesans API
- `pipeline/recon.py` (≤ 12 zapytań) i `docs/api-findings.md` z faktami z karoo-kolejka i dokumentacji
  API. **Rekonesans na żywo jeszcze nie wykonany** (brak klucza w środowisku budowy) — decyzje w sekcji C
  do potwierdzenia.

### Wcześniej
- SPEC v1 i makieta (`docs/design/mockup.dc.html`) uzgodnione z właścicielem (21.11.2026).
