# PHASE 10: Launch Readiness — "Make It Real" Production Checklist

> Merge this into the Phase 10 prompt. It turns the 18-point "real website" checklist into concrete,
> testable deliverables for **this** codebase: a single-page React/R3F scrollytelling portfolio served as a
> static bundle by NGINX on Railway, at `https://gokulmv.com`.
> Each item says what exists today, what to build, and how CI proves it.

## CONTEXT (state of the repo going into Phase 10)

- One page (`/`): the 1400vh 3D journey, the lens-paper contact ending and the credits/footer section.
- No `public/` directory: no robots.txt, sitemap, favicon set, web manifest or Open Graph image. The favicon is a
  single inline data-URI SVG in `index.html`.
- `index.html` has a `<title>` and `<meta name="description">` but no canonical, Open Graph, Twitter Card or
  structured data.
- `nginx.conf.template` answers **every** unknown path with `index.html` (HTTP 200). `.github/workflows/ci.yml`
  asserts that `/deep/link/route` returns 200. Both change in this phase.
- `src/store/portfolioStore.ts` still ships **seed placeholder content**: "Company 1–3", "Project 1–3",
  "University", `phone: null`, `resumeUrl: null`.
- Contact is `mailto:` and links on the lens paper (Scene 9) and in the footer. There is no form.
- No analytics, cookies or consent UI. `localStorage` holds the persisted portfolio content (Zustand `persist`).

## NON-NEGOTIABLE LAUNCH LAWS

1. **The HTML shell must stand on its own.** Name, headline, primary CTA, contact details and navigation render
   as real DOM in the first paint, before any WebGL, and work with JavaScript disabled (`<noscript>` fallback
   with the same content). The 3D journey is a progressive enhancement and never blocks content.
2. **No regression of the Phase 0–9 laws:** no React re-renders on scroll, damped motion everywhere, 60fps
   targets, Railway Docker build, and `/healthz`.
3. **Every item below has an automated check in CI** (`.github/workflows/ci.yml`). Main stays green, and Railway's
   "Wait for CI" can gate deploys on it.
4. **Absolute URLs use one origin constant:** `SITE_URL = https://gokulmv.com`. Read it from
   `import.meta.env.VITE_SITE_URL` with that default and use it for canonical, Open Graph, sitemap and robots.
   It is never hard-coded twice.
5. No placeholder content ships to production (item 18).

## DELIVERABLES — the 18 points, adapted

### 1. Custom 404 page
- `public/404.html`: a static, lightweight branded page with no WebGL and inline CSS. It uses the off-route
  mountain theme ("You've wandered off the route"), a "Back to base camp" link to `/`, its own `<title>` and
  description, `noindex`, and the favicon set.
- `nginx.conf.template`: replace the blanket SPA fallback. Serve `/` (and `/privacy`, `/thanks` if built) from
  their HTML files. Any other path gets `error_page 404 /404.html` with a **real 404 status**, and `/404.html`
  itself is `internal`.
- CI: `/does-not-exist` returns **404** with the branded body, and `/`, `/privacy`, `/robots.txt`, `/sitemap.xml`
  return 200. Replace the current deep-link 200 assertion.

### 2. CTA above the fold
- The Scene 1 welcome view gets a visible primary CTA, **"Get in touch"**, plus secondary actions:
  - **"Download résumé"**, when `contact.resumeUrl` is set;
  - **"Skip the climb"**, which jumps to the contact ending via `scrollStore.scrollToProgress`, for visitors who
    won't scroll 1400vh.
- The CTA must stay visible over the cloud curtain at 360–1440px widths, be keyboard focusable, and clear WCAG AA
  contrast.

### 3. Meta title per page
- Unique, descriptive `<title>` per HTML page:
  - `/`: "Gokul M V — Software Engineer · The Ascent"
  - `/privacy`: "Privacy — Gokul M V"
  - `/thanks`: "Thanks — Gokul M V"
  - 404: "Off route (404) — Gokul M V"
- Keep each to 60 characters or fewer.

### 4. Meta description per page
- A unique `<meta name="description">` of 150–160 characters for each page, written from the real profile
  content.

### 5. Open Graph image
- `public/og.png`, 1200×630, under 300 KB. Use a real render of the "last pull" shot: the figure before the next
  mountain, with name and headline typeset. Generate it with a Playwright script in `scripts/` from the built
  site, so it stays in sync with the world.
- Tags on `/`:
  - `og:title`, `og:description`, `og:type=website`, `og:url`, `og:image` (absolute URL), `og:image:width`,
    `og:image:height`, `og:image:alt`, `og:site_name`;
  - `twitter:card=summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image`;
  - `<link rel="canonical">`;
  - JSON-LD `Person` structured data (name, jobTitle, url, sameAs: GitHub and LinkedIn links from the store).

### 6. Favicon set
- `public/favicon.ico` (16/32/48), `favicon.svg` (light and dark aware), `apple-touch-icon.png` (180×180),
  `icon-192.png`, `icon-512.png` and `icon-512-maskable.png`, plus `site.webmanifest` (name, short_name,
  theme_color `#040508`, background_color `#040508`, display `standalone`, icons).
- Matching `<link>` tags. Remove the inline data-URI favicon.

### 7. robots.txt
- `public/robots.txt`: `User-agent: *`, `Allow: /`, `Disallow: /harness/`, and `Sitemap: ${SITE_URL}/sitemap.xml`.
  Generate it at build time from `SITE_URL`.

### 8. sitemap.xml
- `sitemap.xml` generated at build time: `/` and `/privacy`, each with `lastmod` set to the build date. Exclude
  `/thanks` and 404.

### 9. Alt text on every image
- Every `<img>` has meaningful `alt`. Purely decorative ones get `alt=""` and `aria-hidden`.
- Inline brand SVGs that convey information (tech logos in the summit HUD and footer) get `role="img"` and
  `aria-label="<Brand> logo"`. Purely decorative SVGs stay `aria-hidden`.
- The WebGL canvas is decorative (`aria-hidden`). The same story must be available as text: a visually hidden
  "Journey" summary listing base camp, companies, projects, summit and contact.
- `og:image:alt` is set.
- CI: an axe-core or Playwright accessibility scan reports zero `image-alt`, `svg-img-alt` and `role-img-alt`
  violations.

### 10. Mobile breakpoints
- Verified layouts at 360, 390, 768, 1024, 1440 and 1920px for:
  - HUD cards, which become bottom sheets on small screens;
  - the scene rail;
  - the telemetry panel, hidden on mobile unless `?audit`;
  - the lens-paper overlay;
  - the footer.
- Respect `env(safe-area-inset-*)`. Touch scrolling must be smooth with Lenis.
- Readable type: at least 16px body text on mobile. No horizontal scroll.
- CI: Playwright screenshots at each width, plus a no-horizontal-overflow assertion.

### 11. Sticky mobile CTA
- Below 768px, a persistent bottom "Get in touch" pill (safe-area aware) opens the contact.
- It auto-hides while the lens paper shows the contact details (0.955–0.985), inside the footer, and while the
  welcome CTA is on screen.
- It's driven by a rAF loop, not React state on scroll. It never covers HUD text.

### 12. Loads under 2 seconds
- Budget, on mid-tier mobile over 4G with Lighthouse mobile throttling:
  - LCP < 2.0s
  - CLS < 0.05
  - TBT < 200ms
  - first-load JS under 120 KB gzip
- **Lazy-load the 3D world.** `three-vendor` (~900 KB raw) must not block first paint. `Experience` is a
  `React.lazy`/dynamic import started after the HTML shell paints (`requestIdleCallback`). The welcome view and
  CTA are the LCP element.
- Precompressed assets: a zero-dependency Node build step writes `.gz` (and Brotli via `zlib.brotliCompressSync`)
  siblings. NGINX serves them with `gzip_static on`. Add `brotli_static` only if the module is available in the
  image; otherwise gzip only.
- `<link rel="modulepreload">` for the entry chunk only. No render-blocking fonts.
- CI: Lighthouse CI (`npx @lhci/cli`) against the built container. Fail on budget regressions.

### 13. Form error states
*Applies if Phase 10 adds a contact form. Decide at the start of the phase.*
- Recommended: a short "Send a message" form (name, email, message) in the footer and on the lens paper, posting
  to a form backend: Formspree, Web3Forms, or a small Railway function.
- Required behaviour:
  - inline validation on blur and on submit, with field-level error text linked via `aria-describedby`;
  - an error summary;
  - disabled state while sending;
  - network-failure and rate-limit messages with a retry;
  - a honeypot field for spam;
  - no data loss on error.

### 14. Thank-you page
*Applies with the form (item 13).*
- `/thanks`: a static page with its own title, `noindex`, "Back to the summit", and the analytics conversion
  event. The form redirects there on success. The no-JS form post also lands there.

### 15. Privacy policy page
- `/privacy`, linked from the footer, written in plain language:
  - what analytics collects (and that it is cookieless);
  - what `localStorage` stores: persisted portfolio content and the sound preference;
  - the form data processor, if any;
  - retention, contact email for requests, and last-updated date.

### 16. Cookie banner
- **Design goal: no banner needed.** Use cookieless analytics (item 17). Keep `localStorage` strictly functional,
  and set no third-party cookies, embeds or trackers.
- If any non-essential cookie or tracker is ever added, a consent banner becomes mandatory. It must block that
  script until opt-in, use equal-weight Accept/Reject, and persist the choice.
- CI: assert that a fresh page load sets **zero cookies** (`page.context().cookies()` is empty).
- *Not legal advice. Confirm for the jurisdictions you target.*

### 17. Analytics installed
- A privacy-friendly, cookieless provider, configured via `VITE_ANALYTICS_*` env vars (off when unset, so local
  and CI runs aren't tracked). Choose one:
  - Plausible
  - Umami, self-hosted as a second Railway service
  - Cloudflare Web Analytics
- Events:
  - each scene reached once per visit (base camp, each company, summit, horizon), fired from the existing
    `scrollStore.onSceneChange`;
  - contact paper viewed;
  - email, link and résumé clicks;
  - form submit and success;
  - "Skip the climb" used.
- Update the CSP and `Permissions-Policy` headers in `nginx.conf.template` for the analytics origin.

### 18. Real contact details
- Replace **all** seed content in `src/store/portfolioStore.ts` with real data from the résumé:
  - companies, roles and dates;
  - projects with real names, impact and links;
  - education;
  - skills with years;
  - email, phone (optional), location, availability;
  - LinkedIn and GitHub URLs;
  - a hosted résumé PDF in `public/`.
- Validate every link.
- Bump the persisted store version so returning visitors don't keep stale seed data from `localStorage`.
- CI: the production bundle must not contain `Company 1`, `Project 1`, `"University"` or `TODO`, and every
  `mailto:`/`https:` link in the built HTML and JS resolves (link checker, with retries).

## VERIFICATION — Phase 10 is done only when

- **Status codes:**
  - `docker run` the image: `/` and `/privacy` return 200, `/does-not-exist` returns 404 with the branded page,
    and `/robots.txt` and `/sitemap.xml` return 200 with the correct `SITE_URL`.
  - Run the 404 and status-code checks on both the IPv4 and IPv6 listeners.
- **Meta tags:** an HTML validator passes, and each page has a unique title and description. Facebook Sharing
  Debugger / LinkedIn Post Inspector-style checks pass: absolute `og:image`, 1200×630, under 300 KB.
- **Accessibility:** axe-core reports zero serious or critical violations on `/`, `/privacy`, `/thanks` and 404.
- **Performance:** Lighthouse CI on mobile meets item 12's budgets. Scores of 95+ for Accessibility, Best
  Practices and SEO.
- **Responsive:** Playwright screenshots at all item 10 widths are reviewed, with no horizontal overflow.
- **Privacy:** zero cookies on first load, and analytics events are visible in the provider dashboard.
- **Content:** no placeholder strings in the bundle, and the link checker is green.
- **Deploy:** Railway deploy logs show `IPv4 + IPv6 listeners on port 8080`, and `/healthz` is green.
