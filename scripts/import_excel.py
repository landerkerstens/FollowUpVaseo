#!/usr/bin/env python3
"""Zet ContactList.xlsx om naar data/seed.json (startdata voor de website).

Gebruik:
    python3 scripts/import_excel.py "/pad/naar/ContactList.xlsx"

Leest de tabbladen 'Contact Thyroid' en 'Contact Fibroid' zonder externe libraries.
Overschrijft data/db.json NIET; de server maakt db.json alleen aan uit seed.json
als db.json nog niet bestaat.
"""
import json
import re
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
ROOT = Path(__file__).resolve().parent.parent

# Benaderde coördinaten; in de website versleep je een marker om hem te verbeteren.
LOCATIONS = {
    "Gold Coast Private Hospital": (-27.9617, 153.3832, "14 Hill Street, Southport QLD 4215"),
    "Pindara Private": (-28.0003, 153.3966, "Allchurch Avenue, Benowa QLD 4217"),
    "John Flynn Private": (-28.1510, 153.4930, "42 Inland Drive, Tugun QLD 4224"),
    "Gold Coast University": (-27.9609, 153.3791, "1 Hospital Boulevard, Southport QLD 4215"),
    "Robina Hospital": (-28.0773, 153.3868, "2 Bayberry Lane, Robina QLD 4226"),
    "Qscan": (-27.3747, 153.0800, "183 Tufnell Rd, Banyo QLD 4014"),
    "Royal Brisbane & Women's": (-27.4485, 153.0279, "Butterfield St, Herston QLD 4006"),
    "The Prince Charles": (-27.3930, 153.0315, "Rode Rd, Chermside QLD 4032"),
    "Princess Alexandra - Woolloongabba": (-27.4990, 153.0335, "199 Ipswich Rd, Woolloongabba QLD 4102"),
    "Queensland Children's": (-27.4839, 153.0261, "501 Stanley St, South Brisbane QLD 4101"),
    "Queen Elizabeth II Jubilee": (-27.5643, 153.0386, "Kessels Rd, Coopers Plains QLD 4108"),
    "Greenslopes": (-27.5085, 153.0466, "Newdegate St, Greenslopes QLD 4120"),
    "The Wesley": (-27.4757, 152.9940, "451 Coronation Dr, Auchenflower QLD 4066"),
    "Mater Private": (-27.4858, 153.0292, "301 Vulture St, South Brisbane QLD 4101"),
    "St Andrew's War Memorial": (-27.4620, 153.0248, "457 Wickham Ter, Spring Hill QLD 4000"),
    "Sunnybank": (-27.5770, 153.0590, "245 McCullough St, Sunnybank QLD 4109"),
    "St Vincent's Northside": (-27.3870, 153.0330, "627 Rode Rd, Chermside QLD 4032"),
    "St Vincent's Kangaroo Point": (-27.4780, 153.0360, "411 Main St, Kangaroo Point QLD 4169"),
    "St Andrew’s Ipswich Private Hospital": (-27.6155, 152.7600, "Roderick St, Ipswich QLD 4305"),
    "Mermaid Beach Radiology": (-28.0440, 153.4350, "2469 Gold Coast Highway, Mermaid Beach QLD 4218"),
    "Sunshine Coast University Private Hospital": (-26.7480, 153.1160, "3 Doherty Street, Birtinya QLD 4575"),
    "Australian Thyroid Foundation": (-33.8228, 151.1950, "Reserve Road, St Leonards NSW 2065"),
    "Fibroid Foundation": (-27.4600, 153.0280, "525 Boundary Street, Spring Hill QLD 4000"),
    "QueenslandFertilityGroup": (-27.4655, 153.0300, "Wharf Street, Spring Hill QLD 4000"),
}
ORGANISATIONS = {"Australian Thyroid Foundation", "Fibroid Foundation", "QueenslandFertilityGroup"}


def new_id():
    return uuid.uuid4().hex[:10]


def read_sheets(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for s in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", NS):
        target = rels[s.get("{%s}id" % REL_NS)].lstrip("/")
        target = target if target.startswith("xl/") else "xl/" + target
        rows = []
        for row in ET.fromstring(z.read(target)).iter("{%s}row" % NS["m"]):
            cells = {}
            for c in row.findall("m:c", NS):
                col = re.match(r"[A-Z]+", c.get("r")).group(0)
                v = c.find("m:v", NS)
                if c.get("t") == "s" and v is not None:
                    val = shared[int(v.text)]
                elif c.get("t") == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
                else:
                    val = v.text if v is not None else ""
                cells[col] = (val or "").replace("﻿", "").strip()
            rows.append(cells)
        sheets[s.get("name")] = rows
    return sheets


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sheets = read_sheets(sys.argv[1])
    hospitals = {}
    order = []

    for sheet_name, product in (("Contact Thyroid", "Thyroid"), ("Contact Fibroid", "Fibroid")):
        current = None
        header_seen = False
        for r in sheets.get(sheet_name, []):
            name = r.get("A", "")
            if not header_seen:
                header_seen = name == "Hospital"
                continue
            if name == "+10's of leads":
                if current:
                    current["notes"] = (current["notes"] + "\nMeer leads: " + r.get("B", "")).strip()
                continue
            if name:
                if name not in hospitals:
                    lat, lng, addr = LOCATIONS.get(name, (None, None, ""))
                    hospitals[name] = {
                        "id": new_id(),
                        "name": name,
                        "kind": "Organisatie" if name in ORGANISATIONS else "Ziekenhuis",
                        "sector": "",
                        "address": addr,
                        "lat": lat,
                        "lng": lng,
                        "status": "red",
                        "stage": "Prospect",
                        "products": [],
                        "nextAction": "",
                        "nextActionDate": "",
                        "notes": "",
                        "contacts": [],
                        "activities": [],
                    }
                    order.append(name)
                current = hospitals[name]
                if r.get("G") and not current["sector"]:
                    current["sector"] = r["G"]
            if current is None:
                continue
            physician = r.get("B", "")
            phone, email, extra = r.get("D", ""), r.get("E", ""), r.get("I", "")
            if not (physician or phone or email):
                continue
            if product not in current["products"]:
                current["products"].append(product)
            current["contacts"].append({
                "id": new_id(),
                "name": physician or "Algemeen nummer",
                "role": r.get("C", ""),
                "phone": phone.replace("Tel: ", "").strip(),
                "email": email.rstrip(";").strip(),
                "address": r.get("H", ""),
                "product": product,
                "notes": extra,
                "primary": False,
            })

    out = {"version": 1, "hospitals": [hospitals[n] for n in order]}
    dest = ROOT / "data" / "seed.json"
    dest.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    n_contacts = sum(len(h["contacts"]) for h in out["hospitals"])
    print(f"{len(out['hospitals'])} ziekenhuizen/organisaties en {n_contacts} contactpersonen -> {dest}")


if __name__ == "__main__":
    main()
