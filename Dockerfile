# syntax=docker/dockerfile:1
# SECOND WORLD CLI image. Build:  docker build -t second-world .
# Run against an app on the host (see README "Docker"):
#   docker run --rm -v "$PWD:/work" second-world perf http://host.docker.internal:3000
# The Safety Guard only allows loopback by default: add the host you use to safety.allowHosts.

# ---- build: full dev dependencies, compile with tsdown, pack the publishable tarball
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN npm run build \
 && npm pack --ignore-scripts --pack-destination /tmp \
 && mv /tmp/second-world-*.tgz /tmp/second-world.tgz

# ---- runtime: only the packed files (dist + package.json) and production dependencies
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NO_UPDATE_NOTIFIER=1 \
    npm_config_update_notifier=false
COPY --from=build /tmp/second-world.tgz /tmp/second-world.tgz
# typescript is the optional peer `sw inspect` / `sw model build` need (resolved from the global prefix).
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/second-world.tgz typescript@6 \
 && rm /tmp/second-world.tgz \
 && npm cache clean --force \
 && mkdir /work && chown node:node /work
USER node
WORKDIR /work
ENTRYPOINT ["sw"]
CMD ["--help"]
