import { randomUUID } from "node:crypto";

export type IdGenerator = (prefix: string) => string;

export const uuidIds: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;
