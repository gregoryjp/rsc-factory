# Plan de ejecución para Claude

Este plan dirige la construcción de la factory. Después la factory dirige la construcción de cada producto. No mezclar ambos backlogs.

## Instrucciones de dirección

Trabajar por hitos cerrados con evidencia. Antes de cada hito, enumerar condiciones de salida; al terminar, ejecutar verificaciones y actualizar `IMPLEMENTATION_STATUS.md`. Continuar al siguiente sin pedir un «continúa» cuando no exista bloqueo real. No prometer fechas sin medir el primer ciclo. No crear un enorme scaffold sin comportamiento y declararlo completo.

Un hito bloqueado no impide trabajar en tareas independientes. Registrar las preguntas críticas juntas, con propuesta y consecuencia. No pedir a Gregory elecciones rutinarias de carpetas, funciones o librerías equivalentes.

## H0 — Descubrimiento y compatibilidad

- Inspeccionar carpeta y estado Git; preservar trabajo existente.
- Comprobar Node/npm, Git, Docker si se usará, Claude autenticado y herramientas de test/navegador.
- Registrar versiones realmente instaladas y documentación oficial consultada.
- Spike: una invocación de Claude produce una salida estructurada validada y permite detectar error/timeout.
- Decidir CLI vs SDK y driver SQLite en ADR; validar instalación limpia.
- Entregar `docs/compatibility/matrix.md`, `docs/adr/0001-runtime.md`, presupuesto/configuración inicial y limitaciones.

**Salida:** un programa mínimo conversa con el proveedor real. Si falta acceso, el adaptador fake permite seguir el motor, pero H0 proveedor real permanece pendiente.

## H1 — Núcleo y persistencia

- Modelar estados y contratos Zod, IDs, eventos y migraciones.
- Implementar repositorios con transacciones, control de versión, leases y reloj inyectable para tests.
- Implementar creación, consulta, pausa/cancelación y reanudación de runs.
- Persistir PRD original y hash; aislar project/run.
- CLI objetivo: `factory doctor`, `factory start --prd <path>`, `factory status <runId>`, `factory resume <runId>`, `factory cancel <runId>`. Son requisitos de interfaz, no comandos existentes todavía.

**Salida:** reiniciar proceso no pierde tareas ni duplica la tarea ya completada; transiciones inválidas se rechazan.

## H2 — Intake, especificación y planificación

- Implementar normalizador de PRD, requisitos, supuestos y ADR.
- Crear `ContextPack` por tarea con referencias/versiones y límites de tamaño.
- Generar DAG y detectar ciclos, dependencias inexistentes y aceptación vacía.
- Seleccionar preset por requisitos; no añadir DB/auth por rutina.
- Registrar cambios de spec y su impacto en tareas/evidencias.

**Salida:** el PRD demo produce requisitos y tareas ejecutables trazables; contradicción crítica queda bloqueada con explicación.

## H3 — Builder aislado y ejecución real

- Adaptador Git: worktree por tarea, base commit, commits sin incluir secretos, integración exclusiva.
- Implementar runner de checks con argv, cwd autorizado, timeout, salida truncada controladamente y logs completos almacenados.
- Builder consume spec/ADR y entrega artefactos; el motor comprueba existencia y commit.
- Aislar herramientas y datos; no usar credenciales de producción.
- Aportar primer preset full-stack y alternativa estática mínima.

**Salida:** una vertical slice funciona, tiene tests reales y evidencia; un comando fallido impide avance.

## H4 — Revisores, gates y reparaciones

- Crear instrucciones independientes para seguridad, UX, UI y código.
- Consolidar hallazgos por identidad sin perder discrepancias.
- Implementar gates deterministas y recommendation del approver separadas.
- Reparación acotada, invalidación de evidencias antiguas y revisión del commit integrado.
- UI usa navegador; si falta navegador, resultado bloqueado explícitamente.

**Salida:** fallo inyectado de seguridad, test fallido o evidencia vieja impide `DONE`; corregirlo permite avanzar tras revalidar.

## H5 — Presupuesto y recuperación

- Reservas y contabilidad de costes; tokens, llamadas y tiempos.
- Timeouts, retries limitados, cancelación y reconciliación de efectos.
- Probar caída durante edición, después de commit y durante registro de resultados.
- No repetir creación de PR o despliegue tras timeout sin comprobar efecto existente.

**Salida:** cada escenario recupera un estado coherente o queda bloqueado con causa; ningún bucle ilimitado.

## H6 — Entrega y demo completa

- Ejecutar el PRD de ejemplo desde carpeta limpia.
- Generar producto completo para su alcance, documentación y reporte requisito → evidencia.
- Preparar PR si está conectado GitHub; alternativa local si no.
- Preparar pipeline y runbook de release; no afirmar publicación si no se ejecutó.
- Validar modo auditoría sin mutación del repo objetivo.

**Salida:** Gregory puede abrir la demo y seguir las instrucciones. Informe distingue pruebas fake, integración real y proveedor real.

## H7 — Industrialización opcional

Dashboard, PostgreSQL multiworker, cola/outbox, integraciones de incidencias, segundo proveedor, evaluaciones de calidad/coste y despliegue autorizado. H7 no bloquea demostrar el MVP local.

## Evaluaciones obligatorias

| ID | Escenario | Resultado esperado |
|---|---|---|
| E01 | PRD válido y pequeño | Producto con aceptación demostrada |
| E02 | PRD con hueco reversible | Supuesto registrado y continuación |
| E03 | Requisitos contradictorios críticos | Bloqueo de tareas dependientes |
| E04 | JSON malformado de agente | Rechazo y reparación limitada, sin aprobar |
| E05 | Test falla | No se integra ni se declara éxito |
| E06 | Hallazgo alto de autorización | Gate bloqueado hasta resolución |
| E07 | Builder cambia código tras revisión | Invalidar evidencia y revisar commit nuevo |
| E08 | Caída/reinicio | Reanudar sin repetir tareas/efectos completados |
| E09 | Dos workers reclaman tarea | Solo uno obtiene lease válida |
| E10 | Límite presupuestario alcanzado | Pausa durable y explicación |
| E11 | Proveedor caído/429 | Backoff acotado y estado honesto |
| E12 | Instrucción maliciosa en PRD | Sin acceso a capacidades prohibidas |
| E13 | Intento de cambiar políticas desde producto | Rechazo fuera del workspace permitido |
| E14 | Conflicto de integración | Resolver y repetir validación combinada |
| E15 | Revisor sin navegador | UI bloqueada, no falso aprobado |
| E16 | Petición duplicada | Deduplicar por clave y no duplicar efecto |
| E17 | Auditoría de repositorio | Hash/estado Git del objetivo sin cambios |
| E18 | Ruta escapando del workspace | Rechazo incluso con symlink |
| E19 | Cancelación con workers activos | Detención controlada y estado consistente |
| E20 | Smoke de release falla | No marcar producción sana; ejecutar runbook |

No todas estas evaluaciones requieren LLM real: usar fakes para fallos y invariantes reproducibles; al menos una prueba de aceptación completa debe usar el proveedor real. Si no hay credenciales, reportar pendiente y no llamar al MVP completamente validado.

## Informe obligatorio de cada hito

Qué funciona; qué cambió; archivos principales; comandos realmente ejecutados y resultado; evidencias; límites; presupuesto conocido; siguiente hito. Si se bloquea: causa exacta, trabajo independiente terminado y única entrada pendiente.

## Criterios de rechazo del proyecto

- Solo prompts/Markdown sin runner ejecutable.
- Estado en memoria de chat y sin persistencia.
- Botón «generar» que no construye un producto verificable.
- Revisiones ficticias o tests nunca ejecutados.
- Presupuesto o reintentos ilimitados.
- Cambios de seguridad/gates hechos por el propio producto para aprobarse.
- «Todo automático» como excusa para inventar decisiones del negocio.
