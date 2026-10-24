# ADR 0006 — Aislamiento del builder y del runner de checks

- Estado: aceptado
- Fecha: 2026-10-24
- Evidencia: `docs/compatibility/evidence/h3-builder-spike-*.json` (Claude Code CLI 2.1.258, modelo `sonnet`, coste total ≈ USD 0,11 a precio de lista)

## Contexto

El builder necesita editar código del producto. El código generado después se ejecuta (instalación, tests). Un worktree separa código pero no limita capacidades (doc 02 §11).

## Resultados del spike

| Perfil | Escribir dentro del workspace | Leer/escribir fuera | Bash no permitido | `git commit` | Editar `.git/config` |
|---|---|---|---|---|---|
| `--restricted` + `--permission-mode dontAsk` | Denegado | Denegado | Denegado | Denegado | — |
| `--restricted` + `--permission-mode acceptEdits` | **Permitido** | **Denegado** | **Denegado** | **Denegado** | **Denegado** |

`--restricted` confina Read/Edit/Write/Glob/Grep al directorio de trabajo, ignora settings de usuario/proyecto, elimina herramientas de ejecución salvo que `--tools` las nombre y rechaza `bypassPermissions`.

## Decisión

1. **Builder sin Bash.** Perfil: `--restricted --tools "Read,Edit,Write,Glob,Grep" --permission-mode acceptEdits`, cwd = worktree de la tarea, más los flags de contexto mínimo de ADR 0001. Motivo: `Bash(npm run *)` equivale a ejecución arbitraria, porque el builder controla `package.json`.
2. **El motor ejecuta los checks y observa el TDD.** Ciclo por tarea: el builder escribe tests → el motor ejecuta y exige rojo por el motivo esperado → el builder implementa → el motor ejecuta checks y exige verde. Rojo/verde queda como evidencia del motor, no como afirmación del agente. Iteraciones acotadas por el límite de reparaciones.
3. **El runner ejecuta código generado dentro de Docker cuando esté disponible**: contenedor Node efímero con solo el worktree montado, sin secretos del host ni socket Docker, en una red con el PostgreSQL de pruebas. Sin Docker, el runner host queda permitido pero se declara «sin aislamiento» en el informe.
4. **El motor hace los commits**, tras escaneo de secretos; el builder nunca ejecuta git.
5. **Cambios en configuración de checks** (`package.json` scripts, `tsconfig*`, `biome.json`, `vitest.config.*`, scripts de guard) se detectan por diff y obligan a revisión; no pueden convertir un rojo en verde sin rastro.
6. **Revalidar el destino** (realpath, fuera de la factory y de FACTORY_HOME) antes de cada escritura del motor, para cerrar el TOCTOU señalado en la verificación de H2.

## Consecuencias

- Más llamadas por tarea (al menos dos), pero TDD verificable y menor superficie.
- El confinamiento de Claude es un control del proveedor, no un sandbox del sistema operativo. La ejecución del código generado es el riesgo mayor y por eso va a Docker.
