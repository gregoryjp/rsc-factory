# Estado de implementación

Actualizado: 2026-10-24.

| Hito | Estado | Evidencia |
|---|---|---|
| H0 Descubrimiento y compatibilidad | **Hecho** | `docs/compatibility/matrix.md`, `docs/adr/0001-runtime.md`, spikes reales en `docs/compatibility/evidence/` |
| H1 Núcleo y persistencia | **Hecho** (motor y CLI; sin ejecución real de tareas) | `src/`, `test/`, `docs/adr/0004-engine-layout.md`, `docs/operations/cli.md` |
| H2 Intake, spec y planificación | **Hecho** (con proveedor falso; sin ejecución real contra Claude) | `src/modules/planning/`, `src/domain/planning/`, `factory/prompts/`, `docs/adr/0005-planning-pipeline.md`, `test/planning*.test.ts` |
| H3 Builder aislado y ejecución | **Hecho** (H3a + H3b; el bucle se probó con proveedor guionizado, sin builder real) | `factory/templates/`, `factory/policies/`, `src/modules/execution/`, `src/infrastructure/{git,runner}/`, `docs/adr/0007-product-templates.md`, `docs/adr/0010-builder-loop.md`, `test/build-loop.test.ts`, `test/docker/` |
| H4 Revisores, gates y reparaciones | **Hecho (H4a + H4b + H4c)**: captura autenticada por rol, red interna en runtime, proxy `/api`; revisores de seguridad, código, UX y UI, refutador, approver, gate G4 con cuatro áreas, evidencia de navegador real ejecutada por el motor, reparación por hallazgos, `blocked-diff` y `factory retry`; revisores de modelo solo con proveedor guionizado | `src/domain/review/`, `src/modules/execution/review-task.ts`, `src/infrastructure/runner/docker-preview*.ts`, `factory/preview/`, `docs/adr/0012-review-gate.md`, `docs/adr/0013-browser-evidence.md`, `test/review-*.test.ts`, `test/ui-*.test.ts`, `test/docker-preview*.test.ts`, `test/docker/preview.docker.test.ts` |
| H5 Presupuesto y recuperación | **Hecho**: libro de presupuesto con reserva previa por llamada, `factory budget --add`, taxonomía de fallos del proveedor (cuota vs 429/529), backoff con jitter, `BLOCKED` con `waitUntil`, cancelación con trabajo activo, restauración de worktrees y reservas huérfanas | `src/modules/budget/`, `src/domain/provider/quota.ts`, `src/infrastructure/storage/budget-repository.ts`, `src/modules/runs/{block-run,add-budget,cancellation}.ts`, `factory/config/budget.json`, `docs/adr/0014-budget-and-recovery.md`, `test/{budget-ledger,budget-calls,build-halts,cancel,recovery,provider-quota}.test.ts` |
| H6 Entrega y demo | **Hecho**: validación de punta a punta con el proveedor real superada con el PRD mini (TurnoLocal no ejecutado por coste de cuota) | `src/modules/delivery/`, `src/modules/audit/`, `docs/adr/0015-delivery-report-audit.md`, `test/{report,deliver,release,run-all,audit,cli-delivery}.test.ts`, `test/golden/run-report.md` |
| H7 Industrialización | Fuera del MVP | — |

## H0 — resultado

- Proveedor real: verificado. Una llamada con contexto mínimo devuelve `structured_output` válido (USD 0,0069 a precio de lista).
- Error y timeout detectables (exit 1 + `is_error`; exit 124).
- Decisiones: CLI de Claude Code como adaptador; better-sqlite3 como persistencia local (ADR 0001).
- Gasto del hito: USD 1,10 informados a precio de lista, la mayoría en el primer spike con contexto por defecto.

## H1 — resultado

Funciona (verificado con los comandos de abajo):

- Paquete único ESM (Node >= 22), contratos Zod, máquinas de estados de run y tarea como diccionarios, `Result` en dominio y casos de uso.
- SQLite (better-sqlite3, WAL) con migraciones ordenadas y `schema_migrations`; tablas projects, runs, tasks, task_dependencies, attempts y events (append-only, `seq` por run); `version` en runs y tasks.
- Leases con claim atómico (un solo `UPDATE` condicional), heartbeat y release. `resume` devuelve a `READY` las tareas con lease vencido en cualquier estado que sostiene lease (`LEASED`, `RUNNING`, `VERIFYING`, `REVIEWING`, `REPAIRING`) y no toca tareas `DONE`; no arranca procesos ni modifica el estado del run.
- CLI `doctor`, `start --prd`, `status`, `resume`, `cancel`; copia inmutable del PRD con sha256 y deduplicación por proyecto + hash.
- `ClaudeCliProvider` (argv sin shell, timeout con kill, clasificación de fallos) y `FakeProvider`; probados solo con un ejecutable falso, nunca con el `claude` real (excepto `claude --version` en `doctor`).

Evaluaciones cubiertas (solo la parte de motor/adaptador, no el sistema completo):

| Eval | Cobertura | Test |
|---|---|---|
| E08 reinicio | Persistencia y `resume` tras cerrar/reabrir la BD; la tarea `DONE` no se repite | `test/engine.test.ts` «persistence across restart» |
| E09 doble claim | Atomicidad SQL con dos conexiones SQLite en un mismo proceso de test (no procesos OS paralelos): gana una; lease vencido reclamable; dependencias no `DONE` | `test/engine.test.ts` «leases» |
| E16 duplicado | Mismo PRD → mismo run; `--new` → otro; copia idéntica y hash | `test/engine.test.ts` «start and dedup», `test/cli.test.ts` |
| E19 cancelación | Solo estado: run y tareas (con lease) a `CANCELED`; claim y `resume` rechazados. No hay kill de procesos de tarea todavía; solo el adaptador de proveedor mata su grupo de procesos al expirar el timeout | `test/engine.test.ts` «cancel» |
| E04 JSON malformado | Solo la parte del adaptador: stdout malformado o fuera de esquema → `invalid_output`; la reparación acotada llega en H2+ | `test/claude-provider.test.ts` |

Comandos ejecutados (resultado observado):

- `npm ci`: 0 vulnerabilidades, instalación limpia.
- `npm run typecheck`: sin errores (TypeScript 7.0.2).
- `npm run lint`: 49 archivos, sin avisos.
- `npm test`: 6 archivos, 87 tests pasan (tras la ronda de corrección).
- `npm run factory -- doctor`: todo OK salvo aviso por Playwright ausente; exit 0.
- `FACTORY_HOME=$(mktemp -d) npm run factory -- start --prd templates/PRD-DEMO.md` y `status <runId>`: run en `CREATED`, evento `run.created`, copia `prd.md` de solo lectura.

Ronda de corrección (verificador independiente):

- `READY -> LEASED` ya no existe en la tabla de transiciones: `LEASED` solo se alcanza con `claimTask`.
- `transitionTask` exige `owner` y `expectedVersion` para tareas que sostienen lease, y el `UPDATE` comprueba dueño, versión y lease vigente (`lease_lost` / `version_conflict`); un worker con lease vencido o reclamado ya no puede mover la tarea ni promover dependientes.
- Los estados que sostienen lease salen de una sola constante (`LEASE_HOLDING_STATES`) usada por claim, heartbeat, release, expiración y `resume`; cada estado tiene test.
- `seedTasks` rechaza dependencias duplicadas con `invalid_dependencies`; `Storage.transaction` convierte errores SQLite en `storage_error` (hace rollback) y relanza los errores de programador.
- `status` de un run `BLOCKED` muestra la causa registrada (o que no hay) y aclara que el desbloqueo llega en H2+; `transitionRun` acepta `reason`.
- Proveedor: `ProviderFailure.costUsd` (`null` si se desconoce); timeout mata el grupo de procesos (`detached` + `kill(-pid)`) y la promesa se resuelve sin esperar a `close`; `timeoutMs` validado (entero, 1..2^31-1); tamaño de salida en bytes; `retryable` se decide por campos estructurados y tokens completos (429/529/overloaded/rate limit).
- Intake de PRD: `realpath`, un único `open` + `fstat` + lectura del mismo fd (sin TOCTOU); los symlinks se siguen. `start` con `--delivery` distinto al del run activo falla con `delivery_mismatch`.
- Tests añadidos: contrato `AgentResult`, `Storage.transaction`, `seq` de eventos con dos conexiones, E16 por otra ruta y por symlink, coste nulo vs cero.

Límites de H1:

- Sin planificación ni ejecución real; las tareas solo se siembran desde tests (`seedTasks`, dependencias solo hacia claves anteriores). El ciclo de DAG general es de H2.
- Un solo coordinador por base de datos; no se probó concurrencia con procesos paralelos más allá de dos conexiones en un test.
- `cancel` no termina procesos activos (no existen todavía); solo cambia estado y leases.
- Un run `BLOCKED` no tiene salida en H1: `resume` no lo desbloquea.
- Un lease vencido solo se reclama o recupera si la tarea está en `LEASED` o `RUNNING`.
- `status` muestra el proyecto solo por id en el JSON del run; sin lista de runs.
- El coste del proveedor es `null` cuando el CLI no lo informa (no se asume 0).
- Eventos sin heartbeat: no se registran para evitar ruido.

## H2 — resultado

Funciona (verificado con los comandos de abajo y con proveedor falso):

- `factory start --prd <ruta> --target <dir>`: destino resuelto con `realpath`, rechazado si está dentro de, es igual a o contiene el repo de la factory o `FACTORY_HOME` (también por symlinks, incluso colgantes); admite directorio inexistente, vacío o repo git existente (se registra «descubrimiento en H3»); no vacío sin `.git` es `target_not_empty`. Dedup con otro destino falla con `target_mismatch`. H2 no crea ficheros en el destino.
- `factory plan <runId>`: `CREATED → INGESTING → SPECIFYING → PLANNING` con tareas sembradas. Cada fase persiste su artefacto (write-once, sha256, `<FACTORY_HOME>/runs/<runId>/spec/`) antes de transicionar; reejecutar salta las fases verificadas por hash y no llama al proveedor.
- Roles spec-writer, arquitecto y planner vía `ProviderPort`: prompt versionado en `factory/prompts/`, modelo en `factory/config/roles.json`, JSON Schema derivado con `z.toJSONSchema`, sin herramientas (`--tools ""`), PRD en bloque de datos delimitado por hash.
- Gates deterministas (G0/G1): conjunto exacto de `REQ-###` declarados, DAG (claves, dependencias, ciclos, aceptación vacía, requisitos desconocidos, cobertura de `must`), registro de presets, suelo de riesgo (tabla de reglas en `src/domain/planning/risk.ts`).
- Reparación acotada: una sola reparación por fase; después `BLOCKED` con causa (o `FAILED` si el proveedor falla sin reintento posible); fallos reintentables dejan el run reanudable. Cada llamada queda en `role_attempts`.
- Contradicciones críticas bloquean tareas afectadas y dependientes; todas las `must` bloqueadas → run `BLOCKED`. Supuestos y contradicciones no críticas solo se registran.
- `buildContextPack` con fuente/sha256/versión por pieza y límite de bytes (`context_pack_too_large`, sin truncar); `recordSpecChange` crea v2 y emite `spec.changed` con las tareas impactadas.
- `status` muestra versión de spec, requisitos, supuestos, contradicciones (críticas), presets y tareas bloqueadas con causa. Proveedor falso solo con `FACTORY_PROVIDER=fake` + `FACTORY_FAKE_FIXTURES`, con aviso en `plan`, `doctor` y eventos.

Evaluaciones cubiertas (con proveedor falso y SQLite real en directorios temporales):

| Eval | Test |
|---|---|
| E02 hueco reversible | `test/planning.test.ts` «assumptions (E02) records the assumption and continues» |
| E03 contradicción crítica | «contradictions (E03)»: bloqueo de cubrientes y dependientes, independientes intactas, todas `must` bloqueadas → run `BLOCKED`, no crítica no bloquea |
| E04 JSON malformado | «bounded repair (E04)»: schema inválido y `invalid_output` → una reparación → éxito; dos fallos → `BLOCKED` con exactamente 2 intentos, sin más llamadas; error no reintentable → `FAILED`; reintentable → reanudable |
| E04 gates | «deterministic gates reject model output»: id inventado, id faltante, ciclo, dependencia desconocida, `must` sin cubrir, `presetId` desconocido; unitarios en `test/planning-domain.test.ts` |
| E12 instrucción maliciosa | «untrusted PRD content (E12)»: texto solo dentro del bloque de datos, `tools: []` en todas las llamadas y `--tools ""` en el argv de `buildClaudeArgs` |
| E13/E18 destino | `test/target.test.ts` y «target on start (E13/E18)»: repo de la factory, `FACTORY_HOME`, symlink y symlink en ancestro, symlink colgante, ancestro de la factory, no vacío, archivo; `test/cli.test.ts` por CLI |
| E16 (extendido) | `target_mismatch` en dedup (`test/planning.test.ts`, `test/cli.test.ts`) |
| Suelo de riesgo | «risk floor»: `prisma/schema` y auth suben de `low` a `high` |
| ContextPack | «ContextPack»: solo requisitos de la tarea, hashes coherentes, reutilización/versionado, límite excedido, tarea ajena |
| Cambio de spec | «spec changes»: v2, `spec.changed` con tareas impactadas, spec idéntica/ inválida rechazada |
| Plan reanudable e integridad | «resumability and artifact integrity»: segundo `plan` con 0 llamadas, huérfano sobrescrito, hash alterado → `artifact_corrupted` |
| CLI | `test/cli.test.ts` «CLI planning with the fake provider»: `start --target` → `plan` → `status` → segundo `plan` (0 llamadas), `doctor` con proveedor falso |

Comandos ejecutados (resultado observado):

- `npm ci`: 0 vulnerabilidades.
- `npm run typecheck`: sin errores.
- `npm run lint`: 79 archivos, sin avisos.
- `npm test`: 9 archivos, 159 tests pasan (87 de H1 + 72 nuevos).
- `npm run factory -- doctor`: todo OK salvo aviso por Playwright; migraciones 1 y 2 aplicadas; `provider: claude (real)`.
- Con `FACTORY_PROVIDER=fake FACTORY_FAKE_FIXTURES=test/fixtures/demo`: `start --prd templates/PRD-DEMO.md --target $(mktemp -d)` → `plan` (3 llamadas, 6 tareas, run en `PLANNING`, exit 0) → segundo `plan` (0 llamadas) → `status` (8 requisitos, 1 supuesto, presets backend + web, PENDING=4 READY=2). El destino quedó vacío.

Decisiones fuera del encargo (ver ADR 0005): `presetIds` (lista) en lugar de `presetId`; `targetPath` opcional en el caso de uso `startRun` (los runs de H1 no lo tienen; la CLI lo exige y `plan` falla con `target_missing` sin él); el bloqueo por contradicción se propaga a las tareas dependientes; `plan` devuelve exit 1 si el run queda `BLOCKED`; las llamadas a roles usan presupuesto 2 USD y timeout de 10 min como constantes provisionales hasta H5.

Límites de H2:

- (Superado por la «Corrida real» de abajo, una ejecución manual; no hay test automático con el proveedor real.) Ninguna llamada real a Claude desde los tests: los prompts, los esquemas JSON y la clasificación de errores del adaptador real no se probaron de extremo a extremo con el PRD demo. La aceptación completa con proveedor real sigue pendiente (requisito del plan).
- Sin desbloqueo de runs `BLOCKED` (se corrige el PRD y se crea otro run con `--new`); sin re-plan tras `recordSpecChange`, que solo registra v2 y lista las tareas impactadas (no reevalúa contradicciones ni bloqueos).
- El diseño de experiencia (doc 02 §4 paso 6) y el descubrimiento de repos existentes (paso 4) no están; el destino `git_repo` solo se registra.
- El suelo de riesgo es por patrones y produce falsos positivos por diseño.
- Un solo coordinador por base de datos; `plan` no toma lock entre procesos.
- El coste de las llamadas con el proveedor falso es `null`.

### H2 — ronda de corrección (verificador independiente: PASS_WITH_FINDINGS)

- `expectedPaths`: gate determinista (`src/domain/planning/paths.ts`): ruta relativa POSIX normalizada, sin `..`, sin `/` inicial, sin letra de unidad, sin NUL ni `\`, sin segmento `.git`. El fallo pasa por la reparación acotada.
- Extracción de `REQ-###`: soporta encabezados, filas de tabla, negrita y listas; ignora bloques de código; admite 3 o más dígitos. Los tokens `REQ-\d+` no capturados como declaración emiten el evento `intake.req_ambiguous` (y quedan en `ingest-v1.json`) en lugar de reducir el conjunto en silencio.
- `applyRoleError` propaga el fallo de la transición (`state_transition_failed`, con la causa original).
- `runs.provider_mode` (`real` | `fake`, migración 3): se fija en la primera llamada a un rol; continuar con otro modo falla con `provider_mode_mismatch`; `status` lo muestra.
- `plan` verifica el hash de todos los artefactos registrados antes de continuar (ingest, spec y plan ya no pueden alterarse sin detección), con cero llamadas al proveedor.
- Tests nuevos: formas de REQ-ID, bloque de código, 4 dígitos, aviso por declaración parcial; rutas inseguras; transición fallida; modo de proveedor; marcadores falsos de fin/inicio en el PRD (siguen dentro del bloque real); alteración y borrado de ingest/spec/plan; fallo reintentable repetido en 3 invocaciones (1 llamada por invocación, estado intacto, sin reparación contada).
- Fuera de alcance, para H3: revalidación TOCTOU del destino antes de escribir.

### Corrida real

Observado por el coordinador (no reproducido por este agente): `claude` real (sonnet) sobre `templates/PRD-DEMO.md`; 3 llamadas al proveedor, todas aceptadas; costes a precio de lista 0,1078 / 0,1298 / 0,1332 USD (total ≈ 0,37 USD); 3 min 50 s de tiempo total. Resultado: 8 requisitos (REQ-001..008), 8 supuestos, 1 contradicción no crítica, presets `backend-express-kimmbo` + `web-react-vite`, 17 tareas sembradas (1 READY, 16 PENDING), run en `PLANNING`.

## H3a — resultado

Funciona (verificado con los comandos de abajo, con Docker real):

- **Esqueletos deterministas** en `factory/templates/`: `apiweb` (npm workspaces `api` + `web`, guards del preset, health e2e contra Postgres real, `compose.yaml` para el humano), `static-landing` (HTML/CSS + `scripts/check.mjs`), `mobile` (Expo + React Native Web). Manifiesto `template.json` (id, presets que satisface, archivos a renderizar), marcadores `{{PRODUCT_NAME}}`/`{{PRODUCT_SLUG}}` y `package-lock.json` versionado (ADR 0007, versiones en `docs/compatibility/matrix.md`).
- **Bootstrap** (`src/modules/execution/bootstrap-product.ts`): revalida el destino antes de cada escritura del motor (cierra el TOCTOU de H2), `git init -b main`, identidad local del repo, escaneo de secretos, commit `chore: scaffold from <id>`, artefacto `bootstrap` + evento `product.bootstrapped`; idempotente; repo existente → `existing_repo_unsupported`.
- **Adaptador Git** (`src/infrastructure/git/`): solo `argv`, sin hooks ni config global/de sistema; init, commit, `headSha`, `isClean`, worktree add/remove bajo `<FACTORY_HOME>/runs/<runId>/worktrees/<taskKey>`, `diffNames`, `mergeNoFf` exclusivo (lock `O_EXCL` con detección de pid muerto); nombres validados con `^[a-z0-9][a-z0-9-]{0,63}$`.
- **Escaneo de secretos** (`src/domain/security/secret-scan.ts`): `.env` (salvo `*.example`), cabeceras de clave privada, AWS access key id y asignaciones largas entre comillas fuera de tests/fixtures/ejemplos; los hallazgos llevan archivo, línea y regla, nunca el valor.
- **Runner de checks** (`src/infrastructure/runner/`): `DockerRunner` (red y Postgres por run, contenedor efímero por check, etiquetas `factory.managed`/`factory.run`, limpieza solo por etiqueta, timeout mata solo ese contenedor) y `HostRunner` (marcado sin aislamiento); selección con `FACTORY_RUNNER` y `doctor` informa cuál. Tabla `checks` (migración 4) y `isCheckEvidenceValid` (no aplicada todavía).
- **CLI** `factory build <runId> --bootstrap-only`: bootstrap + `npm ci` + `npm run check` en la raíz del producto; exit 1 si algo falla (E05 a nivel de bootstrap).

Evaluaciones cubiertas (parcial: bootstrap, sin bucle de builder):

| Eval | Test |
|---|---|
| E05 test falla | `test/docker/skeleton.docker.test.ts` (test inyectado en el esqueleto real → `npm run check` ≠ 0, el build informa fallo, el run sigue en `PLANNING`); `test/build-bootstrap.test.ts` (runner simulado: se detiene tras el primer fallo, nada se marca como superado); `test/cli.test.ts` (exit 1 por CLI) |
| E13/E18 destino (TOCTOU) | `test/bootstrap.test.ts`: destino cambiado a symlink hacia `FACTORY_HOME` antes del bootstrap y a mitad de la copia → rechazado, nada escrito en el destino del symlink |
| Seguridad Docker | `test/docker-argv.test.ts` (etiquetas, prefijo, sin `-p`/socket/home, `--user`, secretos solo por nombre, limpieza por etiqueta), `test/docker/runner.docker.test.ts` (teardown real: sin objetos etiquetados al final y todos los contenedores previos intactos) |

Comandos ejecutados (resultado observado):

- `npm ci`: 0 vulnerabilidades.
- `npm run typecheck`: sin errores.
- `npm run lint`: 118 archivos, sin avisos.
- `npm test`: 22 archivos, 366 tests pasan y 1 se salta (el guard `check-comments` del esqueleto necesita `typescript` instalado en el esqueleto, que no está en el repo; lo cubre la aceptación Docker en positivo).
- `npm run test:docker`: 2 archivos, 12 tests pasan en 117 s (tras la corrección) (runner real: HostRunner, DockerRunner, timeout, teardown; aceptación de fullstack con Postgres real, inyección de fallo y landing).
- `npm run factory -- doctor`: todo OK salvo aviso por Playwright; `runner: docker (isolated checks with a per-run Postgres)`; migraciones 1 a 4.
- CLI con `FACTORY_PROVIDER=fake FACTORY_FAKE_FIXTURES=test/fixtures/demo`: `start --prd templates/PRD-DEMO.md --target <dir>` → `plan` (3 llamadas, 6 tareas) → `build --bootstrap-only` → `status`. Con el destino bajo `$HOME`: bootstrap `apiweb`, `npm ci` OK (28 s) y `npm run check` OK (17 s) en Docker, exit 0; segundo `build` salta el bootstrap y repite los checks, exit 0. Con `mktemp -d` bajo `/tmp` y Docker Desktop: `npm ci` exit 125 (Docker Desktop no comparte `/tmp`), el informe lo explica y el exit es 1.
- Tras cada ejecución, `docker ps -a --filter label=factory.managed=true` quedó vacío y `docker ps` siguió listando `kimmbo-prod-api-1`, `kimmbo-prod-postgres-1`, `kimmbo-prod-redis-1`, `kimmbo-prod-caddy-1` y `backend-template-postgres-1`.

Decisiones fuera del encargo: vitest 5.0.5 en los esqueletos (5.0.2 rompe `npm install` con npm 10.9.8); `--user 0:0` en Docker Desktop (el `root` del contenedor es el usuario del host en disco; con `uid:gid` el directorio montado es ilegible); imagen Node `22.23.2-bookworm-slim` fijada por digest; secretos del contenedor por nombre en lugar de valor en el `argv`; `NODE_ENV=production` explícito en el build de `web` (el runner fuerza `NODE_ENV=test`); el motor se niega a ejecutar un check con el árbol sucio y no registra un check que modifica archivos versionados; extensiones de contrato: eventos `product.bootstrapped`/`check.recorded`, artefacto `bootstrap`, `TargetFiles.revalidate`, `ProjectRepository.findById`.

Límites de H3a:

- Sin bucle de builder, ramas por tarea ni merge desde la CLI (llegan en H3b); el adaptador Git está probado en repos temporales pero sin uso de extremo a extremo.
- El runner Docker se verificó solo en Docker Desktop (Linux). El camino de un motor nativo (`--user uid:gid`) se cubre con tests del `argv`, no con ejecución real.
- La ventana entre revalidar el destino y escribir no es cero (sin `openat`); el bootstrap interrumpido entre el commit y el evento requiere borrar el destino.
- `check-comments` del esqueleto no tiene test negativo en la suite rápida (necesita `typescript` del esqueleto); los otros tres guards sí.
- El `HostRunner` no levanta Postgres; el `check` del esqueleto full-stack en host no está verificado.
- No se probó el esqueleto contra `npm` distinto del 10.9.x de la imagen y del host, ni en Windows (el script `build` de `web` usa sintaxis POSIX).
- Los tests no usan el `claude` real (ninguna llamada); `doctor` sigue ejecutando solo `claude --version`.

### H3a — ronda de corrección (verificador independiente: FAIL)

| Hallazgo | Corrección | Test |
|---|---|---|
| ALTO 1: escape por `.git/config` (`core.fsmonitor`) escrito desde el contenedor | Los checks corren sobre un snapshot del commit sin `.git` (`git ls-tree` + `git cat-file --batch`; `git archive` se descartó porque ejecuta filtros `smudge`, medido); solo ese directorio se monta y se borra después; el `commit_sha` es el archivado. Adaptador Git: claves `-c` y variables de entorno endurecidas, sello sha256 de `.git/config` e `info/attributes` (`repo_config_tampered`) y re-sellado tras worktree add/remove. ADR 0008 | `test/git-adapter.test.ts` (sello, filtro + config manipulada, snapshot sin filtros), `test/build-bootstrap.test.ts` (check que escribe `.git/config`: hash intacto, marcador ausente, snapshot borrado) |
| MEDIO 2: doble `digest` tras timeout | `complete` idempotente (digest una vez, temporizadores limpiados en todos los caminos); `docker kill` fallido se registra (`killError`, log y evento) | `test/run-logged.test.ts` (temporizadores simulados, cierre antes/después del kill, sin excepción no capturada) |
| MEDIO 3: carrera en la toma del lock | Creación con temporal + `link()`, token `pid:uuid`, toma por tombstone con verificación y restauración, `release` con token | `test/git-adapter.test.ts` (dos aspirantes intercalados, release ajeno, sin residuos) |
| MEDIO 4: guards que fallan abiertos | `check-layers`/`check-boundaries` fallan cerrado, cubren `.ts/.mts/.cts`, `import "x"`, `export … from`, `import()`, `require()`, resuelven rutas relativas, `express-serve-static-core`, `infrastructure/http/` e índice del módulo | `test/template-guards.test.ts` |
| MEDIO 5: bootstrap interrumpido | Staging + movimiento atómico (rename / rmdir+rename / copia verificada por `EXDEV`), artefacto `bootstrap-staged`, recuperación tras mover | `test/bootstrap.test.ts` (fallo antes y después del movimiento, huella manipulada, `EXDEV`, copia corrupta) |
| MEDIO 6: `.gitignore` | `.env`, `.env.*`, `.envrc` ignorados en todos los niveles salvo ejemplos (ambos esqueletos) | `test/template-guards.test.ts` (`git check-ignore`) |
| BAJO 7: secret scan | `.envrc`; reglas de alta confianza en todas las rutas; ante cualquier fallo de staging/lectura se deshace el staging; `commitAll` eliminado del puerto | `test/secret-scan.test.ts`, `test/safe-commit.test.ts` |
| BAJO 8 | `buildReadyArgv` devuelve `Result`; patrón de run id único (`src/domain/ids/run-id.ts`); cola UTF-8 segura (`utf8Tail`); riesgo de salida a Internet y contraseña del Postgres documentado como aceptado (ADR 0008, matriz) | `test/docker-argv.test.ts`, `test/run-logged.test.ts` |
| BAJO 9 | `rootless`/`userns` en `SecurityOptions` se tratan como Docker Desktop (`--user 0:0`); **no verificado en un motor nativo** | `test/runner-select.test.ts` |
| BAJO 10 | `errorHandler` del esqueleto llama a `next(err)` si `res.headersSent` | `api/src/infrastructure/http/errorHandler.test.ts` (rojo observado en la aceptación Docker antes del arreglo, verde después) |

Correcciones de redacción: `isCheckEvidenceValid` existe y está probada pero **no se aplica** en ninguna decisión del motor todavía (H3b). Ya no se comprueba «árbol sucio» ni «HEAD movido» para la evidencia: el check corre sobre el commit archivado. Orden de trabajo: los tests de las correcciones se escribieron antes que el código (rojo observado) salvo los de guards de `.gitignore`/layers, cuyo código ya fallaba o se reescribió junto al test en la misma pasada; el primer fallo del esqueleto real (formato de Biome en mis scripts nuevos) lo detectó la propia aceptación Docker.

Límites tras la corrección: el sello no cubre `.git/hooks` (desactivados con `core.hooksPath`), `objects/info/alternates` ni otras vías de configuración; el snapshot omite submódulos; la copia `EXDEV` se probó por inyección; rootless/userns en motor nativo sin verificar; la toma del lock obsoleto se probó con intercalado simulado, no con procesos concurrentes; el negativo de `check-comments` sigue sin test en la suite rápida; la red de los checks tiene salida a Internet (aceptado).

### H3a — re-verificación (verificador independiente: PASS_WITH_FINDINGS)

- ALTO 1 cerrado para la amenaza descrita: ningún contenedor ve un repositorio vivo.
- Hallazgo nuevo MEDIO, corregido por el coordinador: un árbol con un symlink `link` y una entrada `link/x` hacía que el snapshot escribiera fuera de su directorio siguiendo el symlink (reproducido por el verificador con `git mktree`). Ahora `snapshot` rechaza cualquier árbol donde una entrada cuelgue de otra entrada (`hasNestedEntryConflict` en `src/infrastructure/git/git.ts`). Test: `test/git-adapter.test.ts` «refuses a tree where an entry path is nested under a symlink entry» (rojo observado antes del arreglo, verde después). `npm run check`: 22 archivos, 367 tests pasan, 1 omitido.
- Pendientes bajos aceptados para H3b: el sello falla abierto si falta el archivo de sello; no cubre `credential.helper`, `core.editor`, `gpg.program`, `info/exclude`, `alternates` ni `refs/replace` (irrelevante mientras los checks usen snapshots y el builder no ejecute git); carrera residual estrecha en la restauración del lock; la regla genérica de secretos sigue exenta en rutas de test/fixtures y no detecta asignaciones sin comillas.

## H3b — resultado

Funciona (verificado con los comandos de abajo, con Docker real):

- `factory build <runId> [--max-tasks N] [--max-provider-calls N]` (ADR 0010): bootstrap si hace falta, rama `factory/integration`, y por tarea: worktree `factory/task/<key>`, ContextPack, llamada de rojo (perfil ADR 0006: `--restricted`, `Read,Edit,Write,Glob,Grep`, `acceptEdits`, cwd = worktree), rojo observado por el motor (`test` con código ≠ 0), llamada de verde, `check` completo, reparaciones acotadas (`FACTORY_REPAIRS_PER_TASK`, por defecto 2), merge `--no-ff` bajo el lock y check sobre la nueva cabeza de integración. Una tarea es `DONE` solo si el check leído de la base de datos es del commit de integración, pasó, es de esa tarea y es el comando `check` de la política (`isCheckEvidenceValid` ya se aplica).
- Fase por tarea persistida (`task_builds`, migración 5): tras una interrupción, `resume` + `build` continúan sin repetir la llamada de rojo. Con `--max-provider-calls` las tareas vuelven a `READY` sin perder la fase.
- Cambios protegidos: `scripts/check-*.mjs` y `scripts` de `package.json` bloquean (`protected_change`); manipular los tests del commit rojo bloquea (`tests_tampered`); `tsconfig*`, `biome.json`, `vitest.config.*`, `.github/**`, `factory/**` y tests borrados marcan `requires_review` y emiten `task.protected_change`. `status` lista tareas bloqueadas con causa y tareas a revisar.
- Política de checks por plantilla (`factory/policies/checks.json`), rol `builder` en `roles.json`, prompts `builder-red.md` y `builder-green.md`.
- Proveedor guionizado con ediciones de archivos (`writes`/`deletes` dentro del `cwd`, rutas seguras, sin symlinks) para conducir ciclos rojo/verde reales sin LLM.
- Adaptador Git ampliado (rama con `/`, `checkoutBranch`, `statusEntries`, `blobOid`, `showFile`, `resetBranch`, `withMergeLock`); `mergeNoFf` y `resetBranch` aceptan el lock ya tomado.

Evaluaciones cubiertas:

| Eval | Test |
|---|---|
| E05 test falla | `test/build-loop.test.ts` «E05 failing tests never advance» (exactamente 1 rojo + 1 verde + 2 reparaciones, tarea `BLOCKED`, integración intacta, checks con shas distintos); «repairsPerTask = 0»; rojo no observado → reparación → `BLOCKED` |
| E07 evidencia de otro commit | «E07: only a passed check on exactly the integration head…» (el check verde de la rama no valida la cabeza de integración) y «feeds the failure tail back…» (tras un cambio el motor vuelve a ejecutar sobre el nuevo commit) |
| E14 conflicto de merge (detección) | «E14: a conflicting merge blocks the task…» (`merge_conflict`, integración en el commit previo, árbol limpio, la primera tarea sigue `DONE`); «resets integration… when the check after the merge fails» |
| Cambios protegidos | tests de `package.json` scripts, guard `check-*.mjs`, tsconfig/biome (`requires_review`), tests alterados o borrados |
| Dependencias, límites y reanudación | «keeps a dependent PENDING…», «stops cleanly at --max-provider-calls…», «--max-tasks», «resumes after an interruption…» |
| Perfil del builder | «gives the builder the restricted profile…» y `test/builder-provider.test.ts` (flags, nunca `--tools ""` ni Bash) |
| Aceptación Docker | `test/docker/builder.docker.test.ts`: una tarea `ping` (ruta, servicio y e2e) sobre el esqueleto real `apiweb`: rojo y verde en Docker con Postgres, integración, `DONE`, run `READY_FOR_RELEASE`, sin objetos Docker etiquetados al final |

Comandos ejecutados (resultado observado):

- `npm ci`: 0 vulnerabilidades.
- `npm run typecheck`: sin errores.
- `npm run lint`: 133 archivos, sin avisos.
- `npm test`: 26 archivos, 406 tests pasan y 1 se salta (el mismo `check-comments` de H3a).
- `npm run test:docker`: 3 archivos, 13 tests pasan en 293 s (la aceptación del builder sola, 186 s).
- `npm run factory -- doctor`: todo OK salvo aviso por Playwright; migraciones 1 a 5; `runner: docker`.
- `docker ps -a --filter label=factory.managed=true -q`: vacío; `docker ps` sigue listando `kimmbo-prod-api-1`, `kimmbo-prod-caddy-1`, `kimmbo-prod-redis-1`, `kimmbo-prod-postgres-1` y `backend-template-postgres-1`.

Decisiones fuera del encargo: `strictObject` de la salida del builder igual en ambas fases (`testFiles` obligatorio; vacío en verde); el run atraviesa `VERIFYING → REVIEWING → INTEGRATING` antes de `READY_FOR_RELEASE` porque la máquina de estados no permite `BUILDING → INTEGRATING`; los archivos «de test» bloqueados contra manipulación son los de la diferencia `base..rojo` con ruta de test (no los helpers); `FACTORY_REPAIRS_PER_TASK` como configuración; `builder.json` opcional en las fixtures del proveedor falso; lease de tarea de 45 min con latido entre pasos; el primer lanzamiento del test de Docker pasó sin iteraciones.

Límites de H3b:

- El builder real no se ejecutó: el perfil `--restricted` solo se verificó en el spike de ADR 0006; los prompts, el esquema de salida y la calidad de los tests/código del builder real están sin probar de extremo a extremo.
- El rojo exige código ≠ 0, no un motivo concreto; un timeout cuenta como rojo.
- Sin resolución de conflictos de merge ni desbloqueo de tareas `BLOCKED`; sin revisores (H4) ni presupuesto en USD acumulado (H5); `VERIFYING`/`REVIEWING` del run se atraviesan sin trabajo.
- Un `build` por run a la vez. Si se interrumpe entre el merge y el check, la fase `merged` reanuda con el check solo si la cabeza de integración no cambió (si no, `integration_head_moved`).
- Los cambios de config protegidos distintos de guards y `scripts` solo se marcan, no bloquean.

### H3b — ronda de corrección (verificador independiente: PASS_WITH_FINDINGS)

| Hallazgo | Corrección | Test |
|---|---|---|
| ALTO: secuestro del puntero `.git` del worktree (`.evil` + filtro `clean` + `.git` = `gitdir: .evil` ejecutaba el filtro en el host) | El adaptador ya no lee el gitdir desde `<worktree>/.git`. `worktreeAdd` registra el gitdir esperado en `<FACTORY_HOME>/worktree-registry/`; cada llamada a git usa `GIT_DIR`/`GIT_WORK_TREE` explícitos y verifica que `.git` contenga exactamente `gitdir: <esperado>`, si no `worktree_pointer_tampered`. El repo principal usa `GIT_DIR=<repo>/.git` | `git-builder.test.ts` (ataque reproducido: `statusEntries`, `stageAll`, `headSha`, `commit` y `commitGuarded`; el marcador nunca se crea) |
| ALTO: sello ausente devolvía ok | `verifySeal` falla cerrado con `repo_not_sealed`; solo `init` (bootstrap) corre sin sello | `git-builder.test.ts` (sello borrado, y `init` inicial sigue funcionando) |
| MEDIO: debilitar tests pasaba inadvertido | Modificar o borrar un test que existe en el commit base de la tarea => `protected_change` (`base_test_modified`); `vitest/jest/playwright.config.*` => `protected_change`; `.npmrc`, `package-lock.json`, `.gitignore`, deps de `package.json` y soporte de tests (`test/**`, `tests/**`, `__fixtures__/**`, `__snapshots__/**`) => `requiresReview`. Las rutas quedan en `protectedPaths`, el evento `task.protected_change` lleva `reasons` y `task.integrated` lleva `reviewPaths` | `builder-domain.test.ts`, `build-loop.test.ts` |
| MEDIO-BAJO: el commit rojo podía incluir código fuente | Solo rutas de test o soporte de test; si no, una reparación roja y luego BLOCKED `red_not_test_only` | `build-loop.test.ts` (reparado y bloqueado) |
| BAJO: caída entre `mergeNoFf` y la fase `merged` | `preMergeCommit` se persiste antes del merge. Al reanudar, si la cabeza es el merge de esta tarea (padres `[preMerge, rama]`) se continúa al check; si se movió por otra razón, BLOCKED `integration_head_moved` con nota de que el merge puede estar presente. Nuevos puertos `parentsOf` y `branchHead` | `build-loop.test.ts` (tres puntos de caída) |

Límites que siguen abiertos:

- Spike real (coordinador, USD 0,024): bajo `--restricted` + `acceptEdits`, Claude **se negó por criterio propio** a reescribir `.git`, pero el sistema de permisos no lo denegó (0 denegaciones). No es un control; el motor ya no depende de ello.
- Mutación (coordinador): forzar que el motor confíe en el puntero `.git` hace fallar los 2 tests del ataque en `test/git-builder.test.ts`; restaurado, 422 tests pasan.
- La revisión humana de `requiresReview` sigue pendiente: H3b solo la registra y la lista; la exigencia de firma es de H4.
- El caso "la cabeza se movió por otra razón" no revierte: bloquea y deja el merge de la tarea posiblemente en la historia.
- Los tests de la propia tarea siguen modificables hasta el commit rojo; desde el verde quedan bloqueados (como antes).

### H3b — corrida real del builder (coordinador)

- Run real con `sonnet` sobre `templates/PRD-DEMO.md` (FACTORY_HOME y destino bajo `~/.cache/gsf-smoke/`): `plan` 3 llamadas, 12 tareas, 2m56s; `build --max-tasks 1 --max-provider-calls 5`, 7m29s.
- Tarea `db-schema-setup`: commit rojo del builder real, `npm ci` exit 0 y tests exit 1 en Docker → **rojo observado por el motor**. En verde el builder modificó los scripts de `api/package.json` → BLOCKED `protected_change`. Nada se marcó como aprobado.
- Coste informado (lista): spec 0,188 + arquitectura 0,223 + plan 0,209 + builder 0,581 + 0,344 ≈ **USD 1,55**.
- Ajuste derivado (coordinador, TDD con rojo observado): la política bloqueaba cualquier cambio de scripts. Ahora `scriptsChangeKind` bloquea editar/borrar scripts existentes o añadir scripts tipo check (`check*`, `test*`, `lint*`, `typecheck*`, `format*`, `build*`, `pre*`/`post*`, ciclo de vida npm); añadir otros scripts (p. ej. `db:migrate`) pasa a `requiresReview` (`package_scripts_added`). Tests en `test/builder-domain.test.ts`; `npm run check`: 426 pasan.
- Pendiente detectado: el diff de un verde bloqueado se pierde al borrar el worktree; conviene guardarlo como artefacto para diagnóstico. No hay desbloqueo de tareas BLOCKED (reintentar exige un run nuevo).

## H4a — resultado

Funciona (proveedor guionizado; ADR 0012):

- Contrato de hallazgos Zod (`src/contracts/review.ts`) con reglas deterministas (alto/crítico exigen archivo y evidencia, `pass` sin hallazgos, `blocked`/`not_applicable` con razón, `requiresReviewAck` obligatorio para el revisor de código). Mal formado: una reparación acotada y `BLOCKED review_output_invalid`.
- Roles `reviewer-security`, `reviewer-code`, `review-refuter` (perfil de solo lectura `--restricted --tools Read,Glob,Grep --permission-mode dontAsk`, cwd = snapshot sin `.git` borrado después) y `approver` (sin herramientas, consultivo). Prompts con atribución MIT a rsc-harness.
- Dedup puro (archivo + ventana ±3 + clase de severidad + títulos con Jaccard ≥ 0,5; discrepancias con `conflictsWith`), refutador solo para críticos/altos, gate G4 puro (`evaluateGate`).
- Bucle: fases `reviewing` y `reviewed`; reparación por hallazgos con el presupuesto compartido (`builder-repair-findings.md`); re-revisión del commit nuevo; migración 6 (`reviews`, `findings`, `task_retries`, `task_builds.reviewed_commit`); artefactos `review` y `blocked-diff`; `factory retry`; `status` con revisiones y ruta del diff.

Evaluaciones:

| Eval | Test |
|---|---|
| E06 hallazgo alto de autorización bloquea hasta resolverse | `test/review-domain.test.ts` («E06…»), `test/review-loop.test.ts` («repairs open findings…», «persisting findings blocks as review_findings_open…», «uncertain refutation…») |
| E07 evidencia de otro commit | `review-domain` («E07: a review of an older commit is stale…»), `review-loop` («E07: a commit added to the task branch during review…», reviews ligadas al commit fusionado) |

Comandos ejecutados (resultado observado):

- `npm run typecheck`: sin errores.
- `npm run lint`: 146 archivos, sin avisos.
- `npm test`: 30 archivos, 497 tests pasan y 1 se salta.
- `npm run test:docker`: 3 archivos, 13 tests pasan en 346 s (la aceptación del builder ahora incluye un hallazgo alto, reparación y re-revisión).
- `docker ps -a --filter label=factory.managed=true -q`: vacío; `docker ps` sigue listando los 4 `kimmbo-prod-*`.

Decisiones fuera del encargo: `approver` siempre se llama aunque no haya hallazgos; `green_not_reached` también es reintentable; `FACTORY_MAX_TASK_RETRIES`.

Límites de H4a:

- Ningún revisor, refutador ni approver se ejecutó con el `claude` real; el perfil de solo lectura solo está probado por argv.
- (Resuelto en H4b) UX/UI y el gate de cuatro áreas.
- Tests de adaptador Git, de prompts y del comando `retry` en la CLI se escribieron después de la implementación (sin rojo previo observado).

### H4a — ronda de corrección (verificador independiente: PASS_WITH_FINDINGS + coordinador)

| Hallazgo | Corrección | Test |
|---|---|---|
| Revisor, refutador y approver no contaban en `--max-provider-calls` | Presupuesto compartido (`ReviewInput.budget`); al agotarse en mitad de la revisión la tarea se libera en `reviewing` y se reanuda sin repetir revisores del mismo commit y ciclo | `review-loop` («counts reviewer, refuter and approver calls…», «stops cleanly when the budget runs out before the refuter») |
| Revisiones arrastradas (`carried`) entre reparaciones | Eliminado de código, gate, tipos y estado; todo commit nuevo exige todas las áreas; la columna queda en 0 | `review-loop` («re-runs every review area on the new head…»), `review-domain` (E07) |
| `blocked-diff` podía guardar secretos | `redactDiff` (reglas de `secret-scan`) sobre líneas añadidas, `[REDACTED:<regla>]`, reglas en evento | `redact-diff.test.ts`, `review-loop` («never stores a raw secret…») |
| Snapshots con symlinks absolutos o que escapan | `unsafe_symlink` en `snapshot` | `git-adapter` («symlink targets», 3 tests) |
| Texto de tarea fuera de bloque delimitado | `dataBlock("TASK", …)` en prompts de revisión y de builder | `task-prompts.test.ts` |
| Approver `repair` sin críticos/altos pasaba siempre | Con presupuesto: una ronda de reparación; sin presupuesto: pasa y se lista `accepted_open` | `review-domain` (tabla del gate), `review-loop` («approver repair without critical/high…») |
| Carrera en `retry` | Comprobaciones dentro de la transacción | `retry.test.ts` (dos conexiones, 2 tests) |
| Approver con `cwd` = `FACTORY_HOME` | Directorio temporal vacío bajo `runs/<id>/approver-work/` | `review-loop` («runs the approver in an empty directory…») |

Límites restantes: cada `callRole` cuenta 1 aunque haga un reintento interno de formato; refutador y approver no se persisten antes del gate, así que se repiten si la ejecución se interrumpe entre ambos; las reglas de redacción son las de `secret-scan` (no detectan secretos sin patrón conocido); los artefactos no tienen metadatos, las reglas de redacción van en un evento; un symlink seguro dentro de la raíz que apunte a otro symlink se valida solo de forma léxica.

TDD: el código de los puntos 1, 2, 5, 6 y 8 se escribió antes que sus tests (verdes a la primera, sin rojo observado); los puntos 3, 4 y 7 se hicieron con rojo observado previo.

## H4b — resultado

Funciona (ADR 0013):

- `PreviewPort` + implementación Docker (`createDockerPreview`): snapshot del commit, `npm ci` y build en contenedores Node fijados, servidor estático del motor, Postgres/migrate/seed/api solo si la política `preview` los define, y contenedor de Playwright (`mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd…`, verificada con `docker pull`) que ejecuta `factory/preview/capture.mjs` (hash registrado en la evidencia) a 390x844 y 1440x900: PNG de página completa, axe-core 4.14.0, desbordamiento horizontal, foco con Tab (10 elementos), errores de consola. El motor valida con Zod, recalcula sha256/tamaño de cada PNG y escribe `ui-evidence.json` en `runs/<runId>/ui/<commit>/`. Teardown siempre en `finally`, solo por etiqueta `factory.preview` (más `factory.managed`/`factory.run`), sin puertos, socket ni home.
- Roles `reviewer-ux` y `reviewer-ui` (solo lectura, `cwd` = snapshot + `ui-evidence/`), prompts con la doctrina de H4a, `evidenceRef` opcional en hallazgos.
- Aplicabilidad determinista (`web/` o html/css según plantilla): `not_applicable` con «no UI changes» sin llamadas; aplica y evidencia `unavailable` -> ux/ui `blocked` -> `BLOCKED review_blocked` (E15). Gate G4 con cuatro áreas; cada llamada UX/UI cuenta en `--max-provider-calls`; las revisiones `blocked` del motor para ux/ui no se reutilizan al reanudar.
- Plantilla `apiweb`: solo se añadió `web/ui-routes.json` (`["/"]`); no hizo falta ningún script `start:preview` (el motor sirve `web/dist`). `status` muestra por tarea la ruta de la evidencia y los conteos de axe.

Evaluaciones:

| Eval | Test |
|---|---|
| E15 revisor sin navegador nunca pasa | `test/ui-gate.test.ts` («E15…»), `test/ui-review-loop.test.ts` («E15: applicable UI work with unavailable browser evidence…», «E15: no preview port at all…»), `test/docker-preview.test.ts` («reports unavailable…») |
| Aplicabilidad / rutas / esquema | `test/ui-domain.test.ts` |
| argv de preview y Playwright (etiquetas, sin `-p`, montajes de solo lectura, sin socket/home) | `test/docker-preview-argv.test.ts` |
| Hash del script, teardown en fallos, evidencia atada al commit | `test/docker-preview.test.ts` |
| Bucle con UI / sin UI / sin preview, reparación, presupuesto, status | `test/ui-review-loop.test.ts` |
| Navegador real sobre el esqueleto | `test/docker/preview.docker.test.ts` |

Comandos ejecutados (resultado observado):

- `npm run typecheck`: sin errores.
- `npm run lint`: 160 archivos, sin avisos.
- `npm test`: 37 archivos, 582 tests pasan y 1 se salta.
- `npm run test:docker`: 4 archivos, 14 tests pasan en 428 s (la captura de navegador sobre el esqueleto añade ≈ 35–50 s con las imágenes ya descargadas).
- `docker ps -a --filter label=factory.managed=true -q`: vacío; `docker network ls --filter label=factory.managed=true -q`: vacío; `docker ps` sigue listando los 4 `kimmbo-prod-*`.

Decisiones fuera del encargo: el servidor estático lo pone el motor (`factory/preview/static-server.mjs`) en vez de `vite preview` (que bloquea hosts desconocidos); el producto no se monta en el contenedor de Playwright (solo recibe las rutas por entorno); el Postgres de la captura es propio (no reutiliza el contenedor del runner, para poder hacer teardown sin tocar el de checks), reutilizando los mismos ajustes; la evidencia se guarda en `runs/<id>/ui/<commit>/` y un evento `task.ui_evidence` (sin tipo de artefacto nuevo ni migración); `PreviewPolicy` es opcional en `checks.json`.

Límites de H4b:

- Los revisores UX/UI nunca se ejecutaron con el `claude` real (solo proveedor guionizado); los prompts no se validaron con un modelo.
- La rama `api` del preview solo estaba probada con Docker simulado y argv (resuelto en H4c con Docker real).
- La accesibilidad automatizada no es cumplimiento completo; foco solo en los primeros 10 elementos; dos viewports; sin flujos con interacción ni autenticados.
- La red de la captura no bloqueaba la salida a internet (resuelto en H4c para el runtime).
- La primera captura descarga la imagen de Playwright (≈ 2,5 GB) dentro del timeout; conviene `docker pull` previo.

TDD: los tests de dominio UI, del preview Docker simulado y del bucle se escribieron antes y se observó rojo (módulo/comportamiento ausente). Desviaciones: `test/docker-preview-argv.test.ts` se escribió primero pero la implementación se añadió antes de ejecutarlo (sin rojo observado); `test/ui-gate.test.ts` quedó verde a la primera porque el gate ya era genérico por áreas; el test Docker real y los prompts se escribieron junto con la implementación; las expectativas de `test/review-loop.test.ts` se actualizaron a cuatro áreas tras el cambio.

## H4c — resultado

Funciona (ADR 0013, ampliación H4c): endurecimiento de la captura de navegador tras la verificación independiente de H4b y captura autenticada para TurnoLocal (PRD REQ-001/REQ-006).

| Hallazgo | Corrección | Test |
|---|---|---|
| 1 Directorio estático como symlink (MEDIO) | `lstat` debe ser directorio real, `realpath` dentro del snapshot y se monta el `realpath`; raíz del producto también con `realpath` | `test/docker-preview.test.ts` (symlink a host y symlink en el padre); `test/docker/preview.docker.test.ts` («rejects a static dir that the build replaced with a symlink…», Docker real) |
| 2 Aplicabilidad (MEDIO) | `static-landing`: todo salvo `*.md`, `docs/**`, `LICENSE`; `apiweb`: `web/**`, archivos raíz de build/config y workspaces distintos de `api/` | tablas en `test/ui-domain.test.ts` |
| 3 Salida de red (MEDIO) | red `-net` (con salida) solo para install/build/api-build; red `-int` (`--internal`) para Postgres, migrate, seed, api, servidor estático y Playwright | `test/docker-preview-argv.test.ts`, `test/docker-preview.test.ts`; Docker real: «the runtime network is internal…» (api/step alcanza Postgres, `1.1.1.1:443` no) |
| 4 Colisión de nombres (BAJO) | `shots/<índice>-<slug>-<rol>-<ancho>x<alto>.png` (`factory/preview/names.mjs`); el contrato rechaza rutas duplicadas | `test/preview-names.test.ts`, `test/ui-domain.test.ts`, `test/docker-preview.test.ts` |
| 5 Texto del producto (BAJO) | consola y etiquetas de foco fuera de `UI_EVIDENCE`, en `UI_PRODUCT_TEXT` (`dataBlock`, tope 4000 caracteres, topes por entrada en el contrato y el script) | `test/ui-domain.test.ts`, `test/ui-review-loop.test.ts` |
| 6 Confianza en la caché (BAJO) | sha256 de los archivos cacheados vs origen antes de cada captura; diferencia = `unavailable` | `test/docker-preview.test.ts` («refuses to run tools whose cached copy…») |
| 7 Captura autenticada | `web/ui-auth.json` (Zod estricto), rutas `{path, as}`, login por rol con `getByLabel`/`getByRole`, verificación (URL ≠ login y sin `role=alert`), entradas `unavailable` si falla; evidencia con `as`/`authenticated`; cobertura en los prompts; entradas `unavailable` = evidencia incompleta = ux/ui `blocked` | `test/ui-domain.test.ts`, `test/ui-review-loop.test.ts` (E15), `test/docker-preview.test.ts`; Docker real: login correcto capturado con `authenticated: true`, contraseña errónea `unavailable` |
| 8 Proxy `/api` | servidor estático del motor reenvía `/api/*` (sin prefijo) al api de la red interna; límites de tamaño/tiempo, ruta normalizada, destino único | `test/preview-static-server.test.ts` (12 tests con servidor real y upstream local); Docker real (login vía proxy con cookie) |
| 9 Rama `api` en Docker real | política `preview.api` del esqueleto (build, `db:deploy`, start, `/health/ready`), `CORS_ORIGINS` = origen de la web | `test/docker/preview.docker.test.ts` (esqueleto con Postgres + migrate + api + web + proxy, captura de `/`) |

Cobertura de captura autenticada: la fixture de prueba (copia del esqueleto con una página `/login`, una `/tickets` protegida, un servidor de api mínimo y una semilla con un usuario) demuestra extremo a extremo: login por etiquetas accesibles, cookie de sesión a través del proxy `/api`, pantalla protegida capturada en ambos viewports con `authenticated: true`, y un segundo rol con contraseña errónea que queda `unavailable` sin captura. El `storageState` solo vive en memoria.

Comandos ejecutados (resultado observado):

- `npm run typecheck`: sin errores.
- `npm run lint`: 162 archivos, sin avisos.
- `npm test`: 39 archivos, 653 tests pasan y 1 se salta.
- `npm run test:docker`: 4 archivos, 17 tests pasan en 506 s (H4b: 14 tests, 428 s). Tiempo añadido por H4c ≈ 80 s: esqueleto con api ≈ 47 s en total (antes ≈ 35–50 s), captura autenticada ≈ 50 s, symlink ≈ 4 s, red interna ≈ 5 s.
- `docker ps -a --filter label=factory.managed=true -q`: vacío; `docker network ls --filter label=factory.managed=true -q`: vacío; `docker ps` sigue listando los 4 `kimmbo-prod-*`.

Decisiones fuera del encargo: `storageState` en memoria en vez de escribirlo en `/out` (evita dejar tokens de sesión en el directorio de evidencia); las credenciales llegan al navegador por variable de entorno pasada por nombre; cualquier entrada `unavailable` bloquea ux/ui en el motor (no se deja al criterio del revisor); el proxy elimina el prefijo `/api`; `api-build` pasa a la red con salida y sin `DATABASE_URL`; `migrate`/`seed` van en la red interna; no hizo falta excepción en el secret scan (la regla genérica no coincide con claves JSON entre comillas, hay test); aplicabilidad de workspaces por heurística de ruta (el motor no lee los workspaces del producto).

Límites de H4c:

- `install`/`build` del producto siguen con salida a internet (necesitan el registro); solo el runtime está aislado.
- La aplicabilidad de workspaces es heurística (primer segmento de la ruta); puede pedir evidencia de más, nunca de menos para los casos listados.
- El login se verifica solo por URL y ausencia de `role=alert`; un toast con `role=alert` posterior al login válido lo marcaría como fallido (queda `unavailable`, falla cerrado). Un login solo con selector sin etiqueta accesible no es soportado.
- La fixture usa un api mínimo propio, no el api de la plantilla con módulo de usuarios; las credenciales de `ui-auth.json` viajan en el repositorio y en el diff de revisión (solo de prueba).
- Los revisores UX/UI siguen sin ejecutarse con el `claude` real.

TDD: las tablas de dominio (`ui-domain`), el proxy estático, los argv de red y los tests del preview Docker simulado y del bucle se escribieron antes y se observó rojo. Desviaciones: el contrato `ui-evidence` y `domain/review/ui.ts` se implementaron antes de la primera ejecución de sus tests (rojo no observado, se corrigieron 2 fallos de los propios tests tras la implementación); `test/preview-names.test.ts` se escribió después de `names.mjs` (verde a la primera); los tests Docker reales se escribieron junto con la implementación (el de red interna falló una vez por no esperar a Postgres y se corrigió en el test); `capture.mjs` solo se ejercita con Docker real.

### H4c — verificación independiente (PASS_WITH_FINDINGS, sin altos ni medios)

- Proxy `/api` sondeado con un upstream simulado: traversal, prefijos, absolute-form, `Host`, smuggling CL+TE, CRLF y límites de tamaño se comportan bien; sin SSRF.
- Corregido por el coordinador (medio-bajo): una ruta con rol que redirigía a una página distinta del login se capturaba como si fuera la pantalla del rol. Ahora `capture.mjs` exige que la ruta final sea la pedida; si no, la entrada queda `unavailable` («redirected away»). Test real en Docker: `test/docker/preview.docker.test.ts` añade `/backoffice` (redirige a `/`) → `unavailable`; el test pasa. Rojo no observado (el cambio se razonó; ejecutar la versión anterior cuesta ~2 min de Docker).
- Bajos aceptados: `Connection` no elimina las cabeceras que nombra; el timeout del proxy es de inactividad; Postgres de preview sin `--cap-drop`; la regla genérica de secretos no detecta `"password": "..."` en JSON (las cuentas de `ui-auth.json` son solo de prueba por diseño); heurística de aplicabilidad no cubre archivos de UI sueltos en la raíz.

## H5 — resultado

Migración 7 (`runs.budget_usd`, `budget_entries`, `role_attempts.failure_class/try_number`). Detalle de decisiones en `docs/adr/0014-budget-and-recovery.md`.

| Evaluación | Cobertura (tests) |
|---|---|
| E08 recuperación | `test/recovery.test.ts`: (a) caída durante la edición del builder, worktree sucio restaurado y sin commits duplicados; (a2) commit no registrado descartado; (b) caída tras el commit rojo y antes de registrar el check: se re-ejecuta sobre el mismo commit sin nueva llamada; (c) fallo de escritura en BD a mitad de la transacción: sin estado a medias; (e) reserva abierta por un proceso muerto cargada como desconocida y registrada. (d) merge hecho sin `DONE`: `test/build-loop.test.ts` (3 tests de H3b, sin cambios) |
| E10 presupuesto | `test/budget-ledger.test.ts` (reserva atómica, carga, liberación, desconocido, barrido), `test/budget-calls.test.ts` (ceiling por rol → `--max-budget-usd`, sin llamada si no cabe, `BLOCKED` + `--add`), `test/build-halts.test.ts` (parada en build y reanudación sin repetir llamadas) |
| E11 cuota/reintentos | `test/provider-quota.test.ts` (clasificación del mensaje real, `resets 7:30am (Europe/Madrid)`, DST, backoff), `test/claude-provider.test.ts` (sobre real con 429 y 529), `test/budget-calls.test.ts` (3 intentos, un reintento de timeout, `quota_wait`, `--force`, `waitUntil` nulo), `test/build-halts.test.ts` |
| E19 cancelación | `test/cancel.test.ts` (aborto del proveedor en vuelo, parada entre pasos, check de 60 s terminado por grupo de procesos), `test/claude-provider.test.ts` (señal), `test/cli.test.ts` (`budget`) |

Comandos y resultados observados: `npm run typecheck` sin errores; `npm run lint` sin hallazgos; `npm test` 45 archivos, 709 pasan, 1 omitido; `npm run test:docker` 4 archivos, 17 tests pasan (498 s); tras ellos `docker ps -a --filter label=factory.managed=true -q` y las redes con esa etiqueta vacíos y los 4 contenedores `kimmbo-prod-*` intactos.

Límites de H5:

- Cancelación probada con proveedor largo inyectado y un check real de 60 s (un solo proceso); no se probó con dos procesos CLI reales. La captura de evidencia de navegador (preview Docker) no es interrumpible a mitad: termina o vence por su timeout, y luego se desmonta por etiqueta.
- La hora de reinicio sin zona usa la zona local del proceso; el formato de `resets …` se conoce por un solo mensaje real observado.
- El coste informado puede superar la reserva (se carga lo informado y el restante puede quedar negativo); la reserva por rol son valores conservadores no medidos.
- El barrido de reservas huérfanas usa el TTL del lease (45 min): una llamada legítima más larga que eso podría cargarse dos veces en un proceso concurrente (no ocurre con el timeout de 10 min).
- Las pruebas con `FakeProvider` cuentan `costUsd: null` como 0 (normalización del doble); el camino «coste desconocido» se prueba con un proveedor que lo anula.

### H5 — verificación independiente (PASS_WITH_FINDINGS, solo bajos)

- Confirmado: toda llamada al proveedor pasa por `guarded-invoke.ts` (sin bypass), reserva y cargo transaccionales, coste desconocido cargado como reserva completa, cuota agotada sin reintento, transitorios acotados, cancelación hasta el grupo de procesos, barrido conservador de reservas huérfanas.
- Coordinador: `parseResetTime` probado con los dos mensajes reales observados hoy («resets 4pm (Europe/Madrid)» → 14:00Z; «resets 7:30am (Europe/Madrid)» → 06:30Z del día siguiente, ya en horario de invierno).
- Bajos aceptados: sin evento explícito de sobregasto (se ve como presupuesto negativo); si `invoke` lanzara excepción la reserva queda abierta hasta el barrido de 45 min; la espera del backoff no es abortable (hasta 60 s); el barrido usa `createdAt`, no el heartbeat; `budget --add` desbloquea un `quota_wait` aunque no haya llegado `waitUntil` (intencional según ADR 0014).

## H6-prep — resultado

Preparación de H6 (ADR `docs/adr/0015-delivery-report-audit.md`): informe por run, entrega local, orquestación en un comando, auditoría de solo lectura y release con smoke. Falta la demo real TurnoLocal con el proveedor real.

Comandos nuevos (detalle en `docs/operations/cli.md`): `factory report`, `factory deliver`, `factory run`, `factory audit`, `factory release prepare`; `factory status` muestra el estado de entrega y la ruta del informe. Exit 3 solo en `run` (pausa por presupuesto, cuota o límite).

| Evaluación | Cobertura | Test |
|---|---|---|
| E01 (parcial) | PRD → producto entregado en `main` con informe, solo con proveedor guionizado; no es la demo real | `test/run-all.test.ts` «chains start, plan, build and deliver», `test/docker/builder.docker.test.ts` (entrega en Docker real) |
| E17 auditoría | HEAD, `git status`, índice y sha256 de cada archivo (incluidos cambios sin commit y archivos sin rastrear) idénticos tras auditar; un escritor inyectado produce `target_mutated` con el diff (también cuando `git status` no cambia); sin sello; sin refresco del índice | `test/audit.test.ts`, `test/cli-delivery.test.ts` |
| E20 smoke de release | Smoke fallido → `FAILED_SMOKE`, rollback registrado con los pasos del runbook, run `BLOCKED`, nunca sano ni `SUCCEEDED`; smoke correcto → sano; `release.enabled=false` por defecto rechaza | `test/release.test.ts` (adaptador falso) |
| Informe | Golden con un requisito bloqueado («no entregado») y otro sin tareas («sin evidencia»); etiquetado de proveedor falso, runner sin aislamiento y coste desconocido; determinismo; evidencia de navegador | `test/report.test.ts`, `test/golden/run-report.md` |
| Entrega | `main` con integración + commit del informe, check final ligado al commit de merge de `main`; fallo del check en `main` o del commit del informe → no `SUCCEEDED` y reanudable; idempotente; checkout restaurado en `main` | `test/deliver.test.ts` |
| Orquestación | Parada por presupuesto y por cuota con el comando exacto y reanudación con el mismo comando sin repetir llamadas | `test/run-all.test.ts` |

Comandos y resultados observados:

- `npm run typecheck`: sin errores.
- `npm run lint`: 202 archivos, sin hallazgos.
- `npm test`: 51 archivos, 746 pasan, 1 omitido (H5: 709).
- `npm run test:docker`: 4 archivos, 17 tests pasan en 598 s; el test de aceptación del builder ahora termina con `deliverRun` en Docker real sobre el esqueleto fullstack (4 checks aislados `npm ci` / `npm run check` sobre el commit del informe y el merge de `main`); ese archivo solo: 358 s.
- Tras Docker: `docker ps -a --filter label=factory.managed=true -q` y `docker network ls --filter label=factory.managed=true -q` vacíos; los 4 contenedores `kimmbo-prod-*` siguen en ejecución.

Límites de H6-prep:

- Todo con proveedor guionizado; ningún revisor, builder ni `--review` de auditoría se ejecutó con el `claude` real. La entrega solo se probó en Docker con el esqueleto fullstack (no con `static-landing`) y con un producto local sin remoto (no se hizo push ni PR).
- El informe versionado en el producto no puede contener los checks de entrega ni el commit de `main` (aún no existen); `factory report` los muestra.
- `deliver` escribe en el checkout de `factory/integration` en vez de un worktree (git no permite dos copias de la misma rama).
- El adaptador real de despliegue está fuera de alcance; no hay comando CLI de despliegue.
- La auditoría audita el commit HEAD (no el árbol sucio), rechaza repositorios con `.git` como archivo y crea un pseudo-run `aud_…` (cerrado como `CANCELED`) para el libro de presupuesto; con runner `host` el código auditado corre sin aislamiento (queda anotado en el informe).
- `run` reanuda runs activos con el mismo PRD y destino; tras `CANCELED`/`FAILED` crea otro. `--budget-usd` solo cuenta al crear el run.

TDD: informe, entrega, orquestación, auditoría y CLI se escribieron con el test antes y se observó rojo por módulo inexistente (no por aserciones). Desviaciones: `captureTargetState`, `diffTargetState`, `createReadOnlyGit` y las adiciones a `GitPort` (`statusPorcelainV2`, `listFiles`, `remoteNames`) se escribieron antes de su test (verde a la primera); `release.ts` y `deliver` salieron antes que `test/release.test.ts`; el único rojo por aserción fue el de coste desconocido del informe, un error del propio test (el proveedor falso normaliza `null` a 0) corregido inyectando un cargo `unknown_reservation`; `test/golden/run-report.md` se generó con la primera ejecución y se revisó a mano.

## Plantilla mobile

Plantilla `mobile` (preset `mobile-expo`): Expo SDK 58, React Native 0.88.0, React 19.3.0 y React Native Web 0.21.4 (versiones de `bundledNativeModules.json` de `expo@58.0.19`, fijadas exactas). Detalle en ADR 0007.

- Unit: `npm run typecheck`, `npm run lint` y `npm test` en verde (772 tests unit).
- Docker: `npx vitest run --project docker test/docker/skeleton.docker.test.ts -t mobile` (`npm ci` + `npm run check` en el runner, ~57 s) y `npx vitest run --project docker test/docker/preview.docker.test.ts -t mobile` (`build:web` + captura 390/1440, 2 PNG, axe presente, ~50 s). Sin objetos `factory.managed` residuales; `kimmbo-prod-*` intactos.
- Límites: sin tests de componentes; el comportamiento solo nativo requiere revisión manual; combinación con backend sin plantilla todavía.

## Límites conocidos

- `--max-budget-usd` del CLI se comprueba después de la llamada; desde H5 el motor reserva antes (ADR 0014) y lo pasa solo como red secundaria.
- Sin `ANTHROPIC_API_KEY`: `--bare` no disponible.
- Playwright no instalado; Docker (Desktop) probado en H3a.
- TypeScript 7.0.2 validado en H1 con vitest 5.0.5 y tsx 4.23.15 (ver ADR 0004).
- `evidence/transcripcion-automatica.md` y el `.srt` no están en el repo todavía.

## Evaluaciones E01–E20

Parciales (motor/planificación con proveedor falso): E02, E03, E04, E08, E09, E12, E13/E18, E16, E19. H6-prep añade E17 y E20 (motor, sin proveedor real; ver «H6-prep — resultado»). E05 y E07 cubiertas en H3b (bucle del builder, con proveedor guionizado); E14 solo detección (sin resolución). Detalle por hito arriba. El resto no está implementado.

## Siguiente paso

### Validación de punta a punta con el proveedor real (2026-10-24) — **SUPERADA**

Run `run_d937a9a7…` con `factory/examples/PRD-MINI-LANDING.md` → `SUCCEEDED` (delivery local) en `~/Projects/landing-mini`: 5 tareas `DONE` con rojo/verde observado por el motor en Docker, cuatro revisores reales (seguridad, código, UX y UI con capturas de navegador 390/1440 px y axe), approver, integración y entrega a `main` (`c5df65a`) con `docs/verification/factory-report.md` (REQ-001..003 «entregado»). Verificación del coordinador: `npm run check` del producto → 50 tests, 0 fallos; árbol limpio. Coste informado: USD 7,42 a precio de lista (cuota Pro), con una pausa por cuota (reanudada a la hora indicada) y dos por presupuesto.

Defectos que solo apareció el proveedor real, todos corregidos con test primero:

1. El CLI devuelve `"api_error_status": null` → el sobre se rechazaba (schema admite ahora `null`).
2. Bajo `$HOME` el CLI cargaba ~27k tokens de instrucciones globales del usuario pese a `--setting-sources project` → `--safe-mode` (1,2k tokens, ~19× menos; confinamiento `--restricted` re-verificado con denegación real).
3. El arquitecto podía elegir una combinación de presets sin plantilla → gate en planificación + prompt con combinaciones válidas.
4. El `check` de `static-landing` no ejecutaba los tests → nunca había rojo; ahora `npm test` = `node --test` y `check` lo incluye.
5. Planner demasiado granular y con tareas de scaffold → `provides` del manifiesto de plantilla al planner + tope `max(3, 2×must)` tareas.
6. Reparación pedida por el approver solo por hallazgos menores rompió código aprobado → ya no dispara reparación (ADR 0012 §6b revisado).
7. Topes por llamada exagerados (builder 3 USD) → calibrados con 51 llamadas reales (~2× máximo observado); los tests usan su propia configuración fija.
8. El builder inventó el formato de `ui-routes.json` → la plantilla lo trae (`["/"]`), `AGENTS.md` lo documenta y los prompts del builder obligan a leer `AGENTS.md`; un `ui-routes.json`/`ui-auth.json` inválido bloquea como `ui_config_invalid` (reintentable); `retry --force` para override registrado del operador.

Decisión 2026-10-24: Gregory no ejecuta la demo TurnoLocal (estimado USD 30–50 a precio de lista de cuota Pro). Alternativa preparada, sin coste hasta que se lance: `factory/examples/PRD-MINI-LANDING.md` (3 requisitos, landing estática, ~2–3 tareas, estimado USD 3–6). Comando: `npm run factory -- run --prd factory/examples/PRD-MINI-LANDING.md --target ~/Projects/landing-mini --budget-usd 8`. Esa corrida es lo único que validaría el sistema completo con el proveedor real (builder + cuatro revisores reales nunca ejecutados juntos).

Comprobación del coordinador (sin LLM): `factory audit` sobre un repo con cambios sin commit y archivos sin seguimiento dejó HEAD, `git status`, hashes de archivos y `.git/index` idénticos; el informe marcó `checks_failed` (`npm ci` sin lockfile) sin maquillarlo.

Pendiente de Gregory: commit inicial del repositorio `rsc_factory` (todo está sin commit).

## P0 de seguridad, legal y diseño (2026-10-25)

Tres flujos paralelos fusionados en `integration-p0`. Verificado: typecheck, lint, 881 pruebas unitarias y 20 de Docker en verde. Sin objetos Docker de fábrica huérfanos; contenedores `kimmbo-prod-*` intactos.

- **A · API (`api`, `apiweb`)**: módulo `auth` (argon2id, tokens opacos hasheados, refresh rotado con detección de reutilización), rate limiting global y estricto en auth, denegación por defecto (`PUBLIC_API_ROUTES`, 404 uniforme en recursos ajenos), CSRF/Origin en cookies, cabeceras, timeouts. Los dos árboles `api/` son idénticos (test). Límite: el almacén de rate limit es en memoria; Redis queda documentado, no implementado. Registro con email repetido devuelve 409 (enumeración mitigada solo por rate limit).
- **B · Motor**: gate determinista de `npm audit` con baseline (`audit_new_vulnerability`, `audit_unavailable`; reintentable) y revisor `legal` (área nueva en G4: security, code, legal, ux, ui; aplicabilidad determinista). ADR 0016. Pendiente: baseline en `buildBootstrapOnly` y auditoría en cada merge por tarea.
- **C · Front y móvil**: CSP, páginas legales provisionales con `[PENDIENTE]`, tokens con modo oscuro, WCAG 2.2, componentes de estado, `check` que falla ante incumplimientos; móvil con `expo-secure-store` y validación de deep links. Los textos legales son estructura, no asesoría.
- **Fixture Docker del builder** actualizado a la composición nueva (ping protegido por defecto) y a la auditoría de entrega.
- **Pendiente**: los tests Docker usan ids fijos (`factory-run_2-*`) y chocan si corren dos suites a la vez; hacerlos únicos por worktree. P1/P2 del análisis y H7 (segundo proveedor, ver ADR pendiente) sin empezar.

## H7: segundo proveedor Codex y respaldo por rol (2026-10-25)

- **H7** (`4305636`): proveedor Codex CLI; `roles.json` con `{provider, model, effort?, fallback?}` por rol. Cerebro (spec-writer, architect, planner, approver): Claude Opus; builder, reviewers security/code/legal y refuter: Claude Sonnet; reviewers UX/UI: Codex `gpt-6-astra` medium. ADR 0017. Codex cuesta 0 USD en el ledger; tope `maxCodexCallsPerRun` (12, estimado).
- **H7b** (`d550d26`): toda llamada a Codex corre en contenedor Docker endurecido (rootfs de solo lectura, sin capacidades, solo el proyecto y una copia de `auth.json`); sin Docker falla cerrado. Riesgo aceptado: red abierta. ADR 0018.
- **H7c** (`6dc6e4a`): respaldo automático de un salto (cerebro → Codex `gpt-6-astra` high; Sonnet → Codex `gpt-6-sol`; UX/UI → Claude Sonnet) ante binario/sesión/modelo no disponible, cuota agotada o errores repetidos; no ante salida inválida ni presupuesto. Evento `provider.fallback`. ADR 0019.
- **Sin probar**: un builder Codex real (solo confinamiento verificado), el mensaje real de cuota agotada de Codex y patrones de error de Claude (supuestos).
