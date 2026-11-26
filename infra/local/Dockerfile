# SPDX-License-Identifier: Apache-2.0
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /app
ENV CI=true WRANGLER_SEND_METRICS=false NODE_OPTIONS=--max-old-space-size=768
RUN npm install --global pnpm@11.29.0
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN NODE_OPTIONS=--max-old-space-size=3072 ORIGINS=http://localhost:18787 SETUP_TOKEN=local-build-placeholder pnpm --filter doota build
CMD ["node", "infra/local/run.mjs"]
