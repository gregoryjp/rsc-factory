# Matriz de compatibilidad — H0

Fecha de verificación: 2026-10-24. Máquina: Linux 6.8.0, x86_64. Todo lo marcado «verificado» se ejecutó localmente; la evidencia está en `evidence/`.

## Herramientas instaladas

| Herramienta | Versión | Estado | Uso |
|---|---|---|---|
| Node.js | 22.23.2 | Verificado | Runtime de la factory (LTS) |
| npm | 10.9.8 | Verificado | Gestor de paquetes, lockfile |
| Git | 2.34.1 | Verificado | Worktrees por tarea (soporta `git worktree`) |
| Docker | 29.2.1 | Instalado, no probado aún | Aislamiento de ejecución (H3) |
| Claude Code CLI | 2.1.258 | Verificado con llamada real | Adaptador de proveedor |
| Codex CLI | 0.154.0 | Verificado con 1 llamada real (`gpt-6-astra`, `medium`, sandbox `read-only`) y 1 rechazo real de modelo | Segundo proveedor (ADR 0017); revisores UX/UI |
| Playwright (imagen oficial) | 1.64.1 | Verificado con captura real (H4b) | Evidencia de navegador para UX/UI; no se instala en el host, ver «Imágenes» |
| `playwright-core` / `axe-core` | 1.64.1 / 4.14.0 | Verificado (`npm view`, lockfile en `factory/preview/`) | Script de captura del motor; versión de Playwright igual a la etiqueta de la imagen |
| `ANTHROPIC_API_KEY` | — | **No definida** | Auth actual: OAuth del CLI |

## Paquetes npm (versión `latest` consultada con `npm view`)

| Paquete | Versión | Estado |
|---|---|---|
| zod | 4.6.7 | Instalación limpia verificada |
| better-sqlite3 | 13.0.3 | Instalación limpia + consulta verificada (SQLite 3.53.4) |
| commander | 15.0.0 | Instalación limpia verificada |
| @anthropic-ai/claude-agent-sdk | 0.3.310 | No adoptado (ver ADR 0001) |
| typescript | 7.0.2 (`latest`, compilador nativo) | Pendiente de validar con vitest/tsx en H1 |
| vitest | 5.0.5 | Pendiente H1 |
| tsx | 4.23.15 | Pendiente H1 |
| `node:sqlite` | integrado | Emite `ExperimentalWarning` en Node 22 → descartado |

## Flags del CLI verificados en `claude --help` (2.1.258)

`-p/--print`, `--output-format json`, `--json-schema`, `--tools` (lista vacía = sin herramientas), `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--max-budget-usd`, `--model`, `--system-prompt`, `--append-system-prompt`, `--setting-sources`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--agents`, `--settings`, `--bare`.

## Resultados del spike con proveedor real

| # | Configuración | Resultado | Coste informado (`costBasis: list`) |
|---|---|---|---|
| 1 | Contexto por defecto, modelo por defecto, `--max-budget-usd 0.20` | `error_max_budget_usd`; sin salida estructurada | **USD 1,0945** (~108k tokens de creación de caché) |
| 2 | `--system-prompt` propio, `--setting-sources project`, `--strict-mcp-config`, `--disable-slash-commands`, `--tools ""`, `--model sonnet` | `success`, `structured_output` válido | **USD 0,0069** |
| 3 | `--model not-a-real-model` | exit 1, `is_error: true`, stderr `unrecognized_model` | USD 0 |
| 4 | `timeout 2` sobre una respuesta larga | exit 124, stdout vacío | no informado |

Identificadores de modelo efectivamente devueltos por el CLI: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` (este último lo usa el CLI internamente aunque se pida `sonnet`).

## Hallazgos que condicionan el diseño

1. **`--max-budget-usd` no es un límite previo.** Se comprueba después de la llamada: el spike 1 gastó 5,5× el límite. El presupuesto de la factory debe reservar antes de lanzar y usar este flag solo como red secundaria.
2. **El contexto por defecto es caro.** Carga CLAUDE.md global, reglas, plugins, MCP y skills del usuario. Toda invocación de worker debe usar contexto explícito y mínimo.
3. **`--bare` no sirve con OAuth.** Exige `ANTHROPIC_API_KEY` o `apiKeyHelper`. Con OAuth se usa la combinación del spike 2.
4. **El CLI espera stdin.** Sin stdin cerrado avisa y espera 3 s. Lanzar con `stdio: ['ignore', 'pipe', 'pipe']`.
5. **`costBasis: list`.** Es coste a precio de lista; con suscripción OAuth el cargo real puede diferir. La factory registra el valor informado y su base, sin presentarlo como factura.
6. **Errores y timeouts son distinguibles**: exit 1 + `is_error`/`subtype`/`errors`, o exit 124/señal con stdout vacío.

## Documentación oficial

Ver `docs/04-FUENTES-Y-DECISIONES.md`. Las conclusiones de esta matriz provienen de la ejecución local, no solo de la documentación.

## H3a — runner Docker y esqueletos de producto (verificado 2026-10-24)

### Imágenes

| Uso | Referencia fijada | Notas |
|---|---|---|
| Contenedor de checks (Node) | `node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9` | Verificada con `docker pull node:22.23.2-bookworm-slim`; Node 22.23.2 coincide con el del host. Tamaño local ≈ 227 MB. Bookworm (glibc, con libssl) para que Prisma encuentre sus motores sin paquetes extra |
| Navegador de evidencia (Playwright) | `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea` | Verificada con `docker pull mcr.microsoft.com/playwright:v1.64.1-noble` (2026-10-24); etiqueta = versión de `playwright-core`. Tamaño local ≈ 2,5 GB. Solo la usa la captura de H4b (ADR 0013) |
| PostgreSQL de pruebas | `postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` | Imagen ya existente en la máquina (digest del RepoDigest local). Datos en `tmpfs` (sin volumen anónimo), `fsync=off`, 1 GB de memoria |

Las constantes viven en `src/config/compatibility.ts` (`NODE_IMAGE`, `POSTGRES_IMAGE`, `PLAYWRIGHT_IMAGE`, `PLAYWRIGHT_VERSION`, `AXE_VERSION`); cambiarlas exige repetir `npm run test:docker`.

### Notas del runner Docker

- Docker 29.2.1 sobre **Docker Desktop** (Linux). Hallazgos medidos, no supuestos:
  - Solo se pueden montar rutas bajo el home del usuario (`/tmp` no está compartido con la VM: `bind source path does not exist`, exit 125). Un `--target` o `FACTORY_HOME` bajo `/tmp` no funciona con el runner Docker; los tests de Docker usan `~/.cache/gsf-docker-tests/`.
  - El directorio montado se ve como `root:root` dentro del contenedor y el `root` del contenedor equivale al usuario del host en el disco (un `uid 1000` del contenedor aparece como `100999` en el host). Por eso en Docker Desktop el runner usa `--user 0:0` (con `--cap-drop ALL` y `no-new-privileges`) y en un motor nativo usa `--user <uid>:<gid>` del host (`containerUserFor`).
- Flags de cada contenedor de check: `--rm`, nombre `factory-<runId>-chk-<hex>`, etiquetas `factory.managed=true` y `factory.run=<runId>`, red `factory-<runId>-net`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 4g`, `--pids-limit 1024`, un único bind del worktree en `/work`, `HOME=/tmp`, `npm_config_cache=/work/.npm-cache`. Sin `-p`, sin socket Docker, sin home.
- Los secretos (contraseña de Postgres y URLs de base de datos) viajan por nombre (`-e NOMBRE`) y valor en el entorno del proceso `docker`, no en el argv.
- Limpieza solo por etiqueta (`--filter label=factory.managed=true --filter label=factory.run=<runId>`) y, además, se rechaza borrar cualquier objeto cuyo nombre no empiece por `factory-`.
- Medido: `npm ci` + `npm run check` del esqueleto fullstack dentro del runner dentro de ~1 minuto en esta máquina (la suite completa de aceptación de esqueletos, con fullstack, inyección de fallo y landing, tardó 86 s y 124 s en dos ejecuciones; incluye la descarga de motores de Prisma).

### Versiones de los esqueletos (`factory/templates/`)

| Paquete | Versión | Fuente |
|---|---|---|
| express, @prisma/client, prisma, zod, typescript, @biomejs/biome, pino, pino-http, helmet, cors, supertest, tsx, @types/* | las de `kimmbo_API` (ver preset), verificadas con `npm view <pkg>@<ver> version` | preset `backend-express-kimmbo` |
| vitest | **5.0.5** (no 5.0.2) | `npm install` con npm 10.9.8 falla con vitest 5.0.2, 5.0.3 y 5.0.4 (`Cannot read properties of null (reading 'edgesOut')`); 5.0.5 instala bien |
| react, react-dom | 19.3.1 | `npm view` el 2026-10-24 |
| vite | 8.3.5 | `npm view` |
| @vitejs/plugin-react | 6.1.2 | `npm view` |
| @testing-library/react / jest-dom | 16.3.3 / 7.0.1 | `npm view` |
| jsdom | 30.1.3 | `npm view` |
| @types/react, @types/react-dom | 19.3.0 | `npm view` |
| typescript (web) | 5.9.3 (no 7.0.2) | mismo que el API; la factory misma usa 7.0.2 (ADR 0004) |
| @biomejs/biome (web) | 2.5.14 (no 2.6.2) | mismo estándar 2.5.x que el API |
| @types/node | 22.20.4 | Node 22 |

### H3a — ronda de corrección: cambios de comportamiento del runner

- El contenedor de check monta un **snapshot** del commit (`<FACTORY_HOME>/runs/<runId>/check-work/<id>/`, sin `.git`), no el worktree vivo (ADR 0008). Se verificó con git 2.34.1 que `git archive` ejecuta filtros `smudge` de la configuración; por eso el snapshot se escribe con `git ls-tree` + `git cat-file --batch`.
- Claves `-c` verificadas aceptadas por git 2.34.1: `core.fsmonitor=false`, `core.untrackedCache=false`, `core.pager=cat`, `diff.external=`, `core.sshCommand=`, `protocol.allow=never`.
- Detección de usuario del contenedor: Docker Desktop, `name=rootless` o `name=userns` en `SecurityOptions` → `--user 0:0`. Solo Docker Desktop está verificado en ejecución real; rootless/userns en motor nativo **no está verificado**.
- Riesgo aceptado: la red del run no es interna (necesaria para `npm ci` y para que Prisma descargue sus motores), el código del producto tiene salida a Internet y conoce la contraseña aleatoria del Postgres efímero de ese run.
- Un `docker kill` fallido tras un timeout se registra (`killError` en el log y en el evento `check.recorded`).

## H7 — Codex CLI como segundo proveedor (verificado 2026-10-25)

Evidencia: `test/fixtures/codex/real_codex_ok.jsonl` y `real_codex_model_not_found.jsonl` (salida real de `codex exec --json`).

- Flags verificados en `codex exec --help` (0.154.0): `--json`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `--output-schema FILE`, `-m`, `-c clave=valor`, `-s read-only|workspace-write`, `-C DIR`, `--disable <feature>`, prompt por stdin con `-`.
- Flujo de eventos real: `thread.started`, `turn.started`, `item.completed` (`agent_message` con el JSON final en `text`), `turn.completed` con `usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`). Error de modelo: evento `error` + `turn.failed`, exit 1, mensaje JSON con `error.code = model_not_found`.
- Una llamada mínima (`{"ok":true}`) consume ~13,6k tokens de entrada: es el prompt de sistema propio de Codex, no se puede quitar.
- `--ignore-user-config` no carga `$CODEX_HOME/config.toml` (MCP, hooks, `model_instructions_file` de engram), pero la autenticación sigue saliendo de `CODEX_HOME`. Por eso cada llamada usa un `CODEX_HOME` temporal propio que solo contiene una copia de `auth.json`.
- Sin `--system-prompt`: el prompt de rol se antepone al prompt por stdin.
- El sandbox `read-only` de Codex **permite leer todo el sistema de archivos** del usuario (comprobado con `codex sandbox`: lee `~/.codex/config.toml` y lista `~/.ssh`); solo impide escribir y usar red desde los comandos. Ver riesgos en el ADR 0017.
- Modelos: `gpt-6-astra` y `gpt-6.1-sol` aparecen en `~/.codex/models_cache.json` (`gpt-6-astra` aceptado en la llamada real). Un modelo inexistente devuelve `model_not_found` (cubierto por fixture real).
- Cuota/uso: Codex con ChatGPT Pro no informa USD. El texto exacto del error de límite de uso **no se capturó** (no se agotó la cuota): el clasificador se probó con mensajes sintéticos (`usage_limit_reached`, `resets_at`, `resets_in_seconds`, «try again in…/at…»).

## H7b — Codex en contenedor (verificado 2026-10-25)

Evidencia: `test/fixtures/codex/real_codex_docker_ok.jsonl` (salida real de `codex exec --json` dentro del contenedor) y `test/docker/codex-isolation.docker.test.ts`.

| Componente | Valor | Verificación |
|---|---|---|
| Imagen de Codex | la misma `NODE_IMAGE` fijada por digest (`CODEX_IMAGE` en `src/config/compatibility.ts`) | El binario nativo de Codex es un ELF estático musl: corre en cualquier imagen; la de Node aporta `/bin/sh` y `node` (para generar el bundle de CA) |
| Binario | directorio `vendor/<triple>` del paquete npm `@openai/codex-linux-<arch>`, montado de solo lectura en `/opt/codex` | `codex --version` dentro del contenedor = 0.154.0 |
| CA | la imagen no trae `ca-certificates`: sin ellas Codex falla con `invalid peer certificate: UnknownIssuer`. Se genera `/tmp/ca-bundle.pem` desde `tls.rootCertificates` de Node al arrancar y se exporta `SSL_CERT_FILE`/`CODEX_CA_CERTIFICATE` | Llamada real `{"ok":true}` con `gpt-6-astra`/`medium` OK en ~10 s |
| Sandbox propio de Codex | `bwrap: setting up uid map: Operation not permitted` dentro del contenedor (sin capacidades): se usa `-s danger-full-access` | Verificado con `codex sandbox linux` en el contenedor |
| Docker Desktop | `--user 0:0` (misma lógica `containerUserFor`); los bind mounts deben estar bajo `$HOME` | Verificado en Docker Desktop; en motor nativo no está verificado |
