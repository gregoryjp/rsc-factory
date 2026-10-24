# Fuentes, límites y decisiones de diseño

Consultado: 24 de octubre de 2026.

## Evidencia primaria del vídeo

Archivo proporcionado: `Programar con agentes ya no basta_ monta tu Software Factory.publer.com.mp4`. Duración técnica: 1041,39 s. Vídeo 640×360, audio presente, sin pista separada de subtítulos. Se inspeccionaron fotogramas distribuidos a intervalos de 10 s y se extrajo el audio completo con reconocimiento automático local.

La transcripción se entrega como ASR, no como transcripción humana certificada. Los términos técnicos y nombres propios pueden reconocerse mal; el resumen normaliza únicamente términos apoyados por las diapositivas. Las marcas de tiempo ayudan a volver a la fuente. Las pantallas con texto pequeño tienen límites de legibilidad por resolución.

Este material no incluye el repositorio de RSC, sus prompts completos, configuración de ejecución, infraestructura, pruebas ni costes. Es imposible reconstruir con certeza esos detalles internos solo a partir del vídeo. La arquitectura propuesta completa esas lagunas con decisiones propias, identificadas como tales.

## Documentación oficial de Claude consultada

- Subagentes: https://code.claude.com/docs/en/sub-agents
- Ejecución programática: https://code.claude.com/docs/en/headless
- Memoria: https://code.claude.com/docs/en/memory
- Permisos: https://code.claude.com/docs/en/permissions
- Hooks: https://code.claude.com/docs/en/hooks
- Guía de hooks: https://code.claude.com/docs/en/hooks-guide
- Permisos SDK: https://code.claude.com/docs/en/agent-sdk/permissions

Conclusiones limitadas a estas fuentes: Claude dispone de mecanismos para delegación especializada, instrucciones persistentes y ejecución programática. Hooks y permisos son mecanismos distintos de las instrucciones conversacionales. La configuración efectiva debe probarse contra la versión instalada; esta entrega no fija opciones de SDK/CLI no comprobadas localmente.

No se verificaron aquí modelos disponibles en la cuenta de Gregory, precios de proveedores, límites de suscripción ni credenciales de Claude. Los nombres mostrados en el vídeo no bastan para seleccionar identificadores de API.

## Decisiones de esta propuesta — no atribuir al autor del vídeo

| Decisión | Motivo | Alternativa / cuándo revisar |
|---|---|---|
| Factory y producto separados | Evitar que cada app modifique su motor de control | Monorepo puede alojarlos con límites claros |
| Monolito modular inicial | Reducir operación y facilitar transacciones | Servicios separados cuando existan necesidades medidas |
| SQLite para un coordinador local | Menos infraestructura para demostrar flujo | PostgreSQL al operar varios coordinadores |
| Motor determinista decide gates | No confiar el éxito a una opinión del modelo | LLM aporta juicio, no sustituye evidencia |
| PR/entrega local como primera meta | Demostrar valor sin credenciales productivas | Publicación automática con política y entorno configurados |
| Roles con modelos configurables | Disponibilidad/coste cambian | Segundo proveedor tras evaluación y acceso |
| Context packs con versiones | Evitar memoria obsoleta y exceso de contexto | Retrieval adicional cuando la base crezca |
| Worktrees más aislamiento | Separación Git no limita capacidades del proceso | Contenedores/VM según entorno |
| Tests por requisito/riesgo | Evitar métricas vacías de cantidad | Cobertura y mutación donde aporten valor |
| Budget/retries/leases | Control de fallos reales de ejecución | Colas distribuidas/outbox en fase posterior |

## Lectura crítica del vídeo

- Repetible significa procedimiento controlable y entradas/salidas verificables; no implica que un modelo genere siempre lo mismo.
- El código también puede depender de reloj, red, aleatoriedad o concurrencia. Determinismo requiere controlar esas dependencias.
- Contexto persistente ayuda, pero no garantiza ausencia de alucinaciones ni decisiones incoherentes.
- Revisar con otro modelo puede aportar diversidad; no prueba independencia ni seguridad total.
- TDD mejora el feedback, pero tests mal definidos pueden validar un comportamiento incorrecto. La aceptación debe derivar del PRD.
- Las afirmaciones sobre entrenamiento específico, superioridad de modelos o uso en empresas son afirmaciones del presentador, no hechos verificados por esta entrega.
- Una edición visual pequeña puede tener impacto de accesibilidad/branding. La política de riesgo no debe basarse solo en líneas cambiadas.
- «No hace falta n8n» es una elección de implementación; n8n puede ser una integración útil sin ser el motor central.
- La propuesta mostrada parte principalmente de tareas sobre una aplicación existente. Generar un producto entero desde un PRD requiere las fases adicionales de descubrimiento, arquitectura, diseño y aceptación incluidas aquí.
