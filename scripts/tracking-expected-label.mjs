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

// Reproduces what the tracking screen must decide, per driver:
//   live order (on_transit|on_rent) wins; otherwise the order the newest ping
//   belongs to decides the tense.
const r = await pool.query(`
  WITH last_ping AS (
    SELECT DISTINCT ON (dl.driver_id) dl.driver_id, dl.recorded_at, dl.order_id
      FROM trip_locations dl
     ORDER BY dl.driver_id, dl.recorded_at DESC
  ), live AS (
    SELECT DISTINCT ON (o.driver_id) o.driver_id, o.id, o.status, o.customer_id
      FROM orders o
     WHERE o.status IN ('on_transit','on_rent')
     ORDER BY o.driver_id, o.created_at DESC
  )
  SELECT d.id, d.name,
         lp.recorded_at,
         EXTRACT(EPOCH FROM (now() - lp.recorded_at))/86400 AS days,
         COALESCE(lv.status, po.status) AS eff_status,
         COALESCE(c.name, pc.name) AS eff_customer
    FROM drivers d
    LEFT JOIN last_ping lp ON lp.driver_id = d.id
    LEFT JOIN live lv ON lv.driver_id = d.id
    LEFT JOIN orders po ON po.id = lp.order_id
    LEFT JOIN customers c ON c.id = lv.customer_id
    LEFT JOIN customers pc ON pc.id = po.customer_id
   WHERE lp.recorded_at IS NOT NULL OR lv.status IS NOT NULL
   ORDER BY d.name
`);

for (const row of r.rows) {
  const age = row.days == null ? "no ping" : `${Number(row.days).toFixed(1)}d`;
  const status = row.eff_status || "none";
  const tense =
    status === "on_transit" ? "Delivering to" : ["on_rent", "returned", "completed", "cancelled", "rejected"].includes(status) ? "Delivered to" : "—";
  console.log(
    `${(row.name || "?").padEnd(18)} ping:${age.padEnd(8)} status:${status.padEnd(10)} => ${tense} ${row.eff_customer || "—"}`,
  );
}

await pool.end();
