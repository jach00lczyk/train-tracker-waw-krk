# CLAUDE.md

Pełna specyfikacja: [SPEC.md](SPEC.md). Przeczytaj w całości przed pierwszą zmianą.
Priorytet: **prostota i stabilność ponad liczbę funkcji.** Wzorzec: repo karoo-kolejka
(pipeline, parser opóźnień, zasady) — kopiuj sprawdzone fragmenty zamiast pisać od zera.

## Reguły

- Nie zgaduj API PLK — `docs/api-findings.md` (faza 0) lub dokumentacja `https://pdp-api.plk-sa.pl/api-documentation`.
- Logika strony w `web/logic.js` bez DOM; każda zmiana tam = test. Czas zawsze przez wstrzykiwane `now`, strefa Europe/Warsaw.
- Zero zależności runtime: pipeline na bibliotece standardowej, strona bez frameworka i bez budowania, worker bez paczek. Nowa zależność tylko z uzasadnieniem w commit message.
- Bez nowego pollingu/timerów bez wpisu w SPEC 6.
- Repo jest publiczne: klucz `PDP_API_KEY` tylko w sekretach Actions i Workera; nigdy w plikach, logach, URL ani odpowiedziach.
- Teksty UI po polsku. Wygląd zgodnie z SPEC 8 i `docs/design/mockup.dc.html`; nie zmieniaj par kolorów bez sprawdzenia kontrastu.
- Każda faza kończy się zielonymi testami i wpisem w `CHANGELOG.md`.

## Komendy

```
# pipeline
cd pipeline
uv run --python 3.12 --with-requirements requirements.txt pytest
uv run --python 3.12 python build_trains.py --out ../dist/data

# strona
node --test web/test
python3 -m http.server -d web 8000     # http://localhost:8000/?demo=rano

# worker
cd worker && node --test test && npx wrangler dev
```
