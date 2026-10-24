import type { Clock } from "../infrastructure/clock.js";
import type { IdGenerator } from "../infrastructure/ids.js";
import type { Storage } from "./storage.js";

export type AppDeps = { storage: Storage; clock: Clock; ids: IdGenerator };
