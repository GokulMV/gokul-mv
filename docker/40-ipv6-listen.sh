#!/bin/sh
# Adds an IPv6 listener next to the IPv4 one, but only when the kernel
# supports IPv6. Railway's private network is IPv6-only, while some hosts and
# local Docker setups have IPv6 disabled, where `listen [::]` would crash NGINX.
# Runs after 20-envsubst-on-templates.sh has rendered default.conf.
set -eu

CONF=/etc/nginx/conf.d/default.conf
PORT="${PORT:-8080}"

if [ ! -f "$CONF" ]; then
  echo "$0: $CONF not found, skipping IPv6 listener"
  exit 0
fi

# Same test as the stock 10-listen-on-ipv6-by-default.sh. Note: `-s` would be
# wrong here — procfs files always report a size of 0.
if [ -f /proc/net/if_inet6 ]; then
  if ! grep -q "listen \[::\]:${PORT};" "$CONF"; then
    sed -i "s|^\(\s*\)listen ${PORT};|\1listen ${PORT};\n\1listen [::]:${PORT};|" "$CONF"
  fi
  echo "$0: IPv4 + IPv6 listeners on port ${PORT}"
else
  echo "$0: IPv6 unavailable, IPv4 listener on port ${PORT} only"
fi
