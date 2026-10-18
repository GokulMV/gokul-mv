# Gokul M V — The Ascent

A 3D scrollytelling portfolio: React 18 + TypeScript, Three.js via `@react-three/fiber` / `drei` /
`postprocessing`, GSAP `ScrollTrigger`, `@studio-freight/lenis`, and Zustand. It's built to deploy on
[Railway](https://railway.com) from the first commit.

> **Phase 0** is the deployment-verification build. It renders a 3D world across the full 10-scene timeline:
> stand-in geometry for the protagonist and gear, a cloud curtain, project beacons, the summit and horizon,
> and the contact paper. It also shows a live Railway health/runtime telemetry panel.

## Run locally

```bash
npm ci
npm run dev        # http://localhost:5173  (/healthz is mirrored by a Vite middleware)
npm run build      # tsc --noEmit && vite build
npm run preview    # http://localhost:4173
```

Append `?audit=1` to the URL, or press <kbd>`</kbd>, to toggle audit mode. It expands the telemetry panel and
draws the protagonist's path and waypoints.

## Deploy on Railway

1. Create a service from this repository and set its source branch to **`main`** (Service → Settings → Source).
   Leave **Root Directory** empty. Railway auto-detects the root `Dockerfile`, and the build log shows
   "Using detected Dockerfile!". `railway.json` holds only deploy settings: the `/healthz` healthcheck and the restart policy.
2. You don't need any variables. Railway injects `PORT`, and the image defaults to `8080`.
   `RAILWAY_GIT_COMMIT_SHA` / `RAILWAY_ENVIRONMENT_NAME` are baked into the build and shown in the telemetry panel.
3. Railway gates each deploy on the `/healthz` healthcheck, which returns
   `{"status":"ok","service":"portfolio","port":"…","time":"…"}`.
4. When adding a domain, enter target port **8080**. The deploy logs confirm the bound port with a line like
   `40-ipv6-listen.sh: … listener(s) on port 8080`.

### CI

`.github/workflows/ci.yml` runs on every push and PR to `main`:
- **Typecheck & build:** the same `npm ci` → `tsc` → `vite build` as the container.
- **Docker image & /healthz smoke test:** builds the exact Railway image, boots it on `PORT=8080` and checks
  `/healthz`, the SPA fallback, 404s, gzip, immutable asset caching, the startup port line and the nginx worker count.

Railway deploys through its own GitHub integration, not GitHub Actions. To deploy only commits that pass CI, enable
**Wait for CI** in the Railway service settings.

### Container

| Stage   | Image              | Notes                                                                                   |
| ------- | ------------------ | --------------------------------------------------------------------------------------- |
| builder | `node:20-alpine`   | `npm ci` then `npm run build`, with a 2 GB heap cap and vendor chunks split for low peak memory |
| runtime | `nginx:1.27-alpine`| `nginx.conf.template` rendered by envsubst on `$PORT`: gzip, SPA fallback, immutable `/assets`, 2 workers, `warn`-level logs |

The IPv6 listener (Railway private networking) is added at boot by `docker/40-ipv6-listen.sh`, and only when
the kernel supports IPv6.

## Architecture rules

- **No React re-renders on scroll.** Lenis writes progress into the mutable singleton
  `src/store/scrollStore.ts`. R3F `useFrame` callbacks and DOM `requestAnimationFrame` loops read it directly.
- **Everything is damped** with `THREE.MathUtils.damp(current, target, lambda, delta)`.
- **Decluttered HUD.** The previous scene's card fully fades out before the next one fades in.
- **Content** lives in `src/store/portfolioStore.ts`, a Zustand store persisted to `localStorage`. The
  `OFFICIAL_TECH_LOGOS` dictionary holds 55 brand SVG paths and hex colours from Simple Icons (CC0).
  The brand marks are trademarks of their owners.

### Timeline (0 → 1 over 1400vh)

| #  | Range       | Scene                          | Gear |
| -- | ----------- | ------------------------------ | ---- |
| 1  | 0.00 – 0.08 | Volumetric clouds & welcome    | 0/4  |
| 2  | 0.08 – 0.18 | Base camp                      | 0/4  |
| 3  | 0.18 – 0.28 | Getting equipped               | 4/4  |
| 4  | 0.28 – 0.45 | First ascent (backpack drops at 0.42)        | 3/4 |
| 5  | 0.45 – 0.62 | First chasm jump (rope drops at 0.56)        | 2/4 |
| 6  | 0.62 – 0.78 | Extreme chasm leap (axes + harness at 0.72)  | 0/4 |
| 7  | 0.78 – 0.86 | The summit                     | 0/4  |
| 8  | 0.86 – 0.92 | Horizon reveal                 | 0/4  |
| 9  | 0.92 – 0.98 | Paper throw & returning clouds | 0/4  |
| 10 | 0.98 – 1.00 | Blown away into nothingness    | 0/4  |
