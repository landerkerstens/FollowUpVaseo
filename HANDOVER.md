# Handover – FollowUp Vaseo

Dit document legt uit hoe de website/app **FollowUp Vaseo** is opgebouwd, zodat je er zelf een variant van kan maken (ander product, ander land, andere klanten). Lees ook `README.md` voor het dagelijks gebruik.

---

## 1. Wat is het?

Een kleine CRM-app voor de verkoop van RF-ablatienaalden (Thyroid en Fibroid) aan ziekenhuizen in Australië:

- **Kaart** met alle ziekenhuizen, gekleurd volgens verkoopstatus.
- **Lijst + zoeken + filters** (status, product, opvolging).
- **Fiche per ziekenhuis**: verkoopfase, contactpersonen, contactmomenten, volgende actie, dealwaarde.
- **Vandaag-scherm**: wat te laat is, wat vandaag/deze week moet, follow-ups van procedures.
- **Contactmomenten loggen** (telefoon, bezoek, demo, procedure, bestelling …), met optionele klinische procedure-gegevens (anoniem).
- **Statistieken**: procedures per maand/ziekenhuis, doelen per jaar, pijplijn, conversietrechter.
- **Export** (CSV/JSON), back-ups terugzetten, werkt offline en op gsm (PWA).

## 2. Technische keuzes in één oogopslag

| Onderdeel | Keuze | Waarom |
|---|---|---|
| Frontend | Gewone HTML + CSS + JavaScript, **geen framework, geen build-stap** | Openen en aanpassen zonder `npm install` |
| Kaart | [Leaflet](https://leafletjs.com) + OpenStreetMap-tegels | Gratis, geen API-sleutel |
| Adres zoeken | [Photon](https://photon.komoot.io) (OpenStreetMap) | Gratis, geen API-sleutel |
| Databank online | [Supabase](https://supabase.com) (Postgres + login) | Gratis tier, login ingebouwd |
| Databank lokaal | `server.py` (Python 3, enkel standaardbibliotheek) | Werkt zonder internet/account |
| Hosting | GitHub Pages (statisch) | Gratis; root-`index.html` stuurt door naar `public/` |
| Lettertype | Jost via Google Fonts | Huisstijl Vaseo Medical |
| Offline | Service worker (`public/sw.js`) + `localStorage` | Werkt zonder bereik |

Bibliotheken (Leaflet, Supabase-js) staan **lokaal** in `public/vendor/`, niet via een CDN.

## 3. Mappenstructuur

```
.
├── index.html              # Doorverwijzing naar public/ (voor GitHub Pages)
├── .nojekyll               # GitHub Pages: geen Jekyll-verwerking
├── server.py               # Lokale server + JSON-opslag (alternatief voor Supabase)
├── start.command           # Dubbelklik-starter voor macOS
├── public/                 # ← DE WEBSITE ZELF
│   ├── index.html          # Alle HTML: topbalk, zijbalk, kaart, tabbalk, login, dialoog
│   ├── styles.css          # Alle opmaak; kleuren/fonts als CSS-variabelen bovenaan
│   ├── config.js           # Supabase-URL + publieke sleutel (leeg = lokale modus)
│   ├── core.js             # Bedrijfslogica zonder scherm (fases, datums, samenvoegen) – getest
│   ├── storage.js          # Opslaglaag: lokaal (server.py) óf Supabase
│   ├── app.js              # Alle schermen en interactie (kaart, lijst, fiche, dialogen …)
│   ├── stats.js            # Statistiekenpagina en grafieken (pure HTML/CSS)
│   ├── sw.js               # Service worker voor offline gebruik
│   ├── logo.svg, favicon.svg, apple-touch-icon.png
│   └── vendor/             # leaflet.js/.css, supabase.js
├── supabase/schema.sql     # Tabellen, back-ups, historiek en beveiliging voor Supabase
├── data/seed.json          # Startdata (ziekenhuizen + contacten) uit de Excel
├── scripts/import_excel.py # Excel → data/seed.json (zonder externe libraries)
└── tests/                  # core.test.js (JS-logica) + test_server.py (server)
```

### Laadvolgorde van de scripts (`public/index.html`)

```
vendor/leaflet.js → vendor/supabase.js → core.js → config.js → stats.js → storage.js → app.js
```

Elk bestand hangt één object aan `window`:

- `window.FollowUpCore` (core.js) – logica
- `window.FOLLOWUP_CONFIG` (config.js) – instellingen
- `window.FollowUpStats` (stats.js) – statistieken
- `window.FollowUpStore` (storage.js) – opslag
- `app.js` gebruikt die allemaal en start de app.

De `?v=202611051200` achter elke bestandsnaam is **cache-busting**: verhoog dat getal (overal tegelijk) na elke wijziging zodat browsers de nieuwe versie laden.

## 4. Datamodel

Alle data is **één JSON-document**:

```jsonc
{
  "version": 2,
  "hospitals": [
    {
      "id": "cc17e9edcc",
      "name": "Gold Coast Private Hospital",
      "sector": "Private",                 // Private / Public
      "region": "QLD",                     // zie REGIONS in core.js
      "address": "14 Hill Street, Southport QLD 4215",
      "lat": -27.96, "lng": 153.38,
      "stage": "Prospect",                 // verkoopfase (zie §5)
      "status": "red",                     // wordt AFGELEID van stage, nooit zelf zetten
      "stageHistory": [{ "stage": "Eerste contact", "date": "2026-03-01" }],
      "products": ["Thyroid"],
      "nextAction": "offerte sturen", "nextActionDate": "2026-11-12",
      "dealValue": 12000, "winChance": "",  // leeg = standaard per fase
      "lostReason": "", "notes": "", "owner": "", "createdAt": "",
      "contacts": [
        { "id": "…", "name": "Dr …", "role": "Endocrine Surgeon", "phone": "", "email": "",
          "address": "", "product": "Thyroid", "notes": "", "primary": false }
      ],
      "activities": [
        { "id": "…", "date": "2026-10-02", "type": "Procedure", "product": "Thyroid",
          "contactId": "…", "qty": 1, "note": "", "createdBy": "naam@…",
          "details": { "volume": 12.3, "followupDate": "2027-01-02", "ageGroup": "40-49", … } }
      ]
    }
  ]
}
```

- `core.js → normalize()` maakt elk ziekenhuis veilig (types, datums, id's). Voeg je een veld toe, voeg het daar ook toe.
- `core.js → migrate()` zet oudere versies om. Verander je het formaat, verhoog `version` en schrijf een migratie.

## 5. Bedrijfslogica (core.js)

Alle regels staan bovenaan `public/core.js` en zijn de eerste plek om aan te passen voor een variant:

| Constante | Betekenis |
|---|---|
| `STAGES` | Verkoopfases (Prospect → … → Klant, On hold, Niet geïnteresseerd) |
| `FUNNEL` | De eerste 7 fases = de trechter |
| `STATUS` | 4 kleuren: green / orange / red / grey + label |
| `ACT_TYPES` | Soorten contactmomenten |
| `REGIONS` | Australische staten |
| `WIN_CHANCE` | Standaard winkans % per fase (voor gewogen pijplijn) |
| `STALE_DAYS` | Na hoeveel dagen zonder contact een ziekenhuis "lang stil" is (30) |

Belangrijke regels:

- **De fase bepaalt de kleur** (`statusForStage`): Klant = groen, Prospect = rood, Niet geïnteresseerd = grijs, de rest oranje.
- **Een contactmoment duwt de fase enkel vooruit** (`stageAfterActivity`): Bezoek → Meeting / bezoek, Demo → Demo gedaan, Procedure → Proefperiode, Bestelling → Klant.
- `dueGroups()` bepaalt wat op het Vandaag-scherm komt.
- `funnel()`, `daysToCustomer()`, `pipelineValue()` voeden de statistieken.

Specifiek voor dit product staat in **app.js** bovenaan:

- `PRODUCTS = ["Thyroid", "Fibroid"]`
- `LOST_REASONS` – redenen waarom een deal verloren ging
- `PROC_FIELDS` – de velden van een procedure (TI-RADS, FIGO, volume, naald, …). Het veld `product` bepaalt bij welk product een veld getoond wordt.
- `AUS_BOUNDS` – kaartgrenzen van Australië

En in **stats.js**: `DEFAULT_TARGETS` (doelen per jaar/product) en `GOAL_REGION = "QLD"`.

## 6. Opslag en synchronisatie

`storage.js` kiest zelf:

- **`config.js` leeg** → lokale modus: `GET/PUT /api/data` op `server.py`, data in `data/db.json`, dagelijkse back-up in `data/backups/`.
- **`config.js` ingevuld** → Supabase: login-scherm, data in tabel `app_state` (één rij `id = 'main'`).

Hoe opslaan werkt (`app.js`, sectie "opslag"):

1. Elke wijziging gaat eerst naar `localStorage` (`followup-mine`) → nooit verloren bij wegvallend bereik.
2. Na 400 ms wordt het hele document naar de databank gestuurd.
3. **Optimistische vergrendeling**: Supabase overschrijft alleen als `updated_at` nog gelijk is aan wat we laatst lazen. Anders → `ConflictError`.
4. Bij een conflict: nieuwste versie ophalen en **3-weg samenvoegen** (`Core.merge(base, mine, theirs)`) per ziekenhuis, contact en contactmoment. Alleen als hetzelfde veld aan beide kanten wijzigde, wint de laatste.
5. Offline: om de 30 s opnieuw proberen.
6. Bij afmelden wordt alle lokale data gewist.

## 7. Supabase opzetten (voor je eigen variant)

1. Maak een gratis project op supabase.com.
2. **SQL Editor** → plak de volledige inhoud van `supabase/schema.sql` → Run. Dit maakt:
   - `app_state` (de data), `app_state_backups` (dagkopie, 365 dagen), `app_state_history` (versies, max. 1 per 10 min, 90 dagen);
   - `allowed_users` + Row Level Security: **alleen gebruikers op die lijst** kunnen lezen/schrijven.
3. **Authentication → Users**: maak je gebruiker(s) aan (e-mail + wachtwoord). Zet registratie **uit** (Sign In / Providers).
4. Voeg nieuwe gebruikers toe aan de lijst:
   ```sql
   insert into public.allowed_users (user_id) select id from auth.users where email = 'naam@voorbeeld.be';
   ```
5. **Project Settings → API**: kopieer de Project URL en de *anon/publishable* sleutel naar `public/config.js`.
6. Pas in `public/index.html` de **Content-Security-Policy** aan: vervang `https://gmiefdoeezfobquwxyve.supabase.co` door jouw Supabase-URL (anders blokkeert de browser de verbinding).

> De anon-sleutel mag publiek staan: de beveiliging zit in Row Level Security. De *service_role*-sleutel mag **nooit** in de code.

## 8. Lokaal draaien en testen

```bash
python3 server.py
```

Open <http://localhost:8080>. Voor lokale modus zonder Supabase: maak de twee waarden in `public/config.js` leeg.

Tests (`tests/run.sh` gebruikt de JavaScriptCore van macOS):

```bash
tests/run.sh
```

Op Linux/Windows kan je de JS-test met Node draaien door `core.js` en `core.test.js` na elkaar te laden, en de Python-test met:

```bash
python3 -m unittest discover -s tests -p "test_*.py"
```

## 9. Online zetten (GitHub Pages)

1. Repo op GitHub → **Settings → Pages** → Deploy from branch → `main` / root.
2. De root-`index.html` stuurt door naar `public/`. `.nojekyll` zorgt dat GitHub de bestanden ongewijzigd serveert.
3. Elke push naar `main` = nieuwe versie online. Vergeet de `?v=` niet te verhogen.

Elke andere statische host (Netlify, Vercel, Cloudflare Pages) werkt ook: publiceer gewoon de map `public/`.

## 10. Stappenplan: je eigen variant maken

1. **Fork/kopieer** de repo en verwijder `data/seed.json` (die bevat echte contactgegevens – zie §11).
2. **Huisstijl**: `public/styles.css` → variabelen in `:root` (kleuren, `--font`), `logo.svg`, `favicon.svg`, `apple-touch-icon.png`, de Google-Fonts-link in `index.html` en de titel/`apple-mobile-web-app-title`.
3. **Producten**: `PRODUCTS` in `app.js` én `stats.js`, de productfilter-knoppen in `index.html`, de reekskleuren `--series-1/2` in `styles.css`.
4. **Land/regio**: `REGIONS` in `core.js`, `AUS_BOUNDS` en de knop "Heel Australië" in `app.js`/`index.html`, `AU_BBOX` (zoekgebied van de Photon-adreszoeker in `app.js`).
5. **Verkoopproces**: `STAGES`, `ACT_TYPES`, `WIN_CHANCE`, `stageAfterActivity` in `core.js`; `LOST_REASONS` in `app.js`.
6. **Procedurevelden**: `PROC_FIELDS` in `app.js` (of weglaten als je product geen procedures heeft).
7. **Doelen**: `DEFAULT_TARGETS` en `GOAL_REGION` in `stats.js`.
8. **Startdata**: eigen Excel → pas `scripts/import_excel.py` aan (tabbladnamen, kolommen, `LOCATIONS`) → `data/seed.json`. Of begin leeg en voeg klanten toe in de app.
9. **Databank**: eigen Supabase-project (§7), `config.js` en CSP aanpassen.
10. **Taal**: alle teksten staan rechtstreeks in de HTML/JS (Nederlands). Zoek/vervang voor een andere taal; datums gebruiken `nl-BE` (zoek op `toLocaleDateString`/`toLocaleString`).
11. Verhoog `?v=` in `index.html`, en de cachenaam `followup-shell-v1` in `sw.js` als je bestanden toevoegt.

## 11. Privacy en beveiliging – let op

- **`data/seed.json` bevat echte namen, telefoonnummers en e-mailadressen** van artsen. Geef die niet door en verwijder ze in je variant. Staat de repo publiek op GitHub Pages, dan is dat bestand ook via de website op te vragen.
- Procedures bewaren **geen patiëntnamen of -nummers**, enkel een leeftijdsklasse. Hou dat zo.
- Externe diensten die het IP-adres van de gebruiker zien: Supabase, OpenStreetMap-tegels, Photon en Google Fonts.
- De Content-Security-Policy in `index.html` laat enkel die domeinen toe; voeg je een dienst toe, zet die er ook bij.
- `server.py` aanvaardt enkel verzoeken van `localhost` (bescherming tegen DNS-rebinding/CSRF) en is **niet** bedoeld om publiek op internet te zetten.

## 12. Waar vind ik wat? (snelle index van app.js)

| Sectie in `app.js` | Wat |
|---|---|
| `// ---------- opslag ----------` | Opslaan, offline, samenvoegen |
| `// ---------- kaart ----------` | Leaflet-kaart, markers, locatie kiezen/slepen |
| `// ---------- filter + lijst ----------` | Zoeken, filters, lijst, KPI's |
| `// ---------- fiche ----------` | `renderFiche()` – detailpaneel ziekenhuis |
| `// ---------- vandaag ----------` | `renderToday()` – takenoverzicht |
| `// ---------- adres zoeken ----------` | Photon-adressuggesties |
| `// ---------- dialogen ----------` | Contact- en contactmomentdialogen |
| `// ---------- export / import ----------` | CSV/JSON export, import, back-ups |
| `// ---------- start ----------` | `init()` – opstarten, laden, startlijst aanbieden |
| `// ---------- schermen ----------` | `setView()` – wisselen tussen Vandaag/Lijst/Kaart/Cijfers |
