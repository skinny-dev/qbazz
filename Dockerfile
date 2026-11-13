# Qbazz in one container: core + website + Telegram bot (+ the Telegram proxy when a VPN subscription is given).
# Build context is made by `node deploy/build-image.mjs` (it puts the built site and the code under ./app).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tar \
 && rm -rf /var/lib/apt/lists/*

# sing-box: the small proxy client that carries Telegram through your VPN subscription. Optional - without it the
# image still builds, and QBAZZ_PROXY_SUBSCRIPTION just cannot be used.
ARG TARGETARCH=amd64
RUN set -e; \
    URL="$(curl -fsS -m 30 https://api.github.com/repos/SagerNet/sing-box/releases/latest | grep -oE "https://[^\"]+linux-${TARGETARCH}\.tar\.gz" | head -1 || true)"; \
    if [ -n "$URL" ]; then \
      curl -fsSL -m 180 "$URL" -o /tmp/sb.tgz && tar -xzf /tmp/sb.tgz -C /tmp \
      && install "$(find /tmp -name sing-box -type f | head -1)" /usr/local/bin/sing-box; \
      rm -rf /tmp/sb.tgz /tmp/sing-box*; \
    else echo "NOTE: sing-box could not be downloaded; the Telegram proxy will not be available."; fi

WORKDIR /app
COPY app/ /app/
# the bot imports Qbazz's code from ../qbazz-core; here that folder is called core
# The persistent disk is mounted at /data owned by root, so the container runs as root: as the unprivileged `node` user
# it cannot create anything on the disk (EACCES). The container is the isolation boundary on a platform like Runflare.
RUN ln -s core qbazz-core && mkdir -p /data

# everything that must survive a restart lives in /data: the database, the photos and the generated secrets
ENV QBAZZ_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8000
CMD ["node", "supervisor.mjs"]
