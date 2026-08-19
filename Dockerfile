# No browser image on purpose: this Actor is HTTP-only (assessment §3).
FROM apify/actor-node:22 AS builder

COPY package*.json ./
RUN npm ci --include=dev --audit=false

COPY . ./
RUN npm run build

FROM apify/actor-node:22

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional --audit=false \
 && echo "Installed:" && (npm list --omit=dev --all || true)

COPY --from=builder /usr/src/app/dist ./dist
COPY .actor ./.actor

CMD ["node", "dist/main.js"]
