# Arquitectura de {{PRODUCT_NAME}}

## Backend (`api`)

Flujo por módulo: routes → controller → service → repository → Prisma. `createApp` no tiene efectos secundarios; la composición vive en `src/composition.ts` y `src/server.ts` arranca el proceso.

Orden de middleware: requestId → pino-http → helmet → CORS (lista de orígenes) → `express.json({ limit: "100kb" })` → rutas → 404 → manejador de errores.

Envelopes: éxito `{ data, meta: { requestId } }`; error `{ error: { code, message, details?, requestId } }`.

## Frontend (`web`)

React + Vite + TypeScript estricto, CSS Modules. Estructura por feature cuando aparezcan funcionalidades.

Llamadas al api: siempre con URLs relativas `/api/...` (el prefijo `/api` se elimina antes de llegar al api: `/api/health/ready` llega como `/health/ready`). En desarrollo lo resuelve el proxy de `web/vite.config.ts`; en la vista previa del motor, su servidor estático. Pantallas con login: declarar `web/ui-auth.json` y rutas `{ "path": "...", "as": "<rol>" }` en `web/ui-routes.json` (credenciales solo de prueba, las mismas que crea la semilla de pruebas).

## Datos

PostgreSQL con Prisma. Las migraciones viven en `api/prisma/migrations`.
