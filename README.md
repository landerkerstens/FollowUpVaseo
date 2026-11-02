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

| Kleur | Betekenis |
|---|---|
| 🟢 Groen | Aan het verkopen |
| 🟠 Oranje | In progress / nog actie nodig |
| 🔴 Rood | Nog geen contact |

- **Zoeken**: op ziekenhuis, arts, functie, stad of e-mail. `Enter` opent het eerste resultaat, `/` springt naar de zoekbalk.
- **Fiche**: klik op een bolletje op de kaart of in de lijst. Alles is aanpasbaar: naam, status, verkoopfase, volgende actie, adres, notities.
- **Contactpersonen**: toevoegen, bewerken (✎), verwijderen. Met ★ markeer je de hoofdcontactpersoon.
- **Contactmomenten**: Prospectie, Telefoon, E-mail, Bezoek, Demo, Procedure, Bestelling. Bij Procedure/Bestelling vul je het aantal in; de tellers in de fiche en bovenaan tellen dat op.
  - Eerste contactmoment bij een rood ziekenhuis → wordt automatisch oranje.
  - Een procedure of bestelling → wordt automatisch groen. De kleur kan je altijd zelf terugzetten.
- **Volgende actie + datum**: verlopen acties krijgen een rode badge; filter "Actie te laat" toont ze allemaal.
- **Locatie**: de coördinaten zijn benaderd. Gebruik "Versleep marker" of "Klik nieuwe locatie" in de fiche om ze te verbeteren.
- **Exporteer**: CSV's voor Excel (ziekenhuizen, contactpersonen, contactmomenten) of een volledige JSON-back-up. **Importeer** zet zo'n back-up terug.

## Data

- `data/db.json` – je actuele data (wordt automatisch opgeslagen bij elke wijziging).
- `data/backups/db-JJJJ-MM-DD.json` – automatische dagelijkse back-up.
- `data/seed.json` – startdata uit ContactList.xlsx. Wordt alleen gebruikt als `db.json` nog niet bestaat.

De Excel opnieuw inlezen (overschrijft alleen `seed.json`):

```bash
python3 scripts/import_excel.py "/Users/landerkerstens/Desktop/VaseoMedical/Camb Int/MarketResearch/ContactList.xlsx"
```

Wil je volledig opnieuw beginnen vanaf de Excel: verwijder `data/db.json` en herstart de server.
