# ADR 0008 — Checks sobre snapshots y bootstrap en staging

- Estado: aceptado
- Fecha: 2026-10-24
- Relacionado: ADR 0006 (aislamiento del builder y runner Docker), ADR 0007 (esqueletos de producto)

## Contexto

La verificación independiente de H3a reprodujo un escape del sandbox: el contenedor de checks tenía montado el worktree real, incluido `.git`. Código del producto podía escribir `[core] fsmonitor = <comando>` en `.git/config`, y el siguiente `git status` del motor, en el host, ejecutaba ese comando. Además, el bootstrap escribía directamente en el destino, de modo que una interrupción entre `git init` y el commit dejaba un repositorio atascado.

## Decisión

1. **Los checks nunca corren sobre el repositorio vivo.** Antes de cada secuencia de checks el motor materializa el commit evaluado (`HEAD` del repo, leído por el motor) en `<FACTORY_HOME>/runs/<runId>/check-work/<id>/` y monta **solo** ese directorio en el contenedor. El snapshot no tiene `.git`, de modo que un check no puede alterar la configuración del repositorio. Se borra al terminar (los logs se conservan). El `commit_sha` del registro es el commit archivado por construcción, así que desaparecen las comprobaciones de árbol sucio y de HEAD movido para la evidencia de checks. La secuencia `npm ci` + `npm run check` comparte un snapshot para que el segundo comando vea `node_modules`.
2. **El snapshot no usa `git archive` ni `git checkout`.** Se verificó empíricamente (git 2.34.1) que `git archive` aplica los filtros `smudge` definidos en la configuración del repositorio. El motor lee el árbol con `git ls-tree -r -z` y los blobs con `git cat-file --batch` y escribe los archivos él mismo (modo 644/755, enlaces simbólicos como enlaces, submódulos omitidos, rutas con `..`, `.git` o vacías rechazadas). Ningún filtro, atributo ni `export-subst` se ejecuta o interpreta. Test: `test/git-adapter.test.ts` («never runs clean or smudge filters»).
3. **Defensa en profundidad en el adaptador Git.** Todas las invocaciones llevan `-c core.hooksPath=/dev/null -c commit.gpgsign=false -c core.fsmonitor=false -c core.untrackedCache=false -c core.pager=cat -c diff.external= -c core.sshCommand= -c protocol.allow=never` (las seis últimas claves verificadas con git 2.34.1) y el entorno `GIT_TERMINAL_PROMPT=0`, `GIT_ATTR_NOSYSTEM=1`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`.
4. **Sello del repositorio.** Tras `git init` y la identidad local el motor guarda en `<FACTORY_HOME>/repo-seals/` el sha256 de `.git/config` y de `.git/info/attributes` (o «ausente»). Toda operación git posterior sobre ese repo (o sus worktrees, resolviendo `commondir`) verifica el sello y devuelve `repo_config_tampered` si cambió, sin ejecutar git. El motor es el único escritor de la configuración local: `worktree add/remove` re-sellan tras terminar. El sello protege contra manipulación posterior; la causa raíz está cerrada por el punto 1.
5. **Bootstrap en staging.** El esqueleto se construye completo (render, `git init`, identidad, escaneo de secretos, commit, huella de configuración) en `<FACTORY_HOME>/runs/<runId>/staging/` y solo entonces se mueve al destino: destino inexistente → `rename`; destino vacío → `rmdir` + `rename`; `EXDEV` → copia y verificación (`HEAD` igual al commit del staging, árbol limpio y huella de `.git/config` igual) antes de borrar el staging, con error `bootstrap_copy_mismatch` si no coincide. El destino se revalida inmediatamente antes del movimiento. Antes de mover se guarda el artefacto `bootstrap-staged` con el sha del staging y la huella.
6. **Recuperación.** Un fallo antes del movimiento deja el destino intacto y el siguiente intento descarta y reconstruye el staging. Un fallo después del movimiento y antes del evento se detecta porque el destino es un repositorio cuyo `HEAD` es el sha del artefacto `bootstrap-staged`, con árbol limpio y huella de configuración idéntica; entonces el motor completa el artefacto final y el evento `product.bootstrapped` (`recovered: true`). Cualquier otro repositorio sigue siendo `existing_repo_unsupported`.
7. **Locks de merge atómicos.** El lock se crea con un archivo temporal + `link()` (falla si existe) y lleva un token `pid:uuid`. La toma de un lock obsoleto renombra el archivo a un tombstone único y verifica que lo renombrado es el contenido observado; si se robó un lock vivo lo restaura y devuelve `lock_held`. `release` solo borra si el token coincide.

## Riesgo aceptado

- La red de los contenedores de check **no** es interna (`npm ci` necesita el registro y Prisma descarga motores), así que el código del producto tiene salida a Internet. Además recibe `TEST_DATABASE_URL` con la contraseña aleatoria de un Postgres efímero que solo existe en la red del run: se acepta porque no tiene valor fuera de ese run.
- En Docker Desktop y en motores rootless/userns el contenedor corre como `root` del contenedor (equivale al usuario del host en disco). La detección de rootless/userns (`docker info --format '{{json .SecurityOptions}}'`) está implementada y probada con entradas de ejemplo, pero **no verificada en un motor nativo**.
- Entre revalidar el destino y moverlo sigue habiendo una ventana mínima (no se usa `openat`).
- Si el repositorio fue manipulado antes del sellado (staging) no hay defensa distinta de la que ya impone que solo el motor escribe ahí.

## Consecuencias

- Cada check cuesta una materialización del árbol (milisegundos para un esqueleto) y un directorio temporal bajo `FACTORY_HOME`; en Docker Desktop `FACTORY_HOME` debe estar bajo el home.
- `GitPort.commitAll` desaparece: todo commit del motor pasa por `commitGuarded` (escaneo de secretos con reversión del staging ante cualquier fallo).
- Los guards del esqueleto fallan cerrado ante errores de lectura, cubren `.ts/.mts/.cts`, importaciones por efecto, `export … from`, `import()` y `require()`.
