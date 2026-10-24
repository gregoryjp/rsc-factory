# Specification v1

## Requirements

### REQ-001 (must)

El operador autenticado inicia sesión y puede ver la lista de tickets; una credencial incorrecta produce un error genérico y un usuario no autenticado no puede consultar la API de tickets.

Source: Requisitos y aceptación — REQ-001

Acceptance:
- Con credenciales válidas de operador, el login tiene éxito y se muestra la lista de tickets.
- Con credenciales incorrectas, el sistema devuelve un mensaje de error genérico (sin indicar si el usuario o la contraseña es el incorrecto).
- Una petición a la API de tickets sin sesión/token válido es rechazada (no se devuelven datos de tickets).

### REQ-002 (must)

El operador crea un ticket con una nota opcional de hasta 200 caracteres; se genera un número único y el ticket queda en estado PREPARING, persistiendo tras reiniciar la API.

Source: Requisitos y aceptación — REQ-002

Acceptance:
- Crear un ticket sin nota tiene éxito, genera un número único y el estado inicial es PREPARING.
- Crear un ticket con nota de hasta 200 caracteres se acepta y la nota se almacena.
- Dos tickets creados consecutivamente tienen números distintos.
- Tras reiniciar el proceso de la API, un ticket creado previamente sigue siendo recuperable con los mismos datos.

### REQ-003 (must)

El ticket transiciona únicamente PREPARING → READY → PICKED_UP, sin permitir saltos de estado ni retrocesos, y las peticiones concurrentes no corrompen el estado.

Source: Requisitos y aceptación — REQ-003

Acceptance:
- La transición de PREPARING a READY se permite y actualiza el estado correctamente.
- La transición de READY a PICKED_UP se permite y actualiza el estado correctamente.
- Un intento de transicionar directamente de PREPARING a PICKED_UP es rechazado.
- Un intento de retroceder de READY a PREPARING (o de PICKED_UP a cualquier estado anterior) es rechazado.
- Al enviar dos peticiones de transición concurrentes sobre el mismo ticket, el estado final resultante es consistente con una única transición válida (sin estado corrupto ni duplicado).

### REQ-004 (must)

La lista de tickets admite filtro por estado y paginación de 20 elementos con orden determinista, mostrando visualmente los estados de carga, vacío, error y reintento.

Source: Requisitos y aceptación — REQ-004

Acceptance:
- Al filtrar por un estado dado, solo se muestran tickets con ese estado.
- Cada página de resultados contiene como máximo 20 tickets.
- El orden de los tickets es el mismo en cargas repetidas de la misma consulta (orden determinista).
- La interfaz muestra un indicador de carga mientras se obtienen los datos.
- La interfaz muestra un estado vacío cuando no hay tickets que coincidan con el filtro.
- Ante un fallo de la petición, la interfaz muestra un estado de error con una acción de reintento visible y funcional.

### REQ-005 (must)

Solo el supervisor puede cancelar un ticket que no ha sido recogido; un operador que invoque directamente la API de cancelación recibe una denegación.

Source: Requisitos y aceptación — REQ-005

Acceptance:
- Un supervisor autenticado puede cancelar un ticket en estado PREPARING o READY.
- Un intento de cancelar un ticket ya en estado PICKED_UP es rechazado.
- Una petición de cancelación realizada por un operador autenticado (no supervisor) es denegada por la API, independientemente de la interfaz.

### REQ-006 (must)

La interfaz es utilizable completamente con teclado y se visualiza correctamente en viewports de 390 px y 1440 px sin scroll horizontal no justificado, comunicando el estado del ticket sin depender únicamente del color.

Source: Requisitos y aceptación — REQ-006

Acceptance:
- Todos los controles interactivos (crear ticket, filtrar, cambiar estado, cancelar) son accesibles y operables solo con teclado.
- En un viewport de 390 px de ancho no aparece scroll horizontal no justificado.
- En un viewport de 1440 px de ancho no aparece scroll horizontal no justificado.
- El estado de cada ticket se identifica mediante texto o icono además del color.

### REQ-007 (must)

El servidor valida todas las entradas y las notas se muestran siempre como texto, nunca como HTML ejecutable.

Source: Requisitos y aceptación — REQ-007

Acceptance:
- Una petición al servidor con datos inválidos (p. ej. campos faltantes o con formato incorrecto) es rechazada por el servidor independientemente de cualquier validación en el cliente.
- Una nota que contiene etiquetas HTML o scripts se renderiza como texto literal en la interfaz, sin ejecutarse (ausencia de XSS).

### REQ-008 (must)

El proyecto incluye un README con instalación, variables de entorno de ejemplo sin secretos, migración, seed, comandos de pruebas, y un health endpoint básico.

Source: Requisitos y aceptación — REQ-008

Acceptance:
- El README contiene pasos de instalación reproducibles.
- El README incluye un archivo o sección de variables de entorno de ejemplo que no contiene secretos reales.
- El README incluye los comandos para ejecutar migraciones y seed de datos de demostración.
- El README incluye los comandos para ejecutar las pruebas (unitarias, integración, E2E).
- Existe un endpoint de health que responde con éxito cuando el servicio está operativo.

## Assumptions

### ASM-001

El número único del ticket se genera de forma secuencial/legible, sin coordinarse con sistemas externos, dado que el documento no especifica el formato.

- Reason: El PRD solo exige 'número único' sin definir algoritmo ni formato.
- Impact: Determina el diseño del generador de números y su presentación en UI/API.
- Reversible: yes
- Requirements: REQ-002

### ASM-002

La autenticación se implementa mediante sesión de servidor (o token equivalente) con credenciales sembradas solo en entorno de pruebas, sin especificar el proveedor exacto.

- Reason: El documento exige que 'sesión/auth deben justificarse y probarse' pero no indica el mecanismo concreto (cookie de sesión, JWT, etc.).
- Impact: Condiciona la implementación de login, verificación de rol y pruebas de autorización.
- Reversible: yes
- Requirements: REQ-001, REQ-005

### ASM-003

Si la nota supera los 200 caracteres, el servidor rechaza la petición con un error de validación en lugar de truncarla silenciosamente.

- Reason: El PRD indica el límite de 200 caracteres pero no define el comportamiento ante su incumplimiento.
- Impact: Afecta la respuesta de la API y los mensajes mostrados al operador al crear el ticket.
- Reversible: yes
- Requirements: REQ-002, REQ-007

### ASM-004

Se usa el código 401 para peticiones no autenticadas y 403 para peticiones autenticadas pero sin permiso (p. ej. operador intentando cancelar).

- Reason: El documento exige 'denegación' en ambos casos sin precisar códigos HTTP concretos.
- Impact: Afecta el diseño de la API y de las pruebas de integración de permisos.
- Reversible: yes
- Requirements: REQ-001, REQ-005

### ASM-005

El orden determinista de la lista paginada se define por fecha de creación ascendente, usando el número de ticket como criterio de desempate.

- Reason: El PRD exige 'orden determinista' pero no especifica el campo de ordenación.
- Impact: Afecta la consulta de paginación y las pruebas de orden en la lista de tickets.
- Reversible: yes
- Requirements: REQ-004

### ASM-006

El 'preset full-stack web definido en la arquitectura' referenciado en la sección Stack corresponde a un documento externo no incluido aquí; las versiones concretas se documentarán en el README de la entrega.

- Reason: El PRD menciona un preset de arquitectura sin incluir su contenido ni versiones en este documento.
- Impact: La elección final de stack y versiones queda fuera de este spec y debe justificarse en el README (REQ-008).
- Reversible: yes
- Requirements: REQ-008

### ASM-007

La cancelación de un ticket se implementa como un cambio de estado (p. ej. CANCELLED) que conserva el historial de eventos, en lugar de borrar o sobrescribir registros previos.

- Reason: La sección 'Datos' pide explícitamente 'evitar borrar historial para simular cancelación', lo que condiciona cómo REQ-005 debe implementarse.
- Impact: Determina el modelo de datos de TicketEvent y la lógica de cancelación.
- Reversible: yes
- Requirements: REQ-005

### ASM-008

El health endpoint es una ruta simple (p. ej. GET /health) que devuelve 200 OK con un cuerpo mínimo indicando disponibilidad, sin verificar dependencias externas en detalle.

- Reason: El PRD exige un 'health endpoint básico' sin especificar ruta, formato de respuesta ni alcance de las verificaciones.
- Impact: Define el contrato mínimo del endpoint de salud y su prueba de aceptación.
- Reversible: yes
- Requirements: REQ-008

## Contradictions

### CON-001 (non-critical)

El problema planteado requiere 'ver cuándo están preparados' los tickets (visibilidad oportuna de cambios de estado), pero la sección 'Usuarios' excluye explícitamente capacidades de tiempo real. No es bloqueante: puede resolverse con refresco manual o polling periódico en vez de actualizaciones push, pero el documento no aclara si eso satisface la necesidad del negocio.

- Requirements: REQ-004

## Out of scope

- Implementación del alcance comercial de Kimmbo (este es un producto ficticio de evaluación).
- Registro público de usuarios.
- Pagos.
- Notificaciones por correo electrónico.
- NFC.
- Pantalla pública y funcionalidad en tiempo real (realtime).
- Soporte para múltiples empresas/locales (multi-tenant); el alcance es un único local.
- Despliegue a producción; la entrega es local con instrucciones reproducibles.
- Uso de datos reales de clientes.
- Persistencia en memoria (lista en memoria) como solución final de almacenamiento; se requiere PostgreSQL.

## Open questions

- ¿Qué stack/preset exacto y qué versiones deben usarse, dado que el documento solo referencia 'el preset definido en la arquitectura' sin detallarlo aquí?
- ¿Qué mecanismo concreto de sesión/autenticación se debe implementar (cookie de sesión, JWT u otro) y qué nivel de prueba se exige para justificarlo?
- ¿Qué debe ocurrir exactamente si la nota de un ticket supera los 200 caracteres: rechazo con error o truncado automático?
- ¿Qué formato debe tener el número único de ticket (secuencial, con prefijo, aleatorio, etc.)?
- ¿Es aceptable para el negocio resolver la visibilidad de 'tickets preparados' mediante refresco manual/polling, dado que se excluye explícitamente el tiempo real?
- La sección 'Evaluaciones de fallo' del documento describe pruebas del propio proceso de entrega/factory (respuestas de agente inválidas, cortes de ejecución, límites de gasto) y no comportamiento del producto TurnoLocal: ¿se confirma que queda fuera del alcance de este spec de producto?
