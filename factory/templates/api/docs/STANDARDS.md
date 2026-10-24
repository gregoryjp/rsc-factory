# Estándares de {{PRODUCT_NAME}}

1. Código y tests en inglés; documentación en español.
2. Funcional: objetos planos y closures; sin `class` salvo `AppError`.
3. TypeScript estricto, sin `any`. Imports con extensión `.js` en el API.
4. SQL crudo solo con tagged templates (`npm run check:sql`).
5. Controllers sin Prisma y services sin Express (`npm run check:layers`).
6. Tests contra PostgreSQL real, en serie, con guard que exige `NODE_ENV=test` y una base `*_test`.
7. Sin comentarios en código (`npm run check:comments`).
8. Versiones exactas en `package.json`.
