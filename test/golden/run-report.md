# Informe de la factory: run run_2

Proyecto: node-demo. Hash de entrada (PRD): `<sha256:1>`. Versión de spec: v1.

## Etiquetado de la evidencia

- Proveedor: FALSO (guionizado; la salida no la produjo un modelo).
- Proveedor por fase: planificación fake; construcción fake; revisión fake.
- Runner de checks: host SIN aislamiento (0 aislados, 3 sin aislamiento).
- Evidencia omitida o no disponible: ver «Limitaciones».

## Resumen

- Estado del run: BUILDING.
- Entrega (local): no iniciada.
- Release: NOT_STARTED. Producción no está publicada.
- Commit de integración: `<sha1:2>`.
- Check final: no registrado.

## Requisitos y evidencia

### REQ-001 (must): entregado

Add numbers

- Aceptación: add works
- Tareas: add
- Detalle: Tareas DONE con check superado sobre su commit de integración.

### REQ-002 (must): no entregado

Subtract numbers

- Aceptación: sub works
- Tareas: sub
- Detalle: sub: BLOCKED (builder_blocked)

### REQ-003 (next): sin evidencia

Export a CSV

- Aceptación: csv works
- Tareas: ninguno
- Detalle: Ninguna tarea cubre este requisito.

## Tareas

### add: Task add

- Estado: DONE
- Requisitos: REQ-001
- Commit de integración: `<sha1:2>`
- Reintentos: 0; reparaciones: 0
- Checks:
  - `node --test` -> exit 1 (worktree-red, commit `<sha1:3>`, SIN aislamiento, log `runs/run_2/checks/chk_13.log`, sha256 `<sha256:4>`)
  - `node --test` -> exit 0 (worktree-green, commit `<sha1:5>`, SIN aislamiento, log `runs/run_2/checks/chk_15.log`, sha256 `<sha256:6>`)
  - `node --test` -> exit 0 (integration, commit `<sha1:2>`, SIN aislamiento, log `runs/run_2/checks/chk_29.log`, sha256 `<sha256:7>`)
- Revisiones:
  - security: pass sobre `<sha1:5>`
  - code: pass sobre `<sha1:5>`
  - ux: not_applicable (no UI changes) sobre `<sha1:5>`
  - ui: not_applicable (no UI changes) sobre `<sha1:5>`
- Hallazgos por severidad: ninguno; aceptados abiertos (no graves)=0
- Archivos que exigen revisión: ninguno
- Evidencia de navegador: no aplica (el cambio no toca la interfaz)

### sub: Task sub

- Estado: BLOCKED (builder_blocked)
- Requisitos: REQ-002
- Commit de integración: ninguno
- Reintentos: 0; reparaciones: 0
- Checks:
  - ninguno
- Revisiones:
  - ninguna
- Hallazgos por severidad: ninguno; aceptados abiertos (no graves)=0
- Archivos que exigen revisión: ninguno
- Evidencia de navegador: no revisada (la tarea no llegó a la revisión)

## Supuestos

- ASM-001: Integers only (impacto low, reversible; requisitos REQ-001)

## Contradicciones

- CON-001: Signs unclear (requisitos REQ-001, REQ-002)

## Reintentos y reparaciones

- Reintentos manuales: 0; reparaciones del builder: 0; reintentos del proveedor: 0.

## Presupuesto

- Presupuesto: 15 USD; coste informado 0 USD; coste desconocido 0 USD; reservado 0 USD; restante 15 USD.
- Llamadas por rol: approver=1, architect=1, builder=3, planner=1, reviewer-code=1, reviewer-security=1, spec-writer=1.

## Entrega

- Sin checks de entrega registrados aún.
- Commit del informe: ninguno; commit de merge en main: ninguno.

## Limitaciones

- Proveedor FALSO: la salida de planificación, construcción y revisión fue guionizada, no producida por un modelo; esto prueba el motor, no la calidad de un modelo.
- Checks ejecutados en el host SIN aislamiento: 3 de 3.
- Tarea sub bloqueada: builder_blocked.
- Requisito REQ-002 no entregado: sub: BLOCKED (builder_blocked)
- Requisito REQ-003 sin evidencia: Ninguna tarea cubre este requisito.
- El check final de integración no se ha ejecutado o no está registrado.
- Producción no se ha publicado ni desplegado: la política `release.enabled` está desactivada por defecto y el informe no afirma ningún despliegue.

## Siguiente paso

Tasks are being built. Re-run `factory build <runId>` to continue; use `factory resume` after an interruption.
