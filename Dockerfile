# Takalif — one image, one process, one SQLite file.
#
# The server serves the API and the built PWA from a single process (ADR 0006),
# so the image is just: production dependencies + the two build outputs.
# better-sqlite3 is a native module; debian-slim (glibc) is deliberate —
# prebuilt binaries exist for it, while musl/Alpine would compile from source.

FROM node:22-slim AS build
RUN npm install -g pnpm@11.10.0
WORKDIR /app

# Install before copying source so dependency layers cache across edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build


FROM node:22-slim AS runtime
RUN npm install -g pnpm@11.10.0
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --prod --frozen-lockfile

# Build outputs only. The server bundle reads schema.sql from beside itself,
# and serves the PWA from packages/web/dist when present.
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# HOST must bind all interfaces inside the container; loopback would accept
# only connections from within. compose sets this too — belt and braces.
ENV HOST=0.0.0.0 PORT=8787 DB_FILE=/data/takalif.sqlite
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
