FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production
# Database: set DATABASE_URL to a postgres:// address and it is used (recommended).
# Without DATABASE_URL the server falls back to the SQLite file at DB_PATH.
# One-time migration of an old SQLite file: node scripts/migrate-sqlite-to-postgres.js <file> "$DATABASE_URL"
ENV DB_PATH=/data/magnetengine.db
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
