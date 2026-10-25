# ADR 0016 — Auditoría de dependencias y revisor legal/privacidad

- Estado: aceptado (P0 baseline de seguridad)
- Relacionado: ADR 0006 (perfil de solo lectura), ADR 0008 (snapshots), ADR 0011 (runner Docker), ADR 0012 (gate G4), ADR 0013 (evidencia de navegador)

## Contexto

El gate G4 revisaba seguridad, código, UX y UI, pero no había ninguna comprobación determinista de vulnerabilidades conocidas en las dependencias ni una mirada explícita a los riesgos de privacidad cuando el producto trata datos personales. Ambas lagunas se cierran sin añadir confianza en el modelo donde se puede evitar.

## Decisión 1 — Auditoría de dependencias determinista

- La política `factory/policies/checks.json` admite por plantilla un campo opcional `audit` (argv): `["npm","audit","--omit=dev","--json"]` en `api`, `apiweb`, `landing` y `mobile`.
- Se ejecuta con el mismo runner de checks sobre el snapshot del commit (en Docker, el contenedor del check está en la red `factory-<run>-net`, que tiene salida al registro; no hace falta otra red). Cada ejecución queda en la tabla `checks` con su argv, commit y log, igual que cualquier check.
- Si el snapshot no tiene `package-lock.json` con dependencias bloqueadas (p. ej. `landing`), la auditoría se omite (`skipped`, registrado) sin lanzar contenedor.
- El JSON de npm 10 se interpreta con Zod de forma tolerante (ruido de `npm warn` alrededor, `via` mixto, `fixAvailable` booleano u objeto). Cada advisory se reduce a `{id (GHSA o npm:<source>), package, severity, fixAvailable}`.

### Línea base

Al iniciar `build`, mientras la cabeza de integración sea todavía el commit del bootstrap, el motor audita la plantilla intacta y guarda el artefacto `audit-baseline` (los advisories ya presentes). Si no hay dependencias, la línea base es vacía y queda marcada como omitida. Si la auditoría no está disponible en ese momento no se guarda línea base y se reintenta en el siguiente `build` mientras la cabeza no haya cambiado; una línea base tomada más tarde habría absorbido vulnerabilidades nuevas.

### Gate

Tras el check verde de cada tarea y tras el check final de integración se compara contra la línea base:

- Un advisory `high` o `critical` que no está en la línea base bloquea: la tarea queda `BLOCKED audit_new_vulnerability` (reintentable con `factory retry`); en el check final el run queda `BLOCKED`.
- Los advisories de la línea base nunca se ocultan: se listan como `accepted_baseline` en el evento, en `status` y en `report`. Los `moderate`, `low` e `info` se cuentan pero no bloquean.

### Semántica de «no disponible»

Registro inalcanzable, salida vacía o no interpretable, o falta de línea base dan `unavailable` con su motivo. **Nunca equivale a pasar.** Por tarea solo produce un evento `depaudit.warning` y el progreso continúa; en cambio **bloquea la entrega**: `factory deliver` repite la auditoría sobre la cabeza de integración y, si sigue sin estar disponible, falla con `audit_unavailable` sin tocar `main`. Reintentar más tarde basta. Una vulnerabilidad nueva en ese momento falla con `audit_new_vulnerability`.

### Informes

Eventos `depaudit.recorded` (fase `baseline`, `task`, `integration`, `delivery`) alimentan la sección «Auditoría de dependencias» de `factory report` (conteo por severidad, nuevas frente a línea base, no disponibles) y la línea `Dependency audit` de `factory status`.

## Decisión 2 — Revisor legal/privacidad (área `legal`)

- Nueva área `legal`, rol `reviewer-legal` (modelo `sonnet`, techo 0,5 USD por llamada), perfil de solo lectura como los demás revisores. El prompt `factory/prompts/reviewer-legal.md` es texto original.
- **Límites**: señala riesgos, no da asesoría legal ni afirma cumplimiento o incumplimiento de ninguna norma, y no inventa hechos legales (plazos de retención, bases legales). Lista de comprobación: inventario de datos personales, base legal/consentimiento, minimización, retención y vía de borrado, derechos del titular, cookies/analítica, datos de menores, encargados y transferencias, política de privacidad y aviso legal, seguridad de datos sensibles, datos personales en logs. Los hallazgos exigen evidencia; alto/crítico exige prueba. Un humano decide lo legal.
- **Aplicabilidad determinista** (`legalApplicability`, sin llamada al modelo). Aplica si hay alguna señal: (1) el diff de un schema o migración de Prisma añade campos de datos personales (email, name, phone, address, birth, dni/nif/passport, ip, location, lat/lng, avatar, photo); (2) código nuevo de cookies, `localStorage`, analítica o rastreo; (3) rutas de auth o sesión; (4) formularios que recogen esos campos; (5) el texto de requisitos menciona datos personales, privacidad, RGPD/GDPR, consentimiento o registro de usuarios. Si no, `not_applicable` con la razón «no personal data processing detected». Solo se consideran líneas añadidas del diff. Es heurística: puede dar falsos positivos (se revisa de más) y falsos negativos (un campo con otro nombre), y no sustituye una revisión legal humana.
- G4 exige ahora cinco áreas (`security`, `code`, `legal`, `ux`, `ui`) para el commit y ciclo exactos; un revisor legal `blocked` bloquea; los hallazgos siguen el mismo flujo de severidad, refutador, approver y reparación, y las reglas de re-revisión no cambian.
- El spec-writer registra supuestos explícitos (retención, base legal, vía de borrado) cuando el PRD implica datos personales. El suelo de riesgo determinista de la planificación sube a `high` con las palabras clave de datos personales, privacidad, consentimiento, GDPR/RGPD, cookies, tracking y borrar cuenta.

## Consecuencias

- `RoleSchema`, `roles.json`, `budget.json` y los fixtures de presupuesto incluyen `reviewer-legal`.
- El orden de revisión persistido pasa a `security, code, legal, ux, ui`.
- Limitaciones: la auditoría solo cubre npm y dependencias de producción (`--omit=dev`); la línea base de `build-bootstrap` (solo bootstrap) no se registra, se toma al iniciar `build`; el check de integración por tarea (tras cada merge) no repite la auditoría, solo el verde por tarea y el final.
