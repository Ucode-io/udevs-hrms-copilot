FROM node:22-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# NOT /app. The Vault agent mounts a volume at /app to place .env there (see
# secret-volume-path-.env in k8s/values.yaml), and that mount SHADOWS whatever
# the image put at /app — dist, node_modules and package.json all disappear at
# runtime, and the container dies with "Cannot find module '/app/dist/main'"
# while the image itself is perfectly fine. kp-generator-agent hit this and
# moved the same way.
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/package.json ./package.json
EXPOSE 8080
# Secrets arrive as a file, not as environment variables: the Vault agent
# injects /app/.env at pod start (see k8s/values.yaml). That path stays /app on
# purpose — it is Vault's mount, and the reason this image lives elsewhere.
# --env-file-if-exists rather than --env-file so the container still boots
# locally, and in any environment that passes configuration the ordinary way.
CMD ["node", "--env-file-if-exists=/app/.env", "dist/main"]
