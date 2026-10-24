# ADR 0015 — Informe por run, entrega local, orquestación `run`, auditoría y release

- Estado: aceptado
- Fecha: 2026-10-24
- Hito: H6 (preparación)

## Contexto

H0–H5 construyen y revisan un producto en la rama `factory/integration`, pero el run termina en `READY_FOR_RELEASE` sin entrega declarada, sin informe trazable y sin forma de ejecutar el flujo completo con un comando. El documento 02 (§5) exige que `SUCCEEDED` dependa de un resultado de entrega declarado (`delivery=local` o `production`), §13 pide un informe por run y un release con smoke que impida etiquetar sano, y el plan H6 pide modo auditoría sin mutación (E17) y smoke de release fallido (E20).

## Decisión 1 — Informe `factory report`

- Se construye **solo** desde la base de datos y los artefactos de `FACTORY_HOME` (`src/modules/delivery/build-report.ts`); es una función pura del estado, con orden estable (requisitos por id, tareas por clave, checks por orden de registro, áreas de revisión en orden fijo). Misma entrada, mismos bytes: se prueba con un golden (`test/golden/run-report.md`, con los hashes normalizados).
- Cada requisito se etiqueta `entregado`, `no entregado` o `sin evidencia`. `entregado` exige que todas las tareas que lo cubren estén `DONE` **y** que exista un check superado sobre su commit de integración. Una tarea bloqueada da `no entregado`; un requisito sin tareas, o con tareas `DONE` sin check válido, da `sin evidencia`. Nunca se infiere «hecho».
- Etiquetado obligatorio: proveedor `fake` o `real` (y por fase, desde los eventos `role.called`), aislamiento del runner (`isolated` por check: aislado, host, mixto, sin checks) y evidencia omitida (evidencia de navegador `no disponible`, `sin evidencia` o `no revisada`; coste desconocido cargado por reserva; tareas bloqueadas; check final ausente). Todo se repite en «Limitaciones».
- Evidencia de navegador: el informe lee `ui-evidence.json` (validado con el esquema de ADR 0013) para listar capturas y roles autenticados; si el archivo falta, mantiene los conteos del evento y deja la lista vacía.
- Salidas: Markdown en español y JSON (`schemaVersion: 1`). Dentro del producto se escribe la variante **previa a la entrega** (`preDelivery`): sin checks ni eventos de entrega, estado de entrega `in_progress`, para que no contenga hechos que todavía no existen ni dependa de su propio commit. `factory report` muestra la variante viva (con los checks `delivery-*`).

## Decisión 2 — `factory deliver`

Requisitos: run `READY_FOR_RELEASE`; entrega `local` (si no estaba declarada se declara `local` con el evento `delivery.declared`; `production` se rechaza con `delivery_production_unsupported`) y un check final superado **sobre la cabeza exacta** de `factory/integration` (`assertDoneEvidence`, mismo argv que el check completo de la política).

Pasos, todos bajo el lock de merge del run:

1. Escribir `docs/verification/factory-report.{md,json}` y `docs/operations/release.md` (runbook) en el producto y commit `docs(verification): factory report for <runId>` por `commitGuarded` (secret scan incluido). El motor escribe en el checkout de `factory/integration` y no en un worktree: git no permite una segunda copia de trabajo de la misma rama, un worktree sobre una rama temporal añadiría un merge sin aportar aislamiento (el contenido lo genera el motor, no un agente), y el repositorio se comprueba limpio antes y después.
2. Check completo sobre el commit del informe (`delivery-report`). Si falla: `factory/integration` vuelve a su cabeza anterior (`resetBranch`) y el run sigue en `READY_FOR_RELEASE` con el evento `delivery.failed` (`delivery_report_check_failed`).
3. Checkout de `main` y `merge --no-ff` de `factory/integration`.
4. Check completo sobre el commit de merge de `main` (`delivery-main`). Si falla: `main` vuelve a su cabeza anterior y el run **no** pasa a `SUCCEEDED` (`delivery_main_check_failed`).
5. Solo entonces: evento `delivery.completed` (con `mainCommit`, `reportCommit` y el id del check) y run → `SUCCEEDED`.

Reanudable e idempotente: cada paso comprueba su evidencia (`passedOn`) y el estado de git (cabeza de integración igual al commit del informe registrado; `main` con ese commit entre sus padres) antes de repetirlo, de modo que tras un fallo o una caída `factory deliver` continúa sin duplicar el commit del informe. Un run ya entregado devuelve un resumen sin cambiar nada. Al terminar, con éxito o error, el checkout vuelve a `main`.

No se hace push ni PR: si el producto tiene remotos, se imprimen los comandos que el humano podría ejecutar. `gh` no se invoca.

## Decisión 3 — `factory run`

`runAll` encadena `start` (con la deduplicación existente por proyecto + hash de PRD), `plan`, `build` y `deliver` leyendo el estado persistido del run en cada vuelta; no guarda estado propio. Volver a ejecutar el mismo comando continúa donde quedó. Un run `SUCCEEDED` con el mismo PRD y destino devuelve «ya entregado» sin crear otro (`findLatestByInput`). Se detiene limpiamente (sin reintentos en bucle) con el comando exacto siguiente:

| Resultado | Código | Siguiente comando |
|---|---|---|
| `delivered` | 0 | — |
| `paused_budget`, `paused_quota`, `paused_limit` | 3 | `factory budget <runId> --add <usd>`, el mismo `factory run …` tras `waitUntil`, o el mismo `factory run …` |
| `blocked`, `failed`, `canceled` | 1 | `factory status <runId>` (y `retry`), `factory deliver <runId>` |

## Decisión 4 — Modo auditoría (E17)

`factory audit --target <repo>` no escribe nunca en el objetivo.

- Antes y después captura HEAD, `git status --porcelain=v2 --untracked-files=all` y el sha256 de cada archivo rastreado o sin rastrear no ignorado (los enlaces simbólicos se huellan por su destino). Cualquier diferencia → resultado `target_mutated` con el diff y exit 1.
- Camino de git de solo lectura: `createReadOnlyGit` expone solo `headSha`, `snapshot`, `statusPorcelainV2`, `listFiles` y `commitExists`, con la misma configuración endurecida (`SAFE_CONFIG`, sin hooks, sin fsmonitor), `GIT_OPTIONAL_LOCKS=0` (que `git status` no refresque el índice; hay test con el índice) y **sin exigir sello**: el sello vive en `FACTORY_HOME` y declara confiable la configuración del repositorio, algo que una auditoría de un repositorio ajeno no debe hacer ni requerir. Límite: un repositorio cuyo `.git` es un archivo (worktree enlazado) se rechaza.
- Los checks corren sobre un snapshot de HEAD en `FACTORY_HOME/audits/<id>/snapshot` con el runner elegido (Docker por defecto): política de la plantilla si `template.json` declara un id conocido; si no, `npm ci` + `npm test` cuando hay `package.json`; si no, se omiten con la razón.
- `--review` ejecuta los revisores de seguridad y de código con el perfil de solo lectura (`Read,Glob,Grep`) sobre snapshots; cuentan contra el presupuesto de un **pseudo-run** de auditoría (fila de `runs` con id `aud_…`, necesaria por las claves foráneas del libro de presupuesto y de `role_attempts`), que se cierra como `CANCELED` con razón `audit_pseudo_run_closed`. Sus hallazgos no pasan por el refutador.
- Salida en `FACTORY_HOME/audits/<id>/report.{json,md}`.

## Decisión 5 — Release (E20)

- Política `factory/policies/release.json` (`enabled: false` por defecto; si falta, se asume desactivado).
- `factory release prepare <runId>` guarda en `FACTORY_HOME` el plan (`release-plan` v1: commit, comandos de instalación/check/build/migración de la política de la plantilla, ruta de salud, pasos de rollback) y el texto del runbook; `deliver` commitea el runbook `docs/operations/release.md` en el producto (artefacto desde el commit exacto, migraciones con copia y restauración, smoke, rollback con la advertencia expand/contract).
- Máquina de release con un `DeploymentPort` (`deploy`, `smoke`, `rollback`): `deployRelease` exige `release.enabled`, entrega `production`, run `READY_FOR_RELEASE` y check final válido; `RELEASING`, `deploy`, `smoke`. Smoke sano → `release.healthy` y `SUCCEEDED`. Smoke fallido → `release.smoke_failed`, `rollback` del puerto, `release.rollback_recorded` con los pasos del runbook y run `BLOCKED` (`release_smoke_failed`); nunca `SUCCEEDED` ni «sano».
- El adaptador real de despliegue queda **fuera de alcance**: solo existe un adaptador falso de pruebas (`test/helpers/fake-deployment.ts`) y no hay comando CLI de despliegue.

## Consecuencias y límites

- Todo lo anterior se probó con el proveedor guionizado y, para la entrega, también en Docker real (esqueleto fullstack); no hay corrida con el `claude` real ni demo TurnoLocal todavía.
- El informe no puede incluir los checks de entrega en su copia versionada en el producto (todavía no existen); están en `factory report`.
- La auditoría analiza HEAD, no el árbol de trabajo sucio; garantiza que no lo modifica.
