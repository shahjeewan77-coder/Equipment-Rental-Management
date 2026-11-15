import 'dotenv/config';
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
// Default BS range = current BS month start -> today
const r = await c.query(`
SELECT e.name,
  COALESCE(SUM(CASE WHEN m.type='in' THEN m.qty ELSE 0 END),0) AS all_in,
  COALESCE(SUM(CASE WHEN m.type='out' THEN m.qty ELSE 0 END),0) AS all_out,
  COALESCE(SUM(CASE WHEN m.type='in' AND m.date_ad >= '2026-10-18' THEN m.qty ELSE 0 END),0) AS rng_in,
  COALESCE(SUM(CASE WHEN m.type='out' AND m.date_ad >= '2026-10-18' THEN m.qty ELSE 0 END),0) AS rng_out,
  COUNT(m.id)::int AS n,
  COUNT(m.id) FILTER (WHERE m.date_ad < '2026-10-18')::int AS before_range
FROM equipment e LEFT JOIN stock_movements m ON m.equipment_id=e.id
GROUP BY e.name ORDER BY e.name`);
console.log('item | allOut | rngOut | allIn | rngIn | n | beforeRange');
for (const x of r.rows) console.log(`${x.name} | ${x.all_out} | ${x.rng_out} | ${x.all_in} | ${x.rng_in} | ${x.n} | ${x.before_range}`);
await c.end();
