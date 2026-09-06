# SPDX-License-Identifier: MIT
# Node 22 LTS (replaces EOL Node 18)
FROM node:22-alpine
WORKDIR /app
# Pin the container clock to UTC. calcNextRun no longer depends on it — it reads
# and writes UTC instants explicitly — but log lines and the failure-alert email
# call toLocaleString(), and a base image that ever shipped with a TZ set would
# silently reword them. Timezones exist in exactly one place in this product:
# the browser, which converts the schedule picker on the way in and out.
ENV TZ=UTC
# Install production dependencies first (layer cached unless the manifests change).
# `npm ci` against the committed lock file, not `npm install`: the image then
# contains exactly the dependency tree that was tested and audited, rather than
# whatever the registry resolves to on the day it is built.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# The image copies named paths only — a new directory that is not listed here is
# silently missing at runtime (CLAUDE.md §9.3). Add a COPY for every new folder.
COPY server.js ./
COPY db/ ./db/
COPY lib/ ./lib/
COPY routes/ ./routes/
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "server.js"]
