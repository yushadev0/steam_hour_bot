# yusha's Steam Hour Bot
# Panel gömülü tek binary derlenir (Windows exe ile aynı yol), son imajda yalnızca o bulunur.

FROM node:24-bookworm-slim AS build
RUN npm install -g bun@1.4.3
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build:web && cd apps/server && bun scripts/build-exe.ts

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 1000 --create-home shb \
  && mkdir -p /data && chown shb:shb /data
COPY --from=build /src/apps/server/dist/steam-hour-bot-linux /usr/local/bin/steam-hour-bot

USER shb
ENV SHB_DATA_DIR=/data \
    SHB_PORT=8090
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["steam-hour-bot", "health"]
ENTRYPOINT ["steam-hour-bot"]
CMD ["serve"]
