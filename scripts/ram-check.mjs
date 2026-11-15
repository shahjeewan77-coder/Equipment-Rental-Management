import { Pool } from "pg";
import fs from "fs";

const env = Object.fromEntries(
  fs.readFileSync("/workspace/app/.env", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }),
);
const pool = new Pool({ connectionString: env.DATABASE_URL });

// Ram Bahadur's live orders, newest first — which one the SERVER resolves, and
// whether "Everest Construction" is still a live trip or stale test data.
const d = await pool.query(`SELECT id, name, owner_id FROM drivers WHERE name = 'Ram Bahadur' ORDER BY name`);
console.log("drivers:", JSON.stringify(d.rows));

for (const drv of d.rows) {
  const o = await pool.query(
    `SELECT o.id, o.order_no, o.status, o.driver_id, c.name AS customer, o.created_at
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.driver_id = $1 AND o.status IN ('on_transit','on_rent')
      ORDER BY o.created_at DESC`, [drv.id]);
  console.log(`driver ${drv.name} (${drv.id}) live orders:`);
  for (const r of o.rows) console.log("   ", JSON.stringify(r));
}

// Any live order to Everest at all?
const ev = await pool.query(
  `SELECT o.order_no, o.status, o.driver_id, c.name AS customer, o.created_at
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.status IN ('on_transit','on_rent')
    ORDER BY o.created_at DESC`);
console.log("\nALL live orders:");
for (const r of ev.rows) console.log("   ", JSON.stringify(r));

await pool.end();
