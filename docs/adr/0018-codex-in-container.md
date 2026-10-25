# ADR 0018 — Codex siempre dentro de un contenedor Docker

Estado: aceptado (H7b). Fecha: 2026-10-25.

## Contexto

El sandbox `read-only` de Codex permite leer todo el sistema de archivos (ADR 0017): un revisor Codex inyectado por el contenido del repositorio podría leer `~/.ssh` o el `auth.json` real y exfiltrarlo. Hay que dejar de depender del sandbox de Codex y confinar el proceso con Docker.

## Decisión

1. Cada llamada `codex exec` corre en `docker run` con el mismo convenio de objetos que el runner: nombre `factory-<run>-codex-<callId>`, etiquetas `factory.managed=true` y `factory.run=<run>`, sin `-p`, sin `docker.sock`, sin montar `$HOME` ni sus ancestros, imagen fijada por digest (`CODEX_IMAGE` = `NODE_IMAGE`).
2. Endurecimiento: `--read-only`, `--tmpfs /tmp` (64 MB, `nosuid`), `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 2g`, `--pids-limit 512`, `--user` igual al del runner de checks (0:0 en Docker Desktop), entorno mínimo (`HOME`, `CODEX_HOME`, `TMPDIR`, `PATH`, `LANG`, CA).
3. Montajes (los únicos): el directorio `vendor/<triple>` del paquete `@openai/codex-linux-*` en `/opt/codex` (solo lectura; es la opción más estrecha: un binario estático musl, no hace falta publicar ni construir una imagen), el directorio `home` de la llamada en `/codex-home` (lectura y escritura; contiene solo la copia de `auth.json`, y es lo que permite devolver al origen el token rotado exactamente como antes), el esquema en `/input/schema.json` (solo lectura) y el `cwd` de la petición en `/workspace` (solo lectura; escritura solo con `permissionMode: acceptEdits`). Las capturas de los revisores UX/UI ya viven dentro de ese `cwd` (`ui-evidence/`), por lo que no hay un montaje de evidencias aparte. La construcción de argv rechaza rutas relativas o con `,:` y saltos de línea, cualquier ruta que sea `$HOME` o ancestro, que toque `~/.ssh` o el `CODEX_HOME` real, o que contenga `docker.sock`.
4. Red: una red bridge propia por llamada `factory-<run>-codex-<callId>-net` (no `--internal`), creada y eliminada por el proveedor en un `finally` junto con el contenedor (`rm -f -v`). Es por llamada y no por run porque los revisores pueden ejecutarse en paralelo dentro del mismo run y compartir un nombre fijo provocaría colisiones. Docker no permite restringir la salida a una lista de hosts sin un proxy o reglas de firewall del host, por lo que no se intenta. Es aceptable porque dentro solo existen la copia de `auth.json` (necesaria para hablar con OpenAI) y el snapshot que se revisa; no hay claves SSH, ni el `auth.json` real, ni el socket de Docker.
5. Sandbox de Codex: dentro del contenedor, `bwrap` falla (`setting up uid map: Operation not permitted`, verificado) porque no hay capacidades. Se usa `-s danger-full-access` **solo** en modo contenedor, porque el contenedor es el sandbox (rootfs de solo lectura, montajes de solo lectura, sin capacidades). Se mantienen `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, los `--disable` y `web_search=disabled`.
6. Certificados: la imagen no trae CA, y sin ellas Codex falla con `UnknownIssuer`. El script de arranque genera el bundle desde `tls.rootCertificates` de Node (de la imagen fijada por digest) y exporta `SSL_CERT_FILE` y `CODEX_CA_CERTIFICATE`. Así no se monta nada del host para esto.
7. Cierre en fallo: sin Docker (o sin el paquete nativo de Codex) la llamada devuelve `provider_error` no reintentable con el prefijo `codex_requires_docker`. Solo `FACTORY_CODEX_HOST_UNSAFE=1` permite el camino anterior en el host. `doctor` añade `codex-isolation`: `ok` con Docker, `warn` con el opt-in, `fail` en otro caso (cuando algún rol usa Codex).
8. `ProviderRequest` gana `runId` (lo rellena `guardedInvoke`); sin él se usa `adhoc` como etiqueta.

## Verificación real (Docker Desktop, 2026-10-25)

- Dentro del contenedor no existen `~/.ssh`, `$HOME`, `~/.codex` ni `docker.sock`; el único `auth.json` visible es `/codex-home/auth.json`; rootfs, `/opt/codex` y `/workspace` son de solo lectura; `CapEff` es 0 y `NoNewPrivs` es 1.
- No quedan contenedores ni redes etiquetados tras éxito ni tras salida distinta de cero.
- Llamada real mínima (`gpt-6-astra`, `medium`, `{"ok":boolean}`) correcta en ~10 s (fixture `real_codex_docker_ok.jsonl`); un PNG del directorio de evidencias montado fue legible por la herramienta de shell del revisor.

## Riesgos abiertos

- Un revisor comprometido puede enviar el `auth.json` copiado y el snapshot por la red (salida abierta). El `auth.json` es una copia que puede rotar, pero el token sigue siendo válido: aceptado.
- Docker Desktop: los bind mounts solo funcionan bajo `$HOME`; en motor nativo con `userns`/rootless el usuario de contenedor no está verificado.
- `danger-full-access` depende de que los montajes y el endurecimiento del contenedor sigan intactos; los tests de argv fijan cada bandera.
- Un builder Codex con `acceptEdits` monta el `cwd` en escritura; no está verificado.
- El arranque añade ~1 s (Docker + bundle de CA).
