# Production Deployment & Operations

> Best practices, Docker containerization, PostgreSQL configuration, and operational checklist for running Embody in production.

---

## 🚀 Production Readiness Checklist

Before moving your Embody application to production, ensure you have completed the following:

- [ ] Set `NODE_ENV=production` in the environment.
- [ ] Configured a managed **PostgreSQL 16+** database via `DATABASE_URL`.
- [ ] Ensured local development verifiers are replaced by `gatewayJwtVerifier`.
- [ ] Secured secret keys (`GATEWAY_REGISTRATION_SECRET`, `GATEWAY_JWT_SECRET`) in your secret manager.
- [ ] Configured health checks targeting `GET /health`.
- [ ] Configured container graceful shutdown (`SIGTERM` / `SIGINT`).

---

## 🐳 Docker Containerization

Here is an optimized, multi-stage `Dockerfile` for production:

```dockerfile
# Stage 1: Build & Dependencies
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependency manifests
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code and build
COPY . .
RUN pnpm build

# Prune devDependencies
RUN pnpm prune --prod

# Stage 2: Minimal Production Runtime
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Run as non-root user for security
USER node

# Copy compiled artifacts and production dependencies
COPY --chown=node:node --from=builder /app/package.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/embody.config.js ./

EXPOSE 8080

# Health check
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Start the application host
CMD ["node", "dist/index.js"]
```

---

## 🐘 PostgreSQL Configuration

Embody uses high-performance JSONB storage and connection pooling:

```ini
# Database Connection String
DATABASE_URL=postgresql://embody_user:StrongPassword123!@postgres.internal:5432/embody_prod?sslmode=require&pool_size=20
```

### Connection Pooling Best Practices
- For containerized deployments (Kubernetes, AWS ECS, Google Cloud Run), configure a connection pooler like **PgBouncer** or **AWS RDS Proxy** to manage transient agent connections.
- Set maximum pool size per container instance: `max: 10` to `20`.

---

## 🩺 Monitoring & Health Checks

Embody exposes a built-in health endpoint:

```http
GET /health
```

### Response
```json
{
  "status": "healthy",
  "uptimeSeconds": 86420,
  "appId": "ops",
  "version": "1.0.0",
  "database": {
    "dialect": "postgres",
    "connected": true
  }
}
```

If the database connection is severed, `/health` returns `503 Service Unavailable`, allowing load balancers and orchestrators to automatically route traffic away from unhealthy nodes.

---

## 🔄 Graceful Shutdown

When an instance receives a `SIGTERM` or `SIGINT` signal (e.g. during a rolling deployment):
1. Stops accepting new HTTP / MCP connections.
2. Allows in-flight actions to complete up to `requestTimeoutMs` (default: 30 seconds).
3. Closes database connection pools and flushes pending outbox events.
4. Exits with status `0`.

Next: **[Troubleshooting & FAQ →](./02-troubleshooting-faq.md)**
