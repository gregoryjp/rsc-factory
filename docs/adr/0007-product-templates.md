# ADR 0007 — Esqueletos de producto determinísticos

- Estado: aceptado
- Fecha: 2026-10-24
- Relacionado: ADR 0002 (preset por defecto), ADR 0006 (aislamiento del builder y runner Docker), `factory/presets/`

## Contexto

Antes de que el builder escriba una sola tarea, el producto necesita una base que compile, tenga los guards del preset y pase sus propios checks. Dejar que un modelo genere esa base cada vez introduce variación en lo que debería ser lo más estable del producto (configuración de TypeScript, Biome, Vitest, guards), cuesta tokens y deja al builder la posibilidad de aflojar los controles que luego lo evalúan.

## Decisión

1. **Esqueletos versionados en el repositorio, sin LLM.** Viven en `factory/templates/<id>/` y el motor los copia y renderiza. El builder recibe un producto que ya pasa `npm ci && npm run check` y solo añade comportamiento.
2. **Selección por tabla.** Un diccionario en `src/domain/templates/render.ts` asocia el conjunto exacto de presets del run con un esqueleto (`backend-express-kimmbo + web-react-vite → fullstack-kimmbo`, `static-landing → static-landing`). Cualquier otra combinación falla con `no_template_for_presets`; no se improvisa. Un test comprueba que cada `template.json` (`presetIds`) coincide con la tabla.
3. **Manifiesto `template.json`.** `id`, `presetIds` que satisface y `render`: la lista de archivos con marcadores. Los demás se copian tal cual. Solo existen `{{PRODUCT_NAME}}` y `{{PRODUCT_SLUG}}`; una función pura los sustituye una sola vez (sin re-expandir el valor). Un test exige que todo archivo con marcador esté en `render` y viceversa. El nombre se sanea (letras, números, espacio, `.`, `_`, `-`; máximo 60) para que no pueda romper el código generado; el slug es ASCII con `_` y sirve de prefijo de la base de datos de pruebas (`<slug>_test`).
4. **Disposición del full-stack.** Monorepo npm workspaces: raíz (`package.json` privado con script `check`, `.nvmrc` 22, `.gitignore`, `AGENTS.md`, `docs/{STATE,ARCHITECTURE,STANDARDS}.md`, `compose.yaml` para el Postgres local del humano), `api/` (preset `backend-express-kimmbo`: ESM, `strict` y banderas del preset, Biome, Vitest con `globalSetup` que ejecuta `prisma migrate deploy`, setup que trunca tablas, archivos en serie, guard que solo permite `NODE_ENV=test` y una base `*_test`, módulo `health` con e2e contra Postgres real, scripts guard `check-boundaries`, `check-raw-sql`, `check-comments` y `check-layers`) y `web/` (React + Vite + TypeScript estricto, CSS Modules, Vitest + Testing Library + jsdom; `check` = typecheck, lint, test y build). `static-landing/` es HTML + CSS y un `scripts/check.mjs` sin dependencias. Un solo `package-lock.json` por esqueleto, generado con `npm install` y verificado con `npm ci`.
5. **Genérico, no Kimmbo.** Solo se tomaron convenciones y estructura de `kimmbo_API`; no su código de negocio, catálogo de errores, ADR, secretos ni valores de entorno. Redis, rate-limit y argon2 se omiten: los añade la feature que los necesite.
6. **Versiones.** Las del preset (las fijadas en `kimmbo_API`) se reverificaron con `npm view <paquete>@<versión> version`; las del frontend se resolvieron con `npm view` el 2026-10-24 y se fijaron exactas (tabla en `docs/compatibility/matrix.md`). Desviación forzada: vitest **5.0.5** en lugar de 5.0.2, porque `npm install` (npm 10.9.8) falla con 5.0.2 a 5.0.4.
7. **Bootstrap por el motor.** `bootstrapProduct` solo actúa sobre un run en `PLANNING` con destino inexistente o vacío: revalida el destino antes de cada escritura (cierra el TOCTOU señalado en la verificación de H2 y exigido por ADR 0006 §6), copia y renderiza, `git init -b main`, identidad local del repo (`Gregory Software Factory <factory@localhost>`, nunca global), escaneo de secretos de lo staged y commit `chore: scaffold from <templateId>`. Registra el artefacto `bootstrap` y el evento `product.bootstrapped` con el sha. Un repositorio existente devuelve `existing_repo_unsupported` (el descubrimiento llega más tarde). Repetirlo se salta si el evento existe y el commit sigue en el repo.

## Alternativas descartadas

- **Esqueleto generado por el modelo:** variable, caro y deja las puertas de calidad en manos de quien se evalúa.
- **`create-vite`/`prisma init` en ejecución:** dependen de la red y de versiones del momento, y producen configuraciones que no cumplen el preset.
- **Clonar un repositorio plantilla externo:** añade una dependencia remota y rompe la auditabilidad de la versión usada.

## Consecuencias

- Cada cambio de preset exige actualizar el esqueleto y repetir `npm run test:docker` (la aceptación real del esqueleto).
- Los esqueletos arrastran dependencias fijadas que envejecen; actualizarlas es una tarea explícita con `npm view` y repetición de la aceptación.
- El script `build` del frontend usa `NODE_ENV=production vite build` (sintaxis POSIX), porque el runner exporta `NODE_ENV=test` a todo el `check` y Vite compilaría React en modo desarrollo.
- Límite del bootstrap: si el proceso muere entre el commit y el registro del evento, el destino queda como repositorio git sin evento y el siguiente intento falla con `existing_repo_unsupported`; hay que borrar el destino y repetir. No hay recuperación automática.
