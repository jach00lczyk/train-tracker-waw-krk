# Pociągi Warszawa ↔ Kraków

Strona (PWA na ekran główny iPhone'a) z bezpośrednimi pociągami Warszawa ↔ Kraków Główny na dziś
i jutro, z opóźnieniami na żywo. Specyfikacja: [SPEC.md](SPEC.md). Dane: PKP PLK — Otwarte Dane Kolejowe.

Adres: https://jach00lczyk.github.io/train-tracker-waw-krk/

## Jak to działa

- **Rozkład** — `pipeline/build_trains.py` codziennie w GitHub Actions (`.github/workflows/pages.yml`)
  pobiera rozkład z API PLK, zostawia pociągi WAW ↔ KRK i publikuje `data/trains.json` razem ze stroną
  na gałęzi `gh-pages`.
- **Opóźnienia** — strona pyta mały Cloudflare Worker (`worker/`), który trzyma klucz API.
  Klucz nigdy nie trafia do przeglądarki ani do repozytorium.
- **Strona** — `web/`, czysty HTML/CSS/JS bez budowania.

## Pierwsze uruchomienie (raz)

1. **Sekret repo:** GitHub → Settings → Secrets and variables → Actions → `PDP_API_KEY`
   — ten sam klucz co w karoo-kolejka (SPEC 15.1; dlatego Worker ma limit 30/h).
2. **GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → `gh-pages` / `(root)`.
   Gałąź powstanie po pierwszym przebiegu workflow (push na `main` albo *Run workflow*).
3. **Worker** (z komputera):
   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler kv namespace create STATE   # raz; ID wpisz w wrangler.toml ([[kv_namespaces]])
   npx wrangler secret put PDP_API_KEY
   npx wrangler deploy
   ```
   KV trzyma wspólny przypięty pociąg (SPEC 5.5). Przy zmianie API Workera najpierw `deploy`, potem push strony.
   Adres z wyjścia `deploy` (np. `https://train-tracker-waw-krk.<konto>.workers.dev`) wpisz do
   `web/config.js` jako `LIVE_URL` i wypchnij zmianę. Bez tego strona działa „rozkładowo”.
4. **Rekonesans API (faza 0)** — jednorazowo, ≤ 12 zapytań:
   ```bash
   cd pipeline
   PDP_API_KEY=… uv run --python 3.12 python recon.py
   ```
   Wynik (`recon-report.md`) wklej do `docs/api-findings.md`, sekcja D.
   Na macOS Python z `uv` może zgłosić `CERTIFICATE_VERIFY_FAILED` (łańcuch Certum serwera API) — wtedy
   dodaj certyfikaty systemowe (weryfikacja TLS zostaje włączona):
   ```bash
   security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > /tmp/roots.pem
   export SSL_CERT_FILE=/tmp/roots.pem
   ```

## Na iPhonie: dodanie do ekranu głównego

1. Otwórz adres strony w **Safari**.
2. Stuknij **Udostępnij** (kwadrat ze strzałką) → **Do ekranu początkowego** → **Dodaj**.
3. Uruchamiaj z ikony — strona otwiera się na pełnym ekranie, bez paska Safari.

Rano (przed 12:00) strona otwiera się na „Do Krakowa”, po południu na „Do Warszawy”; ręczny wybór
obowiązuje do północy. Pinezka przypina pociąg — **osobno do Krakowa i do Warszawy**, wspólnie dla wszystkich
urządzeń (Safari, ikona na ekranie, telefony domowników). Oba przypięte są u góry w kontenerze „Przypięte”;
stuknięcie w mały pasek przełącza kierunek. Pociągi, które już dojechały albo są w drodze, są zwinięte
w wierszu „Wcześniejsze”. Stuknięcie w kafelek pokazuje stacje pośrednie.

Ikona dodana przed 21.11.2026 ma rozmytą górę ekranu (iOS 26.1+). iOS czyta styl paska statusu tylko przy
dodawaniu do ekranu — **usuń ikonę i dodaj ją ponownie**.

## Praca lokalna

```bash
# pipeline
cd pipeline
uv run --python 3.12 --with-requirements requirements.txt pytest
uv run --python 3.12 python build_trains.py --schedules tests/fixtures/pdp_schedules.json --today 2026-10-24 --min-trains 1 --out ../web/data

# strona (tryb demo nie wysyła zapytań)
node --test web/test/*.test.js
python3 -m http.server -d web 8000
# http://localhost:8000/?demo=rano
# http://localhost:8000/?demo=wieczor
# http://localhost:8000/?demo=awarie&stan=ladowanie|brak|stary|blad|koniec
# ?now=09:30 nadpisuje zegar demo; node web/demo/generate.mjs odtwarza fixtures

# worker
cd worker && node --test test/*.test.js
cp .dev.vars.example .dev.vars   # wpisz klucz; plik jest w .gitignore
npx wrangler dev
```

## Ograniczenia (SPEC 13)

- Perony tylko z rozkładu — API nie podaje zmian peronu na żywo.
- Dane na żywo pojawiają się zwykle ok. 3 h przed startem kursu; wcześniej „rozkładowo”.
- „Ostatnio: …” zależy od tego, czy PLK potwierdza czasy na stacjach pośrednich.
- Worker liczy limit godzinowy (30/h, klucz wspólny z karoo-kolejka) w pamięci — po restarcie licznik się zeruje.
  Po wyczerpaniu limitu oddaje ostatnie znane dane; przy dłuższym patrzeniu na stronę opóźnienia mogą się
  odświeżać rzadziej niż co minutę.
