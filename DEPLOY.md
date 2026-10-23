# Publishing My Voting Booth

The app is a small Python server (standard library only, no installs) plus static files in `public/`.

## Before you publish
1. Create a NEW Google Civic API key (Google Cloud Console > APIs & Services > Credentials).
   Enable "Google Civic Information API" and restrict the key to that API. Don't reuse a key that has been pasted into chat or email.
2. Have someone you trust review the quiz statements and left/right tags in `public/data/issues.json`.

## Deploy on Render (free tier)
1. Put this folder in a GitHub repo (the key is never in the code; `.gitignore` is set up).
2. On render.com: New > Blueprint (or Web Service), pick the repo. `render.yaml` sets everything up.
3. In the service's Environment tab, set `GOOGLE_CIVIC_API_KEY` to your new key.
4. Deploy. Render gives you an https:// address; add a custom domain under Settings if you like.

Railway and Fly.io work the same way: start command `python3 server.py`, env var `GOOGLE_CIVIC_API_KEY`.
The server listens publicly automatically when the host sets `PORT`.

## Settings (environment variables)
- `GOOGLE_CIVIC_API_KEY`: live data. Leave unset for demo data.
- `RATE_LIMIT_PER_MIN`: lookups per visitor per minute (default 20).

## Know before launch
- The free Render tier sleeps when idle; the first visit after a pause takes ~30 seconds.
- ZIP-only search uses OpenStreetMap's free reverse-geocoding service, which isn't meant for heavy traffic.
- Google's data has gaps: many addresses return no races, and local races are the least complete.
- The server doesn't log addresses and the quiz runs only in the browser. Say so in a privacy note on your site.
