# Hosted merrymen — ONE image, TWO services.
#
# The same image runs either the Next.js dashboard (the web service) or the
# process-per-tenant supervisor (the orchestrator service); Railway picks which
# by overriding the start command per service (see docs/hosted-deploy.md). Both
# need the whole monorepo present: the web build resolves packages/core + worker
# from source via tsconfig paths (next.config externalDir), and the orchestrator
# runs worker/src directly with tsx at runtime.
#
# node:22 (not alpine) for glibc + a node new enough for the built-in node:sqlite
# the worker uses (>= 22.12).
FROM node:22-slim

WORKDIR /app

# Deps first, for layer caching. --ignore-scripts skips the `prepare` hook
# (cli/build.mjs, an npm-package concern); the dashboard is built explicitly
# below. tsx/next/typescript are runtime dependencies, so --omit=dev keeps them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The Postgres driver — a HOSTED-ONLY runtime dependency. Both the shared ledger
# (worker/src/db.ts) and the grant store (worker/src/grant-store.ts) reach it by
# dynamic import, and only when DATABASE_URL is set; a self-hosted install never
# sets it and never loads pg, which is why pg is deliberately NOT in package.json.
# --no-save keeps it out of the manifest/lock; it just has to exist in the image's
# node_modules so `require('pg')` resolves at runtime. Without this the first
# Postgres access on Railway throws "Cannot find module 'pg'" at boot.
RUN npm install --no-save --ignore-scripts pg@8

# Full source. .dockerignore keeps node_modules / .next / local state out.
COPY . .

# Build the dashboard (the web service serves it; the orchestrator ignores it).
RUN npm run build

ENV NODE_ENV=production

# Default to the web service. The orchestrator service overrides this with
# `npm run start:orchestrator` in its Railway service settings. Every secret
# (MERRYMEN_SESSION_SECRET, MERRYMEN_STORE_DEK, DATABASE_URL, the house keys) is
# injected at RUNTIME by Railway, never baked into the image.
CMD ["npm", "run", "start:web"]
