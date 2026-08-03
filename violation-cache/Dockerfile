# SPDX-License-Identifier: MIT
# Node 22 LTS (replaces EOL Node 18)
FROM node:22-alpine
WORKDIR /app
# Install production dependencies first (layer cached unless package.json changes)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
# The image copies named paths only — a new directory that is not listed here is
# silently missing at runtime (CLAUDE.md §9.3). Add a COPY for every new folder.
COPY server.js ./
COPY db/ ./db/
COPY lib/ ./lib/
COPY routes/ ./routes/
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "server.js"]
