# Build context is the repo root (see docker-compose.yml) — npm workspaces
# needs the root package-lock.json plus every workspace's package.json to
# resolve the @kaispace/shared link; Vite bundles that source directly
# into the browser build, so nothing from shared/ ships separately.
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN npm ci
ARG VITE_SERVER_URL
ARG VITE_TURN_URL
ARG VITE_TURN_USERNAME
ARG VITE_TURN_CREDENTIAL
ENV VITE_SERVER_URL=$VITE_SERVER_URL \
    VITE_TURN_URL=$VITE_TURN_URL \
    VITE_TURN_USERNAME=$VITE_TURN_USERNAME \
    VITE_TURN_CREDENTIAL=$VITE_TURN_CREDENTIAL
RUN npm run build --workspace=@kaispace/client
FROM nginx:alpine
COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
