import type postgres from "postgres";

/** Reuse identical read promises within a single availability snapshot only.
 * Never used by the booking transaction: capacity must be read fresh under its lock.
 * SQL fragments and non-plain arguments are passed through without caching.
 */
export function snapshotReader(
  tx: postgres.TransactionSql,
): postgres.TransactionSql {
  const cache = new Map<string, Promise<unknown>>();
  const plain = (v: unknown): boolean =>
    v === null ||
    ["string", "number", "boolean", "undefined"].includes(typeof v) ||
    (Array.isArray(v) && v.every(plain));
  return new Proxy(tx, {
    apply(target, thisArg, args) {
      const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
      if (
        !Array.isArray(strings) ||
        !/^\s*select\b/i.test(strings[0] ?? "") ||
        !values.every(plain)
      )
        return Reflect.apply(target, thisArg, args);
      const key = JSON.stringify([strings, values]);
      let result = cache.get(key);
      if (!result) {
        result = Promise.resolve(Reflect.apply(target, thisArg, args));
        cache.set(key, result);
      }
      return result;
    },
  });
}
