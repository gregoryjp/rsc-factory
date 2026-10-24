# ADR 0011 — Endurecimiento de git en worktrees y tests append-only

- Estado: aceptado
- Fecha: 2026-10-24
- Relacionado: ADR 0006, ADR 0010

## Contexto

El builder escribe dentro de su worktree, incluido `<worktree>/.git`. El adaptador leía de ahí el gitdir, de modo que un `.git` falso (`gitdir: .evil`) con un `[filter]` en su `config` hacía que el motor ejecutara código del builder en el host al correr `git status` o `git add`. Además, un sello ausente se trataba como válido.

## Decisión

1. El motor nunca confía en `<worktree>/.git`. Al crear el worktree registra fuera de él (`<FACTORY_HOME>/worktree-registry/`) el gitdir esperado; toda llamada git usa `GIT_DIR` y `GIT_WORK_TREE` explícitos y comprueba antes que `.git` sea un archivo con exactamente `gitdir: <esperado>`. Si no, devuelve `worktree_pointer_tampered`. El repo principal usa `GIT_DIR=<repo>/.git`.
2. El sello es obligatorio: sin sello `repo_not_sealed`. Solo `init` corre sin él.
3. Los tests son append-only entre tareas: modificar o borrar un test presente en el commit base es `protected_change`. Los configs de runners de test (`vitest`, `jest`, `playwright`) también se bloquean; `.npmrc`, lockfile, `.gitignore`, dependencias y soporte de tests pasan a `requiresReview`.
4. El commit rojo solo puede tocar rutas de test.

## Consecuencias

- Un builder malicioso ya no puede dirigir git hacia un repositorio que él controla.
- Cambiar un test anterior exige una tarea explícita de un humano, no del builder.
- Se desconoce si la herramienta Write restringida puede crear `.git`; la defensa no depende de eso.
