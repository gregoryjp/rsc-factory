# RSC Factory

Motor en TypeScript que convierte un PRD de negocio en un producto verificado y entregado en local: especifica, diseña la arquitectura, planifica, construye con TDD, revisa (seguridad, código, legal, UX, UI), integra y deja un informe. Inspirado en el flujo mostrado por Eric Risco y adaptado a un stack propio.

## Cómo funciona

`PRD → spec → arquitectura → plan → tareas (rojo → verde → reparaciones) → revisores → gate G4 → integración → entrega`

- Estado durable en SQLite, con reanudación tras cortes, presupuesto y espera por cuota.
- Los checks (tests, auditoría de dependencias, SAST, evidencia visual con Playwright) corren en Docker sobre snapshots del commit.
- Dos proveedores configurables por rol (`factory/config/roles.json`): Claude Code CLI y Codex CLI, con respaldo automático de uno a otro. Codex corre confinado en contenedor.
- Cuatro plantillas listas: `api`, `apiweb`, `landing` y `mobile`.

## Requisitos

Node 22, Docker, git y al menos uno de: Claude Code CLI (suscripción Pro) o Codex CLI (suscripción ChatGPT). No usa claves de API de pago.

## Uso

```bash
npm ci
npm run factory -- doctor
npm run factory -- run --prd factory/examples/PRD-MINI-LANDING.md --target ../mi-producto --budget-usd 15
```

Referencia de comandos y códigos de salida: [docs/operations/cli.md](docs/operations/cli.md). Plantilla de PRD: [templates/PRD-PRODUCTO.md](templates/PRD-PRODUCTO.md).

## Documentación

- [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md): estado por hito y límites conocidos.
- [docs/adr/](docs/adr/): decisiones de arquitectura (0001–0020).
- [docs/compatibility/matrix.md](docs/compatibility/matrix.md): versiones y modelos verificados.
- [docs/01-EXTRACCION-DEL-VIDEO.md](docs/01-EXTRACCION-DEL-VIDEO.md) a [docs/04-FUENTES-Y-DECISIONES.md](docs/04-FUENTES-Y-DECISIONES.md): origen del diseño.

## Seguridad y límites

Cada plantilla trae una base de seguridad (autenticación, rate limiting, CSP, denegación por defecto), páginas legales provisionales con marcadores `[PENDIENTE]` y comprobaciones automáticas. Los textos legales son estructura, no asesoría jurídica. Antes de producción hay que revisar los marcadores, las credenciales y la configuración del host.

No es el código oficial de RSC Factory ni está afiliado a su autor.
