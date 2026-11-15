import { Pool } from "pg";
import fs from "fs";

const env = Object.fromEntries(
  fs.readFileSync("/workspace/app/.env", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }),
);
const pool = new Pool({ connectionString: env.DATABASE_URL });

// The tracked driver is the LOCKER (transited_by_driver_id), not driver_id —
// that was the error in my first expectation query, not in the app.
console.log("ALL live trips (status, tracked driver, customer):");
const live = await pool.query(`
  SELECT o.id, o.status, c.name AS customer,
         d.name AS tracked_driver,
         (o.transited_by_driver_id IS NOT NULL) AS has_locker,
         o.created_at
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN drivers d ON d.id = COALESCE(o.transited_by_driver_id, o.driver_id)
   WHERE o.status IN ('on_transit','on_rent')
   ORDER BY o.created_at DESC`);
for (const r of live.rows) console.log("   ", JSON.stringify(r));

console.log("\nPer-driver: newest ping's order vs live lock");
const per = await pool.query(`
  WITH last_ping AS (
    SELECT DISTINCT ON (driver_id) driver_id, recorded_at, order_id
      FROM trip_locations ORDER BY driver_id, recorded_at DESC
  ), live AS (
    SELECT DISTINCT ON (COALESCE(transited_by_driver_id, driver_id))
           COALESCE(transited_by_driver_id, driver_id) AS drv, id, status, customer_id
      FROM orders WHERE status IN ('on_transit','on_rent')
     ORDER BY COALESCE(transited_by_driver_id, driver_id), created_at DESC
  )
  SELECT d.name,
         ROUND(EXTRACT(EPOCH FROM (now()-lp.recorded_at))/86400) AS ping_days,
         lv.status AS live_status, lc.name AS live_customer,
         po.status AS ping_status, pc.name AS ping_customer
    FROM drivers d
    LEFT JOIN last_ping lp ON lp.driver_id = d.id
    LEFT JOIN live lv ON lv.drv = d.id
    LEFT JOIN orders po ON po.id = lp.order_id
    LEFT JOIN customers lc ON lc.id = lv.customer_id
    LEFT JOIN customers pc ON pc.id = po.customer_id
   WHERE lp.recorded_at IS NOT NULL OR lv.status IS NOT NULL
   ORDER BY d.name`);
for (const r of per.rows) {
  const eff = r.live_status || r.ping_status || "none";
  const cust = r.live_customer || r.ping_customer || "—";
  const tense = eff === "on_transit" ? "Delivering to" : ["on_rent","returned","cancelled"].includes(eff) ? "Delivered to" : "—";
  console.log(`   ${(r.name||"?").padEnd(16)} ping:${String(r.ping_days ?? "none").padEnd(5)} eff:${eff.padEnd(10)} => ${tense} ${cust}`);
}
await pool.end();
