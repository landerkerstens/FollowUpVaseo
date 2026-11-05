# FollowUp Vaseo

Administratie van de verkoop van RF-naalden in Australië: een kaart met alle ziekenhuizen,
zoeken op naam, en per ziekenhuis een fiche met status, contactpersonen en contactmomenten.

## Starten

Geen installatie nodig, enkel Python 3 (staat standaard op je Mac).

- **Dubbelklik** op `start.command`, of
- in de VS Code-terminal: `python3 server.py`, of
- in VS Code: Run and Debug → "FollowUp Vaseo starten".

Open daarna <http://localhost:8080>. Stoppen met `Ctrl+C` in de terminal.

## Werken met de app

De **verkoopfase** bepaalt de status; er is één bron, zodat cijfers en kaart altijd kloppen.

| Vorm | Status | Fase |
|---|---|---|
| Groene cirkel | Aan het verkopen | Klant |
| Oranje ruit | In progress | Eerste contact t/m Proefperiode, On hold |
| Rood vierkant | Nog geen contact | Prospect |
| Open ring | Niet geïnteresseerd | Niet geïnteresseerd |

**Klant = eerste bestelling.** Een contactmoment duwt de fase alleen vooruit: een bezoek naar Meeting / bezoek, een demo naar Demo gedaan, een procedure naar Proefperiode, een bestelling naar Klant. De regels staan in `stageAfterActivity` in `public/core.js`.

- **Vandaag**: wat te laat is, wat vandaag en deze week moet, follow-ups van procedures, ziekenhuizen zonder volgende actie en ziekenhuizen die lang stil zijn. Met Log, +1 week en ✓.
- **Log contact**: kies het ziekenhuis, het type, een notitie en meteen de volgende actie.
- **Zoeken**: op ziekenhuis, arts, functie, stad of e-mail. `Enter` opent het eerste resultaat, `/` springt naar de zoekbalk.
- **Fiche**: alles is aanpasbaar. "In agenda" downloadt de volgende actie als agenda-afspraak.
- **Adres**: zoekt via Photon (OpenStreetMap). Wat je daar typt, gaat naar die externe dienst, dus enkel adressen en ziekenhuisnamen.
- **Procedures**: zonder patiëntnamen of -nummers, met leeftijdsklasse in plaats van exacte leeftijd.
- **Statistieken**: procedures, doelen (tellen QLD en ziekenhuizen zonder regio), pijplijn, conversie, waarde en klinische gegevens.
- **Exporteren**: CSV's voor Excel of een volledige JSON-back-up.

## Opslaan

Elke wijziging staat meteen op het toestel en gaat daarna naar de databank. Zonder bereik blijft ze bewaard en wordt ze later verstuurd. Werk je op twee toestellen tegelijk, dan worden de wijzigingen per ziekenhuis, contact en contactmoment samengevoegd; alleen als hetzelfde veld op beide werd gewijzigd, wint de laatste opslag. Bij afmelden wordt de kopie op het toestel gewist.

## Online databank

`supabase/schema.sql` plak je in Supabase → SQL Editor. Het script mag opnieuw uitgevoerd worden. Het voegt toe:

- een historiek van versies (maximaal één per 10 minuten, 90 dagen bewaard) en dagkopieën (365 dagen), terug te zetten via ⋯ → Back-ups terugzetten;
- een lijst toegelaten gebruikers (`allowed_users`). Bij de eerste keer komen alle bestaande accounts erop; een nieuw account moet je toevoegen:

```sql
insert into public.allowed_users (user_id) select id from auth.users where email = 'naam@voorbeeld.be';
```

Hou registratie uit in Supabase (Authentication → Sign In / Providers).

## Externe diensten

Supabase (databank en login), OpenStreetMap (kaarttegels), Photon (adres zoeken) en Google Fonts (lettertype) zien het IP-adres van de gebruiker. Leaflet en de Supabase-bibliotheek staan zelf in `public/vendor/`.

## Testen

```bash
tests/run.sh
```

## Data

- `data/db.json` – je actuele data (wordt automatisch opgeslagen bij elke wijziging).
- `data/backups/db-JJJJ-MM-DD.json` – automatische dagelijkse back-up.
- `data/seed.json` – startdata uit ContactList.xlsx. Wordt alleen gebruikt als `db.json` nog niet bestaat.

De Excel opnieuw inlezen (overschrijft alleen `seed.json`):

```bash
python3 scripts/import_excel.py "/Users/landerkerstens/Desktop/VaseoMedical/Camb Int/MarketResearch/ContactList.xlsx"
```

Wil je volledig opnieuw beginnen vanaf de Excel: verwijder `data/db.json` en herstart de server.
