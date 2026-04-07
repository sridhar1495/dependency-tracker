# SPDX-License-Identifier: MIT
# Node 22 LTS (replaces EOL Node 18)
FROM node:22-alpine
WORKDIR /app
COPY server.js .
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "server.js"]
