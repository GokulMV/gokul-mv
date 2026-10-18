# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Stage 1 — build the static bundle with Node 20 (Alpine, musl).
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Railway injects these at build time when they are declared as ARGs.
ARG RAILWAY_GIT_COMMIT_SHA=local
ARG RAILWAY_ENVIRONMENT_NAME=local
ENV RAILWAY_GIT_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA} \
    RAILWAY_ENVIRONMENT_NAME=${RAILWAY_ENVIRONMENT_NAME} \
    NODE_OPTIONS=--max-old-space-size=2048 \
    CI=true

COPY package.json package-lock.json ./
# Fail fast if npm exits 0 without installing the toolchain (known npm bug on
# flaky networks) instead of failing later with a confusing `tsc: not found`.
RUN npm ci --no-audit --no-fund \
 && test -x node_modules/.bin/tsc \
 && test -x node_modules/.bin/vite

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — serve with NGINX. The official image runs envsubst over
# /etc/nginx/templates/*.template at boot, only substituting variables that
# are actually defined, so NGINX runtime variables ($uri, …) are untouched.
# PORT defaults to 8080 and is overridden by Railway's injected $PORT,
# which gives the effective `${PORT:-8080}` binding.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

ENV PORT=8080

# A static site needs few workers. `auto` would spawn one per *host* CPU
# (~80 on Railway), and `notice`-level logs flood Railway's log view in red
# (NGINX logs to stderr). Startup notes from the entrypoint scripts — including
# the bound port — still print on stdout.
ARG NGINX_WORKER_PROCESSES=2
RUN rm -f /etc/nginx/conf.d/default.conf \
 && sed -i \
      -e "s/^worker_processes.*/worker_processes ${NGINX_WORKER_PROCESSES};/" \
      -e 's#^error_log .*#error_log /var/log/nginx/error.log warn;#' \
      /etc/nginx/nginx.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 docker/40-ipv6-listen.sh /docker-entrypoint.d/40-ipv6-listen.sh
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["nginx", "-g", "daemon off;"]
