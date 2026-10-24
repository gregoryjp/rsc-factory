export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const isValidRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);
