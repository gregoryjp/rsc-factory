export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type Failure<C extends string = string> = { code: C; message: string };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const fail = <C extends string>(code: C, message: string): Result<never, Failure<C>> =>
	err({ code, message });
