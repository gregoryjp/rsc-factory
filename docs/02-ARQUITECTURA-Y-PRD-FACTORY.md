# Gregory Software Factory — arquitectura y PRD de implementación

Versión de diseño: 1.0 · 24 de octubre de 2026 · Estado: especificación para construir, no sistema ya desplegado.

«RSC Factory» se usa aquí como referencia al nombre mostrado en el vídeo. No disponemos de su código ni de su arquitectura interna. Esta es una implementación independiente para Gregory; RSC no significa aquí React Server Components.

## 1. Resultado que queremos

Tras una configuración inicial de herramientas, credenciales, presupuesto y destino, Gregory entrega un PRD o una idea. La factory lo transforma en especificaciones verificables, decisiones de arquitectura, backlog con dependencias, código, interfaz, pruebas, documentación y una entrega revisable. Debe poder corregir fallos y reanudar sin depender de la memoria del chat.

Un PRD puede ser la única entrada habitual; no sustituye credenciales, decisiones comerciales desconocidas, acceso al alojamiento, licencias ni una autorización de producción. Si solo llega una idea, producir primero un PRD derivado y un registro explícito de supuestos. Continuar con decisiones reversibles; bloquear únicamente tareas que dependan de datos realmente imprescindibles.

Dos entregables distintos:

1. **Factory template:** motor, contratos, políticas, adaptadores de agentes, memoria y evaluaciones. Sirve para múltiples productos y repositorios.
2. **Product template:** código inicial del producto seleccionado por el PRD. Cada producto tiene su repositorio, configuración, decisiones y datos separados.

No copiar credenciales, historiales de clientes ni memoria privada entre productos. No instalar todas las tecnologías en todos los proyectos.

## 2. Alcance y límites

### MVP obligatorio

CLI local, un operador, un producto por ejecución, Claude como proveedor inicial, Git, tareas durables, presupuesto, reanudación, cuatro revisiones, ejecución de checks y entrega local/PR cuando haya acceso. Trabajadores secuenciales inicialmente; paralelismo limitado en revisiones sin mutaciones. Modo auditoría separado sin modificar el repositorio objetivo. Un producto de demostración generado desde un PRD realista.

### Después del MVP

Panel web, varios productos, workers remotos, PostgreSQL para la factory, cola distribuida, integraciones con GitHub/Sentry, proveedores alternativos, previews automáticas, métricas de operación y despliegues según política.

### Fuera del MVP

Marketing automático, publicación social, facturación del negocio de Gregory, contratación de servicios, modelos locales, Kubernetes, microservicios por defecto, marketplace de agentes y autorreescritura autónoma de las políticas de la factory. Son extensiones, no requisitos para demostrar PRD → producto.

## 3. Arquitectura de la factory

Adoptar **monolito modular** con **vertical slices** por capacidad y **puertos/adaptadores** en fronteras externas. Clean Architecture determina la dirección de dependencias; no obliga a crear capas sin comportamiento. SOLID guía responsabilidades, no un número de clases.

- **Domain:** estados, invariantes, requisitos, presupuesto, hallazgos, políticas de transición. Sin importar SDK de modelos, ORM, Git ni HTTP.
- **Application:** casos de uso `ingestPrd`, `planProject`, `dispatchTask`, `recordEvidence`, `evaluateGate`, `resumeRun`, `prepareRelease`.
- **Adapters:** Claude, Git, SQLite/PostgreSQL, command runner, almacenamiento de evidencias, GitHub y navegador de QA.
- **Interfaces:** CLI primero; API y dashboard después reutilizan casos de uso.

Módulos: intake, requirements, architecture, planning, execution, review, quality, memory, artifacts, budget, release, audit. Un módulo no accede directamente a tablas internas de otro.

### Stack propuesto para construir la factory

- TypeScript estricto, Node.js en una versión LTS compatible verificada al comenzar, npm y lockfile.
- Zod para validar todas las entradas externas y salidas de agentes.
- SQLite para la ejecución local de un solo coordinador; transacciones y migraciones explícitas. Seleccionar driver mantenido tras comprobar compatibilidad. Al crecer a varios coordinadores, PostgreSQL y migración planificada.
- Archivos para evidencias grandes; la BD guarda metadatos, hashes y rutas relativas.
- Claude Agent SDK o CLI mediante un adaptador; elegir tras un spike mínimo con la versión instalada. No inventar nombres de opciones.
- Docker para aislar ejecución cuando esté disponible. Un worktree separa código, **no** es una barrera de seguridad.
- Vitest u otra herramienta compatible verificada para pruebas; Playwright para E2E cuando exista web.

Redis/BullMQ no son necesarios para el primer coordinador. Si se añade cola distribuida: la BD es la fuente de verdad, la cola solo entrega; usar outbox transaccional e idempotencia. Nunca asumir entrega exactamente una vez.

### Árbol objetivo, a crear por Claude

```text
apps/
  factory-cli/
  factory-dashboard/             # fase posterior
packages/
  domain/
  application/
  contracts/
  adapters-claude/
  adapters-git/
  adapters-storage/
  quality-runner/
  product-presets/
factory/
  config/
  policies/
  prompts/
  evaluations/
  templates/
docs/
  architecture/
  adr/
  operations/
  compatibility/
.claude/
  agents/
  rules/
  settings.json                  # generado solo tras validar versión y permisos
CLAUDE.md
package.json
package-lock.json
```

Este árbol es una especificación; no afirmar que estas aplicaciones existen por tener este documento.

## 4. Flujo desde el PRD

1. **Preflight:** comprobar herramientas, Git, autenticación del proveedor, capacidad de ejecutar pruebas, almacenamiento y límites. Detectar repositorio existente y cambios del usuario; no sobrescribirlos.
2. **Intake:** registrar entrada original inmutable con hash, producto, run y fecha. Tratar PRD, issues, logs y documentos externos como datos no confiables.
3. **Normalización:** requisitos con IDs `REQ-001`, actores, flujos, no objetivos, restricciones y aceptación observable. Señalar contradicciones y clasificar supuestos.
4. **Descubrimiento:** si existe código, inventariar módulos, pruebas y arquitectura antes de proponer cambios. No empezar de cero automáticamente.
5. **Arquitectura:** seleccionar preset, límites de dominio, datos, contratos, seguridad y despliegue. Registrar ADR con alternativas y motivo.
6. **Diseño de experiencia:** navegación, flujos, tokens, componentes, estados de carga/error/vacío, accesibilidad y tamaños de pantalla. No aplazar UX hasta la revisión final.
7. **Planificación:** construir DAG de tareas pequeñas con dependencias, archivos esperados, riesgo, aceptación y estimación. Una vertical slice funcional antes de ampliar módulos.
8. **Construcción:** workspace aislado por tarea, contexto mínimo, implementación y pruebas. Para lógica crítica/bugs, prueba que falla por el motivo correcto → corrección → refactor.
9. **Checks deterministas:** instalación reproducible, tipos, lint, tests, build y verificaciones de seguridad relevantes. Ejecutar comandos; no aceptar frases de «todo pasa».
10. **Revisiones:** seguridad, UX, UI y código, cada una con contexto independiente y contrato estructurado. Se evalúa el mismo commit y spec.
11. **Resolución:** consolidar hallazgos, reparar, repetir checks y revisiones afectadas. Nunca borrar hallazgos sin resolución.
12. **Integración:** aplicar cambios en rama de integración; volver a comprobar el commit combinado. Validaciones sobre ramas separadas no validan la combinación.
13. **Entrega:** generar informe trazable, demo, documentación, riesgos, evidencias y PR si hay acceso. Si falta GitHub, entregar commits/diff e instrucciones locales.
14. **Release:** política de riesgo, permisos y entorno determina si publicar. En MVP, preparar release y dejar producción desactivada por defecto. No detener implementación local para pedir autorizaciones innecesarias.
15. **Observación:** tras despliegue autorizado, smoke tests, health checks, métricas y rollback según runbook. Un error nuevo crea tarea con evidencia y deduplicación.

## 5. Máquina de estados durable

Estados de run: `CREATED`, `INGESTING`, `SPECIFYING`, `PLANNING`, `BUILDING`, `VERIFYING`, `REVIEWING`, `REPAIRING`, `INTEGRATING`, `READY_FOR_RELEASE`, `RELEASING`, `SUCCEEDED`, `BLOCKED`, `FAILED`, `CANCELED`.

- Una transición la valida el motor con datos persistidos. Un agente solo propone acciones.
- `SUCCEEDED` requiere el resultado declarado para ese run: por ejemplo `delivery=local` o `delivery=production`. No etiquetar como desplegado un run que solo preparó un PR.
- `BLOCKED` registra causa, dependencia y acción exacta para continuar; no es un éxito.
- Pausa por presupuesto conserva evidencias y siguiente paso. No vuelve a intentar indefinidamente.
- Cancelar impide nuevas tareas; los procesos activos se terminan de forma controlada y se registran efectos ya realizados.

Estados de tarea: `PENDING`, `READY`, `LEASED`, `RUNNING`, `VERIFYING`, `REVIEWING`, `REPAIRING`, `DONE`, `BLOCKED`, `FAILED`, `CANCELED`.

Una tarea no puede ejecutarse antes de que sus dependencias estén `DONE`. Una lease tiene propietario, vencimiento y heartbeat. Reanudar reconcilia procesos y efectos existentes antes de relanzarlos. Comparación de versión o transacción evita doble adjudicación.

## 6. Datos y contratos

Entidades mínimas:

| Entidad | Datos obligatorios |
|---|---|
| Project | id, nombre, ruta autorizada, preset, versión de políticas |
| Run | id, projectId, inputHash, estado, deliveryTarget, versión, fechas, límite monetario |
| Requirement | id, runId, texto, aceptación, prioridad, fuente, versión |
| Assumption | id, motivo, impacto, reversible, estado y tareas dependientes |
| Decision | id ADR, opciones, decisión, contexto, referencias, estado |
| Task | id, runId, dependencias, aceptación, estado, intento, lease, baseCommit |
| Attempt | id, taskId, proveedor/modelo real, tiempos, tokens/coste, errores |
| Artifact | id, tipo, ruta, hash, productor, commit, specVersion |
| Check | comando, argumentos, cwd, exitCode, log, commit, duración |
| Review | área, commit, specVersion, resultado, hallazgos y evidencia |
| Finding | id estable, severidad, archivo/rango si aplica, reproducción, estado |
| Approval | actor, política, alcance, commit, entorno, caducidad |
| Event | id, secuencia, runId, taskId, tipo, timestamp, payload validado |
| Release | artefacto/digest, commit, entorno, estado, resultado de smoke y rollback |

Schema de salida de agente con unión discriminada:

```ts
type AgentResult =
  | { status: 'completed'; artifactIds: string[]; evidenceIds: string[] }
  | { status: 'blocked'; reason: string; requiredInputs: string[] }
  | { status: 'failed'; errorCode: string; retryable: boolean };
```

Validar JSON con Zod; campos desconocidos sensibles se rechazan. `completed` no equivale a gate aprobado. El coordinador comprueba que las rutas existen dentro del workspace, los hashes coinciden, los checks son auténticos y el commit es el esperado. Ruta con `..`, symlink fuera del workspace o evidencia de otro run → rechazar.

Cada gate referencia `runId`, `taskId`, `commitSha`, `specVersion`, `policyVersion` y evidencias. Si cambia el commit, invalidar checks/revisiones afectados y ejecutar de nuevo la verificación final sobre el commit de integración.

## 7. Roles y separación de responsabilidades

| Rol | Responsabilidad | Salida | No puede |
|---|---|---|---|
| Director | Coordinar DAG, contexto, prioridad y bloqueos | Estado y próxima tarea | Saltarse gates o inventar resultados |
| Analista/spec writer | Convertir intención en aceptación | Spec y supuestos | Inventar hechos del negocio |
| Arquitecto | Elegir estructura y contratos | ADR, modelo de datos y límites | Imponer microservicios sin motivo |
| Diseñador UX/UI | Diseñar antes de construir | Flujos, tokens y estados | Dar por probada la usabilidad |
| Builder | Implementar slice y pruebas | Commit, tests y notas | Aprobar su propia entrega |
| Revisor seguridad | Riesgos, auth, tenant, datos, dependencias | Hallazgos reproducibles | Cambiar política o desplegar |
| Revisor UX | Recorridos, claridad, errores, recuperación | Hallazgos por tarea de usuario | Confundir opinión con evidencia |
| Revisor UI | Consistencia visual, responsive, accesibilidad | Capturas y defectos | Aprobar solo leyendo JSX |
| Revisor código | Arquitectura, contratos, mantenimiento | Hallazgos con referencias | Reescribir silenciosamente el alcance |
| Approver | Consolidar hallazgos y recomendar paso | Recomendación estructurada | Anular un fallo determinista |
| Release adapter | Preparar/publicar según política | Release y smoke | Publicar sin capacidad autorizada |

Un solo Claude visible puede dirigir estos roles en sesiones separadas. No es necesario tener nueve procesos simultáneos. En v1 pueden compartir proveedor/modelo, pero deben tener contextos separados. Eso **no** produce independencia estadística garantizada. Añadir otro proveedor es opcional y depende de acceso, coste y evaluación; nunca degradar silenciosamente si no está disponible.

Los modelos concretos son configuración, no arquitectura. Registrar identificador efectivamente utilizado y soporte de herramientas/visión. No copiar «Opus 5.5», «Sol» o «Astra» del vídeo como IDs de API.

## 8. Brain: memoria verificable

Fuente autoritativa: PRD versionado, requisitos, ADR aceptados, contratos, código actual y evidencias en Git/almacenamiento. La memoria conversacional es auxiliar.

`brain/index.md` enlaza a `product.md`, `architecture.md`, `decisions/`, `conventions.md`, `known-issues.md` y `handoff.md`. No concatenar todos los documentos en cada prompt.

Antes de cada tarea: cargar resumen del producto, políticas aplicables, spec, ADR relevantes, contratos y último resultado. Cada pieza lleva fuente, hash/versión y ámbito. Después: registrar resultados, decisiones nuevas propuestas y deuda; actualizar el índice sin sobrescribir ADR aceptados.

Reanudación: leer run persistido → reconciliar Git y procesos → validar versiones → cargar tarea pendiente → continuar. Nunca «recuerda lo que hicimos» como mecanismo de recuperación.

No usar búsqueda vectorial como fuente de verdad; si se añade, solo sirve para recuperar referencias que luego se validan contra el estado vigente. Conflicto entre memoria y código/spec se registra y resuelve, no se oculta.

## 9. Preset de producto por defecto

Para un SaaS web de Gregory: React + Vite + TypeScript, componentes funcionales y hooks, CSS Modules, Zustand para estado cliente que lo justifique; separar estado remoto de estado UI. Node.js + Express + Zod, PostgreSQL y Prisma si encaja en el repositorio. Verificar versiones e interoperabilidad al construir.

Backend por módulo: dominio y casos de uso; adaptadores HTTP/persistencia. No exponer modelos del ORM como contrato público. Frontend por feature; componentes comunes solo cuando exista reutilización real.

- Landing estática: sin API/BD si no la necesita.
- App móvil: preset Expo/React Native si el PRD lo pide; no inferir móvil de la palabra «app».
- Go/GORM: solo solicitado o justificado por ADR.
- Realtime: Socket.IO si hay necesidad explícita; Redis solo para coordinación/carga que lo requiera.
- Pagos: proveedor externo sandbox; operaciones idempotentes y webhooks verificados.
- Multiempresa: aislamiento por tenant tanto en consultas como en autorización; pruebas negativas de acceso cruzado.
- Listados: paginación y límites; filtros y orden determinista.
- Auth: estrategia documentada según clientes; cookies/tokens, expiración, revocación y CSRF según corresponda. Evitar mezclar estrategias arbitrariamente.
- Calidad: errores consistentes, validación de entrada, migraciones, logs sin secretos, pruebas de autorización, health checks y backup/restauración verificables.

No declarar este preset universal. Registrar por qué el producto lo necesita y qué se omitió.

## 10. Gates de calidad

G0 entrada válida y contradicciones críticas identificadas. G1 requisitos trazables y aceptación comprobable. G2 arquitectura y experiencia coherentes. G3 implementación compilable con pruebas relevantes. G4 cuatro revisiones resueltas. G5 integración comprobada. G6 release elegible. G7 smoke post-release satisfactorio cuando haya despliegue.

Reglas mínimas:

- Types, lint, build y pruebas obligatorias deben pasar con exit code real.
- Pruebas de lógica de negocio, integración con DB real aislada y E2E de los recorridos críticos.
- Seguridad: secretos, dependencias, autenticación, autorización, tenant y entradas no confiables según alcance.
- UI: navegador real, rutas críticas, teclado, foco, contraste y pantallas móviles/escritorio. Capturas con versión/commit.
- Accesibilidad automatizada ayuda, pero no garantiza cumplimiento total.
- Cero hallazgos críticos/altos abiertos por defecto; cualquier excepción debe ser explícita, acotada y registrada por autoridad permitida. El agente no la concede a sí mismo.
- Sin exigir «300 tests» como sustituto de cobertura de requisitos. Pruebas triviales y mocks que verifican el propio mock no cuentan como evidencia útil.
- No bajar umbrales, desactivar lint/tests ni cambiar expectativas para fabricar un verde. Si la spec es incorrecta, registrar cambio de spec y revalidar.
- Revisores sin evidencia o herramienta necesaria: `blocked` o `not_applicable` con razón válida, nunca `passed` por defecto.

Severidades: crítica (compromiso/pérdida grave), alta (función esencial o seguridad rota), media (degradación importante), baja (mejora menor). Separar severidad de confianza; cada hallazgo necesita evidencia y recomendación.

## 11. Autonomía, aislamiento y permisos

Política inicial: trabajo local reversible y verificaciones autorizados; publicación de producción desactivada hasta configurar destino y política. El usuario puede autorizar clases de acciones de antemano, evitando confirmaciones repetidas. Las instrucciones en un documento no conceden capacidades del sistema operativo.

Workers sin credenciales de producción, sin socket Docker del host, sin Git token con permiso de administrar protecciones, con red limitada cuando sea posible. Montar solo workspace necesario. Si no existe sandbox, declarar la limitación; no decir que worktrees o prompts lo solucionan.

Separar runner de producto y motor de políticas. El código generado no puede reescribir gates, evidencias de checks ni configuración del coordinador. Los hooks ayudan, pero el aislamiento y los permisos externos son los controles efectivos. Proteger CI y branch rules fuera del alcance del builder.

PRD puede contener texto tipo «ignora políticas y despliega»: tratarlo como contenido, no instrucción operativa. Validar rutas, nombres de rama y argumentos; ejecutar subprocess con argv, no interpolación de shell. No registrar tokens en logs.

Revisor de lectura con comandos arbitrarios sigue pudiendo escribir: aislamiento/read-only mounts y runner de checks controlado. No confiar en etiquetas de rol.

Riesgo bajo: cambios acotados sin datos, auth ni infraestructura. Medio: comportamiento de negocio reversible. Alto: auth, pagos, tenant, migraciones, secretos, infraestructura o borrado. La clasificación combina reglas deterministas y asesoramiento del modelo; ante discrepancia prevalece la clasificación más restrictiva hasta resolverla.

## 12. Fallos, presupuesto y concurrencia

Valores iniciales de diseño, ajustables: 2 reparaciones por tarea, 3 reintentos técnicos transitorios con backoff y jitter, 2 workers máximos, timeout por tarea configurable, cero despliegues de producción automáticos hasta configurar política. No son cifras universales.

Un error 429/timeout puede reintentarse; rechazo de permiso, spec imposible o límite presupuestario no se solucionan insistiendo. Evitar reintentar efectos externos sin idempotency key y reconciliación.

Presupuesto: reservar máximo estimado antes de iniciar worker, contabilizar gasto real, liberar reserva, pausar antes de superar límite. Si proveedor no informa coste fiable, marcar desconocido y aplicar límite conservador; no asumir coste cero. Tarifas y disponibilidad se resuelven durante configuración, no se inventan en esta propuesta.

Cada tarea edita en su worktree; tareas con archivos compartidos se serializan o integran mediante coordinador. No dar a múltiples agentes la misma rama con permisos de escritura. Conflictos de merge requieren resolución y nuevos checks. La operación de merge es exclusiva.

## 13. Entrega y operación

Informe por run: requisitos entregados/no entregados, commit, comandos ejecutados, resultados, pruebas de navegador, hallazgos, supuestos, costes conocidos/desconocidos, limitaciones y siguiente paso. Evidencias sanitizadas, sin credenciales ni datos reales innecesarios.

Métricas: éxito por tipo de PRD, tiempo por fase, coste por run, reparaciones por tarea, fallos escapados, reanudaciones, tasa de hallazgos confirmados y cobertura de aceptación. Medir valor, no solo tokens, líneas o número de agentes.

Release: artefacto inmutable ligado al commit; migraciones revisadas y ensayadas; copia/restauración para cambios de datos. Rollback de aplicación no implica rollback seguro de esquema: preferir expand/contract o plan específico. Smoke fallido debe impedir etiquetar release sano.

## 14. Definición de terminado de la factory

La factory está terminada como MVP cuando un clon limpio, con configuración documentada, procesa el PRD demo y produce un producto funcional verificable; se ha demostrado recuperación tras interrupción, fallo de test, hallazgo alto, proveedor caído y presupuesto agotado. Entrega logs y evidencias; no basta una pantalla que muestre «completed».

Esta especificación no certifica que el software futuro esté libre de errores. Claude debe ejecutar los criterios del plan de implementación y reportar exactamente qué se verificó.
