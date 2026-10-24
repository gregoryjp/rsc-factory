# ADR 0003 — Cogni como memoria del operador y límites por suscripción

- Estado: aceptado
- Fecha: 2026-10-24

## Contexto

Gregory usa Claude Pro y ChatGPT Pro (sin API keys de pago por uso) y Cogni v2.3.8 (memoria local SQLite FTS5/BM25, MCP) ya instalado y configurado para Claude Code y Codex CLI 0.154.0.

## Decisión 1 — Papel de Cogni

- **Sí**: memoria de las sesiones del operador y del director (construir la factory, retomar trabajo, decisiones transversales).
- **No como fuente de verdad del brain del producto**: el brain sigue siendo archivos versionados (doc 02 §8). Motivos:
  - auditabilidad y reproducibilidad: una memoria mutable fuera de Git no queda ligada a commit/spec;
  - aislamiento entre productos: la búsqueda de Cogni hace fallback entre proyectos (Fase 3 del README), lo que choca con «no copiar memoria privada entre productos» (doc 02 §1);
  - coste: los workers corren con `--strict-mcp-config`; cargar el MCP añade definiciones de herramientas a cada llamada.
- **Opcional después (H7)**: un puerto de solo lectura que consulte Cogni con ámbito del proyecto, cuyo resultado se valide contra el estado vigente antes de entrar en un ContextPack.
- Las cifras de ahorro de tokens del README de Cogni son del autor; no se han medido aquí.

## Decisión 2 — Límites por suscripción

- El gasto en dinero adicional es cero (uso extra desactivado). El recurso escaso es la **cuota** de Claude Pro.
- El presupuesto de la factory se mide en coste estimado a precio de lista (`total_cost_usd`) como proxy de cuota, con reserva previa por llamada.
- Modelo por defecto de los workers: `sonnet`. Modelos superiores solo para roles configurados explícitamente.
- Ejecución secuencial por defecto (1 worker).
- Un límite de cuota/429 lleva el run a `BLOCKED` con causa y momento de reanudación; nunca reintento en bucle.
- Codex CLI (ChatGPT Pro) queda como segundo proveedor candidato para un revisor (H7), tras un spike propio.

## Pendiente

Fijar el tope por run tras medir el coste de un run con el PRD demo.
