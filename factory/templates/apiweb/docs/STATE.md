# Estado de {{PRODUCT_NAME}}

| Área | Estado |
|---|---|
| Esqueleto (api + web) | Generado por la factory; sin funcionalidad de negocio todavía |
| Health (`/health/live`, `/health/ready`) | Implementado con test e2e contra PostgreSQL real |
| Paginación (`src/infrastructure/pagination.ts`) | Implementada con tests; referencia en `GET /api/v1/audit/events` |
| Idempotency-Key (`src/modules/idempotency`) | Implementada con tests e2e; ninguna ruta de negocio la usa todavía |
| Auditoría (`src/modules/audit`) | Eventos de auth registrados; tabla solo de inserción |
| Apagado ordenado, readiness y timeouts de servidor | Implementados con tests |
| Roles de base de datos y migraciones separadas | Scripts y tests; el aprovisionamiento real es manual (`docs/operations/base-de-datos.md`) |
| Backup/restore | Scripts en `scripts/`; el simulacro de restauración en el entorno real está pendiente |
| Imagen Docker, compose de producción y CI | Incluidos; el despliegue real y los secretos están pendientes |
