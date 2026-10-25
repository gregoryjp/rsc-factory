import { dockerIdSalt, ID_SALT_ENV } from "../helpers/id-salt.js";

process.env[ID_SALT_ENV] = process.env[ID_SALT_ENV] ?? dockerIdSalt();
