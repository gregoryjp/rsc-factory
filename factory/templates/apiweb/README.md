# {{PRODUCT_NAME}}

Monorepo npm workspaces: `api` (Express + Prisma + PostgreSQL) y `web` (React + Vite).

## Uso local

```bash
cp .env.example .env
docker compose up -d postgres
npm ci
npm run check
```

`npm run check` ejecuta la verificación completa de ambos workspaces. Los tests del API necesitan `NODE_ENV=test` y `TEST_DATABASE_URL` apuntando a una base cuyo nombre termine en `_test`.
