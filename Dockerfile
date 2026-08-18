FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Persist this path with a Coolify volume so showtimes survive redeploys.
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server.js"]
