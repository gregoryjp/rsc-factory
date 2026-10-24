# PRD — Landing mini (validación de bajo coste)

Producto ficticio para validar la factory de punta a punta con el menor consumo posible. Sin backend, sin base de datos, sin autenticación.

## Problema y usuario
Un profesional independiente necesita una página de presentación con un formulario de contacto que no se pueda enviar con datos inválidos.

## Objetivo del MVP
Una página estática verificable. No entra: envío real del formulario, analítica, cookies, varios idiomas.

## Requisitos

- REQ-001: la página muestra un título, una descripción breve y un botón «Contactar» que lleva al formulario de la misma página.
  Aceptación: Dado que abro la página, cuando pulso «Contactar», entonces el foco se mueve al primer campo del formulario.
- REQ-002: el formulario pide nombre (obligatorio), correo (obligatorio, formato válido) y mensaje (obligatorio, máximo 500 caracteres).
  Aceptación: Dado un correo con formato inválido, cuando envío, entonces se muestra un error junto al campo y no se considera enviado; con datos válidos se muestra «Mensaje listo para enviar».
- REQ-003: la página es utilizable con teclado y en pantallas de 390 y 1440 px, sin scroll horizontal; los errores no se comunican solo por color.

## Interfaz
Español. Sin marca: la factory propone una base sobria y la marca como supuesto.

## Entrega
Local. Sin publicación.
