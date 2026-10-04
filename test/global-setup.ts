import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { TEST_DATABASE_URL } from "./config.js";

export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL, 1);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
