#!/usr/bin/env python3
"""Voter lookup server: serves the UI and proxies the Google Civic Information API.

Run:  GOOGLE_CIVIC_API_KEY=your_key python3 server.py
Without a key the server runs in demo mode with sample data.
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

API_KEY = os.environ.get("GOOGLE_CIVIC_API_KEY", "").strip()
BASE = "https://www.googleapis.com/civicinfo/v2"
PORT = int(os.environ.get("PORT", "8000"))
# Hosting platforms set PORT and need a public bind; locally we stay on loopback.
HOST = os.environ.get("HOST") or ("0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
RATE_LIMIT = int(os.environ.get("RATE_LIMIT_PER_MIN", "20"))  # lookups per IP per minute
_hits, _hits_lock = {}, threading.Lock()


def rate_limited(ip):
    now = time.time()
    with _hits_lock:
        recent = [t for t in _hits.get(ip, []) if now - t < 60]
        limited = len(recent) >= RATE_LIMIT
        if not limited:
            recent.append(now)
        _hits[ip] = recent
        if len(_hits) > 5000:  # keep memory bounded
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 60]:
                del _hits[k]
    return limited
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


def civic_get(path, params):
    params = dict(params, key=API_KEY)
    url = f"{BASE}/{path}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e)["error"]["message"]
        except Exception:
            msg = e.reason
        raise LookupError(e.code, msg)


def level_of(contest):
    levels = [l.lower() for l in contest.get("level", [])]
    if "country" in levels:
        return "federal"
    if "administrativearea1" in levels:
        return "state"
    if levels:
        return "local"
    return "local"


def fmt_location(loc):
    a = loc.get("address", {})
    street = " ".join(filter(None, [a.get("line1"), a.get("line2")]))
    city = ", ".join(filter(None, [a.get("city"), " ".join(filter(None, [a.get("state"), a.get("zip")]))]))
    return {
        "name": loc.get("address", {}).get("locationName") or "Voting location",
        "address": ", ".join(filter(None, [street, city])),
        "hours": loc.get("pollingHours", ""),
        "startDate": loc.get("startDate", ""),
        "endDate": loc.get("endDate", ""),
        "notes": loc.get("notes", ""),
    }


def normalize(election, vi):
    contests = []
    for c in vi.get("contests", []):
        item = {
            "level": level_of(c),
            "type": c.get("type", "General"),
            "office": c.get("office") or c.get("referendumTitle") or "Ballot measure",
            "district": c.get("district", {}).get("name", ""),
            "text": c.get("referendumText") or c.get("referendumSubtitle") or "",
            "candidates": [
                {
                    "name": k.get("name", ""),
                    "party": k.get("party", "Unaffiliated") or "Unaffiliated",
                    "url": k.get("candidateUrl", ""),
                }
                for k in c.get("candidates", [])
            ],
        }
        if c.get("referendumTitle") and not c.get("candidates"):
            item["type"] = "Referendum"
            item["options"] = c.get("referendumBallotResponses", [])
        contests.append(item)

    state = (vi.get("state") or [{}])[0]
    admin = state.get("electionAdministrationBody", {})
    return {
        "election": {"name": election.get("name"), "date": election.get("electionDay")},
        "normalizedAddress": vi.get("normalizedInput", {}),
        "contests": contests,
        "pollingLocations": [fmt_location(l) for l in vi.get("pollingLocations", [])],
        "earlyVoteSites": [fmt_location(l) for l in vi.get("earlyVoteSites", [])],
        "dropOffLocations": [fmt_location(l) for l in vi.get("dropOffLocations", [])],
        "officials": {
            "name": admin.get("name", ""),
            "url": admin.get("electionInfoUrl", ""),
            "registrationUrl": admin.get("electionRegistrationUrl", ""),
            "ballotInfoUrl": admin.get("ballotInfoUrl", ""),
            "votingLocationFinderUrl": admin.get("votingLocationFinderUrl", ""),
        },
        "demo": False,
    }


def standardize(address):
    """Match a free-form address against the US Census geocoder (no key needed).

    Returns the cleaned-up address string, or None if the Census can't match it.
    """
    qs = urllib.parse.urlencode({"address": address, "benchmark": "Public_AR_Current", "format": "json"})
    url = f"https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?{qs}"
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            matches = json.load(r)["result"]["addressMatches"]
    except Exception:
        return None
    return matches[0]["matchedAddress"] if matches else None


def zip_to_address(zipcode):
    """Pick a representative street address inside a ZIP (zippopotam.us centroid -> OSM reverse geocode)."""
    def fetch(url):
        req = urllib.request.Request(url, headers={"User-Agent": "VoterBallotLookup/0.1 (local dev)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    try:
        place = fetch(f"https://api.zippopotam.us/us/{zipcode[:5]}")["places"][0]
        a = fetch("https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=18&"
                  + urllib.parse.urlencode({"lat": place["latitude"], "lon": place["longitude"]}))["address"]
        street = " ".join(filter(None, [a.get("house_number"), a.get("road")]))
        city = a.get("city") or a.get("town") or a.get("village") or place["place name"]
        return f"{street}, {city}, {place['state abbreviation']} {zipcode[:5]}" if street else None
    except Exception:
        return None


def lookup(address):
    if re.fullmatch(r"\d{5}(-\d{4})?", address.strip()):
        rep = zip_to_address(address.strip())
        if not rep:
            raise LookupError(404, "We couldn't find that ZIP code. Check it, or enter your full street address.")
        result = lookup_one(rep)
        result["zipOnly"] = address.strip()[:5]
        for k in ("pollingLocations", "earlyVoteSites", "dropOffLocations"):
            result[k] = result[k][:5]  # a ZIP can return dozens of sites; keep it readable
        result["matchedAs"] = ""
        return result
    return lookup_address(address)


def lookup_address(address):
    """Try the address as typed; if the Civic API can't find it, retry with the Census-standardized form."""
    try:
        result = lookup_one(address)
        result["matchedAs"] = ""
        return result
    except LookupError as err:
        fixed = standardize(address)
        if not fixed or fixed.lower() == address.lower():
            if not fixed:
                raise LookupError(404, "We couldn't find that address. Check the street number and spelling, "
                                       "and include the city, state and ZIP code.")
            raise err
        result = lookup_one(fixed)
        result["matchedAs"] = fixed
        return result


def add_statewide_measures(result):
    """Append curated statewide measures for this state/election that Google didn't supply."""
    try:
        with open(os.path.join(ROOT, "data", "statewide_measures.json")) as f:
            measures = json.load(f)["measures"]
    except (OSError, ValueError, KeyError):
        return result
    state = (result.get("normalizedAddress", {}).get("state") or "").upper()
    date = result["election"].get("date")
    have = {c["office"].strip().lower() for c in result["contests"]} | {c.get("text", "").strip().lower() for c in result["contests"]}
    for m in measures:
        if m["state"].upper() != state or m["election"] != date:
            continue
        if m["title"].strip().lower() in have or m["question"].strip().lower() in have:
            continue  # Google already supplied it
        result["contests"].append({
            "level": "state", "type": "Referendum", "office": m["title"], "district": "Statewide",
            "category": m.get("category", ""), "text": m["question"], "options": m.get("options", []),
            "candidates": [], "supplemental": True, "source": m.get("source", {}),
        })
        result["supplemented"] = True
    return result


def lookup_one(address):
    elections = civic_get("elections", {}).get("elections", [])
    real = [e for e in elections if "test" not in e.get("name", "").lower()]  # skip Google/VIP test elections
    if not real:
        raise LookupError(404, "No upcoming elections are currently listed.")
    last_err = None
    fallback = None  # address recognized, but only state election-office info published
    for e in sorted(real, key=lambda x: x.get("electionDay", "")):
        try:
            vi = civic_get("voterinfo", {"address": address, "electionId": e["id"]})
        except LookupError as err:
            last_err = err
            continue
        if vi.get("contests") or vi.get("pollingLocations") or vi.get("earlyVoteSites"):
            return add_statewide_measures(normalize(e, vi))
        if vi.get("state") and fallback is None:
            fallback = add_statewide_measures(normalize(e, vi))
    if fallback:
        fallback["noData"] = True
        return fallback
    raise LookupError(404, last_err.args[1] if last_err else "No election data found for this address yet.")


DEMO = {
    "election": {"name": "Sample General Election (demo data)", "date": "2026-11-03"},
    "normalizedAddress": {"line1": "123 Main St", "city": "Springfield", "state": "IL", "zip": "62701"},
    "contests": [
        {"level": "federal", "type": "General", "office": "U.S. Senate", "district": "Illinois", "candidates": [
            {"name": "Alex Rivera", "party": "Democratic", "url": ""},
            {"name": "Jordan Whitfield", "party": "Republican", "url": ""},
            {"name": "Sam Okafor", "party": "Libertarian", "url": ""}]},
        {"level": "federal", "type": "General", "office": "U.S. House", "district": "IL-13", "candidates": [
            {"name": "Priya Nair", "party": "Democratic", "url": ""},
            {"name": "Tom Hadley", "party": "Republican", "url": ""}]},
        {"level": "state", "type": "General", "office": "Governor", "district": "Illinois", "candidates": [
            {"name": "Maria Delgado", "party": "Democratic", "url": ""},
            {"name": "Robert Kincaid", "party": "Republican", "url": ""},
            {"name": "Lee Park", "party": "Green", "url": ""}]},
        {"level": "state", "type": "General", "office": "State Senate", "district": "District 48", "candidates": [
            {"name": "Dana Cho", "party": "Democratic", "url": ""},
            {"name": "Frank Pruitt", "party": "Republican", "url": ""}]},
        {"level": "local", "type": "General", "office": "County Clerk", "district": "Sangamon County", "candidates": [
            {"name": "Helen Marsh", "party": "Republican", "url": ""},
            {"name": "Omar Haddad", "party": "Democratic", "url": ""}]},
        {"level": "local", "type": "General", "office": "School Board (3 seats)", "district": "Springfield SD 186", "candidates": [
            {"name": "Katie Brooks", "party": "Nonpartisan", "url": ""},
            {"name": "Ibrahim Yusuf", "party": "Nonpartisan", "url": ""},
            {"name": "Linda Fox", "party": "Nonpartisan", "url": ""},
            {"name": "Carl Dunn", "party": "Nonpartisan", "url": ""}]},
        {"level": "local", "type": "Referendum", "office": "Library Bond Measure", "district": "Springfield",
         "text": "Shall the city issue $12M in bonds to renovate the public library?", "candidates": [],
         "options": ["Yes", "No"]},
    ],
    "pollingLocations": [{"name": "Lincoln Elementary Gym", "address": "400 E Capitol Ave, Springfield, IL 62701",
                          "hours": "6:00 AM – 7:00 PM", "startDate": "", "endDate": "", "notes": ""}],
    "earlyVoteSites": [{"name": "Sangamon County Clerk's Office", "address": "200 S 9th St, Springfield, IL 62701",
                        "hours": "Mon–Fri 8:30 AM – 4:30 PM", "startDate": "2026-10-08", "endDate": "2026-10-31", "notes": ""}],
    "dropOffLocations": [{"name": "Municipal Center Drop Box", "address": "800 E Monroe St, Springfield, IL 62701",
                          "hours": "24 hours", "startDate": "", "endDate": "", "notes": ""}],
    "officials": {"name": "Illinois State Board of Elections", "url": "https://elections.il.gov",
                  "registrationUrl": "https://ova.elections.il.gov", "ballotInfoUrl": "",
                  "votingLocationFinderUrl": ""},
    "demo": True,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def client_ip(self):
        # Behind a proxy the rightmost X-Forwarded-For entry is the one the proxy added (not spoofable by the client).
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[-1].strip() if fwd else self.client_address[0]

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-cache")  # always revalidate, so redeploys reach visitors right away
        super().end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            return self.send_json(200, {"ok": True})
        if parsed.path == "/api/status":
            return self.send_json(200, {"demo": not API_KEY})
        if parsed.path == "/api/lookup":
            address = urllib.parse.parse_qs(parsed.query).get("address", [""])[0].strip()
            if len(address) < 5:  # also accepts a bare 5-digit ZIP
                return self.send_json(400, {"error": "Please enter a full street address, city and state."})
            if rate_limited(self.client_ip()):
                return self.send_json(429, {"error": "Too many lookups. Please wait a minute and try again."})
            if not API_KEY:
                return self.send_json(200, DEMO)
            try:
                return self.send_json(200, lookup(address))
            except LookupError as e:
                code, msg = e.args
                return self.send_json(404 if code in (400, 404) else 502, {"error": msg})
            except Exception as e:  # network failure etc.
                return self.send_json(502, {"error": f"Lookup service unavailable: {e}"})
        return super().do_GET()

    def log_message(self, fmt, *args):
        # Never log query strings: they contain voters' home addresses.
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))


if __name__ == "__main__":
    mode = "LIVE (Google Civic API)" if API_KEY else "DEMO (set GOOGLE_CIVIC_API_KEY for live data)"
    print(f"Voter lookup on {HOST}:{PORT} — {mode}", flush=True)  # flush: hosts capture stdout through a pipe, which is otherwise buffered
    near = [k for k in os.environ if ("CIVIC" in k.upper() or "GOOGLE" in k.upper()) and k != "GOOGLE_CIVIC_API_KEY"]
    if near and not API_KEY:
        print(f"No GOOGLE_CIVIC_API_KEY found, but these similarly named variables exist (names only): {near}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
