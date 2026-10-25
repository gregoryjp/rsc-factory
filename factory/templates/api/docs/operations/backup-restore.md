# Backup y restauración

Scripts POSIX en `scripts/` (en la raíz del producto). Necesitan `pg_dump` y `pg_restore` de PostgreSQL 16 en el `PATH` del host que los ejecuta; el contenedor del API no los incluye a propósito.

## Backup

```bash
BACKUP_DATABASE_URL=postgresql://app_migrator:...@host:5432/db \
BACKUP_DIR=/var/backups/producto BACKUP_KEEP_DAYS=30 \
sh scripts/db-backup.sh
```

- Usa `BACKUP_DATABASE_URL` y, si no existe, `MIGRATION_DATABASE_URL` (el rol migrador es dueño de las tablas, así que lee todo; `app_runtime` no puede leer `_prisma_migrations`).
- Escribe `backup-<UTC>.dump` (formato custom, sin owners ni privilegios) con permisos `600`, primero como `.partial`. Solo si `pg_restore --list` lee el archivo se renombra; si algo falla no queda ningún archivo parcial.
- `BACKUP_KEEP_DAYS` borra los `backup-*.dump` más antiguos de ese directorio.
- Imprime solo la ruta del archivo. La URL no se imprime, pero `pg_dump --dbname` la deja visible en la lista de procesos mientras corre: usar una URL sin contraseña y `PGPASSFILE`/`PGPASSWORD` en hosts compartidos.
- Códigos de salida: `2` configuración, `3` falta `pg_dump`/`pg_restore`, `4` falló `pg_dump`, `5` archivo ilegible.

## Restauración (y simulacro)

```bash
RESTORE_DATABASE_URL=postgresql://app_migrator:...@host:5432/db_restore \
sh scripts/db-restore.sh /var/backups/producto/backup-20260101T000000Z.dump --confirm
```

- Exige `--confirm`, un archivo existente y un `RESTORE_DATABASE_URL` explícito. Nunca usa `DATABASE_URL`.
- Restaura con `--single-transaction --exit-on-error`: si el destino no está vacío o hay un error, no se aplica nada. Para sustituir una base en producción, restaurar en una base nueva, comprobarla y cambiar la conexión; no se restaura encima.
- Después de restaurar: ejecutar `api/scripts/db/02-grants.sql` (los privilegios no viajan en el dump) y `npm run db:status -w api`.

## Simulacro recomendado

1. Hacer un backup.
2. Crear una base vacía `*_restore` y restaurar.
3. Comprobar conteos de `User` y `AuditEvent` y arrancar el API contra esa base (`/health/ready` debe responder 200).
4. Borrar la base de simulacro. Repetirlo tras cambios de esquema grandes y al menos una vez por trimestre.

## Qué prueban los tests

`api/test/ops-scripts.test.ts` ejecuta los scripts con `pg_dump`/`pg_restore` simulados: valida la sintaxis, los códigos de error, que el archivo sea privado y sin parciales, la poda por antigüedad, que no se filtre la URL y los flags de restauración. La ida y vuelta real con PostgreSQL se verificó a mano contra un contenedor `postgres:16-alpine`; el entorno de checks no instala el cliente de PostgreSQL, por eso no se automatiza ahí.
