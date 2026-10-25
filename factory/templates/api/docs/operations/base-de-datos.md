# Base de datos: roles de mínimo privilegio y migraciones

El API usa dos roles distintos. Nunca el superusuario `postgres` ni el mismo rol para migrar y para servir tráfico.

| Rol | Variable | Qué puede hacer |
|---|---|---|
| `app_runtime` | `DATABASE_URL` | Solo DML (`SELECT/INSERT/UPDATE/DELETE`) sobre las tablas de la aplicación. Sin DDL, sin `TRUNCATE`, sin leer `_prisma_migrations`. En `AuditEvent` solo `INSERT` y `SELECT`. |
| `app_migrator` | `MIGRATION_DATABASE_URL` | Dueño del esquema `public`: crea y altera tablas. Solo lo usan las migraciones y los backups. No tiene superusuario, ni `CREATEDB`, ni `CREATEROLE`. |

En producción `parseEnv` rechaza `DATABASE_URL` con el usuario `postgres` y rechaza que `MIGRATION_DATABASE_URL` sea igual a `DATABASE_URL`. `npm run db:deploy` (`api/scripts/migrate.mjs`) usa `MIGRATION_DATABASE_URL` si existe y, si no, `DATABASE_URL` (desarrollo local).

## Aprovisionamiento (una vez, como administrador)

1. Crear la base de datos vacía.
2. Ejecutar `api/scripts/db/01-roles.sql` como administrador: crea los roles sin contraseña, revoca `PUBLIC` sobre la base y el esquema, deja `app_migrator` como dueño de `public` y da `USAGE` a `app_runtime`.
3. Fijar las contraseñas (fuera del repositorio, desde un gestor de secretos): `ALTER ROLE app_migrator PASSWORD '...'; ALTER ROLE app_runtime PASSWORD '...';`
4. Migrar con el rol migrador: `MIGRATION_DATABASE_URL=... npm run db:deploy -w api`.
5. Ejecutar `api/scripts/db/02-grants.sql` (como `app_migrator` o administrador). Es idempotente: concede DML a `app_runtime`, fija los privilegios por defecto para tablas futuras y revoca lo que no corresponde (`UPDATE/DELETE/TRUNCATE` sobre `AuditEvent` y todo sobre `_prisma_migrations`).

Repetir el paso 5 después de cada migración que cree tablas. Si se olvida, `AuditEvent` sigue protegida por el trigger que rechaza `UPDATE` y `DELETE`, pero `app_runtime` tendría más privilegios de los debidos.

```bash
psql "$ADMIN_DATABASE_URL" -f api/scripts/db/01-roles.sql
MIGRATION_DATABASE_URL=... npm run db:deploy -w api
psql "$MIGRATOR_DATABASE_URL" -f api/scripts/db/02-grants.sql
```

Los scripts SQL separan cada sentencia con una línea en blanco (sin líneas en blanco dentro de una sentencia) para poder ejecutarlos también sentencia a sentencia desde los tests.

## Qué verifican los tests

`api/test/roles.test.ts` ejecuta ambos scripts en la base de test y, con `SET ROLE app_runtime`, comprueba que DML funciona y que `CREATE/DROP/ALTER/TRUNCATE`, crear roles o esquemas, tocar el trigger de auditoría, modificar `AuditEvent` y leer `_prisma_migrations` fallan con `permission denied`.

## Retención de la auditoría

`AuditEvent` es solo de inserción (trigger `AuditEvent_append_only`). Para aplicar una política de retención hace falta una migración explícita que, con el rol migrador, desactive el trigger, borre por fecha y lo vuelva a activar; queda registrada en el historial de migraciones. Decidir el plazo es una decisión legal del producto.
