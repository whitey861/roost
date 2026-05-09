# Roost dev-agent worker container.
#
# Runs on DigitalOcean App Platform. Leases dev_jobs from Supabase, clones
# the target repo, drives Claude Code headlessly, opens a PR, and posts a
# Telegram notification.
#
# Pinning: bump CLAUDE_CODE_VERSION and GH_VERSION deliberately so changes
# are visible in PRs.
FROM node:20-bullseye-slim

ARG CLAUDE_CODE_VERSION=2.0.0
ARG GH_VERSION=2.69.0

# System packages: git for clone/push, curl for health probes, ca-certificates
# for HTTPS, build-essential because some npm postinstall scripts need it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) for PR creation. Pinned binary release.
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tgz \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"

# Claude Code CLI from npm. The package and binary are both `@anthropic-ai/claude-code`.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Non-root user for the worker. Keeps Claude Code's filesystem writes scoped
# to /home/worker; the container's root filesystem stays read-only-ish in
# practice.
RUN useradd --create-home --shell /bin/bash worker
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

RUN chown -R worker:worker /app /home/worker
USER worker

ENV NODE_ENV=production
CMD ["node", "/app/dist/main.js"]
