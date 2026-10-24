# syntax=docker/dockerfile:1

# CipherScan Next.js frontend - multi-stage build producing a standalone server.
# Base image uses an exact Node patch tag; override with
# --build-arg NODE_IMAGE=... to build against a specific Node image / commit.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim

# ---------------------------------------------------------------------------
# deps: install production-resolved node_modules from the lockfile
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY vendor/braces ./vendor/braces
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# builder: compile the Next.js standalone output
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Bake the source git commit into the image for traceability.
ARG GIT_COMMIT=unknown
ARG NEXT_PUBLIC_NETWORK
ENV NEXT_PUBLIC_GIT_COMMIT=${GIT_COMMIT}
ENV NEXT_PUBLIC_NETWORK=${NEXT_PUBLIC_NETWORK}
ENV CIPHERSCAN_ALLOW_BUILD_UPSTREAM_FALLBACK=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# runner: minimal runtime image
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.title="cipherscan-web" \
      org.opencontainers.image.source="https://github.com/dannywillems/cipherscan" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

# Run as the non-root user that the base image already provides.
USER 1000

# Standalone output: server, static assets, and public files (incl. WASM).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
