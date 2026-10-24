# ADR 0005 — Pipeline de planificación: fases, gates deterministas y presets

- Estado: aceptado
- Fecha: 2026-10-24
- Contexto del hito: H2 (intake, especificación y planificación)

## Contexto

El PRD debe convertirse en requisitos trazables, decisiones de arquitectura y un DAG de tareas ejecutables. Las salidas de los roles (spec writer, arquitecto, planner) son JSON producido por un modelo y el contenido del PRD es dato no confiable (doc 02 §11). La validación no puede delegarse al modelo.

## Decisión

### Fases y estado durable

`factory plan <runId>` lleva el run `CREATED → INGESTING → SPECIFYING → PLANNING` y se detiene con las tareas sembradas (`BUILDING` es H3).

| Fase | Entrada | Salida persistida | Quién decide |
|---|---|---|---|
| Intake (`INGESTING`) | copia inmutable del PRD | `spec/ingest-v1.json` (hash, título, ids `REQ-###` declarados) | motor |
| Especificación (`SPECIFYING`) | PRD como dato | `spec-v1.json`, `spec-v1.md`, filas `requirements`/`assumptions`/`contradictions` | modelo propone, gate G0/G1 valida |
| Arquitectura (`PLANNING`) | spec | `architecture-v1.json`, `adr/ADR-###.md`, filas `decisions`, presets del run | modelo propone, gate valida |
| Plan (`PLANNING`) | spec + arquitectura | `plan-v1.json` (orden topológico, riesgo ya elevado) | modelo propone, gate valida |
| Siembra | `plan-v1.json` | tareas (`seedTasks`) + `task_meta`; tareas bloqueadas por contradicciones críticas | motor |

Cada fase escribe su artefacto (write-once, sha256 en la tabla `artifacts`, ruta relativa al directorio del run) **antes** de transicionar el run, y el registro del artefacto y las filas de dominio se confirman en la misma transacción. Reejecutar `plan` salta las fases con artefacto registrado cuyo hash en disco coincide; un hash distinto es `artifact_corrupted`. Un archivo en disco sin registro es un huérfano de un fallo previo y se reescribe. Un fallo reintentable del proveedor (timeout, 429) deja el run en su estado y `plan` lo retoma; no avanza ni llama de nuevo a fases completas.

### Gates deterministas frente a salida del modelo

El modelo propone; el motor valida con funciones puras (`src/domain/planning/`):

- G0/G1 sobre la spec: si el PRD declara ids `REQ-###`, la spec debe contener exactamente ese conjunto (ni faltan ni se inventan); ids duplicados, referencias desconocidas en supuestos y contradicciones y aceptación en blanco se rechazan.
- Arquitectura: `presetIds` deben existir en el registro, sin duplicados ni combinaciones en conflicto; ids de ADR únicos.
- DAG: claves duplicadas, auto-dependencias, dependencias desconocidas o repetidas, ciclos (Kahn), aceptación vacía, requisitos desconocidos y todo requisito `must` cubierto por al menos una tarea. El motor devuelve el orden topológico estable que exige `seedTasks`.
- Suelo de riesgo: el motor eleva a `high` cualquier tarea cuyas rutas esperadas o texto de requisitos coincidan con reglas deterministas (auth, sesión, contraseña, pagos, migraciones, `prisma/schema`, tenant, secretos, borrado). Prevalece la clasificación más restrictiva (doc 02 §11); el riesgo del modelo y las razones quedan en `task_meta`.

### Reparación acotada

Un fallo de esquema o de gate dispara **como máximo una** llamada de reparación por fase con los errores de validación como realimentación. Si la segunda salida también falla, el run pasa a `BLOCKED` con la causa registrada. Un error no recuperable del proveedor (`provider_error` no reintentable, presupuesto) pasa el run a `FAILED`. Toda llamada queda registrada en `role_attempts` (rol, modelo, hash del prompt, coste o `null`, resultado).

### Contradicciones y supuestos

Los supuestos se registran y el run continúa (E02). Una contradicción crítica siembra bloqueadas las tareas que cubren los requisitos afectados y, transitivamente, las que dependen de ellas; las independientes siguen normales. Si todos los requisitos `must` quedan bloqueados, el run pasa a `BLOCKED`. Las contradicciones no críticas solo se registran (E03).

### Modelo de presets

Registro en código (`src/domain/planning/presets.ts`) con tres presets: `backend-express-kimmbo`, `web-react-vite` y `static-landing`, cada uno con id, documento, ámbito y conflictos. **El arquitecto devuelve `presetIds` (lista), no un único `presetId`**: un producto full-stack como el PRD demo es backend + web y modelarlo como un preset monolítico mezclaría dos convenciones distintas. `static-landing` no se combina con los otros dos. El ContextPack incluye el documento de cada preset elegido.

### Prompts y roles como configuración

Cada rol tiene un prompt versionado en `factory/prompts/<rol>.md` (más `_common.md`) y un modelo en `factory/config/roles.json` (validado con Zod; por defecto `sonnet`). El hash del prompt enviado se registra por intento. El PRD y cualquier salida derivada (spec, arquitectura) viajan en bloques delimitados por un marcador que incluye el hash del contenido (`BEGIN_UNTRUSTED_PRD_<hash16>`), de modo que el contenido no puede cerrar su propio bloque; el prompt de sistema declara que lo que hay dentro es dato. Las llamadas no tienen herramientas (`--tools ""`).

### ContextPack

`buildContextPack(runId, taskId)` entrega, con fuente, sha256 y versión por pieza, solo los requisitos de la tarea, sus supuestos y contradicciones, los ADR, los presets elegidos y la aceptación de la tarea. Si el JSON supera el límite (por defecto 60 KB) devuelve `context_pack_too_large` con los tamaños; nunca trunca en silencio.

## Consecuencias

- Los hashes de artefactos permiten detectar manipulación y que un cambio de spec invalide evidencia posterior (`spec.changed` lista las tareas impactadas; el re-plan completo queda fuera de H2).
- El modelo nunca decide transiciones de estado, cobertura ni riesgo final.
- La salida de H2 es un plan, no código: ningún comando de H2 crea ficheros en el directorio `--target`.
- Límite conocido: el suelo de riesgo es una lista de patrones; produce falsos positivos (p. ej. «migration» en un README) por diseño, porque prima el criterio más restrictivo.
