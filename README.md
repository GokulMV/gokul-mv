# Gokul MV — the shelf

A portfolio that is one room: three black floating shelves on a cream wall, between two windows. The files on the
shelves are the work: hover one to lift it out, click it and a manila folder opens with the whole story.

- **Top shelf, work:** Thoughtworks, OpenText, Cognizant, and how I build with AI.
- **Middle shelf, education:** the B.Tech, the Agile & Scrum certificate, skills, and the résumé.
- **Bottom shelf, GitHub:** every public project with a README that is released (green dot) or nearly done (amber).

The room is live. The light follows the visitor's clock: sunrise in the east window, sunset in the west, the lamp
at night. The season follows the date, and the weather changes every six hours (rain, snow, clouds). The plants
grow when they are watered and wilt when nobody does; the shelf gathers dust and cobwebs while nobody visits.
Strike a match and carry it to the candle, pull the thread for contact details and the résumé, pick up the
watering can, play with the Rubik's cube, wind the robot, drag the car, and leave a note on the cork board.

## How it's built

The room is drawn in SVG and HTML, with CSS for the light and the animation; there is no WebGL and no framework
beyond [Preact](https://preactjs.com) for rendering.

| Path | What it is |
| ---- | ---------- |
| `src/shelf/Shelf.dc.html` | **The design file**: the room's template and its logic class (time, weather, plants, files, cube, notes…). This is the file to edit. |
| `scripts/build-shelf.mjs` | Compiles the design file into `src/shelf/shelf.generated.js` (logic + `renderTree`) and `shelf.generated.css`. Runs before `dev`, `typecheck` and `build`. |
| `src/main.ts` | Mounts the room, redraws it on every state change, and scales the 1400 × 1000 room to fit the window. |
| `public/Gokul_MV_Resume.pdf` | The résumé the contact tag and the Résumé file offer for download. |

The template language in the design file is small: `{{a.b}}` lookups, `<sc-for list="{{…}}" as="x">`,
`<sc-if value="{{…}}">`, and a `<helmet>` whose `<style>` becomes the generated CSS. Don't edit the generated
files by hand; change `Shelf.dc.html` and run `npm run shelf` (or any of the scripts below).

Visitor state (plant health, the last visit and its cobwebs, pinned notes) is kept in the visitor's own
`localStorage`, so it is per browser. A shared notes board or a site-wide "nobody has visited" would need a small
server.

## Run locally

```bash
npm ci
npm run dev        # http://localhost:5173  (/healthz is mirrored by a Vite middleware)
npm run build      # compile the shelf → tsc --noEmit → vite build
npm run preview    # http://localhost:4173
```

Add `?debug` to the URL for a bar that sets the time of day, season, weather, plant health, time away and wind
by hand, plus a button that forgets your visit; for example `/?debug&mood=night&season=winter&weather=snow`.
In debug mode the room's logic is on `window.shelf`.

## Deploy on Railway

1. Create a service from this repository and set its source branch to **`main`** (Service → Settings → Source).
   Leave **Root Directory** empty. `railway.json` selects the root `Dockerfile`, one replica, the `/healthz`
   healthcheck and the restart policy.
2. You don't need any variables. Railway injects `PORT`, and the image defaults to `8080`.
3. Railway gates each deploy on the `/healthz` healthcheck, which returns
   `{"status":"ok","service":"portfolio","port":"…","time":"…"}`.
4. When adding a domain, enter target port **8080**.

### CI

`.github/workflows/ci.yml` runs on every push and PR to `main`:
- **Typecheck & build:** the same `npm ci` → shelf compile → `tsc` → `vite build` as the container.
- **Docker image & /healthz smoke test:** builds the exact Railway image, boots it on `PORT=8080` and checks
  `/healthz`, the SPA fallback, 404s, gzip, immutable asset caching, the startup port line and the nginx worker count.

Railway deploys through its own GitHub integration, not GitHub Actions. To deploy only commits that pass CI, enable
**Wait for CI** in the Railway service settings.

### Container

| Stage   | Image              | Notes |
| ------- | ------------------ | ----- |
| builder | `node:20-alpine`   | `npm ci` then `npm run build` |
| runtime | `nginx:1.27-alpine`| `nginx.conf.template` rendered by envsubst on `$PORT`: gzip, SPA fallback, immutable `/assets`, 2 workers, `warn`-level logs |

The IPv6 listener (Railway private networking) is added at boot by `docker/40-ipv6-listen.sh`, and only when
the kernel supports IPv6.

## Credits

The portraits are flat illustrations after Leonardo's *Mona Lisa* (c. 1503) and Vermeer's *Girl with a Pearl
Earring* (1665), both in the public domain. Fonts from Google Fonts: Instrument Serif, Inter, Courier Prime and
Caveat (SIL Open Font License).
