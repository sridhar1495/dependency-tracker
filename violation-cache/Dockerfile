# SPDX-License-Identifier: MIT
# Node 22 LTS (replaces EOL Node 18)
FROM node:22-alpine
WORKDIR /app
# Install production dependencies first (layer cached unless package.json changes)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "server.js"]
