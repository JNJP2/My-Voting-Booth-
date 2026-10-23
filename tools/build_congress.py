#!/usr/bin/env python3
"""Build public/data/congress_scores.json from Voteview's member ideology file.

Run from the project folder:  python3 tools/build_congress.py [congress_number]
Source: https://voteview.com (DW-NOMINATE dimension 1: negative = more liberal, positive = more conservative).
Re-run after each Congress or when membership changes.
"""
import csv, io, json, re, sys, urllib.request

CONGRESS = sys.argv[1] if len(sys.argv) > 1 else "119"
URL = "https://voteview.com/static/data/out/members/HSall_members.csv"

raw = urllib.request.urlopen(URL, timeout=60).read().decode("utf-8")
members = []
for r in csv.DictReader(io.StringIO(raw)):
    if r["congress"] != CONGRESS or r["chamber"] not in ("House", "Senate") or not r["nominate_dim1"]:
        continue
    m = re.match(r"([^,]+),\s*(.*)", r["bioname"])
    last, rest = (m.group(1), m.group(2)) if m else (r["bioname"], "")
    nick = re.search(r"\(([^)]+)\)", rest)
    given = re.sub(r"\([^)]*\)", "", rest).split()
    members.append({
        "last": last.title(), "first": given[0].title() if given else "", "nick": nick.group(1).title() if nick else "",
        "state": r["state_abbrev"], "chamber": r["chamber"], "district": int(r["district_code"] or 0),
        "party": {"100": "D", "200": "R"}.get(r["party_code"], "I"), "score": float(r["nominate_dim1"]),
    })
json.dump({"source": {"name": "Voteview (DW-NOMINATE, 1st dimension)", "url": "https://voteview.com"},
           "congress": int(CONGRESS), "members": members}, open("public/data/congress_scores.json", "w"), separators=(",", ":"))
print(f"{len(members)} members written for the {CONGRESS}th Congress")
