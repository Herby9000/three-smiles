# Three Smiles

A small daily gratitude app for Daisy and Charlie.

## Static site

The site can run as static files on GitHub Pages. Entries are saved in the browser with localStorage.

Live site: https://herby9000.github.io/three-smiles/

The public GitHub Pages version now shows a Daisy/Charlie passcode gate before the app. This is useful for casual privacy on a shared URL, but it is still client-side protection because GitHub Pages cannot enforce server-side login. Do not enable shared sync for sensitive entries until the backend is deployed with real server-side authentication.

## Optional shared backend

The lightweight backend is a dependency-free Node server that:

- serves the same static site
- accepts shared entries at `POST /api/entries`
- lists shared entries at `GET /api/entries?circleId=daisy-charlie`
- stores entries in `data/entries.json`
- supports CORS so the GitHub Pages site can sync to it

Run locally:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8787/
```

Or use the GitHub Pages site and put this backend URL in Settings → Shared sync:

```text
http://127.0.0.1:8787
```

For a permanent shared version, deploy `server.js` to a small Node host such as Render, Fly, Railway, or a private VPS, then paste that public URL into Settings → Shared sync on both phones.

## API

Save an entry:

```bash
curl -X POST http://127.0.0.1:8787/api/entries \
  -H 'content-type: application/json' \
  -d '{
    "circleId": "daisy-charlie",
    "entry": {
      "person": "Daisy",
      "date": "2026-07-10",
      "smiles": ["Coffee", "Kids laughing", "A good walk"],
      "mood": "Loved",
      "question": "What made you feel like a team lately?",
      "answer": "Dinner was calm. Miracles do happen."
    }
  }'
```

List entries:

```bash
curl 'http://127.0.0.1:8787/api/entries?circleId=daisy-charlie'
```
