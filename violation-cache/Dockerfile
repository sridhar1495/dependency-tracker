FROM node:18-alpine
WORKDIR /app
COPY server.js .
RUN mkdir -p /data
EXPOSE 3001
CMD ["node", "server.js"]
