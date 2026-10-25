import { randomBytes } from "node:crypto";

export const ID_SALT_ENV = "FACTORY_TEST_ID_SALT";

export const dockerIdSalt = (): string => randomBytes(4).toString("hex");
