# ADR 0020 — Gate SAST determinista

- Estado: aceptado (P1)
- Relacionado: ADR 0008 (snapshots), ADR 0011 (runner Docker), ADR 0016 (auditoría de dependencias, mismo patrón)

## Contexto

El gate G4 revisa seguridad con un modelo y ADR 0016 cubrió las dependencias con `npm audit`, pero ninguna comprobación determinista miraba el código que escribe el builder (`eval`, HTML crudo, secretos en el código, TLS desactivado, inyección de comandos). Hace falta un análisis estático sin cuenta, sin clave de API y sin coste, que corra en el mismo runner aislado y no dependa de que el modelo «se acuerde».

## Decisión

**Un escáner propio sin dependencias**, `factory/sast/scan.mjs`, ejecutado con `node --input-type=module -e <fuente>` sobre el snapshot del commit, a través del runner de checks normal (Docker, sin montar `$HOME` ni el socket). Reglas en el propio archivo (23 reglas por línea, severidad `high`/`medium`/`low`); salida: una línea `FACTORY_SAST_RESULT {json}` interpretada con Zod.

### Alternativas descartadas

- **Semgrep OSS**: es la opción más completa, pero exige imagen Python (la imagen del runner es Node), o `pip install` en cada check, y sus reglas buenas viven en el registro (`p/…`), que necesita red y no es determinista entre días. Con reglas locales y una imagen fijada sería viable, pero añade una segunda imagen al runner, a `doctor` y a los tests Docker; queda como mejora futura si el escáner propio se queda corto.
- **ast-grep / Biome security**: obligan a descargar un binario por check y Biome 2.x no trae un conjunto de reglas de seguridad comparable; añadir dependencias que ejecutar sobre código no confiable en cada check es superficie extra.
- **Escáner en el proceso del motor** (sin contenedor): rompería la regla de que todo código del producto se procesa aislado y no quedaría registrado como `check` (argv, commit, log).

Coste del enfoque elegido: es una heurística por línea, sin análisis de flujo de datos; produce falsos positivos y falsos negativos. No sustituye al revisor de seguridad del gate G4 ni a una herramienta de taint analysis.

### Política y ejecución

- Campo opcional `sast` (ruta relativa del escáner) en cada plantilla de `factory/policies/checks.json`. La fuente se lee con `factoryFiles` y se pasa como argv, de modo que el check queda registrado con su commit y su log como cualquier otro.
- Se omite en directorios `node_modules`, `dist`, `build`, `coverage`, `.expo`, `android`, `ios`, y en archivos de test (`*.test.*`, `test/`, `__tests__/`, `fixtures/`). Solo código, HTML, JSON y YAML de hasta 512 KiB.

### Línea base y gate

- Al iniciar `build` mientras la cabeza sea el commit del bootstrap se guarda el artefacto `sast-baseline` con los hallazgos de la plantilla intacta. Si el escáner no está disponible no se guarda y se reintenta en el siguiente `build`.
- Identidad de un hallazgo: `regla | archivo | huella` (sha256 de la línea recortada); no depende del número de línea, así que mover código no crea hallazgos nuevos. Cambiar la línea sí cuenta como nuevo.
- Tras el check verde de cada tarea, tras el check final de integración y en la entrega se compara con la línea base. Un hallazgo `high` nuevo bloquea: tarea `BLOCKED sast_new_finding` (reintentable con `factory retry`), run `BLOCKED` en el check final y `deliver` falla con `sast_new_finding`. `medium` y `low` se cuentan, no bloquean. Los de la línea base se listan como `accepted_baseline`.
- **`sast_unavailable` nunca cuenta como aprobado**: salida de error, sin línea de resultado, forma inesperada, fuente ilegible o falta de línea base. Por tarea es un aviso (`sast.warning`); `factory deliver` repite el escaneo y, si sigue sin estar disponible, falla con `sast_unavailable` sin tocar `main`.

### Informes

Eventos `sast.recorded` / `sast.warning` alimentan la sección «Análisis estático (SAST)» de `factory report` y la línea `SAST:` de `factory status`.

## Consecuencias

- Cuatro plantillas con `sast`; la política es la única que decide qué plantilla se escanea.
- El escáner es parte del motor: cambiar reglas cambia qué cuenta como «nuevo» solo para líneas base futuras (una línea base ya guardada no se recalcula).
- Límites: sin análisis entre archivos ni de flujo de datos, sin Python/Go/Prisma-SQL más allá de `$queryRawUnsafe`; el escaneo del código generado en `landing` y `mobile` cubre solo JS/TS/HTML/JSON/YAML.
