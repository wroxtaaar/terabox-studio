FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

COPY package*.json ./
RUN npm install --omit=dev \
  && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data

EXPOSE 10000

CMD ["npm", "start"]
