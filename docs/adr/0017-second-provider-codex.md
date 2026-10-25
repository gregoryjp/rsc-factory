# ADR 0017 — Codex CLI como segundo proveedor y modelo por rol

Estado: aceptado (H7). Fecha: 2026-10-25.

## Contexto

Hasta H6 todos los roles usaban `claude` con un único modelo. Se quiere (a) elegir proveedor y modelo por rol y (b) que los revisores de UX/UI sean de otra familia de modelos que el builder, para tener revisión independiente. El usuario dispone de ChatGPT Pro (sin coste por llamada) y Codex CLI 0.154.0.

## Decisión

1. `roles.json` pasa de `rol: "modelo"` a `rol: { provider, model, effort? }`. `effort` solo con `codex`. El esquema es estricto (Zod); la forma antigua se rechaza.
2. Nuevo `ProviderPort` `codex-cli-provider.ts` sobre `codex exec`. `ProviderRequest` gana `provider` y `effort`; un `routing-provider` elige el adaptador por petición. `FACTORY_PROVIDER=fake` sustituye todo el enrutador (el proveedor guionizado ignora `provider`).
3. **Aislamiento** (una llamada no debe ver el contexto del usuario ni poder llamar a MCP, hooks o red):
   - `CODEX_HOME` y `HOME` apuntan a un directorio temporal nuevo (`<FACTORY_HOME>/codex-calls/call-*/home`, modo 0700) que contiene solo una copia de `auth.json` (0600). Se borra al terminar. Si Codex rota los tokens, el `auth.json` rotado se devuelve al origen (si no, el usuario quedaría deslogueado); nunca se lee su contenido para logs ni mensajes.
   - `--ignore-user-config` y `--ignore-rules` (aunque el home ya está vacío: defensa en profundidad), `--ephemeral`, `--skip-git-repo-check`.
   - `--disable` de `apps`, `browser_use`, `browser_use_external`, `computer_use`, `hooks`, `image_generation`, `multi_agent`, `plugins`, `goals` y `-c web_search="disabled"`.
   - Entorno con lista blanca: `PATH`, `LANG`, `LC_ALL`, `TMPDIR` (del entorno ya filtrado de la factory) más `HOME`/`CODEX_HOME`. Nada más.
   - Sandbox `read-only` salvo `permissionMode: acceptEdits`, que usa `workspace-write` confinado a `-C <cwd>`. El builder sigue en `claude` por defecto; un builder en `codex` no está verificado.
   - El prompt de rol (Codex no tiene `--system-prompt`) se antepone al prompt y todo va por stdin; el esquema JSON del rol va a un archivo temporal para `--output-schema`.
4. **Coste**: Codex no informa USD. Se reservan y cargan 0 USD (`basis: reported`), los tokens se guardan en eventos `provider.usage`, y `budget.json` añade `maxCodexCallsPerRun` (12 por defecto: 2 revisores UX/UI por tarea con reparaciones y reintentos, calibrado a ojo; no medido). La columna `role_attempts.provider` (migración 8) permite contar llamadas. Alcanzar el tope bloquea el run como `budget_exhausted`.
5. **Fallos**: igual que Claude. Salida ausente, no JSON o fuera de esquema → `invalid_output` (una reparación); límite de uso → `quota_exhausted` con `waitUntil` si el mensaje lo trae (`resets_at`, `resets_in_seconds`, «try again in/at»), que se convierte en `quota_wait`; 429 → transitorio reintentable; timeout → reintento único; lo demás → `provider_error`.
6. **Independencia**: aviso (no bloqueo) en `doctor` y en `plan` (evento `roles.warning`) cuando un `reviewer-*` comparte proveedor y modelo con el builder.

## Riesgos aceptados / abiertos

- El sandbox `read-only` de Codex permite **leer todo el sistema de archivos** (comprobado). Un revisor Codex podría leer `~/.ssh` o el `auth.json` real e incluirlo en su salida o enviarlo al modelo de OpenAI. Mitigaciones actuales: sin red desde comandos, HOME vacío, entrada del revisor controlada por la factory. No se encontró un modo verificado de restringir lecturas (perfiles de permisos de `config.toml` sin probar). **Resuelto en el ADR 0018**: toda llamada Codex corre en un contenedor que solo monta lo necesario.
- Los revisores UX/UI leen capturas PNG; no se verificó que Codex pueda inspeccionarlas con sus herramientas en `read-only` (Claude las lee con `Read`).
- El texto real del límite de uso de Codex no está capturado; el parser se probó con mensajes sintéticos.
- Cada llamada consume ~13,6k tokens de entrada solo por el prompt de sistema de Codex.
- `FACTORY_PROVIDER=claude` ahora significa «proveedores reales enrutados por rol»; el nombre se conserva por compatibilidad.

## Alternativas descartadas

- Reutilizar el `~/.codex` del usuario con flags de ignorar: carga `AGENTS.md`, MCP y `model_instructions_file` según versión; un home temporal es verificable.
- Symlink de `auth.json`: Codex puede reemplazar el archivo al rotar y perder el cambio.
