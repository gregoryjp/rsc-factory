# ADR 0010 — Bucle del builder: rojo/verde observado, reparaciones, cambios protegidos e integración

- Estado: aceptado
- Fecha: 2026-10-24
- Relacionado: ADR 0006 (aislamiento del builder), ADR 0008 (checks sobre snapshots), doc 02 §5 y §10 (G3, G5)

## Contexto

H3a dejó los esqueletos, el adaptador Git y el runner de checks, pero ninguna tarea se ejecutaba. H3b cierra la rebanada vertical: una tarea pasa de `READY` a `DONE` solo con evidencia producida por el motor, nunca con una afirmación del agente.

## Decisión

### 1. Fases por tarea (persistidas)

Cada tarea tiene un registro `task_builds` (migración 5) con la fase, los commits y los contadores. Cada transición de fase se guarda antes de continuar, de modo que `resume` + `build` reanudan desde la fase persistida sin repetir llamadas al builder ya hechas.

| Fase | Qué hace el motor |
|---|---|
| `started` | Crea el worktree `<FACTORY_HOME>/runs/<runId>/worktrees/<taskKey>` en la rama `factory/task/<taskKey>` desde la cabeza de `factory/integration` (registra `baseCommit`); construye el ContextPack; llamada 1 del builder (rojo); verifica rutas, commit `test(<key>): add failing tests` |
| `red_committed` | Ejecuta `[install, test]` sobre el snapshot del commit. Rojo exige que el comando de test **haya corrido y salido con código ≠ 0** |
| `red_observed` | Llamada 2 del builder (verde): implementar sin tocar los tests; commit `feat(<key>): <título>` |
| `green_committed` | Ejecuta `[install, check]` completo. Si falla, reparación (llamada del builder con la cola del log, commit `fix(<key>): repair attempt n`) hasta `repairsPerTask` |
| `green_observed` | Integración (G5), ver §4 |
| `merged` | Merge hecho, check de integración pendiente (reanudable) |
| `done` / `blocked` | Terminales |

El builder solo edita archivos (perfil ADR 0006: `--restricted`, `Read,Edit,Write,Glob,Grep`, `acceptEdits`, cwd = worktree); no ejecuta git ni comandos. Todo commit lo hace el motor con `commitGuarded` (escaneo de secretos).

### 2. Rojo y verde son evidencia del motor

- **Rojo** (`task.red_observed`): el comando `test` de la política de checks salió con código ≠ 0 sobre el commit rojo. Si sale con 0, `red_not_observed`: una llamada de reparación con ese feedback y, si persiste, la tarea queda `BLOCKED`. Si el `install` falla, `red_check_incomplete` (no cuenta como rojo). Los archivos de test del commit rojo son los de la diferencia `base..rojo` cuya ruta parece un test (`.test.`, `.spec.`, `__tests__/`, `test/`); sin ninguno, `red_no_tests`.
- **Verde** (`task.green_observed`): el comando `check` completo salió con 0 sobre el commit verde.
- Los comandos salen de `factory/policies/checks.json` por plantilla (`install`, `test`, `check`, solo `argv`). Un `templateId` sin política falla con `check_policy_missing`.
- Ningún check se reutiliza para otro commit: cada ejecución archiva el `HEAD` actual (`commit_sha`), y tras cualquier cambio de código el motor vuelve a ejecutar.

### 3. Reparaciones acotadas

`repairsPerTask` (`FACTORY_REPAIRS_PER_TASK`, por defecto 2, máximo 5) acota las reparaciones del verde. Con 2, una tarea que nunca llega a verde consume exactamente 1 llamada de rojo, 1 de verde y 2 de reparación, y queda `BLOCKED` con `green_not_reached` y el id del último check. El rojo admite una única reparación. `--max-provider-calls` (por defecto 40) acota las llamadas por invocación de `build`; al alcanzarlo, la tarea vuelve a `READY` con su fase persistida (no se pierde nada).

### 4. Cambios protegidos

Antes de cada commit del builder el motor lee `git status` del worktree:

| Hallazgo | Efecto |
|---|---|
| Ruta no segura (`isSafeExpectedPath`: absoluta, `..`, bajo `.git`) | `BLOCKED unsafe_path` |
| Un archivo de test del commit rojo modificado, borrado o renombrado en verde/reparación | `BLOCKED tests_tampered` |
| `scripts/check-*.mjs` o `scripts` de cualquier `package.json` (JSON parseado y comparado, cualquier workspace) | `BLOCKED protected_change` + evento `task.protected_change` (`severity: blocked`) |
| `tsconfig*.json`, `biome.json`, `vitest.config.*`, `.github/**`, `factory/**`, test de commits anteriores borrado | evento `task.protected_change` (`severity: review`) y `requires_review` persistido; **no** bloquea en H3b. Los revisores de H4 lo consumirán |
| Secreto detectado | `BLOCKED secret_detected` |

Motivo de bloquear los dos primeros grupos: pueden fabricar un verde falso. El resto queda a revisión humana/H4.

### 5. Integración (G5) y regla de DONE

Bajo el lock de merge del run (`withMergeLock`, mantenido durante el merge **y** el check): merge `--no-ff` de `factory/task/<key>` en `factory/integration` (rama activa del repo del producto), y check completo sobre el snapshot de la **nueva** cabeza de integración.

- Pasa → una tarea es `DONE` solo si `assertDoneEvidence` lo confirma leyendo el check de la base de datos: `commit_sha` igual al commit de integración, código 0, `task_id` de la tarea y `argv` igual al comando `check` de la política (`isCheckEvidenceValid` se aplica aquí). Evento `task.integrated`.
- Falla → `resetBranch` de `factory/integration` al commit previo (exclusivo, bajo el lock) y `BLOCKED integration_check_failed`.
- Conflicto de merge → el adaptador aborta el merge; si la cabeza cambió se reinicia al commit previo; `BLOCKED merge_conflict` (detección E14; la resolución es posterior).
- Un check del worktree de la tarea (verde) no vale como evidencia de la cabeza de integración: el commit de merge es otro.

Cuando todas las tareas están `DONE` el run pasa por `VERIFYING → REVIEWING → INTEGRATING` (etapas que H4 hará reales; se atraviesan con el motivo registrado en el evento), se ejecuta el check final sobre la cabeza de integración y el run queda `READY_FOR_RELEASE` (entrega local). Con tareas `BLOCKED` el run sigue en `BUILDING`, `status` las lista con su causa y `build` sale con 1.

## Riesgos aceptados

- El rojo exige código ≠ 0, no «por el motivo esperado»: un test que falla por un error de sintaxis cuenta como rojo. Mitigación parcial: el verde exige que esos mismos tests pasen y no se pueden tocar.
- El tiempo agotado de un check se registra como código ≠ 0 en la tabla `checks` pero no se distingue en la fase de rojo.
- El builder real nunca se ejecutó en H3b (ver `IMPLEMENTATION_STATUS.md`); el perfil y las reparaciones se probaron con el proveedor guionizado.
- Un solo coordinador por base de datos: el lock protege el merge entre procesos, pero dos `build` simultáneos del mismo run no están soportados.

## Consecuencias

- La CLI cambia el repositorio del producto a la rama `factory/integration` mientras dura el run.
- `strict` de `RolesConfigSchema` exige `builder` en `factory/config/roles.json`.
- Cada tarea cuesta como mínimo dos llamadas del builder y tres secuencias de checks (rojo, verde, integración) más el check final del run.
