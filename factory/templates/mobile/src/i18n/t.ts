import { type MessageKey, messages } from "./messages";

export const t = (key: MessageKey): string => messages[key];
