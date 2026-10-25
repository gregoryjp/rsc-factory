# Estándares de {{PRODUCT_NAME}}

1. Código y tests en inglés; documentación en español.
2. Funcional: objetos planos y closures; sin `class` salvo `AppError`.
3. TypeScript estricto, sin `any`. Imports con extensión `.js` en el API.
4. SQL crudo solo con tagged templates (`npm run check:sql`).
5. Controllers sin Prisma y services sin Express (`npm run check:layers`).
6. Tests contra PostgreSQL real, en serie, con guard que exige `NODE_ENV=test` y una base `*_test`.
7. Sin comentarios en código (`npm run check:comments`).
8. Versiones exactas en `package.json`.
9. Listados siempre paginados con el helper de `src/infrastructure/pagination.ts` (`npm run check:pagination`).
10. Rutas POST con efectos no repetibles aceptan `Idempotency-Key` mediante el módulo `idempotency`.
11. Eventos de seguridad y de negocio sensibles se registran con `audit.record`, solo con ids e IP.
12. El runtime usa `DATABASE_URL` con el rol `app_runtime`; migrar solo con `MIGRATION_DATABASE_URL`.
13. Imagen de producción: digest fijado, usuario no root, `HEALTHCHECK`, sin dependencias de desarrollo (`npm run check:deploy`).
