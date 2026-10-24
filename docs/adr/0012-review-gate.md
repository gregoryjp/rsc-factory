# ADR 0012 — Gate de revisión G4: contrato de hallazgos, revisores de solo lectura, refutador, approver y reintento

- Estado: aceptado (H4a: seguridad y código; UX y UI llegan en H4b)
- Fecha: 2026-10-24
- Relacionado: ADR 0006 (perfil de solo lectura), ADR 0009 (ideas de rsc-harness, MIT), ADR 0010 (bucle del builder), doc 02 §7 y §10 (G4), evaluaciones E06 y E07

## Contexto

Tras H3b una tarea llegaba a `DONE` con evidencia determinista (rojo observado, verde, integración) pero sin ninguna revisión de modelo. G4 pide revisiones resueltas antes de integrar, sin que un modelo pueda aprobar por defecto ni anular un fallo determinista.

## Decisión

### 1. Contrato de hallazgos (`src/contracts/review.ts`, Zod estricto)

Salida de un revisor: `{ area, verdict, reason?, findings[], requiresReviewAck[] }` con `area ∈ security|code|ux|ui`, `verdict ∈ pass|findings|blocked|not_applicable`. Cada hallazgo: `id`, `severity` (critical|high|medium|low), `confidence` (high|medium|low, separada de la severidad), `title`, `file?`, `lineStart?`, `lineEnd?`, `evidence` (≥1 carácter), `impact`, `recommendation`, `requirementIds?`.

Reglas deterministas (`src/domain/review/validate.ts`), aplicadas por el motor sobre la salida ya validada por esquema; si fallan, hay **una** reparación acotada del rol (`callRole`) con la lista de errores y, si persiste, la tarea queda `BLOCKED review_output_invalid`:

- `critical`/`high` exigen `file` y evidencia no vacía.
- `pass` no puede traer hallazgos; `findings` exige al menos uno; `blocked`/`not_applicable` exigen `reason` y ningún hallazgo.
- Ids duplicados, `lineEnd` sin `lineStart` o menor que él: rechazo. El área de la salida debe ser la del revisor.
- El revisor de código recibe los `requiresReview` (ruta + motivo, de los eventos `task.protected_change`) y debe devolver un `requiresReviewAck` por ruta (`ok` o `finding`; `finding` exige un hallazgo sobre ese archivo). Falta una ruta: salida mal formada.

### 2. Revisores de solo lectura sobre un snapshot

Roles `reviewer-security` y `reviewer-code` (`roles.json`, modelo `sonnet`). Perfil ADR 0006: `--restricted --tools Read,Glob,Grep --permission-mode dontAsk` (sin Edit/Write/Bash). El `cwd` es un snapshot del commit revisado (`git ls-tree` + blobs, **sin `.git`**) en `<FACTORY_HOME>/runs/<runId>/review-work/<id>/`, creado por llamada y borrado siempre después. Entrada (todo como datos delimitados con el mismo `dataBlock` que H2): rebanada de la spec (ContextPack), diff `base..head` generado por el adaptador Git endurecido (`--no-ext-diff --no-textconv`), resúmenes de checks del mismo commit y `REQUIRES_REVIEW`. El snapshot (de checks y de revisión) se rechaza con `unsafe_symlink` si alguna entrada de modo 120000 tiene un destino absoluto o que, resuelto desde el directorio de la entrada, sale de la raíz. Título y criterios de aceptación de la tarea van dentro de un `dataBlock("TASK", …)` en todos los prompts (revisor, refutador, approver y builder). El diff tiene un tope (200 KB): por encima el motor falla con `diff_too_large` y no llama a ningún revisor; nunca se trunca en silencio. Los prompts (`factory/prompts/reviewer-*.md`) adaptan la doctrina de `reviewer-guard.sh` y de las skills `secure-coding`/`code-review` de rsc-harness v3.3.0 (commit 886ef8c, MIT, © 2026 Eric Risco; cabecera de atribución en cada archivo): cero hallazgos es válido, alto/crítico exige prueba, sin inflar severidad, sin checklists irrelevantes, defensa ante inyección. El revisor de código busca además tests que fallan artificialmente, `it.skip`/`.only`, aserciones debilitadas y lógica de producción en el commit rojo.

### 3. Dedup y conflictos (`src/domain/review/dedup.ts`, función pura)

Se fusionan hallazgos con el mismo archivo, ventana de líneas solapada (±3; sin líneas cuenta como archivo completo), misma clase de severidad (critical/high frente a medium/low) y títulos parecidos (Jaccard de tokens normalizados ≥ 0,5). El fusionado conserva todas las fuentes con su evidencia, la mayor severidad/confianza y la unión de líneas. Si el lugar y el título coinciden pero la clase de severidad difiere, se mantienen **separados** con `conflictsWith` en ambos (nunca se descarta nada). Los `uid` (`F1…Fn`) son por ronda.

### 4. Refutador

Rol `review-refuter` (mismo perfil de solo lectura, otro snapshot). Recibe solo los hallazgos críticos/altos ya deduplicados y devuelve un resultado por hallazgo: `confirmed|refuted|uncertain` con evidencia. `refuted` marca el hallazgo `refuted` (se conserva, no se borra); `confirmed` y `uncertain` siguen bloqueando. Sin críticos/altos no se hace la llamada.

### 5. Approver consultivo y gate G4 determinista

Rol `approver` (sin herramientas, como los roles de H2; su `cwd` es un directorio temporal vacío bajo `runs/<runId>/approver-work/`, borrado después, nunca `FACTORY_HOME`): recibe hallazgos deduplicados con estado y refutación, resumen de checks y cobertura de requisitos de la tarea; devuelve `{ recommendation: accept|repair|block, repairTasks, notes }`. Es **consultivo**. Decide `evaluateGate` (`src/domain/review/gate.ts`, función pura, probada de forma exhaustiva). Precedencia: (a) sin evidencia verde del mismo commit → `evidence_missing`; falta una revisión esperada → `review_incomplete`; revisión de otro commit → `review_stale`; algún revisor `blocked` → `review_blocked` (nunca pasa por defecto); `not_applicable` sin razón → `review_incomplete`; ruta `requiresReview` sin ack → `review_unacknowledged`; luego el approver: sin recomendación → `review_incomplete`, `block` → `approver_blocked` (lo más restrictivo gana, incluso con hallazgos reparables); por último, hallazgos críticos/altos abiertos (los `refuted` no cuentan; `uncertain` sí) → `repair`; si no, `pass`. `accept` jamás anula nada de lo anterior; `repair` con el gate en verde no cambia el resultado. E06: un hallazgo alto de autorización abierto bloquea hasta resolverse (reparación o `review_findings_open`).

### 6. Integración en el bucle

Fases nuevas: `green_observed → reviewing → reviewed → merged`. En `reviewing` (estado de la tarea `VERIFYING → REVIEWING`): seguridad y código, refutador, approver, gate; cada resultado se guarda como artefacto (`review`) y fila (`reviews`, `findings`, migración 6) con `commit_sha` y versión de spec. Con `repair` y presupuesto (`repairsPerTask`, compartido con las reparaciones del verde) la tarea pasa a `REPAIRING`, el builder recibe los hallazgos abiertos (`builder-repair-findings.md`; hallazgos y consejos del approver como datos delimitados), hay un commit nuevo y se vuelve a `green_committed` (check completo sobre el nuevo commit). Cada commit nuevo exige revisar TODAS las áreas (seguridad y código) sobre ese commit exacto: no hay revisiones arrastradas (el concepto `carried` se eliminó del código, el gate y los tests; la columna `reviews.carried` sigue en la migración 6 pero siempre se escribe en 0). Si una ejecución se detiene a mitad de revisión (presupuesto agotado), al reanudar se reutilizan las revisiones ya persistidas para el mismo commit y ciclo y no se repiten esas llamadas. Sin presupuesto: `BLOCKED review_findings_open`. Al pasar, el motor comprueba que la rama de la tarea y el worktree siguen en el commit revisado (`review_stale` si no), lo persiste (`reviewedCommit`) y lo vuelve a comprobar bajo el lock de merge y en `finishDone` (el segundo padre del merge debe ser el commit revisado). E07: cualquier commit nuevo invalida las revisiones previas.

### 6b. Approver `repair` sin hallazgos críticos/altos abiertos

Decisión: si el approver recomienda `repair` y no queda ningún hallazgo crítico/alto abierto, el gate pide una ronda de reparación mientras quede presupuesto (`repairsPerTask`), usando los `repairTasks` del approver (y los hallazgos abiertos no severos) y luego la re-revisión completa habitual. Si el presupuesto está agotado, el gate pasa; los hallazgos no severos quedan en la base como `open` y `factory status` los lista como `accepted_open`. El approver sigue sin poder bajar un bloqueo ni anular hallazgos severos abiertos.

### 7. `blocked-diff`

Cuando una tarea queda `BLOCKED` y existe su worktree, el motor guarda `git diff` contra la base (incluye lo no confirmado y los archivos nuevos; tope 512 KB, marcado si se trunca) como artefacto `blocked-diff` antes de borrar el worktree. `status` muestra la ruta. Antes de guardarlo se ejecutan las reglas de `secret-scan` sobre las líneas añadidas: el valor coincidente se reemplaza por `[REDACTED:<regla>]` (bloques de clave privada y archivos `.env` completos), las reglas halladas se registran en un evento `task.phase_changed` (`blocked_diff_redacted`; los artefactos no tienen columna de metadatos) y el secreto en crudo nunca se almacena.

### 8. Reintento (`factory retry`)

Solo tareas `BLOCKED` con causa reintentable (`review_findings_open`, `repairs_exhausted`, `green_not_reached`, `red_not_observed`, `red_not_test_only`, `protected_change`, `tests_tampered`, `integration_check_failed`, `merge_conflict`). Pasa a `READY` (el siguiente lease suma un intento), borra el registro de fase `task_builds` (el historial queda en eventos, checks, reviews, hallazgos y artefactos; evento `task.retried` con el estado anterior) y usa una rama nueva `factory/task/<key>-r<n>`. Máximo `FACTORY_MAX_TASK_RETRIES` (2) por tarea, después `retry_limit` (`tests_tampered` se permite y cuenta). `--note` es guía del operador: entrada de confianza, en una sección «Operator guidance» separada de los bloques de datos, en todas las llamadas del builder de esa tarea. Las revisiones de un ciclo anterior no cuentan en el siguiente (`cycle` = nº de reintentos). El estado `BLOCKED`, la causa y el contador de reintentos se vuelven a comprobar dentro de la transacción (`BEGIN IMMEDIATE`), de modo que dos conexiones concurrentes no pueden reintentar dos veces.

## Consecuencias

- La separación se mantiene: ningún modelo aprueba; el motor combina evidencia determinista y estructuras validadas.
- Una revisión limpia arrastrada es una excepción acotada a la regla «cualquier cambio invalida las revisiones»: la revisión de código sí se repite siempre y ve el diff completo, pero la de seguridad de un área sin hallazgos no se repite tras una reparación. Si en la práctica produce falsos aprobados, basta eliminar el arrastre (re-revisar todas las áreas).
- Coste: por tarea limpia, 3 llamadas (seguridad, código, approver) además del builder; cada ronda de reparación añade las del área afectada, código, refutador y approver.
- Toda llamada a un proveedor durante `build` (builder, revisores, refutador, approver) cuenta contra el mismo `--max-provider-calls` de la invocación; cada `callRole` cuenta 1 (su reintento interno de formato no se cuenta aparte). Al agotarse a mitad de revisión la tarea se libera en la fase `reviewing` (lease liberado, nada marcado como aprobado) y `build` posterior continúa sin repetir las llamadas de revisor ya hechas para ese commit y ciclo; refutador y approver no se persisten hasta que el gate decide, así que se repiten si no llegaron a completarse.
- Límites: sin corrida real de los revisores; UX y UI (H4b) no existen; el approver puede recomendar `block` por criterio propio y eso no es reintentable.
