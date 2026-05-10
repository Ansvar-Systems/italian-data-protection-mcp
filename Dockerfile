# ─────────────────────────────────────────────────────────────────────────────
# Italian Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t italian-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 italian-data-protection-mcp
#
# The image expects a pre-built database at /app/data/garante.db.
# Override with GARANTE_DB_PATH for a custom location.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native deps ---
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
# Install ALL deps including better-sqlite3 native binding (postinstall runs)
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV GARANTE_DB_PATH=/app/data/garante.db

# Copy built artifacts AND node_modules (preserves better-sqlite3 native binding)
COPY package.json package-lock.json* ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/

# Bake operational DB into image (provisioned by ghcr-build.yml from Release asset)
COPY data/database.db data/garante.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
