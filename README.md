# Gregory Software Factory — paquete para Claude

## Uso

El motor de la factory (`src/`) se maneja con la CLI: `npm ci && npm run factory -- doctor`, y después, con un solo comando, `npm run factory -- run --prd <ruta> --target <dir> --budget-usd 15` (planifica, construye, revisa y entrega en local; si se detiene por presupuesto o cuota, imprime el comando exacto para continuar). Referencia completa de comandos, códigos de salida y la guía «Cómo usar la factory con un PRD nuevo»: [`docs/operations/cli.md`](docs/operations/cli.md). Estado por hito: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

Este paquete convierte el vídeo proporcionado en una especificación implementable para tu propia factory. **Es un blueprint de construcción, no una factory ejecutable ya terminada.** No es el código oficial de RSC Factory.

## Cómo usarlo

1. Extrae el ZIP en una carpeta de trabajo.
2. Abre esa carpeta en Claude Code, con acceso al entorno donde construirá el proyecto.
3. Envía el contenido de `prompts/00-PROMPT-MAESTRO-PARA-CLAUDE.md`.
4. Claude debe construir y validar H0–H6, usando el PRD demo antes de aceptar la factory como lista.
5. Una vez implementada/configurada, podrás aportar PRD de nuevos productos; no deberías repetir manualmente el proceso de dirección.

No necesitas escribir los archivos del proyecto uno por uno. Claude tiene instrucciones para tomar decisiones rutinarias, implementar, probar, corregir y continuar por hitos. Credenciales y datos esenciales de negocio no pueden inventarse.

## Contenido

- `docs/01-EXTRACCION-DEL-VIDEO.md`: mapa temporal, flujo y límites de lo mostrado.
- `docs/02-ARQUITECTURA-Y-PRD-FACTORY.md`: arquitectura, contratos, memoria, roles, gates, seguridad, fallos y entrega.
- `docs/03-PLAN-DE-IMPLEMENTACION.md`: hitos y 20 evaluaciones de aceptación.
- `docs/04-FUENTES-Y-DECISIONES.md`: documentación oficial y decisiones propias.
- `prompts/00-PROMPT-MAESTRO-PARA-CLAUDE.md`: encargo ejecutable para el agente.
- `prompts/01-CONTRATOS-DE-LOS-ROLES.md`: responsabilidades y salidas de cada agente.
- `templates/PRD-PRODUCTO.md`: formato de entrada reutilizable.
- `templates/PRD-DEMO.md`: prueba concreta PRD → producto.
- `evidence/transcripcion-automatica.md` y `.srt`: audio completo reconocido automáticamente, con tiempos y errores posibles.

## Decisión principal

No depender de un meg prompt que diga «hazlo todo». El director coordina; el motor guarda estado y exige evidencias; los revisores aportan criterio; la política delimita las acciones. Este reparto permite autonomía sin ocultar fallos.

## Qué se ha hecho aquí

Inspección del vídeo, extracción automática del audio, análisis crítico, definición de arquitectura y preparación del encargo para Claude. No se ha ejecutado Claude en tu ordenador, modificado un repositorio tuyo ni desplegado una aplicación. El plan exige esas verificaciones antes de declarar la factory terminada.
