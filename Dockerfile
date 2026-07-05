FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/

RUN mkdir -p data

ENV PORT=3100
EXPOSE 3100

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3100/api/health || exit 1

CMD ["node", "server.js"]
