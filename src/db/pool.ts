import pg from "pg";

// node-postgres returns BIGINT (OID 20) as a string by default, precisely
// because a JS number can't hold every int8. We want plain numbers in the API,
// so convert — but refuse rather than silently round if a value is ever
// outside the safe-integer range. The schema caps balances at
// MAX_SAFE_INTEGER, so this should be unreachable; it's here so that if it
// ever isn't, we find out loudly instead of losing a cent.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value ${value} is outside the JS safe-integer range`);
  }
  return n;
});

export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/move_money";

export function createPool(
  connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  max = 10,
): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

/**
 * Run `fn` inside a transaction on a dedicated client. Commits if `fn`
 * resolves, rolls back if it throws, and always releases the client.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
