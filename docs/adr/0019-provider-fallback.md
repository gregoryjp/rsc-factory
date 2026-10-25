# ADR 0019 — Fallback automático de proveedor por rol

Estado: aceptado (H7c). Fecha: 2026-10-25.

## Contexto

Con dos proveedores (ADR 0017) y ambos con cuotas de suscripción, un límite de uso, un binario ausente o una sesión caducada detenía el run (`quota_wait`) o lo hacía fallar aunque el otro proveedor estuviera disponible. Se quiere que cada rol pueda caer automáticamente al otro proveedor sin intervención.

## Decisión

1. `roles.json` admite por rol un `fallback: { provider, model, effort? }` opcional. Esquema estricto (Zod): el proveedor del `fallback` debe ser distinto del primario y `effort` solo con `codex`.
   - `spec-writer`, `architect`, `planner`, `approver`: `claude`/`opus` → `codex`/`gpt-6-astra` `high`.
   - `builder`, `reviewer-security`, `reviewer-code`, `reviewer-legal`, `review-refuter`: `claude`/`sonnet` → `codex`/`gpt-6-sol` `medium`.
   - `reviewer-ux`, `reviewer-ui`: `codex`/`gpt-6-astra` `medium` → `claude`/`sonnet`.
   - `gpt-6-sol` figura en `~/.codex/models_cache.json` (comprobado leyendo solo la lista de slugs; no se hizo ninguna llamada real).
2. **Disparadores** (`src/domain/provider/fallback.ts`, tabla `tipo de fallo → motivo`, más patrones para `provider_error`), decididos por llamada y deterministas:

   | Fallo del primario | Motivo registrado |
   | --- | --- |
   | `provider_error` con «Could not run provider» (binario ausente) | `binary_missing` |
   | `provider_error` de sesión («not logged in», `/login`, `codex login`, «unauthorized»…) | `not_logged_in` |
   | `provider_error` con `codex_requires_docker` | `codex_requires_docker` |
   | `provider_error` de modelo (`model_not_found`, «model … not found») | `model_not_found` |
   | `quota_exhausted` | `quota_exhausted` (se usa el fallback en vez de pausar el run) |
   | `rate_limited_transient` tras agotar los reintentos existentes | `rate_limited` |
   | `timeout` tras su único reintento | `timeout` |
   | cualquier otro `provider_error` | `provider_error` |

   **No** hay fallback para `invalid_output` (fallo de esquema/validación de la salida del modelo), `budget_exceeded`, `aborted` ni para el agotamiento del presupuesto del run (`budget_exhausted`, que se decide antes de llamar).
3. **Un solo salto, sin cadenas.** `guardedInvoke` ejecuta el primario con su política de reintentos de siempre; si falla con un motivo de la tabla y el rol tiene `fallback`, registra `provider.fallback` y ejecuta el fallback una vez (con su propio ciclo de reserva, intento y ledger). Si el fallback también falla por un motivo de la tabla, o su tope de llamadas/presupuesto está agotado, se devuelve el fallo **original** del primario (por ejemplo `quota_wait` con su `waitUntil`), es decir, el comportamiento anterior. Un fallo de validación de la salida del fallback se trata como cualquier otro: reparación única sobre la misma llamada de rol.
4. **Ledger**: sin cambios por proveedor. Claude reserva y carga USD; Codex 0 USD y cuenta contra `maxCodexCallsPerRun`. Los intentos fallidos quedan como `provider_failed` con su proveedor y modelo.
5. **Auditoría y visibilidad**: evento `provider.fallback` (`role`, `from`, `to`, `reason`, `attemptId`); `factory status` lista `Provider fallback: <rol>: <de> -> <a> (<motivo>)` y el informe final añade «Fallback de proveedor» a la evidencia. Si el fallback deja a un `reviewer-*` en el mismo proveedor y modelo que el builder (por defecto, `reviewer-ux`/`reviewer-ui` → `claude`/`sonnet`) se registra un evento `roles.warning` con el aviso de independencia existente; nunca bloquea.
6. **Seguridad del builder en Codex.** Un fallback `builder → codex` ejecuta `workspace-write` y solo es aceptable dentro del contenedor del ADR 0018:
   - El proveedor Codex **nunca** ejecuta en el host una llamada con `permissionMode: acceptEdits`, ni siquiera con `FACTORY_CODEX_HOST_UNSAFE=1`: sin Docker devuelve `codex_requires_docker` (que a su vez no tiene fallback posible: no hay cadena).
   - El test Docker `test/docker/codex-builder-confinement.docker.test.ts` verifica con un contenedor real, construido con el mismo `buildCodexRunArgv`, que: solo se puede escribir en el worktree montado; el repositorio, el gitdir del worktree, `~/.ssh` y el resto del host no existen dentro; rootfs, `/opt/codex` y `/input` son de solo lectura; el contenedor no puede crear commits (no ve el gitdir, no hay `git`) y es el motor quien commitea lo escrito; y si el contenedor reescribe `.git`, el adaptador devuelve `worktree_pointer_tampered` (ADR 0011). No quedan objetos `factory.managed=true`.
   - Los revisores nunca relajan `read-only`: su `permissionMode` no cambia con el fallback.
7. **Doctor** (`provider-fallback`, solo aviso): por cada rol con fallback comprueba que el binario del proveedor de fallback responde a `--version`; para `codex`, además, que los modelos existen en `models_cache.json`, que hay `auth.json` y que Docker está disponible; para `claude` no hay forma barata de detectar la sesión, así que solo se comprueba el binario.
8. `FACTORY_PROVIDER=fake` desactiva el fallback: el proveedor guionizado ignora el proveedor y consumiría el guion del rol dos veces.

## Riesgos abiertos

- Un builder en Codex dentro del contenedor está verificado en confinamiento, **no en calidad**: no se hizo ninguna llamada real de construcción; se desconoce cómo se comporta con las herramientas de edición de Codex y con el prompt del builder.
- Cada llamada de rol vuelve a intentar primero el primario (no hay memoria de «proveedor caído» entre llamadas): con la cuota agotada cada llamada paga un intento fallido antes de caer. Es deliberado (decisión por llamada, sin estado); un enfriamiento por run sería un cambio posterior.
- Los patrones de `not_logged_in` y `model_not_found` de `claude` son aproximaciones por texto; el texto real de «no autenticado» de `claude` no se capturó. Un fallo de este tipo no reconocido cae en `provider_error`, que también dispara el fallback, por lo que el efecto es el mismo.
- Con el fallback, un run puede mezclar modelos en una misma fase; el informe lo declara pero la calidad entre modelos no está medida.
- Un reintento tras `invalid_output` del primario vuelve a empezar por el primario.

## Alternativas descartadas

- Cadenas de varios saltos: más superficie, estados difíciles de auditar y gasto impredecible.
- Fallback también ante `invalid_output`: ocultaría prompts o esquemas mal calibrados y duplicaría el coste.
- Pausar siempre en `quota_wait`: se mantiene solo cuando no hay fallback utilizable.
