# Three Smiles

A private daily gratitude app for Daisy and Charlie.

## Private Mac mini server

The real app is now served by `server.js` behind server-side login. Unauthenticated visitors are redirected to `/login`, and `/api/entries` returns `401` unless the browser has a valid signed session cookie.

Entries are stored in `data/entries.json` on the Mac mini. Login secrets live in `data/auth.json`; `data/` is gitignored and must not be pushed.

Run locally:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8787/
```

## Public GitHub Pages shell

Live public shell: https://herby9000.github.io/three-smiles/

The GitHub Pages page is now only a placeholder telling visitors the app is private. It does not expose the app interface or shared-entry API.

## Auth config

Create `data/auth.json` with this shape:

```json
{
  "sessionSecret": "long-random-secret",
  "users": {
    "Charlie": "sha256-hex-passcode-hash",
    "Daisy": "sha256-hex-passcode-hash"
  }
}
```

You can generate a SHA-256 hash with:

```bash
node -e "const crypto=require('crypto'); console.log(crypto.createHash('sha256').update(process.argv[1]).digest('hex'))" 'your-passcode'
```

## API

All APIs except `/api/login` and `/api/health` require the signed login cookie.

Login:

```bash
curl -c cookies.txt -X POST http://127.0.0.1:8787/api/login \
  -H 'content-type: application/json' \
  -d '{"person":"Charlie","passcode":"..."}'
```

Save an entry:

```bash
curl -b cookies.txt -X POST http://127.0.0.1:8787/api/entries \
  -H 'content-type: application/json' \
  -d '{
    "entry": {
      "person": "Charlie",
      "date": "2026-07-10",
      "smiles": ["Coffee", "Kids laughing", "A good walk"],
      "mood": "Loved",
      "question": "What made you feel like a team lately?",
      "answer": "Dinner was calm. Miracles do happen."
    }
  }'
```

List shared entries:

```bash
curl -b cookies.txt http://127.0.0.1:8787/api/entries
```
