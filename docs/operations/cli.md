# CLI de la factory (H6-prep)

## Instalación

Requisitos: Node >= 22 (ver `.nvmrc`), git. `claude` (2.1.258 verificado), Docker y Playwright se comprueban con `doctor`. Docker es necesario para el runner aislado de `build` (ver «Runner de checks»).

```bash
npm ci
npm run factory -- doctor
```

Dentro de este repositorio el comando se ejecuta como `npm run factory -- <comando>` (usa `tsx`). Tras `npm run build`, el binario `factory` apunta a `dist/cli/main.js`.

## Configuración

| Variable | Por defecto | Uso |
|---|---|---|
| `FACTORY_HOME` | `<cwd>/.factory` | Base de datos (`factory.db`) y copias inmutables de PRD en `runs/<runId>/input/prd.md` |
| `FACTORY_CLAUDE_BIN` | `claude` | Ejecutable del proveedor Claude (lo usa `plan`) |
| `FACTORY_PROVIDER` | `claude` | `claude` (real) o `fake` (solo pruebas; ver abajo) |
| `FACTORY_FAKE_FIXTURES` | — | Directorio con `spec-writer.json`, `architect.json`, `planner.json` (y, opcionales, `builder.json`, `reviewer-security.json`, `reviewer-code.json`, `reviewer-ux.json`, `reviewer-ui.json`, `review-refuter.json` y `approver.json`); obligatorio si `FACTORY_PROVIDER=fake` |
| `FACTORY_CONTEXT_PACK_MAX_BYTES` | `61440` | Límite del ContextPack por tarea |
| `FACTORY_REPAIRS_PER_TASK` | `2` | Reparaciones por tarea (0 a 5), compartidas entre reparaciones del verde y de hallazgos de revisión |
| `FACTORY_MAX_TASK_RETRIES` | `2` | Reintentos manuales (`factory retry`) por tarea (0 a 10) |
| `FACTORY_RUNNER` | automático | `docker` o `host`. Sin valor: `docker` si `docker info` funciona, `host` si no (con aviso). `docker` explícito nunca cae a `host` |

La configuración se valida con Zod en `src/config/env.ts`; es el único módulo que lee `process.env`.

## Comandos

| Comando | Efecto |
|---|---|
| `factory doctor` | Comprueba Node, git, `claude --version` contra la matriz (aviso si difiere), Docker y Playwright (aviso si faltan), escritura en `FACTORY_HOME` y migraciones aplicadas |
| `factory start --prd <ruta> --target <dir> [--project <nombre>] [--new] [--budget-usd <n>] [--delivery local\|production] [--json]` | Valida el PRD, calcula sha256, guarda una copia de solo lectura, valida el destino y crea el run en `CREATED`. Si ya hay un run no terminal del mismo proyecto con el mismo hash, lo reutiliza y lo indica (si `--delivery` difiere falla con `delivery_mismatch`; si `--target` difiere, con `target_mismatch`); `--new` fuerza uno nuevo. `--budget-usd` fija el presupuesto del run (por defecto `defaultRunBudgetUsd` de `factory/config/budget.json`, 15) |
| `factory plan <runId> [--force] [--json]` | Lleva el run `CREATED → INGESTING → SPECIFYING → PLANNING` y siembra el DAG de tareas. Idempotente y reanudable: salta las fases con artefacto verificado por hash y no vuelve a llamar al proveedor. Salida con código 1 si el run queda `BLOCKED` |
| `factory status <runId> [--json]` | (H5: presupuesto del run — total, cargado informado, cargado desconocido, reservado, restante —, llamadas por rol, reintentos y, si aplica, la espera de cuota `waitUntil`; también en `--json` como `budget` y `quotaWait`.) (H4a: por tarea revisada muestra veredicto por área, hallazgos críticos/altos abiertos, refutados y menores, y la ruta del artefacto `blocked-diff` de las tareas bloqueadas.) Estado del run, versión de spec, nº de requisitos, supuestos y contradicciones (críticas marcadas), presets, tareas por estado (con las bloqueadas y su causa), últimos 10 eventos y siguiente paso |
| `factory build <runId> [--force] [--max-tasks N] [--max-provider-calls N] [--json]` | Bucle del builder (ADR 0010). Si el run está en `PLANNING`, hace el bootstrap (si no estaba), lo pasa a `BUILDING` y deja el repo del producto en la rama `factory/integration`. Procesa secuencialmente las tareas `READY`: worktree, llamada de rojo, rojo observado por el motor, llamada de verde, `check` completo, reparaciones (`FACTORY_REPAIRS_PER_TASK`), **revisión** (H4a, ADR 0012: revisores de seguridad y de código de solo lectura, refutador, approver y gate G4; los hallazgos críticos/altos abiertos disparan una reparación con el mismo presupuesto y una nueva revisión del commit nuevo), merge `--no-ff` bajo lock y check sobre la nueva cabeza de integración; solo entonces `DONE`. Se detiene sin tareas `READY`, con `--max-tasks`, o antes de superar `--max-provider-calls` (por defecto 40; las tareas vuelven a `READY` con su fase guardada). Con todas `DONE` pasa por `VERIFYING → REVIEWING → INTEGRATING`, ejecuta el check final y deja el run en `READY_FOR_RELEASE`. Exit 1 si hay tareas `BLOCKED`, falla el check final o el build se detiene por `budget_exhausted`, `quota_wait` o `run_canceled`. Es reanudable: tras una interrupción, `factory resume <runId>` (cuando expire el lease) y `factory build <runId>` continúan desde la fase persistida |
| `factory build <runId> --bootstrap-only [--json]` | Revalida el destino, crea el esqueleto del producto (`factory/templates/`, commit `chore: scaffold from <id>`; si ya existe y su commit sigue en el repo, lo salta) y ejecuta `npm ci` y `npm run check` en la raíz del producto con el runner elegido. Registra cada check (tabla `checks`) y el evento `check.recorded`. Exit 1 si algún check falla: no se marca nada como superado y el run sigue en `PLANNING` |
| `factory retry <runId> <taskKey> [--note <texto>] [--json]` | Reencola una tarea `BLOCKED` cuya causa es reintentable (`review_findings_open`, `repairs_exhausted`, `green_not_reached`, `red_not_observed`, `red_not_test_only`, `protected_change`, `tests_tampered`, `integration_check_failed`, `merge_conflict`): la pasa a `READY`, borra su fase de build (nueva rama `factory/task/<key>-r<n>` desde la cabeza de integración actual) y conserva eventos, checks, reviews, hallazgos y artefactos. Máximo `FACTORY_MAX_TASK_RETRIES` (2) por tarea; después `retry_limit`. `--note` (hasta 2000 caracteres) llega al builder como «Operator guidance», entrada de confianza del operador separada de los datos del PRD. Otras causas (p. ej. `review_blocked`, `approver_blocked`, `builder_blocked`) devuelven `retry_not_allowed`. Después, `factory build <runId>` |
| `factory resume <runId> [--force]` | Reconcilia (también reservas de presupuesto abiertas y vencidas, que se cargan como desconocidas; un run `BLOCKED` por `quota_wait` se desbloquea si pasó `waitUntil`, y antes falla con `quota_wait` salvo `--force`): leases vencidos (en cualquier estado que sostiene lease) vuelven a `READY` (intento marcado `interrupted`), tareas `PENDING` con dependencias `DONE` pasan a `READY`; las `DONE` no se tocan. Rechaza runs terminales; no desbloquea runs `BLOCKED` |
| `factory budget <runId> --add <usd> [--json]` | Suma presupuesto al run. Si estaba `BLOCKED` por `budget_exhausted` o `quota_wait`, lo devuelve a su estado previo; después `factory build` / `factory plan` continúan desde las fases persistidas sin repetir llamadas completadas (ADR 0014) |
| `factory cancel <runId>` | Run a `CANCELED`; tareas no terminales (incluidas las arrendadas) a `CANCELED` en la misma transacción. No se pueden obtener leases después. Si un `factory build` corre en otro proceso, se detiene antes del siguiente paso, termina el grupo de procesos del proveedor/check en curso, desmonta los contenedores por etiqueta y registra `build.canceled` con los commits y merges ya hechos (stopped because `run_canceled`) |
| `factory report <runId> [--json]` | Informe trazable requisito → tareas → commit de integración → checks (argv, exit, commit, log y sha256) → revisiones y hallazgos por severidad (refutados, aceptados abiertos) → evidencia de navegador (capturas, axe, roles autenticados) → supuestos, contradicciones, reintentos, presupuesto (informado vs desconocido), proveedor por fase, aislamiento del runner, limitaciones y siguiente paso. Se construye solo desde la base de datos y los artefactos; salida determinista. Un requisito sin evidencia aparece como «no entregado» o «sin evidencia», nunca como hecho. Etiqueta explícitamente proveedor FALSO vs real y runner aislado vs host (ADR 0015) |
| `factory deliver <runId> [--json]` | Entrega local (ADR 0015). Exige run `READY_FOR_RELEASE` y un check final superado sobre la cabeza exacta de `factory/integration`. Escribe `docs/verification/factory-report.{md,json}` y `docs/operations/release.md` en el producto con el commit `docs(verification): factory report for <runId>`, repite el check completo sobre ese commit, hace `merge --no-ff` de integración en `main` bajo el lock de merge, ejecuta el check completo sobre el commit de merge de `main` y solo entonces deja el run en `SUCCEEDED` con `delivery=local`. Cualquier fallo deja el run en `READY_FOR_RELEASE` con la causa (`delivery_report_check_failed`, `delivery_main_check_failed`, `final_check_missing`, `delivery_merge_conflict`) y es reanudable. Idempotente. Restaura el checkout del producto en `main`. No hace push ni PR: si el producto tiene remoto, imprime los comandos que podrías ejecutar. `delivery=production` se rechaza |
| `factory run --prd <ruta> --target <dir> [--project <n>] [--budget-usd N] [--max-provider-calls N] [--max-tasks N] [--force] [--json]` | Un solo comando: `start` (con deduplicación), `plan`, `build`, `deliver`. Reanudable: volver a ejecutar el mismo comando continúa donde quedó, sin repetir llamadas completadas; con un run ya entregado informa «ya entregado». Se detiene sin reintentos en bucle ante presupuesto, cuota, límites o bloqueos y escribe el comando exacto siguiente. Códigos de salida: ver «Códigos de salida» |
| `factory audit --target <repo> [--review] [--budget-usd N] [--json]` | Auditoría de solo lectura (E17, ADR 0015): registra el estado previo (HEAD, `git status --porcelain=v2`, sha256 de archivos rastreados y no ignorados sin rastrear), ejecuta los checks de la plantilla detectada (`template.json`) o `npm ci` + `npm test` sobre un snapshot de HEAD con el runner elegido, opcionalmente los revisores de seguridad y código de solo lectura (`--review`, con coste en un pseudo-run de auditoría), escribe `FACTORY_HOME/audits/<id>/report.{json,md}` y vuelve a capturar el estado: cualquier diferencia → resultado `target_mutated`, exit 1 y el diff. No escribe en el objetivo ni exige sello |
| `factory release prepare <runId> [--json]` | Guarda en `FACTORY_HOME` el plan de release (`release-plan`) y el texto del runbook. `deliver` commitea el runbook en el producto. La publicación a producción sigue desactivada (`factory/policies/release.json`, `enabled: false`); no existe comando de despliegue (el adaptador real está fuera de alcance) |

El contenido del PRD se trata solo como dato.

## Destino (`--target`)

Obligatorio al crear un run. Se resuelve con `realpath` (si no existe, el ancestro existente más cercano más el resto; los symlinks colgantes se siguen). Se rechaza con `target_inside_factory` si coincide con, está dentro de o contiene el repositorio de la factory o `FACTORY_HOME`, incluso mediante symlinks o symlinks en ancestros. Puede no existir (`new`), ser un directorio vacío (`empty`) o un repositorio git existente (`git_repo`: el descubrimiento de su código llega en H3); un directorio no vacío sin `.git` falla con `target_not_empty`. H2 no crea ficheros en el destino.

## Runner de checks (H3a)

`build` ejecuta los comandos del producto a través de un `CheckRunnerPort` con `argv` (nunca cadenas de shell), `cwd` autorizado, timeout y log completo en `<FACTORY_HOME>/runs/<runId>/checks/<checkId>.log` (el resultado devuelve los últimos 4 KB y el sha256 del log).

- **Docker (aislado, por defecto):** por run se crea la red `factory-<runId>-net` y un Postgres `factory-<runId>-pg` (`postgres:16-alpine`, contraseña aleatoria por run, base `<slug>_test`, datos en `tmpfs`, `pg_isready` por `docker exec` sobre ese contenedor). Cada check es un `docker run --rm` efímero (`node:22.23.2-bookworm-slim`, digest en `docs/compatibility/matrix.md`) con solo el worktree montado en `/work`, `--cap-drop ALL`, `no-new-privileges`, límites de memoria y procesos, sin publicar puertos, sin socket Docker, sin el home. Todo objeto lleva el prefijo `factory-` y las etiquetas `factory.managed=true` y `factory.run=<runId>`; la limpieza (`teardown`, ejecutada al terminar `build`) selecciona **solo** por etiqueta y se niega a borrar nada cuyo nombre no empiece por `factory-`. El timeout mata únicamente el contenedor de ese check.
- **Host (sin aislamiento):** mismo contrato, el código generado corre en esta máquina con un entorno mínimo (`PATH`, `HOME`, `TMPDIR`, `LANG`, variables de Docker). El resultado y el informe de `build` lo marcan `NO ISOLATION`; `doctor` lo advierte. No levanta Postgres: se espera (no verificado) que el `check` del esqueleto full-stack falle en los tests del API, porque su guard exige `TEST_DATABASE_URL`, salvo que el entorno ya aporte una base de pruebas.
- **Docker Desktop:** solo se pueden montar rutas bajo el home del usuario; un `--target` o `FACTORY_HOME` bajo `/tmp` hace fallar el contenedor con exit 125 (el informe lo indica). En Docker Desktop el contenedor corre como `root` (equivalente al usuario del host en disco) y en un motor nativo como `uid:gid` del host.
- **Evidencia:** cada check se ejecuta sobre un snapshot del commit `HEAD` (sin `.git`, borrado al terminar; ADR 0008) y guarda ese `commit_sha`. `isCheckEvidenceValid(check, sha)` existe y está probada, pero todavía **no se aplica** en ninguna decisión del motor (llega con H3b).

## Pruebas

| Comando | Qué ejecuta |
|---|---|
| `npm test` | Proyecto `unit` de vitest (rápido; sin Docker) |
| `npm run test:docker` | Proyecto `docker`: runner real (`HostRunner` y `DockerRunner`, timeout, teardown solo por etiqueta), **aceptación del bucle del builder** (una tarea `ping` sobre `apiweb`, proveedor guionizado, rojo y verde en Docker con Postgres, integración y `DONE`) y **aceptación de esqueletos** (fullstack y landing con `npm ci` + `npm run check` en Docker contra un Postgres real; inyección de un test que falla). Lento (≈ 2 min). Usa `~/.cache/gsf-docker-tests/` como zona temporal (Docker Desktop no comparte `/tmp`). Si `docker info` falla, los tests se saltan con un aviso explícito |

## Proveedor falso (solo pruebas)

`FACTORY_PROVIDER=fake FACTORY_FAKE_FIXTURES=<dir>` sustituye al proveedor Claude por respuestas guionizadas (`<rol>.json`: lista de `{"output": ..., "costUsd": ..., "writes": {"ruta/relativa": "contenido"}, "deletes": ["ruta"]}` — `writes`/`deletes` solo para `builder`: editan archivos dentro del `cwd` de la petición, con la misma comprobación de rutas seguras que `expectedPaths` y sin atravesar symlinks — o `{"failure": {"kind", "retryable", "message"}}`, una por llamada). No se activa en silencio: exige las dos variables explícitas, `plan` imprime un `WARNING` por stderr, `doctor` lo marca con `WARN provider`, y cada evento `role.called` registra `provider: "fake"`. Las fixtures de la demo están en `test/fixtures/demo/`.

## Presupuesto, cuota y reintentos (H5)

`factory/config/budget.json` (validado con Zod, ceiling por rol en USD: `maxCallUsd`; `retry`: `maxAttempts` 3, `baseMs` 2000, `capMs` 60000; `defaultRunBudgetUsd`). Cada llamada reserva su ceiling, lo pasa como `--max-budget-usd` y carga el coste informado (o la reserva entera si no hay). Sin saldo: sin llamada, run `BLOCKED` (`budget_exhausted`) y siguiente paso `factory budget <runId> --add <usd>`. Cuota agotada: run `BLOCKED` (`quota_wait`) con `waitUntil`; 429/529 transitorios se reintentan hasta 3 veces con backoff y full jitter; un timeout se reintenta una vez.

## Códigos de salida

| Código | Significado |
|---|---|
| 0 | Operación correcta (en `doctor`, sin fallos duros; los avisos no cuentan; en `run`, entregado en `main` con `delivery=local`; en `audit`, objetivo intacto y checks superados u omitidos) |
| 1 | Fallo de la operación (run inexistente, PRD inválido, transición inválida, `doctor` con fallo duro; en `run`, `blocked`/`failed`/`canceled`; en `audit`, `target_mutated` o checks fallidos) |
| 2 | Uso incorrecto de la CLI o configuración inválida |
| 3 | Solo `factory run`: pausa que requiere acción del operador (`paused_budget`, `paused_quota`, `paused_limit`); el siguiente comando exacto se imprime |

Los errores se escriben en stderr como `error [codigo]: mensaje`.

## Cómo usar la factory con un PRD nuevo

1. Escribe el PRD en Markdown (formato: `templates/PRD-PRODUCTO.md`; ejemplo: `templates/PRD-DEMO.md`). Es entrada no confiable: solo se trata como dato.
2. Comprueba el entorno: `npm run factory -- doctor`. Para checks aislados necesitas Docker; sin él el runner cae a `host` (sin aislamiento, con aviso).
3. Lanza todo el flujo con un comando, con un presupuesto que aceptes gastar:

   ```bash
   npm run factory -- run --prd ruta/al/prd.md --target ~/productos/mi-producto --budget-usd 15
   ```

   El destino debe estar bajo tu home si usas Docker Desktop. `--max-tasks` y `--max-provider-calls` acotan cada pasada de `build`.
4. **Presupuesto agotado** (exit 3, `paused_budget`): el run queda `BLOCKED` con todas sus evidencias. Suma presupuesto con `npm run factory -- budget <runId> --add 10` y repite **el mismo comando `run`**; continúa sin repetir llamadas.
5. **Cuota del proveedor** (exit 3, `paused_quota`): se imprime la hora de reinicio (`waitUntil`). Repite el mismo comando `run` cuando pase (o con `--force`).
6. **Tarea bloqueada** (exit 1, `blocked`): `npm run factory -- status <runId>` muestra la causa por tarea; si es reintentable, `npm run factory -- retry <runId> <taskKey> --note "guía"` y repite `run`. Un check final fallido deja el run `BLOCKED` sin entregar nada.
7. **Resultado** (exit 0): el producto está en `main` del `--target`, con el informe en `docs/verification/factory-report.md` (y `.json`) y el runbook de release en `docs/operations/release.md`. Lee el informe también con `npm run factory -- report <runId>`: dice qué proveedor (falso o real) y qué runner (aislado o host) produjeron la evidencia, qué requisitos están «sin evidencia» o «no entregados» y qué evidencia se omitió.
8. La factory no hace push, no abre PR ni despliega. Si el producto tiene un remoto, `deliver` imprime los comandos que podrías ejecutar tú.

Para analizar un repositorio existente sin tocarlo: `npm run factory -- audit --target ~/ruta/repo [--review]`.

## Límites de H6-prep

- Entrega, informe, `run`, auditoría y release se probaron con el proveedor guionizado y runner `host` en pruebas unitarias; la entrega también en Docker real sobre el esqueleto fullstack (`npm run test:docker`). No hay corrida con el `claude` real ni demo TurnoLocal.
- `factory run` reutiliza un run activo con el mismo PRD y destino; un run `CANCELED` o `FAILED` no se reanuda (se crea otro). `--budget-usd` solo aplica al crear el run.
- La auditoría analiza el commit HEAD en un snapshot; no audita cambios sin commit (solo comprueba que no se tocan). Rechaza repositorios cuyo `.git` es un archivo (worktrees enlazados).
- No hay despliegue real: `DeploymentPort` solo tiene un adaptador falso de pruebas (E20).

## Evidencia de navegador y revisores UX/UI (H4b)

`build` revisa cuatro áreas por commit: seguridad, código, UX y UI (ADR 0013). UX y UI solo aplican si el diff de la tarea toca la interfaz (`apiweb`: `web/**`, `package.json`/lockfile/`tsconfig*.json`/`biome.json`/`vite.config.*` de la raíz y cualquier workspace distinto de `api/`; `static-landing` y `mobile`: todo salvo `*.md`, `docs/**` y `LICENSE`); si no, quedan `not_applicable` con la razón «no UI changes» sin llamar al proveedor.

- Cuando aplican, el motor (con el runner Docker) construye el commit en contenedores, instala/construye en una red con salida y sirve la web, el api y Postgres en otra red `--internal` (sin puertos publicados ni salida a internet) y ejecuta Playwright (`mcr.microsoft.com/playwright:v1.64.1-noble`, fijada por digest) con el script `factory/preview/capture.mjs`: 390x844 y 1440x900, captura de página completa, axe-core, desbordamiento horizontal, foco con Tab y errores de consola. Rutas: `ui-routes.json` en la raíz web del producto (`["/"]` por defecto), con entradas `"/ruta"` o `{ "path": "/tickets", "as": "<rol>" }`.
- Pantallas con login: `web/ui-auth.json` (`loginPath`, etiquetas accesibles de usuario/contraseña, nombre del botón y `accounts` por rol, solo credenciales de prueba de la semilla del producto). El motor entra por rol en un contexto nuevo, verifica el login (URL ≠ `loginPath` y sin `role=alert`) y captura las rutas del rol (`authenticated: true`). Si el login falla, esas entradas quedan `unavailable` y UX/UI `blocked` (`incomplete browser evidence`). Ver ADR 0013 §9.
- El servidor estático de la captura reenvía `/api/...` (sin el prefijo `/api`) al api de la política; ver ADR 0013 §10.
- Salida: `<FACTORY_HOME>/runs/<runId>/ui/<commit>/ui-evidence.json` y `shots/*.png`, con sha256 de cada captura, hash del script y versiones. `factory status` muestra por tarea la ruta y los conteos (`axe_violations`, `overflow_pages`).
- Sin evidencia (runner `host`, Docker caído, imagen sin descargar, la app no arranca, timeout) el resultado es `unavailable`: UX y UI quedan `blocked` y la tarea `BLOCKED review_blocked`. Nunca pasa por defecto. Conviene `docker pull mcr.microsoft.com/playwright:v1.64.1-noble` de antemano (≈ 2,5 GB); una captura del esqueleto tarda ≈ 35–40 s.
- Cada llamada a un revisor UX/UI cuenta en `--max-provider-calls`. Los fixtures del proveedor falso aceptan `reviewer-ux.json` y `reviewer-ui.json`.

## Límites de H4b/H4c

- Los revisores UX/UI solo se ejecutaron con el proveedor guionizado, nunca con el `claude` real.
- La accesibilidad automatizada no garantiza cumplimiento completo; foco comprobado solo en los primeros 10 elementos; dos viewports; solo el login como interacción (sin otros estados que requieran interacción).
- Los pasos `install`/`build` del producto tienen salida a internet (registro de paquetes); solo el runtime está aislado en la red interna.

## Límites de H4a

- Los revisores, el refutador y el approver solo se ejecutaron con el proveedor guionizado; no hay corrida con el `claude` real (el perfil `--restricted --tools Read,Glob,Grep --permission-mode dontAsk` no se probó de extremo a extremo para estos roles).
- UX y UI se añadieron en H4b; el gate G4 exige hoy las cuatro áreas.
- El diff que reciben los revisores tiene un tope (200 KB): por encima la tarea queda `BLOCKED` con `diff_too_large`; no se trunca.
- `blocked-diff` guarda el diff del worktree (tope 512 KB, marcado si se truncó) tal cual, sin análisis de secretos; vive solo en `FACTORY_HOME`.

## Límites de H3b

- El builder real (`claude` con el perfil restringido) no se ejecutó en H3b: el bucle se probó con el proveedor guionizado. El rojo exige código de salida ≠ 0 del comando `test`, no un motivo concreto.
- Los cambios de configuración de checks distintos de `scripts/check-*.mjs` y de los `scripts` de `package.json` solo se marcan para revisión (`requires_review`); los revisores llegan en H4.
- Un `build` por run a la vez; la resolución de conflictos de merge y el desbloqueo de tareas `BLOCKED` no existen todavía.
- `VERIFYING` y `REVIEWING` del run se atraviesan sin trabajo real hasta H4.

## Límites de H3a
- Un destino que ya es repositorio git falla con `existing_repo_unsupported`, salvo que sea el repositorio movido desde el staging por una ejecución interrumpida (se completa el evento). El esqueleto se construye en `<FACTORY_HOME>/runs/<runId>/staging/` y se mueve al destino (ADR 0008); la copia por `EXDEV` está probada con inyección, no con dos dispositivos reales.
- La revalidación del destino ocurre inmediatamente antes de cada escritura del motor, pero entre la comprobación y la escritura sigue habiendo una ventana mínima (no se usa `openat`); el modelo de amenaza es un cambio del destino por otro proceso del mismo usuario durante el bootstrap.
- El lock de merge usa `link()` y tombstones; la toma de un lock obsoleto restaura el lock si se robó uno vivo, pero no se probó con procesos reales concurrentes (solo con intercalado simulado).
- El runner Docker se probó solo con Docker Desktop (Linux); el camino `--user uid:gid` de un motor nativo está cubierto por tests del `argv`, no por ejecución real.

## Límites de H2

`plan` se verificó solo con el proveedor falso; no hay ejecución real contra Claude en H2. No hay ejecución de tareas (H3). El re-plan completo tras `recordSpecChange` no existe: solo se registra la v2 y se listan las tareas impactadas. Un run `BLOCKED` por reparación agotada o por contradicciones no tiene comando de desbloqueo: se corrige el PRD y se crea otro run con `--new`.
