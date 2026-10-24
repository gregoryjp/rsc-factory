# Arquitectura de {{PRODUCT_NAME}}

## Backend (`api`)

Flujo por módulo: routes → controller → service → repository → Prisma. `createApp` no tiene efectos secundarios; la composición vive en `src/composition.ts` y `src/server.ts` arranca el proceso.

Orden de middleware: requestId → pino-http → helmet → CORS (lista de orígenes) → `express.json({ limit: "100kb" })` → rutas → 404 → manejador de errores.

Envelopes: éxito `{ data, meta: { requestId } }`; error `{ error: { code, message, details?, requestId } }`.

## Clientes

Producto solo API: no hay frontend en este repositorio. Los contratos HTTP viven bajo `/api/v1`; `/health/live` y `/health/ready` quedan sin versión.

## Datos

PostgreSQL con Prisma. Las migraciones viven en `api/prisma/migrations`.
