# ADR 0004 — Layout del motor: un paquete único con `src/` modular

- Estado: aceptado
- Fecha: 2026-10-24
- Contexto del hito: H1 (núcleo y persistencia)

## Contexto

El documento 02 §3 propone un árbol `apps/` + `packages/` (domain, application, contracts, adapters-*). Para H1 hay un único consumidor (la CLI) y un solo coordinador local. Separar en paquetes exige workspaces, referencias entre `tsconfig`, scripts por paquete y publicación interna: ceremonia sin comportamiento nuevo.

## Decisión

Un único paquete npm en la raíz (ESM, Node >= 22, `.nvmrc` = 22), sin workspaces. La separación por capas se mantiene dentro de `src/` con la misma dirección de dependencias:

```text
src/contracts/         esquemas Zod y tipos inferidos (estados, entidades, eventos, AgentResult)
src/domain/            funciones puras: máquinas de estados como diccionarios Record<Estado, Estados[]>
src/shared/result.ts   Result<T, E>; el dominio y los casos de uso devuelven Result
src/modules/<slice>/   casos de uso + puertos (runs, tasks, doctor)
src/infrastructure/    adaptadores: SQLite (better-sqlite3), reloj, ids, proveedores, sistema de archivos
src/config/env.ts      única lectura de process.env
src/cli/               commander; único lugar que convierte errores en códigos de salida
```

Regla de dependencias: `domain` y `contracts` no importan nada de `modules` ni `infrastructure`; `modules` depende de puertos (`Storage`, `PrdFiles`, `Clock`), no de SQLite.

Se divide en paquetes solo cuando exista un segundo consumidor real (por ejemplo, un dashboard que reutilice los casos de uso).

## Decisiones técnicas asociadas

- **TypeScript 7.0.2**: `tsc --noEmit`, `tsc -p tsconfig.build.json`, vitest 5.0.5 y tsx 4.23.15 funcionan con esta configuración (NodeNext, `strict`, `noUncheckedIndexedAccess`). No hizo falta el respaldo 5.9.3.
- **Biome 2.5.14** (no `latest` 2.6.x): se fija la línea 2.5 acordada para el repositorio; `package.json` y `tsconfig*.json` quedan fuera del formateo.
- **Transacciones**: `Storage.transaction(work)` abre `BEGIN IMMEDIATE`, confirma si el `Result` es `ok` y hace `ROLLBACK` si es error. Así un caso de uso aborta de forma atómica sin lanzar excepciones.
- **Tiempos**: milisegundos epoch enteros en toda la persistencia, para comparar leases en SQL.
- **Leases**: `claim` es un único `UPDATE` condicional (estado `READY` o lease vencido, versión esperada, dependencias `DONE`, run no terminal ni `BLOCKED`). Un lease está vencido cuando `lease_expires_at <= now`.
- **Eventos**: tabla append-only (triggers que abortan `UPDATE`/`DELETE`), `seq` monótono por run con `UNIQUE (run_id, seq)`.
- **Dependencias de semillas**: `seedTasks` exige que `dependsOn` apunte a claves declaradas antes en la lista, lo que impide ciclos por construcción. La detección general de ciclos del DAG llega con la planificación (H2).

## Consecuencias

- Menos archivos de configuración y arranque más simple.
- El coste de dividir más adelante es mecánico (mover carpetas y ajustar imports) porque las dependencias ya respetan las capas.
