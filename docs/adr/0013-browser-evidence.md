# ADR 0013 — Evidencia de navegador ejecutada por el motor y revisores UX/UI

- Estado: aceptado (H4b); ampliado en H4c (captura autenticada, proxy `/api`, red interna, endurecimientos)
- Fecha: 2026-10-24
- Relacionado: ADR 0006 (perfil de solo lectura), ADR 0008 (snapshots), ADR 0011 (runner Docker), ADR 0012 (gate G4), doc 02 §10 (reglas de UI), evaluación E15

## Contexto

G4 pide cuatro revisiones resueltas (seguridad, código, UX, UI). Las dos primeras salen del diff y del código; UX y UI solo tienen sentido con una pantalla real. Doc 02 §10 exige «navegador real, rutas críticas, teclado, foco, contraste y pantallas móviles/escritorio, capturas con versión/commit» y recuerda que la accesibilidad automatizada ayuda pero no garantiza cumplimiento total. Un revisor sin la herramienta necesaria debe quedar `blocked`, nunca `pass`.

## Decisión

### 1. Captura ejecutada por el motor, no por el modelo

El motor, de forma determinista y sin llamar a ningún modelo, levanta la app del commit revisado y captura la evidencia. Los revisores UX y UI **no controlan un navegador**: reciben la evidencia ya capturada (JSON + capturas PNG) y la leen con `Read`. Alternativa descartada: computer-use / navegador dirigido por el modelo. Razones: no es reproducible, el modelo podría navegar a donde quiera (superficie de ataque con contenido no confiable), la evidencia no quedaría atada al commit ni podría hashearse, y obligaría a un perfil con más herramientas que el de solo lectura de ADR 0006.

### 2. Qué se ejecuta y dónde (`PreviewPort`, `src/infrastructure/runner/docker-preview.ts`)

Para un snapshot del commit (ADR 0008, sin `.git`, borrado después) y en **dos redes propias por captura**, sin puertos publicados: `factory-<runId>-<pvXXXXXX>-net` (con salida a internet, solo para instalar y construir) y `factory-<runId>-<pvXXXXXX>-int` (`--internal`, sin salida a internet ni a la LAN, para todo lo que ejecuta código del producto en tiempo de ejecución):

1. Contenedor Node fijado (`NODE_IMAGE`) en la red con salida: `install`, `build` y el `build` del api de la política (`factory/policies/checks.json`, clave `preview`, por plantilla). Mismo endurecimiento que los checks (`--cap-drop ALL`, `no-new-privileges`, límites, sin socket ni home).
2. Si la política define `api` (el esqueleto `fullstack-kimmbo` la define desde H4c): Postgres efímero de la captura (misma imagen y ajustes que el de checks, contraseña aleatoria pasada por nombre de variable), `migrate`/`seed` opcionales **en la red interna** (necesitan la base y no internet) y el api en un contenedor de la red interna con el producto montado de solo lectura, `NODE_ENV=production` y `CORS_ORIGINS` igual al origen de la web de la captura.
3. La web se sirve con un servidor estático **del motor** (`factory/preview/static-server.mjs`) sobre el directorio construido, montado de solo lectura; el código del producto no ejecuta nada en esta fase. El servidor incluye el proxy `/api` (sección 10).
4. Un contenedor de la imagen oficial de Playwright (`mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd…`, ver `docs/compatibility/matrix.md`) ejecuta el script del motor `factory/preview/capture.mjs`. Las dependencias del script (`playwright-core` 1.64.1, igual a la etiqueta de la imagen, y `axe-core` 4.14.0, ambas con versión exacta y `package-lock.json`) se instalan una vez en `<FACTORY_HOME>/preview-tools/<hash>/` con `npm ci --ignore-scripts` y se montan **de solo lectura**. El producto no se monta en el contenedor del navegador.

El script visita las rutas, en 390x844 y 1440x900: captura PNG de página completa, ejecuta axe-core (inyectado por el script), mide desbordamiento horizontal (`scrollWidth > clientWidth`), recorre con Tab hasta 10 elementos enfocables comprobando que tengan indicador visible (outline o sombra) y recoge errores de consola (máx. 20 mensajes de 300 caracteres) y etiquetas de foco (máx. 20 de 100). Rutas: `ui-routes.json` en la raíz web del producto (clave `routesFile` de la política) o, si no existe, `["/"]`; cada entrada es `"/ruta"` o `{ "path": "/tickets", "as": "<rol>" }`; se validan (máx. 10, rutas absolutas del propio sitio, sin `..`, roles `^[a-z][a-z0-9_-]{0,30}$`).

### 3. Evidencia atada al commit

El script solo escribe una salida cruda. El motor la valida con Zod (`src/contracts/ui-evidence.ts`), exige todas las combinaciones ruta x viewport pedidas, **recalcula él mismo** el sha256 y el tamaño de cada PNG (una captura vacía invalida la evidencia), añade `commitSha`, el sha256 del script (`scriptSha256`) y las versiones de Playwright y axe, y escribe `ui-evidence.json` más `shots/*.png` en `<FACTORY_HOME>/runs/<runId>/ui/<commit>/`. El script vive en `factory/` (versionado, no es código del producto) y se monta de solo lectura: el producto no puede alterarlo. Un evento `task.ui_evidence` guarda ruta, sha256 del JSON, hash del script y los conteos (`pages`, `axeViolations`, `overflowPages`); `factory status` los muestra por tarea.

### 4. Aplicabilidad (determinista, sin LLM)

UX y UI aplican cuando el diff `base..head` de la tarea toca la interfaz (`src/domain/review/ui.ts`). `static-landing`: cualquier archivo cambiado salvo documentación (`*.md`, `docs/**`, `LICENSE`), porque scripts, datos e imágenes también cambian lo que se ve. `fullstack-kimmbo`: `web/**`, archivos raíz de construcción/configuración (`package.json`, `package-lock.json`, `tsconfig*.json`, `biome.json`, `vite.config.*`) y cualquier paquete de workspace distinto de `api/` (primer segmento de la ruta que no sea `api`, `docs` ni un directorio oculto). Plantillas desconocidas: `web/`. Es una heurística conservadora: ante la duda aplica y exige evidencia. Si no aplica, el motor persiste ambas revisiones como `not_applicable` con la razón fija «no UI changes», sin llamar a ningún proveedor ni levantar nada.

### 5. Regla E15: nunca `pass` sin navegador

Si aplica y la captura queda `unavailable` (sin Docker, sin imagen, la app no arranca ni responde, build fallido, timeout, evidencia inválida, runner `host`, política sin `preview`), el motor persiste ux y ui como `blocked` con la razón («browser evidence unavailable: …») sin llamar al proveedor, y el gate G4 devuelve `review_blocked` (precedencia ya existente de ADR 0012; ni el approver ni nada la anula). Las revisiones `blocked` generadas por el motor para ux/ui **no se reutilizan** al reanudar sobre el mismo commit: se vuelve a intentar la captura.

### 6. Revisores UX y UI

Roles `reviewer-ux` y `reviewer-ui` (`roles.json`, `sonnet`), perfil de solo lectura de ADR 0006 (`--restricted --tools Read,Glob,Grep --permission-mode dontAsk`). Su `cwd` es el snapshot habitual de revisión **más** `ui-evidence/` (copia del JSON y las PNG), de modo que `Read` puede ver las imágenes. Prompts `factory/prompts/reviewer-ux.md` y `reviewer-ui.md` con la misma doctrina que los de H4a (cero hallazgos es válido, alto/crítico exige prueba, sin inflar severidad, defensa ante inyección, incluido texto dentro de una captura). UI: viewport, ruta, estado, referencia de captura, contraste, foco, desbordamiento, axe; UX: recorridos frente a la aceptación, errores, estados vacíos y de carga, recuperación; ambos distinguen defecto bloqueante de preferencia y no afirman comportamiento dinámico no evidenciado. El contrato de hallazgos se reutiliza con un campo opcional `evidenceRef` (ruta de captura o id de regla axe), conservado en las fuentes del hallazgo deduplicado.

### 7. Gate y presupuesto

`REVIEW_AREAS` pasa a `security, code, ux, ui`; G4 exige las cuatro para el commit y ciclo exactos (`pass`, `findings` o `not_applicable` con razón del motor). Cada llamada a un revisor UX/UI cuenta en `--max-provider-calls`. Un hallazgo UX/UI crítico/alto pasa por refutador, approver y reparación igual que los demás; tras cualquier commit nuevo se re-revisan las cuatro áreas con una captura nueva.

### 8. Limpieza y seguridad Docker

Todo objeto lleva el prefijo `factory-` y las etiquetas `factory.managed=true`, `factory.run=<runId>` y `factory.preview=<id>`. El teardown (siempre, en `finally`) lista y borra **solo** por la etiqueta `factory.preview` de esa captura (no toca el Postgres del runner de checks de la misma ejecución) y se niega a borrar nada sin prefijo `factory-`. Sin `-p`, sin socket Docker, sin montar el home, sin `--privileged`. Chromium se lanza con `--no-sandbox` porque el contenedor no tiene capacidades (`--cap-drop ALL`) y es efímero; la salida a internet queda limitada a los pasos de instalación/construcción (red `-net`); Postgres, api, servidor estático y Playwright viven en la red `--internal` (`-int`), de modo que ni el código del producto en ejecución ni el JS de la página pueden contactar internet o la LAN; `--shm-size 1g` en lugar de compartir el IPC del host. Tiempos acotados: 10 min por paso de instalación/build, 5 min la captura, 60 s por servicio.

## Consecuencias

- La evidencia es reproducible, hasheable y atada al commit; ningún modelo decide qué se captura.
- Coste de tiempo: una captura del esqueleto tarda ≈ 35–40 s (instalación + build + navegador) con las imágenes ya descargadas; la imagen de Playwright pesa ≈ 2,5 GB. La primera captura instala además las dependencias del script (una vez).
- Si la imagen de Playwright no está descargada, `docker run` la baja dentro del timeout de captura; para evitar un `unavailable` espurio conviene hacer `docker pull` antes.
- Límites: los pasos `install`/`build` del producto sí tienen salida a internet (necesitan el registro de paquetes) y ejecutan código del producto con ella; la accesibilidad automatizada no es cumplimiento completo (axe detecta una parte de los problemas; el foco se comprueba solo para los primeros 10 elementos con Tab); solo dos viewports y sin estados que requieran interacción más allá del login; los revisores UX/UI nunca se ejecutaron con el `claude` real.

## Ampliación H4c

### 9. Captura autenticada

El producto puede declarar `web/ui-auth.json` (clave `authFile` de la política), validado con Zod estricto: `{ "loginPath": "/login", "fields": { "username": "<etiqueta accesible>", "password": "<etiqueta accesible>" }, "submit": "<nombre accesible del botón>", "accounts": { "<rol>": { "username": "...", "password": "..." } } }` (1 a 5 roles). Las credenciales son **solo de prueba**: deben coincidir con cuentas que crea la semilla de pruebas del propio producto, nunca credenciales reales. El archivo viaja en el repositorio y por tanto en el diff que ven los revisores.

Secret scan: no hace falta ninguna excepción. La regla genérica `secret_assignment` busca `password = "..."`/`password: "..."` con la clave sin comillas; en JSON la clave siempre lleva comillas, así que `ui-auth.json` no se marca, y las reglas de alta confianza (clave privada, AWS) siguen activas sobre el archivo (test en `test/ui-domain.test.ts`).

Las rutas de `ui-routes.json` pueden llevar `as: "<rol>"`. Si usan un rol sin `ui-auth.json` o sin cuenta para ese rol, la captura queda `unavailable` (E15). El script del motor, por cada rol usado, abre un contexto de navegador nuevo, entra en `loginPath`, rellena con `getByLabel` (nombre exacto), pulsa `getByRole("button", { name })`, y da el login por bueno solo si la URL deja de ser `loginPath` **y** no hay ningún `[role=alert]` visible. El `storageState` se guarda **solo en memoria** (no se escribe en `/out`, para no dejar tokens de sesión en el directorio de evidencia) y se usa únicamente en los contextos de ese rol, que capturan sus rutas en ambos viewports. Un login fallido, o una ruta que acaba redirigida a `loginPath`, genera entradas `status: "unavailable"` con motivo y sin captura: nunca una captura de la página de login hecha pasar por la pantalla protegida. Solo las cuentas de los roles usados llegan al contenedor del navegador, por variable de entorno pasada por nombre (no aparece en el argv).

La evidencia registra por entrada `as` y `authenticated` (`true` solo si hay rol y la captura se hizo con sesión). El motor trata cualquier entrada `unavailable` como evidencia incompleta: UX y UI quedan `blocked` («incomplete browser evidence: …»), con el mismo efecto que cualquier otra evidencia ausente. Los revisores reciben además `UI_COVERAGE` (rutas públicas y por rol, capturadas y no capturadas) y sus prompts prohíben dar por buena una pantalla de un rol que no esté en la cobertura.

### 10. Proxy `/api` del servidor estático

Para que una app que llama a `/api/...` con URLs relativas funcione en la vista previa, el servidor estático del motor reenvía `/api` al contenedor del api (variable `API_UPSTREAM`, solo si la política define `api`). Reglas: un único destino fijo (nunca derivado de la petición; un request-target absoluto se ignora); el prefijo `/api` se elimina (`/api/health/ready` llega como `/health/ready`); ruta normalizada con la API `URL` y rechazo (400) de `%2f`, `%5c`, `%00`, `\` y `%2e%2e` en rutas bajo `/api`; conserva método, cuerpo, cabeceras y cookies (y todos los `Set-Cookie` de vuelta), sustituyendo `Host`; descarta cabeceras hop-by-hop; cuerpo de petición máx. 1 MiB (413), respuesta máx. 5 MiB (corte), 15 s de tiempo (504; 502 si el api no responde). Sin `API_UPSTREAM`, `/api/*` responde 404. La plantilla `fullstack-kimmbo` documenta la convención y su `vite.config.ts` aplica el mismo prefijo en desarrollo con el proxy de Vite.

### 11. Endurecimientos

- Directorio estático: `lstat` debe mostrar un directorio real (no un enlace simbólico) y su `realpath` debe seguir dentro del snapshot; lo montado es el `realpath`. El producto montado como raíz de pasos y del api también se resuelve con `realpath`.
- Caché de herramientas: antes de cada captura se vuelve a calcular el sha256 de los cuatro archivos de `preview-tools/<hash>/` (y `names.mjs`) contra el origen versionado; si difiere, la evidencia es `unavailable` («tool cache does not match the engine source»).
- Nombres de captura: `shots/<índice de ruta>-<slug>-<rol|public>-<ancho>x<alto>.png`; el contrato rechaza rutas de captura duplicadas.
- Texto controlado por el producto: los mensajes de consola y las etiquetas de foco salen del bloque `UI_EVIDENCE` (solo conteos) y van en un bloque propio `UI_PRODUCT_TEXT`, delimitado con `dataBlock` (etiqueta con hash del contenido), limitado a 4000 caracteres con marca de truncado, sin caracteres de control y con aviso de dato no confiable.
