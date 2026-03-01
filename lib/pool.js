// lib/pool.js
// Single source of truth for Postgres connection pool (singleton across invocations).

import { Pool } from "pg";

const pool =
  globalThis.__lux_pool ||
  new Pool({
    connectionString:
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_CONNECTION ||
      process.env.DATABASE_URL,
    ssl:
      process.env.PGSSLMODE === "disable"
        ? false
        : { rejectUnauthorized: false },
  });
globalThis.__lux_pool = pool;

export { pool };
export default pool;
