export type Result<Value, Failure> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly failure: Failure };

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });

export const fail = <Failure>(failure: Failure): Result<never, Failure> => ({ ok: false, failure });
