# Terms: one image, API + desk UI on $PORT (default 8010).
#   docker build -t terms .
#   docker run --rm -p 8010:8010 -e SAMPLE_MODE=true terms        # no credentials at all
#   docker run --rm -p 8010:8010 --env-file .env \
#     -e METERLESS_BASE_URL=http://host.docker.internal:8088/v1 \
#     -e ZETARIS_REST_URL=http://host.docker.internal:8888/api/v1.0 terms
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production PORT=8010 HOST=0.0.0.0 TERMS_DATA=/app/data/runtime

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run web:build && mkdir -p logs data/runtime

EXPOSE 8010
CMD ["npx", "tsx", "src/server.ts"]
