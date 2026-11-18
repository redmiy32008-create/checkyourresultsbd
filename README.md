# CheckYourResults BD – checkyourresultsbd.com

SSC / Dakhil / HSC / Alim result checker for Bangladesh, with a purple water-glass design.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole website (design + form + result card) |
| `server.js` | Small Node.js server. Serves the site and fetches results from the official board portal |
| `package.json` | Lets hosts run `npm start` |

No packages to install. You only need **Node.js 18 or newer**.

## Run it on your computer

```
node server.js
```
Open http://localhost:3000

## Put it on checkyourresultsbd.com

The site needs a host that can run Node.js (a VPS, Render, Railway, Fly.io, etc.). Ordinary
shared hosting that only serves HTML files will show the page but cannot fetch results.

1. Upload the 3 files and run `npm start` (use `pm2` or the host's process manager to keep it running).
2. Put HTTPS in front of it (Nginx + Let's Encrypt, or the host's built-in HTTPS / Cloudflare).
3. Point the domain's DNS at the host.
4. Behind Nginx / Cloudflare, set the environment variable `TRUST_PROXY=1` so the rate limiter sees real visitor IPs.

Optional environment variables: `PORT` (default 3000), `RATE_LIMIT_PER_MIN` (default 20 per visitor),
`OFFICIAL_BASE` (default `https://www.educationboardresults.gov.bd`).

## How it works

1. The page asks `/api/captcha`. The server opens a session with the official portal and returns its
   small maths question, which the **student** answers.
2. The student's details go to `/api/result`. The server submits them to the official portal and sends
   back the parsed result. Nothing about the student is stored or logged.
3. If the board's system is down or changes its layout, the student sees a friendly message with a
   button to the official portal.

## Important: test with the live portal before launching

The server was tested end-to-end against a local imitation of the portal, not the live government site
(it could not be reached from where this was built). The official portal's form field names and result
page layout are set in the `CONFIG` block at the top of `server.js` and in `parseResult()`. On your host:

1. Open `/api/captcha` – it should return a question like `{"ok":true,"token":"…","question":"7 + 5"}`.
2. Try a real roll / registration number on the site.
3. If it says "couldn't read the board's reply", the portal's layout differs from what the parser expects.
   Adjust `FIELD`, `CAPTCHA_FIELD_REGEX` or `parseResult()` (send me the portal's page source and I'll update it).

## Before you launch

- Check the official portal's terms of use and don't claim to be an official service (the footer already says you're independent).
- Expect a big traffic spike on result day. Keep `RATE_LIMIT_PER_MIN` sensible and consider Cloudflare in front.
- Add a privacy policy page if you add ads or analytics.
