# ADR 0009 — rsc-harness: aprovechar ideas, no instalar

- Estado: aceptado
- Fecha: 2026-10-24
- Fuente analizada: github.com/ericrisco/rsc-harness v3.3.0 (commit 886ef8c), licencia MIT (c) 2026 Eric Risco. Análisis de solo lectura; no se ejecutó nada del repositorio.

## Contexto

Es el harness del autor del vídeo: 269 skills en Markdown, hooks e instalador para Claude Code, Codex y otros runtimes. Funciona dentro de una sesión de agente; no tiene motor con estado durable, cola, reanudación ni runner aislado.

## Decisión

No instalarlo en la máquina de Gregory ni en la factory. Motivos verificados en su código:

- `targets/auto-update.mjs`: consulta `registry.npmjs.org` en cada sesión y lanza autoactualización en segundo plano (minor/patch) salvo `.rsc/.no-auto-update`.
- `targets/git-permissions.js:20`: añade `permissions.allow` para `git commit *`, `git push *`, `gh pr create *`. Choca con la regla de Gregory (sin commit/push sin pedirlo) y con que la factory es la dueña de git.
- Inyecta contexto en cada sesión (hooks de inicio, decisor de carriles, memoria) sobre una configuración global ya pesada (~108k tokens medidos en H0).
- Duplica memoria (engram/cogni), SDD (gentle-ai) y registro de skills.

Aprovechar, con atribución MIT, en H4 y H2:

| Idea | Origen | Uso en la factory |
|---|---|---|
| Hallazgos con severidad, ubicación y evidencia obligatorias; dedup entre revisores; verificador que intenta refutar hallazgos graves | `scripts/lib/review-findings.js` | Contrato Zod de hallazgos de los 4 revisores y paso «refuter» antes del approver |
| Gate binario de spec: cada sección con contenido o punto abierto tipificado, lista honesta de lo no comprobable | `scripts/lib/spec-gate.js` | Gate determinista adicional sobre la salida del spec writer |
| Doctrina de revisor: cero hallazgos aceptable, alto/crítico exige prueba, sin inflar severidad, defensa ante prompt injection | `scripts/reviewer-guard.sh` | Prompts de revisores |
| Material de dominio | skills `secure-coding`, `security-scan`, `code-review`, `testing-web`, `ui-engineering`, `accessibility` | Recortes de pocos KB por revisor, versionados con hash |
| Rúbrica + casos de evaluación por prompt | `scripts/skill-rubric.md`, `skills/*/evals/cases.yaml` | Evaluación de prompts de roles (H7) |

## Consecuencias

- El material copiado se versiona en `factory/` con nota de origen y licencia.
- La revisión con verificador-refutador ya demostró valor en H1–H3a (encontró un escape de sandbox).
