import pg from "pg";

// node-postgres returns BIGINT (OID 20) as a string by default, precisely
// because a JS number can't hold every int8. We want plain numbers in the code,
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
  const pool = new pg.Pool({ connectionString, max });
  // An idle pooled connection can die (server restart, network blip). pg
  // reports that as an 'error' event; with no listener, Node treats it as an
  // uncaught exception and the process exits. The pool already discards the
  // dead client, so logging is enough.
  pool.on("error", (err) => {
    console.error("idle postgres client error:", err.message);
  });
  return pool;
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
  // If the connection dies mid-transaction, the in-flight query rejects (and
  // that's how the caller finds out), but pg *also* emits 'error' on the
  // client. Without a listener that event would crash the process.
  const onError = () => {};
  client.on("error", onError);
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The connection is unusable. Postgres aborts the transaction
      // itself when the session ends, so nothing was committed. Just make
      // sure this client isn't handed out again.
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.off("error", onError);
    client.release(broken);
  }
}
