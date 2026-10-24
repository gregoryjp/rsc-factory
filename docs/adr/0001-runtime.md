# ADR 0001 — Runtime de proveedor y persistencia local

- Estado: aceptado
- Fecha: 2026-10-24
- Evidencia: `docs/compatibility/matrix.md`, `docs/compatibility/evidence/h0-spike-*.json`

## Contexto

La factory necesita invocar a Claude con salida estructurada validable, detectar errores y timeouts, limitar gasto y funcionar con la autenticación disponible (OAuth del CLI; no hay `ANTHROPIC_API_KEY`). También necesita persistencia transaccional local para un solo coordinador.

## Decisión 1 — Adaptador de proveedor sobre el CLI de Claude Code

Invocar `claude -p` como subproceso con argv (sin shell), `stdio` con stdin cerrado, y flags:

```
--output-format json --json-schema <schema> --no-session-persistence
--system-prompt <rol> --setting-sources project --strict-mcp-config
--disable-slash-commands --model <configurado> --max-budget-usd <reserva>
--tools <lista mínima por rol>
```

El adaptador valida el sobre de resultado y `structured_output` con Zod; trata exit ≠ 0, `is_error`, stdout vacío o señal como fallo clasificado (`retryable` solo para timeout/429/sobrecarga).

### Alternativas

| Opción | A favor | En contra |
|---|---|---|
| **CLI (elegida)** | Verificada con llamada real; funciona con OAuth; flags de herramientas, presupuesto y schema disponibles; sin dependencia extra | Contrato de salida es JSON del CLI, puede cambiar entre versiones → se fija la versión probada en la matriz y se valida con Zod |
| Agent SDK 0.3.310 | API tipada, streaming | No probado localmente; no verificado con OAuth; añade dependencia. Reevaluar si se necesita streaming o hooks programáticos |
| API HTTP directa | Control total | Requiere API key (no disponible); reimplementar herramientas |

## Decisión 2 — better-sqlite3 13.0.3 para el coordinador local

Transacciones síncronas, instalación limpia verificada en Node 22.23.2. `node:sqlite` descartado por ser experimental en Node 22. PostgreSQL queda para el escenario multi-coordinador (H7).

## Consecuencias

- El presupuesto no puede depender de `--max-budget-usd`: el motor reserva antes de lanzar y reconcilia con `total_cost_usd`.
- Nunca usar el contexto por defecto en workers (coste ~157× en el spike).
- Fijar la versión del CLI probada; `factory doctor` avisará si cambia.
- Si en el futuro hay `ANTHROPIC_API_KEY`, `--bare` simplifica el aislamiento de contexto; registrar en un nuevo ADR.
