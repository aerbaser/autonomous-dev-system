# Builder stage
FROM node:22-alpine AS builder

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy dependency files first (cache layer)
COPY package.json pnpm-lock.yaml ./

# Install dependencies with frozen lockfile for reproducible builds
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Build the SvelteKit SPA (outputs to build/)
RUN pnpm build

# Runtime stage
FROM nginx:alpine AS runtime

# Copy built assets from builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

# Health check via wget (available in alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q http://localhost:80 -O /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
