# Build context is the repo root (see docker-compose.yml) — this is an npm
# workspaces monorepo, so `npm ci` needs the root package-lock.json plus
# every workspace's package.json to resolve the @virtualmeet/shared link,
# and the server build inlines shared's TS source via esbuild (see
# server/package.json's "build" script), so nothing from shared/ needs to
# ship in the final image.
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY . .
RUN npm ci
RUN npx prisma generate --schema=server/prisma/schema.prisma
RUN npm run build --workspace=@virtualmeet/server

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/prisma ./server/prisma
COPY --from=builder /app/server/package.json ./server/package.json
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
