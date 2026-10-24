# PRD demo — TurnoLocal

Producto ficticio de evaluación, no Kimmbo ni implementación de su alcance comercial. Objetivo: comprobar una vertical slice completa con UI, API, datos, autorización y pruebas.

## Problema
Un pequeño mostrador necesita registrar tickets y ver cuándo están preparados, sin pantalla pública ni notificaciones externas.

## Usuarios
Operador autenticado y supervisor autenticado. Un único local. Cuentas demo sembradas solo en entorno de pruebas; sin registro público, pagos, correo, NFC, realtime ni múltiples empresas.

## Requisitos y aceptación

- REQ-001: el operador inicia sesión y ve tickets. Credencial incorrecta produce error genérico; usuario no autenticado no puede consultar la API de tickets.
- REQ-002: el operador crea ticket con nota opcional de hasta 200 caracteres. Se genera número único y estado PREPARING; persiste tras reiniciar la API.
- REQ-003: transiciones PREPARING → READY → PICKED_UP; no se permiten saltos ni retrocesos. Dos peticiones concurrentes no corrompen el estado.
- REQ-004: lista con filtro por estado y paginación de 20, orden determinista. Carga, vacío, error y reintento visibles.
- REQ-005: solo supervisor puede cancelar un ticket no recogido. Un operador que llame directamente a la API recibe denegación.
- REQ-006: interfaz utilizable con teclado y en viewport de 390 y 1440 px, sin scroll horizontal no justificado. Estado no comunicado solo por color.
- REQ-007: validación de entradas en servidor; notas se muestran como texto, no HTML ejecutable.
- REQ-008: README con instalación, variables de entorno de ejemplo sin secretos, migración, seed y comandos de pruebas; health endpoint básico.

## Datos
User, Ticket y TicketEvent. Historial con actor y fecha. No usar datos reales de clientes. Evitar borrar historial para simular cancelación.

## Stack
Preset full-stack web definido en la arquitectura, con versiones compatibles verificadas. Sesión/auth deben justificarse y probarse. PostgreSQL local aislado para integración. No aceptar una lista en memoria como persistencia final.

## Entrega
Local con instrucciones reproducibles y capturas de los flujos. No desplegar producción. Informe requisito → test/evidencia para los ocho requisitos. Pruebas unitarias de transiciones, integración de permisos/persistencia/concurrencia y E2E del recorrido completo.

## Evaluaciones de fallo
Introducir en fixture/test una respuesta de agente inválida, fallo de check y evidencia de otro commit. La factory debe rechazarlos sin declarar éxito. Cortar y reanudar un run; probar también el límite de gasto con proveedor fake.
