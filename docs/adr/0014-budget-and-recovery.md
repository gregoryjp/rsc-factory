# ADR 0014 — Presupuesto de run, taxonomía de fallos del proveedor, cancelación y recuperación

- Estado: aceptado
- Fecha: 2026-10-24
- Hito: H5

## Contexto

La ADR 0003 fijó que el recurso escaso es la cuota de Claude Pro y que `total_cost_usd` (precio de lista) es solo un proxy. La matriz de compatibilidad confirma que `--max-budget-usd` del CLI se evalúa **después** de la llamada. Un error real de la cuota Pro es `API Error: You've hit your session limit · resets 7:30am (Europe/Madrid)` con HTTP 429 y tipo `rate_limit`, que no se distingue por código de estado de un 429/529 transitorio.

## Decisión 1 — Libro de presupuesto con reserva previa

- `runs.budget_usd` (por defecto `defaultRunBudgetUsd` de `factory/config/budget.json`, 15; los runs existentes reciben 15 por la migración 7) y la tabla `budget_entries` (`reservation` / `charge` / `release`, rol, id de intento, importe, `basis` = `reservation | reported | unknown_reservation`).
- Antes de **toda** llamada al proveedor (planificación, builder, revisores, refutador, approver) `guardedInvoke` reserva `maxCallUsd[rol]` con una única sentencia SQL atómica (`INSERT … WHERE restante >= importe`). Si no cabe, **no se llama**: la tarea se libera con su fase persistida y el run pasa a `BLOCKED` con causa `budget_exhausted`, estado previo y siguiente paso exacto.
- Tras la llamada: se carga `total_cost_usd` si se informó (`reported`); si no, se carga la **reserva completa** como `unknown_reservation` (nunca se asume 0); el resto se libera. El CLI recibe además `--max-budget-usd` = reserva como red secundaria.
- Los proveedores informan coste 0 solo cuando saben que no corrió nada (no se pudo lanzar, señal ya abortada); el proveedor falso (`createFakeProvider`) normaliza `null` a 0 porque no consume cuota.
- Reservas abiertas por un proceso muerto: `resume`, `plan` y `build` cargan como `unknown_reservation` las reservas con antigüedad ≥ 45 min (el TTL del lease) y registran `budget.reservation_expired`.
- `factory budget <runId> --add <usd>` sube el presupuesto y, si el run está `BLOCKED` por `budget_exhausted` o `quota_wait`, lo devuelve al estado previo registrado en el evento de bloqueo. No se añadió columna: la causa, el estado previo, `waitUntil` y el siguiente paso viajan en el payload de `run.state_changed`.

## Decisión 2 — Taxonomía de fallos del proveedor

| Clase | Detección | Efecto |
|---|---|---|
| `quota_exhausted` | mensaje de límite de sesión/uso/semanal (aunque venga con 429) | sin reintento; run `BLOCKED` con causa `quota_wait` y `waitUntil` |
| `rate_limited_transient` | 429/529/overloaded sin mensaje de cuota | hasta 3 intentos, backoff exponencial con full jitter (base 2 s, tope 60 s) dentro de `guardedInvoke` |
| `timeout` | tiempo agotado | un reintento (cuenta como intento) |
| `aborted` | señal de cancelación | sin reintento |

El texto se extrae de `errors`, `terminal_reason`, `result` y `api_error_status` del sobre y de stderr. `waitUntil` se calcula con la primera ocurrencia posterior a «ahora» de `resets 7:30am (Europe/Madrid)` / `resets 7am` (zona IANA con `Intl`; sin zona, la local del proceso); si no se puede interpretar, `null`. Cada intento (también los reintentos) es una fila de `role_attempts` con `try_number` y `failure_class`.

`factory resume`, `plan` y `build` sobre un run bloqueado por cuota **antes** de `waitUntil` fallan con `quota_wait` (salvo `--force`); pasado el plazo desbloquean solos.

## Decisión 3 — Cancelación con trabajo activo

`buildRun` crea un `AbortController` y sondea el estado del run (500 ms, configurable). El bucle comprueba la cancelación antes de cada paso (también `guardedInvoke` antes de cada llamada y `runAndRecordChecks` antes y después de cada check). La señal llega al proveedor (mata el grupo de procesos) y a `runLogged` (mata el grupo; en Docker ejecuta además `docker kill` por nombre de contenedor). Al final, `runner.teardown` borra por etiqueta. Se emite `build.canceled` con commits y merges ya realizados. Un check interrumpido no se registra como evidencia.

## Decisión 4 — Recuperación de worktrees

Antes de cada fase `processTask` compara el worktree con la cabeza persistida (`headCommit ?? baseCommit`); si hay cambios sin commit o un commit no registrado, ejecuta `git reset --hard <sha>` + `git clean -fd` (argv, sin shell) y registra `worktree_restored`. Así una llamada interrumpida no deja ediciones a medias ni commits duplicados.

## Consecuencias

- El presupuesto es conservador: sin coste informado se consume la reserva entera; `--add` es la válvula del operador.
- Límites: el coste real puede superar la reserva si el CLI lo informa tarde (se carga lo informado, el restante puede quedar negativo); la captura de evidencia de navegador (preview Docker) no es interrumpible a mitad; el sondeo de cancelación tiene latencia ≤ `cancelPollMs`.
