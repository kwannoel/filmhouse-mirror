# Filmhouse showtimes

An unofficial, static listing of what's showing at [Filmhouse Singapore](https://filmhouse.sg/films/),
with filters for date, genre, rating and session type (4K, Q&A, …). Every showtime links to
filmhouse.sg's own booking page; nothing is booked here.

## How it works

Filmhouse has no API a browser can call from another site (its film list is server-rendered HTML and
its ajax endpoints don't allow cross-origin requests). So:

1. `scripts/scrape.mjs` fetches https://filmhouse.sg/films/ and writes `site/films.json`.
2. `site/` is a plain static page (`index.html`, `app.js`, `style.css`) that reads `films.json`.
3. `.github/workflows/refresh.yml` re-scrapes every 15 minutes and redeploys `site/` to GitHub Pages.
   It commits `films.json` only when films or showtimes actually change.

The page shows "Updated N min ago" and highlights it if the snapshot is over 6 hours old.

## Cost

Free: GitHub Actions minutes are free for **public** repos on standard GitHub-hosted runners and
don't count against your account's included minutes. GitHub Pages is free for public repos too.
Keep the repo public; a private copy would use your quota (~96 runs a day).

## Local development

```bash
npm install
npm run scrape
npm run serve
```

Then open http://localhost:5320. Filters are kept in the URL, so filtered views can be shared.

## Setup on GitHub

1. Push to a public repo.
2. Settings → Pages → Source: **GitHub Actions**.
3. Run the workflow once from the Actions tab (or push to `main`).
