# PHASE 10: Launch Readiness — "Make It Real" Production Checklist

> Merge this into the Phase 10 prompt. It turns the 18-point "your AI-built website is fake" checklist into
> concrete, testable deliverables for **this** codebase: a single-page React/R3F scrollytelling portfolio built by
> Vite, served as a static bundle by `nginx:1.27-alpine` on Railway at `https://gokulmv.com`.
>
> Every technical claim below was checked against the repo and the real runtime image: nginx 1.27.5 modules and
> MIME map, header inheritance, measured chunk sizes, the Zustand `persist` source and the Lenis touch path.
> Where an item depends on earlier phases, it says so.

## CONTEXT (state going into Phase 10)

- **Pages.** One page (`/`): the 1400vh 3D journey. Phase 1's ending adds:
  - the lens-paper contact overlay (Scene 9), which replaces the old contact HUD card;
  - a `CreditsFooter` section after the 3D track;
  - track-relative scroll progress.
  If any of these is missing at the start of Phase 10, build it first. Items 2, 11, 13 and 15 depend on the footer
  and the contact overlay.
- **No `public/` directory:**
  - no robots.txt, sitemap, favicon set, web manifest or Open Graph image;
  - the favicon is one inline data-URI SVG in `index.html`;
  - `index.html` has a title and description, but no canonical, Open Graph, Twitter Card or JSON-LD.
- **The shell is not real HTML.** `<body>` is just `<noscript>…</noscript><div id="root">`. Every HUD card,
  including the welcome card, starts as `opacity:0; visibility:hidden; aria-hidden="true"` and only appears after
  JS runs.
- **three.js is on the first load.**
  - Measured gzip -9: `three-vendor` 238 KB, `react-vendor` 49 KB, `gsap-vendor` 48 KB, entry 59 KB, so about
    393 KB of eager JS.
  - The entry chunk carries about 37 KB gzip of Simple Icons path data.
  - `dist/index.html` modulepreloads `three-vendor`, because `scrollStore.ts`, `SceneHud.tsx`,
    `protagonistPath.ts` (via `App.tsx`) and `worldLayout.ts` import `three` statically.
  - GSAP is used only as a ticker plus `ScrollTrigger.update()`/`refresh()`. No ScrollTrigger instance exists.
- **nginx (`nginx.conf.template`):**
  - every unknown path returns `index.html` with 200, and CI asserts `/deep/link/route` = 200;
  - security headers are set at server level, but nginx **drops them** in any location with its own
    `add_header`, so the HTML document today gets only `Cache-Control` + `X-Content-Type-Options`;
  - there is no CSP;
  - the static-extension regex location overrides the `/assets/` prefix location, so hashed images and fonts get
    7 days instead of `immutable`;
  - the image has `gzip_static` but **no Brotli module**;
  - the image's `mime.types` has no `webmanifest` entry.
- **Content and storage:**
  - `src/store/portfolioStore.ts` ships **seed placeholder content** ("Company 1–3", "Project 1–3", "University",
    a generic summary and traits, `phone: null`, `resumeUrl: null`);
  - Zustand `persist` (version 1) writes it to `localStorage['gokul-mv.portfolio']`, and its `migrate` passes old
    data through;
  - the sound preference is in memory only.
- **Visitor-facing debug UI.** The telemetry panel and the Audit button render for every visitor, and the panel
  polls `/healthz` every 10 s.
- **CI.** `ci.yml` has only the typecheck/build and container jobs: curl, netstat and the IPv6 listener. There is
  no Playwright, axe or Lighthouse.

## NON-NEGOTIABLE LAUNCH LAWS

1. **Content is real HTML first.** Name, headline, primary CTA, contact block, journey summary and footer links are
   in the served HTML and visible at first paint. They work with JavaScript disabled. The 3D journey is a
   progressive enhancement that loads after the shell paints and never blocks it. See P1 and P2.
2. **No regression of the Phase 0–9 laws:** no React re-renders on scroll, damped motion, 60fps targets, the
   Railway Docker build, `/healthz`, and the IPv4 + IPv6 listeners. Keep the line `listen ${PORT};` byte-for-byte,
   because `docker/40-ipv6-listen.sh` rewrites it.
3. **Every item has an automated CI check** in a new `e2e` job (see "CI CHECKS"). Items that also need a human
   review list it. `main` stays green, so Railway's "Wait for CI" can gate deploys.
4. **One origin constant.** `SITE_URL` (`https://gokulmv.com`, no trailing slash) is defined once in
   `vite.config.ts` (P5) and used for canonical, Open Graph, JSON-LD, sitemap and robots. CI fails if
   `gokulmv.com` appears anywhere else in `src`, `scripts`, `*.html` or `vite.config.ts`.
5. **No placeholder content ships** (item 18).
6. **`prefers-reduced-motion` is respected** by every new interaction (P6).

## PREREQUISITES (do these first; most items depend on them)

### P1. One content source and a static HTML shell
- Move content to `src/content/portfolio.ts`: pure typed data plus `CONTENT_UPDATED` (an ISO date), with no zustand
  and no three. The store, the shell plugin, JSON-LD, the sitemap and the CI checks all import it.
- A Vite `transformIndexHtml` plugin renders the shell into `index.html`, **outside `#root`**, because
  `createRoot().render()` would erase anything inside it:
  - `<header id="shell">`: name, headline (the single `<h1>`), "Get in touch", "Download résumé" (only when set)
    and "Skip the climb";
  - `<section id="journey-summary" class="sr-only">`: base camp, companies, projects, summit, the next journey;
  - `<section id="contact">`: email, phone (if set), location, availability, LinkedIn, GitHub, résumé;
  - the footer links (Privacy, contact, ©);
  - JSON-LD.
- Remove SceneHud's welcome Card 0. Its rAF loop fades `#shell` instead, so there is one welcome heading and one
  primary CTA. `#shell` is visible in the HTML, never `aria-hidden`, and is the LCP element. Handing over to the HUD
  causes no layout shift.
- The `<noscript>` text now only says the 3D journey needs JavaScript. All content is already in the shell.

### P2. A three-free shell and a lazy-loaded 3D world
- Nothing reachable from `src/main.tsx` without a dynamic import may import `three`:
  1. Add `src/utils/math.ts` (no imports): `damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt))`,
     `clamp01`, `remap`, `smoothstep`, `smootherstep`. `scrollStore.ts`, `SceneHud.tsx` and every DOM module use
     it.
  2. Move `parabolicArcVec3` and `cubicBezierVec3` from `scrollStore.ts` to `src/three/`.
  3. Move `altitudeAt` and the ENDING/CLOUD_CURTAIN timeline numbers into a three-free `src/story/timeline.ts`.
     `worldLayout.ts` re-exports them, and keeps `SUN_DIRECTION` and other `Vector3`s on the 3D side.
- GSAP leaves the critical path. Lenis runs on its own `requestAnimationFrame` loop, and `scrollStore.tick()` runs
  on that same loop. Load GSAP only inside the 3D chunk, and only if a phase actually creates ScrollTriggers.
- The TECH_LOGOS path data (about 37 KB gzip) moves to a lazily imported module, fetched when the first card with
  logos approaches or with the 3D chunk.
- `import('./three/Experience')` starts on the first of `pointerdown`, `wheel`, `touchstart`, `keydown`, or `load`
  followed by idle. Use `const idle = window.requestIdleCallback ?? ((cb) => setTimeout(cb, 200))`, because Safari
  has no `requestIdleCallback`. `detectGpuTier()` moves into that deferred path, so no WebGL context is created
  before the shell paints.
- Replace `<Preload all />` with a per-scene warm-up spread across frames: no task over 50 ms on a 4×
  CPU-throttled profile.
- Failure handling:
  - `window.addEventListener('vite:preloadError', …)` reloads once per session (sessionStorage guard), for stale
    tabs after a deploy;
  - an error boundary around the lazy world renders the existing `WebGLUnavailable` fallback.
- Leave Vite's own `modulepreload` tags alone. The rule is simply that no 3D or PDF chunk is in the static graph.

### P3. Test hooks
- With `?audit`, `main.tsx` exposes `window.__scroll = scrollStore` and `window.__gpu = gpu`. Tests jump with
  `__scroll.scrollToProgress(p, { immediate: true })`, then wait for `Math.abs(__scroll.dampedProgress - p) < 1e-3`.
- `scrollToProgress` sets `scrollStore.programmatic = true` and clears it on Lenis `onComplete`. Analytics scene
  events and sound effects skip programmatic travel.
- The UI publishes flags for tests and the sticky CTA. The contact overlay sets `scrollStore.contactVisible`, and
  IntersectionObservers on `#shell` and the footer set `shellVisible` and `footerVisible`.
- The page writes `document.documentElement.dataset.gpuTier`, so CI logs show whether the 3D path ran.
- In production, the telemetry panel, the Audit button and the `/healthz` polling run **only** with `?audit`.

### P4. nginx header and routing model (verified in `nginx:1.27-alpine`)
- **No `add_header` inside any `location`.** All headers are set at server level so they reach every response.
  Values that differ per path come from `map`s above the `server` block:
  - `map $uri $cache_control`:
    - `~^/assets/` → `public, max-age=31536000, immutable`
    - `~*\.(?:png|jpe?g|webp|avif|svg|ico|woff2?)$` → `public, max-age=604800`
    - `/healthz` → `no-store`
    - default → `no-cache`
  - `map $uri $robots_tag`:
    - `/thanks` → `noindex`
    - `/404.html` → `noindex`
    - default → `""` (nginx omits empty headers)
  - `add_header Cache-Control $cache_control always;` and `add_header X-Robots-Tag $robots_tag always;`, plus the
    security headers (item 17) and a new CSP, all at server level.
- Routing:
  - `absolute_redirect off;` stops `Location` headers from leaking `:8080`;
  - `location = / { try_files /index.html =404; }`
  - `location = /index.html { return 301 /; }`
  - `location = /privacy { try_files /privacy.html =404; }`
  - `location = /thanks { try_files /thanks.html =404; }` (only if built)
  - `location = /site.webmanifest { default_type application/manifest+json; }`. Never use a `types {}` block: it
    replaces the whole MIME map, and HTML would be served as octet-stream.
  - `location / { try_files $uri =404; }`. No `$uri/` and no `$uri.html`, because those produce soft 404s and
    redirects.
  - `error_page 404 /404.html;` and `location = /404.html { internal; }`
  - keep `location = /healthz` exactly as it is
  - remove the old `location = /index.html { add_header … }`, the `/assets/` and regex `add_header` locations, and
    the SPA fallback
- Dockerfile runtime stage: `RUN rm -rf /usr/share/nginx/html/*` before copying `dist`, so the stock `50x.html` and
  `index.html` aren't served.

### P5. Build-time configuration
- `vite.config.ts`:
  - `const env = loadEnv(mode, process.cwd(), 'VITE_')`;
  - `const SITE_URL = (process.env.VITE_SITE_URL || env.VITE_SITE_URL || 'https://gokulmv.com').replace(/\/$/, '')`;
  - `define: { 'import.meta.env.VITE_SITE_URL': JSON.stringify(SITE_URL) }`. Vite's HTML `%VITE_SITE_URL%`
    replacement reads `define`, and unknown `%VITE_*%` placeholders are left literally in the HTML.
- HTML pages are Vite inputs (`build.rollupOptions.input`): `index.html`, `privacy.html`, `404.html`, and
  `thanks.html` only if item 14 applies. Use flat root-level files, never `privacy/index.html`. They use only
  root-absolute URLs. Add them to Tailwind's `content`.
- `robots.txt` and `sitemap.xml` are emitted by a small plugin in `generateBundle`
  (`this.emitFile({ type: 'asset', … })`) from `SITE_URL` and `CONTENT_UPDATED`. Do not put them in `public/`,
  because Vite copies `public/` verbatim with no substitution.
- Dockerfile builder stage:
  - `ARG VITE_SITE_URL=https://gokulmv.com`, `ARG VITE_ANALYTICS_DOMAIN`, `ARG VITE_ANALYTICS_SRC`, each re-exported
    with `ENV` before `npm run build`. Railway passes service variables to a Dockerfile build only when they are
    declared as `ARG`.
  - The build fails if `RAILWAY_ENVIRONMENT_NAME=production` and the analytics vars are empty.
- `npm run build` becomes `tsc --noEmit && vite build && node scripts/precompress.mjs` (item 12).

### P6. Reduced motion
Under `prefers-reduced-motion: reduce`:
- "Skip the climb", scene-rail and sticky-CTA jumps use `scrollToProgress(p, { immediate: true })`, then set
  `dampedProgress = rawProgress`;
- the scroll cue uses `motion-safe:animate-pulse`;
- the global CSS also sets `animation-duration: 0.01ms !important; animation-iteration-count: 1 !important`;
- the sticky pill appears without sliding;
- idle 3D motion (cloud drift, paper wobble) is reduced, while scroll-driven camera motion stays.

## DELIVERABLES — the 18 points, adapted

### 1. Custom 404 page
- `404.html` is a Vite HTML input with no 3D bundle. It uses the branded off-route theme ("You've wandered off the
  route"), has a "Back to base camp" link to `/`, its own `<title>` and description, `noindex` (meta tag and the
  `X-Robots-Tag` map), the favicon set, and works at any URL depth.
- Served by P4's `error_page 404 /404.html` with a **real 404 status**, with no `Location` header and no soft 404.
- CI:
  - **200:** `/`, `/privacy`, `/robots.txt`, `/sitemap.xml`, `/site.webmanifest`.
  - **404 with the branded body:** `/does-not-exist`, `/deep/nested/typo`, `/Privacy`, `/privacy/`, `/404`,
    `/404.html`, `/50x.html`, `/assets/nope.js`.
  - `/index.html` returns 301 to `/`. No `Location` header contains `:8080`.
  - The same 404 check over IPv6 (`http://[::1]:$PORT/does-not-exist`).
  - Replace the current `/deep/link/route` = 200 assertion with 404.

### 2. CTA above the fold
- In `#shell` (P1):
  - **"Get in touch"**: an `<a href="#contact">` with a `mailto:` fallback, with an opaque fill (e.g.
    `bg-glacier text-void`) so its contrast never depends on the 3D frame;
  - **"Download résumé"**: only when `resumeUrl` is set;
  - **"Skip the climb"**: an `<a href="#contact">` that, with JS, calls
    `scrollStore.scrollToProgress(ENDING.paperStick + 0.01)` so the paper with the contact details is on the lens.
    It counts as one `skip_climb` event and passes through no `scene_reached` events (P3).
- The headline sits on a solid scrim (`bg-void/60 backdrop-blur`), not only a text-shadow.
- At 360–1440px the CTAs are inside the first viewport, and are the first Tab stops after the skip link.
- CI:
  - each CTA's contrast, computed from its own color and opaque background, is ≥ 4.5:1, and axe reports no
    `color-contrast` violations or `incomplete` results for `#shell a`;
  - each CTA's bounding box is in the viewport at 360×640 and 1440×900;
  - Tab order is correct;
  - "Skip the climb" makes the contact overlay visible (`scrollStore.contactVisible`) within 4 s, or within 1 s
    with reduced motion.

### 3. Meta title per page
- Unique titles of 60 characters or fewer:
  - `/`: "Gokul M V — Software Engineer · The Ascent"
  - `/privacy`: "Privacy — Gokul M V"
  - `/thanks`: "Thanks — Gokul M V"
  - 404: "Off route (404) — Gokul M V"
- CI: `scripts/check-meta.mjs` over `dist/*.html` checks exactly one `<title>` of ≤ 60 characters per file, unique
  across pages. `npx html-validate dist/*.html` passes.

### 4. Meta description per page
- A unique `<meta name="description">` of 120–160 characters per page, written from the real profile content.
- CI: same script — exactly one per file, length 120–160, unique.

### 5. Open Graph image
- `scripts/og.mjs` runs by hand or in a manual `workflow_dispatch` job, **never** in `npm run build`: the
  node:20-alpine builder can't run Playwright browsers.
  - Starts `vite preview` and launches Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`.
  - Scrolls to `ENDING.heroPullEnd` (the figure before the next mountain), waits for 60 rendered frames, and
    screenshots 1200×630 with name and headline typeset in the DOM over the frame.
  - Saves `public/og.jpg` (JPEG quality ~80, under 300 KB), which is **committed**.
- Tags on `/` and `/privacy` (and `/thanks`), with `og:*` URLs absolute from `SITE_URL`:
  - `og:title`, `og:description`, `og:type=website`, `og:url`, `og:site_name`;
  - `og:image` (`${SITE_URL}/og.jpg?v=<short sha>`, so crawlers re-fetch after a change), `og:image:type`,
    `og:image:width`, `og:image:height`, `og:image:alt`;
  - `twitter:card=summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image`;
  - `<link rel="canonical">`;
  - JSON-LD `Person` (`name`, `jobTitle`, `url`, `sameAs` = LinkedIn and GitHub from the content source).
- CI:
  - all tags present on `/` and `/privacy`;
  - `og:url` and `og:image` start with `SITE_URL`;
  - `/og.jpg` returns 200 `image/jpeg`, ≤ 300 KB, 1200×630 (read from the JPEG SOF header);
  - JSON-LD parses with `@type: Person`.
- Manual: preview the share card once in a social-card inspector after deploy.

### 6. Favicon set
- Files in `public/`:
  - `favicon.ico` (16/32/48);
  - `favicon.svg` (with a `prefers-color-scheme` variant);
  - `apple-touch-icon.png` (180);
  - `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`;
  - `site.webmanifest`: name, short_name, `theme_color`/`background_color` `#040508`, `display: standalone`,
    icons.
- Matching `<link>` tags. Remove the inline data-URI favicon.
- CI:
  - every icon and the manifest return 200 with the right type;
  - `/site.webmanifest` is `application/manifest+json`, while `/` is still `text/html` and `/robots.txt` is still
    `text/plain`;
  - PNG IHDR sizes match the file names;
  - the manifest parses and every icon `src` returns 200;
  - no `data:` favicon remains in `dist`.

### 7. robots.txt
- Contents: `User-agent: *`, `Allow: /`, `Sitemap: ${SITE_URL}/sitemap.xml`. **No `Disallow` lines.** Nothing
  private is deployed (`harness/` is never built), and `noindex` pages must stay crawlable for `noindex` to work.
- Emitted from `SITE_URL` (P5).

### 8. sitemap.xml
- `${SITE_URL}/` and `${SITE_URL}/privacy`, exactly as their canonical URLs. `lastmod` = `CONTENT_UPDATED`, not
  the build time.
- CI (`scripts/check-seo.mjs` against the container), for items 7 and 8:
  - the sitemap is well-formed XML;
  - every `<loc>` starts with `SITE_URL`, returns 200, equals that page's canonical, has no `noindex`, and is not
    blocked by robots;
  - every `noindex` page (`/thanks`, 404) is absent from the sitemap.

### 9. Alt text on every image
- Every `<img>` has meaningful `alt`. Decorative images get `alt=""`.
- Tech logos shown **next to their visible name** (chips, the skills grid, the footer) stay `aria-hidden="true"`
  with `focusable="false"`. Adding `role="img"` would make screen readers read "Java logo Java". Only a logo with
  no visible text gets `role="img"` and `aria-label="<Brand>"`.
- Skill years become visible or visually hidden text, not just a `title`.
- The WebGL canvas stays `aria-hidden`. Its story is the `#journey-summary` text (P1). `og:image:alt` is set.
- CI (`@axe-core/playwright`):
  - for each of the 10 `SCENES`, jump to its midpoint (P3), wait until the active card or overlay is not
    `aria-hidden`, and scan it;
  - also scan the static shell with JS disabled, `/privacy` and the 404 page;
  - fail on any serious or critical violation, including `image-alt`, `svg-img-alt`, `role-img-alt`,
    `color-contrast` and `aria-hidden-focus`.

### 10. Mobile breakpoints
- Layouts at 360, 390, 768, 1024, 1440 and 1920px for:
  - HUD cards, which become bottom sheets under 768px;
  - the scene rail;
  - the lens-paper contact overlay;
  - the footer;
  - the shell.
- Respect `env(safe-area-inset-*)`. Size the track in `lvh` (with a `vh` fallback). On touch devices, ignore
  height-only resizes under 15%, so URL-bar show/hide doesn't trigger a refresh.
- **Touch:** keep Lenis `syncTouch: false` (native momentum). Remove the inert `touchMultiplier`: Lenis ignores it
  when `syncTouch` is off, and `syncTouch: true` is unstable on iOS.
- **Readable type** under 768px: paragraph and list text in cards, the shell and the footer computes to ≥ 16px.
  Labels (kickers, chips, buttons) are ≥ 12px. Nothing is below 12px.
- CI (Playwright, including `devices['iPhone 13']` and `devices['Pixel 7']`), at each width and scene midpoint:
  - `document.documentElement.scrollWidth <= innerWidth`;
  - the font-size rules above hold;
  - no card box leaves the viewport;
  - touch swipes advance `rawProgress` monotonically;
  - screenshots are uploaded as artifacts for a human pass.

### 11. Sticky mobile CTA
- Under 768px, a bottom "Get in touch" pill (a `mailto:` link, tracked as `contact_click where=sticky`) sits at
  `bottom: calc(12px + env(safe-area-inset-bottom))`. Bottom-sheet cards reserve
  `padding-bottom: calc(64px + env(safe-area-inset-bottom))`, so the pill never covers card text.
- Visibility comes from **flags, not progress numbers** (P3). The pill hides while `shellVisible`, `contactVisible`
  or `footerVisible` is true. A rAF loop applies this, with no React state on scroll.
- CI at 390×844:
  - hidden at progress 0;
  - visible at 0.35, and its box intersects no active card's text;
  - hidden while the contact overlay shows and in the footer;
  - not rendered at 1024px.

### 12. Loads under 2 seconds
- Budget, on Lighthouse mobile preset (simulated 4G, 4× CPU):
  - LCP ≤ 2000 ms
  - CLS ≤ 0.05
  - TBT ≤ 200 ms
  - first-load JS (the entry `<script>` plus every `modulepreload` in `dist/index.html`) ≤ 120 KB gzip. This is
    reachable only with P2: three, GSAP and the logo data all off the critical path.
- LCP element = the `#shell` headline or CTA (P1). The 3D world loads after paint (P2).
- Precompressed assets:
  - `scripts/precompress.mjs` (Node `zlib`, no dependencies) writes `.gz` siblings (level 9) for js, css, html,
    svg, json, xml, txt and webmanifest files ≥ 1 KB;
  - nginx gets `gzip_static on;` next to `gzip on;`;
  - **No Brotli:** `nginx:1.27-alpine` has no Brotli module, so `brotli_static` would fail `nginx -t`. Don't
    generate `.br` files.
- CI:
  - `scripts/check-bundle.mjs` sums the gzip size of the first-load set from `dist/index.html`. It fails over
    120 KB, or if `three-vendor` or `pdf-vendor` is referenced there.
  - The entry chunk fetched with `Accept-Encoding: gzip` returns `Content-Encoding: gzip` **with** a
    `Content-Length`. That proves the precompressed file was served; on-the-fly gzip is chunked.
  - Lighthouse CI: a pinned `npx --yes @lhci/cli@<exact version> autorun` with `lighthouserc.json` against the
    container at `/` (no `?audit`), with:
    - `numberOfRuns: 3`;
    - `chromeFlags: "--no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader"`;
    - absolute `error` assertions: `largest-contentful-paint` ≤ 2000, `cumulative-layout-shift` ≤ 0.05,
      `total-blocking-time` ≤ 200, `resource-summary:script:size` ≤ 122880;
    - accessibility, best-practices and SEO categories ≥ 0.95.
    Log `data-gpu-tier`.

### 13. Form error states
- **Decision gate.** Record the decision in the README before any other item 13/14 work. **Default: no form.**
  Contact is `mailto:` plus LinkedIn/GitHub. Items 13–14 are N/A, and CI asserts `dist` contains no `<form>`.
- If a form is added (name, email, message):
  - submit with `fetch` and go to `/thanks` on 2xx;
  - inline validation on blur and on submit, with field errors linked by `aria-describedby`, and an error summary;
  - a disabled state while sending;
  - distinct messages for 4xx validation, 429 rate limit and network failure, each with retry and **no data loss**;
  - a honeypot field;
  - a backend that sets no cookies and uses no cookie-setting captcha (e.g. Web3Forms, which takes a `redirect`
    field, or Formspree, where a custom `_next` redirect may need a paid plan);
  - its origin added to CSP `connect-src` and `form-action`.
- CI with `page.route` stubbing the backend:
  - an empty submit shows the summary and linked field errors;
  - 422, 429 and a network abort each show the right message and keep the values;
  - the honeypot blocks the submit;
  - a 2xx goes to `/thanks`.

### 14. Thank-you page
- Applies only with item 13.
- `/thanks`: its own title and description, `noindex`, "Back to the summit", and the `form_success` event.
- Keep a no-JS `<form action>` that lands on `/thanks` only if the chosen backend's plan supports redirecting to
  `${SITE_URL}/thanks`.
- CI: returns 200 with `noindex`, and is absent from the sitemap.

### 15. Privacy policy page
- `/privacy`, linked from the footer and the shell, in plain language:
  - the analytics provider, that it is cookieless, and what it records;
  - the form processor, if any;
  - **exactly what the shipped code stores on the device.** After item 18 that is nothing. If a sound preference is
    ever persisted, name the key and say it is strictly functional;
  - the contact email for requests;
  - a "Last updated" date.
- At the end of the phase, check the text against `grep -rn "localStorage\|sessionStorage\|document.cookie" src`.
- CI:
  - the footer link exists in the raw HTML;
  - `/privacy` returns 200 and contains "Last updated";
  - it has OG tags and a canonical (item 5) and appears in the sitemap.

### 16. Cookie banner
- **Design goal: no banner needed.**
  - Use cookieless analytics (item 17).
  - No production `localStorage` (item 18).
  - No third-party cookies, embeds or trackers.
- If any non-essential cookie or tracker is ever added, a consent banner becomes mandatory. It must:
  - block that script until opt-in;
  - give Accept and Reject equal weight;
  - remember the choice.
- CI:
  - build a **second image with the analytics env vars set** to the real script origin;
  - in Playwright, stub the collector with `page.route` (a 202 response), so nothing is sent;
  - load `/`, wait for `networkidle` plus 3 s, scroll through three scenes, click every contact link (with
    navigation blocked);
  - assert `(await context.cookies()).length === 0` and that `localStorage`/`sessionStorage` keys are within an
    allowlist (empty by default).
- Post-deploy, run the same check once against `https://gokulmv.com`, to catch cookies added at the edge.
- *Not legal advice. Confirm for the jurisdictions you target.*

### 17. Analytics installed
- **Provider:** Plausible (`plausible(name, { props })`, with every event added as a Goal) or Umami
  (`umami.track(name, data)`, self-hosted as a second Railway service). **Cloudflare Web Analytics is ruled out**:
  it has no custom events.
- One typed `track()` in `src/utils/analytics.ts`, a no-op when `VITE_ANALYTICS_DOMAIN` is empty. Load the script
  from the bundled module, never an inline `<script>`.
- Events:
  - `scene_reached {scene}` for base camp, companies 1–3, the summit and the horizon. It fires once per visit, only
    after the scene has been active for ≥ 1.5 s, and never during programmatic travel (P3).
  - `contact_viewed`: when `contactVisible` has been true for ≥ 1 s.
  - `contact_click {type: email|phone|linkedin|github|resume, where: overlay|footer|shell|sticky}`.
  - `skip_climb`.
  - `form_submit` and `form_success` (if item 13 applies).
- **Security headers (add new, server level, P4):**
  - `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy`, as today.
    Permissions-Policy stays a feature deny-list, unrelated to analytics.
  - New `Content-Security-Policy`:

    ```
    default-src 'self'; script-src 'self' <analytics-origin>; connect-src 'self' <analytics-origin> [form origin];
    img-src 'self' data:; style-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none';
    base-uri 'self'; form-action 'self' [form origin]; frame-ancestors 'self'
    ```

    Start with `style-src 'self'`. React `style` props and the rAF loops write styles through the CSSOM
    (`element.style.x = …`), which CSP does not block. Static pages must therefore use classes, not `style=""`
    attributes. Add `'unsafe-inline'` only if the Report-Only deploy shows a library injecting `<style>` elements.
    If drei `<Text>` (troika workers) is used, add `worker-src blob:` and `blob:` to `script-src`.
  - Ship the CSP as `Content-Security-Policy-Report-Only` for one deploy first.
- CI:
  - the analytics-enabled build, with `page.route` capturing the collector;
  - a full scripted scroll sends each `scene_reached` exactly once;
  - "Skip the climb" from 0 sends `skip_climb` and no `scene_reached` for scenes 1–7;
  - each contact link sends the right `contact_click`;
  - a build without the vars contains no analytics script;
  - every security header is present on `/`, `/privacy`, a 404 and an `/assets/*.js` response;
  - a full Playwright scroll records no `securitypolicyviolation` events or CSP console errors.

### 18. Real contact details
- Replace **all** seed content in `src/content/portfolio.ts` (P1) with real résumé data:
  - companies, roles and dates;
  - projects with real names, impact and links;
  - education;
  - skills and years;
  - summary, traits, achievements, and the welcome and horizon messages;
  - email, phone (optional), location, availability, LinkedIn and GitHub;
  - a résumé PDF under a dated name (`public/resume-2026-10.pdf`), so it can be cached safely.
- **Content is code-owned.** In production, drop Zustand `persist` (`import.meta.env.DEV ? persist(config, opts) :
  config`). On boot, run `try { localStorage.removeItem('gokul-mv.portfolio') } catch {}` once, so returning
  visitors don't keep stale seed data. A bare version bump does **not** work: the current `migrate` returns old data
  that passes `isPortfolioData`. If persistence is kept for a dev editor, use version 2 and
  `migrate: (p, v) => (v < 2 || !isPortfolioData(p) ? cloneDefaults() : p)`.
- CI:
  - **Placeholders:** fail on `/Company [0-9]|Project [0-9]|"University"|TODO|lorem/i` in the content file and all
    of `dist`.
  - **Links:** only content URLs (contact links, project `url`/`repoUrl`, `resumeUrl`) and `<a href>` in the built
    HTML, never vendor JS.
    - `https:` must return 2xx/3xx within 3 retries with backoff.
    - `linkedin.com` is format-checked only, because it returns 999 to bots.
    - `mailto:`/`tel:` are syntax-checked only.
    - The résumé returns 200 `application/pdf` from the container.
  - **Stale storage:** seed `localStorage['gokul-mv.portfolio']` with a v1 payload containing "Company 1", load `/`,
    and assert the real names render and "Company 1" does not.

## CI CHECKS (new `e2e` job, after `container`, against the running image)

- **Setup:**
  - `actions/setup-node@v4` (Node 20) and `npm ci`;
  - `npx playwright install --with-deps chromium`;
  - devDependencies `@playwright/test`, `@axe-core/playwright` and `@lhci/cli`, pinned;
  - tests in `tests/e2e/`, scripts in `scripts/`.
- **Chromium flags** for Playwright and LHCI: `--use-angle=swiftshader --enable-unsafe-swiftshader
  --ignore-gpu-blocklist`. Each 3D test asserts `__gpu.tier > 0` and that a `canvas` exists.
- **Checks per item:**

  | Item | Check |
  | --- | --- |
  | 1 | curl status matrix over IPv4 and IPv6 |
  | 2 | CTA viewport, contrast, Tab order and skip-to-contact |
  | 3–5 | `check-meta.mjs` and `html-validate` |
  | 5 | og.jpg type, size and dimensions |
  | 6 | icons, manifest and MIME types |
  | 7–8 | `check-seo.mjs` |
  | 9 | axe at every scene, plus the shell, privacy and 404 pages |
  | 10 | widths × scenes overflow and font rules, plus device touch scrolling |
  | 11 | sticky pill flags |
  | 12 | `check-bundle.mjs`, the gzip_static header and LHCI |
  | 13–14 | form decision assertion, or the stubbed form suite |
  | 15 | privacy link, content and sitemap |
  | 16 | zero cookies and empty storage on the analytics build |
  | 17 | event capture, security headers and no CSP violations |
  | 18 | placeholder grep, link check and stale-storage test |
  | Law 4 | single `gokulmv.com` occurrence; no literal `%VITE_` left in `dist` |

## VERIFICATION — Phase 10 is done only when

- `main` is green with the `e2e` job, and Railway deploys only commits that pass CI ("Wait for CI").
- Railway deploy logs show `IPv4 + IPv6 listeners on port 8080`, and `/healthz` is green.
- **Post-deploy, against `https://gokulmv.com`:**
  - `/does-not-exist` returns a branded 404;
  - the security headers and CSP are present;
  - zero cookies after scrolling and clicks;
  - analytics events appear in the provider dashboard;
  - the share card previews correctly;
  - the résumé downloads.
- **Human pass:**
  - the mobile screenshots from CI artifacts at every width;
  - a real iOS Safari and a mid-range Android: touch scroll, URL-bar show/hide, the sticky pill and the contact
    overlay.
