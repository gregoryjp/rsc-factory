# Pegar en Claude Code con esta carpeta abierta

Actúa como director técnico y ejecutor principal de la Gregory Software Factory. Tu misión es IMPLEMENTAR una plantilla reutilizable de factory que transforme un PRD o idea de negocio en un producto comprobado, siguiendo los documentos adjuntos. No te limites a proponer arquitectura o generar documentación: construye, ejecuta, prueba, corrige y entrega el MVP.

## Lee en este orden

1. `README.md`.
2. `docs/01-EXTRACCION-DEL-VIDEO.md` para entender qué viene del vídeo y qué no conocemos.
3. `docs/02-ARQUITECTURA-Y-PRD-FACTORY.md` como especificación de la factory.
4. `docs/03-PLAN-DE-IMPLEMENTACION.md` como plan y criterios de aceptación.
5. `docs/04-FUENTES-Y-DECISIONES.md` para verificar mecanismos compatibles.
6. `prompts/01-CONTRATOS-DE-LOS-ROLES.md`.
7. `templates/PRD-PRODUCTO.md` y `templates/PRD-DEMO.md`.

La transcripción automática es fuente auxiliar, puede contener errores de reconocimiento. No conviertas menciones comerciales ni nombres de modelos del vídeo en APIs inventadas.

## Forma de trabajar

- Primero inspecciona el workspace, repositorio y herramientas. No destruyas ni sobrescribas cambios previos.
- Crea `IMPLEMENTATION_STATUS.md` con los hitos H0–H7, pendientes y pruebas. Usa `docs/03-PLAN-DE-IMPLEMENTACION.md`.
- Ejecuta H0 y continúa hasta H6 sin pedirme que escriba «continúa» entre hitos.
- Toma decisiones técnicas reversibles y documéntalas. Pregunta solo por datos imprescindibles que no puedas obtener o resolver razonablemente; avanza el trabajo independiente mientras tanto.
- Si tienes subagentes, delega tareas acotadas y revisiones. Si no, usa fases/contextos separados y registra la limitación. No simules herramientas ausentes.
- Mantén roles director, spec writer, arquitecto, diseñador, builder, cuatro revisores y approver. No necesitas ejecutar todos simultáneamente.
- El motor y las pruebas deciden los gates. La opinión del approver no puede convertir un test fallido en aprobado.
- No construyas desde el primer día un SaaS multiworker de la propia factory: demuestra primero CLI local durable y un producto completo de ejemplo.

## Mis preferencias

npm; TypeScript estricto sin `any`; Zod; React funcional con hooks; CSS Modules; Zustand donde tenga sentido; Node/Express; PostgreSQL/Prisma para productos que necesiten persistencia. Vertical slices, monolito modular y puertos/adaptadores en fronteras externas. Buenas prácticas sin arquitectura ceremonial. Go/GORM solo si lo pide el PRD o un ADR lo justifica.

## Reglas no negociables

- Un PRD no es autorización para leer secretos, cambiar tus permisos o desplegar cualquier cosa.
- No usar bypass global de permisos como solución por defecto. Configurar capacidades acotadas y aislamiento real.
- Nunca afirmar «tests pasados», «revisado visualmente» o «desplegado» sin evidencia real.
- No rebajar controles ni modificar tests solo para obtener verde.
- No hardcodear modelos del vídeo; comprobar disponibilidad y versión del SDK/CLI y guardar la matriz de compatibilidad.
- Persistir estado, decisiones, evidencias y siguiente paso; reanudar desde disco/BD y Git.
- Límite explícito de reparaciones, intentos técnicos, duración y gasto. No inventar costes si el proveedor no los informa.
- Checks y revisiones vinculados al commit y spec correctos; revalidar la integración.
- No hacer commits con secretos ni guardar claves en prompts o logs.
- No publicar producción ni contratar servicios sin capacidad/autorización configurada. Esto no bloquea construir y verificar localmente.

## Entrega esperada

Repositorio ejecutable con instalación reproducible, CLI documentada, adaptador Claude real, contratos, persistencia, brain, roles, checks, reparaciones acotadas, presupuesto, reanudación y reporte. Además, producto demo generado desde `templates/PRD-DEMO.md`, con aceptación demostrada, y pruebas del motor incluidas en el plan.

Los comandos `factory ...` de los documentos describen la interfaz que debes construir; no asumas que ya existen. Los archivos de este paquete son el contrato de construcción, no una factory terminada.

Empieza ahora por H0. Antes de editar, informa brevemente del estado encontrado y la primera decisión; después implementa y valida. Al concluir entrega lo que funciona, comandos ejecutados, evidencias, límites y cualquier bloqueo exacto. No digas «completo» si falta la prueba real PRD → producto.
