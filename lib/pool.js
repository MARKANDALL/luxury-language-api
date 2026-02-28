// lib/pool.js
import { Pool } from "pg";

// Singleton across invocations / hot reloads
export const pool =
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