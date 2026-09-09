FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
EXPOSE 8080
# Secrets arrive as a file, not as environment variables: the Vault agent
# injects /app/.env at pod start (see k8s/values.yaml). --env-file-if-exists
# rather than --env-file so the container still boots locally, and in any
# environment that passes configuration the ordinary way.
CMD ["node", "--env-file-if-exists=/app/.env", "dist/main"]
