import { Pool } from "pg";
import fs from "fs";

const env = Object.fromEntries(
  fs
    .readFileSync("/workspace/app/.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")];
    }),
);
const pool = new Pool({ connectionString: env.DATABASE_URL });

// Every driver, their last ping age, and the live order they hold (if any).
// This is the same shape the tracking screen renders, so the expectation is
// derived from the database rather than from the screen.
const r = await pool.query(`
  SELECT d.id,
         d.name,
         lp.last_ping,
         EXTRACT(EPOCH FROM (now() - lp.last_ping))/86400 AS days_since_ping,
         lo.status AS live_status,
         lc.name AS live_customer
    FROM drivers d
    LEFT JOIN LATERAL (
      SELECT max(recorded_at) AS last_ping FROM trip_locations dl WHERE dl.driver_id = d.id
    ) lp ON true
    LEFT JOIN LATERAL (
      SELECT o.id, o.status, o.customer_id
        FROM orders o
       WHERE o.driver_id = d.id AND o.status IN ('on_transit','on_rent')
       ORDER BY o.created_at DESC LIMIT 1
    ) lo ON true
    LEFT JOIN customers lc ON lc.id = lo.customer_id
   ORDER BY d.name
`);

for (const row of r.rows) {
  const age =
    row.last_ping == null ? "never pinged" : `${Number(row.days_since_ping).toFixed(1)}d ago`;
  const live = row.live_status ? `${row.live_status} -> ${row.live_customer}` : "no live order";
  console.log(`${(row.name || "?").padEnd(22)} ping:${age.padEnd(18)} live:${live}`);
}

await pool.end();
