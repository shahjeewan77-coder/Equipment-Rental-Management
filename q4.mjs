import 'dotenv/config';
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
console.log('=== stored on_rent_qty vs actual on_rent order lines ===');
const r = await c.query(`
SELECT e.name, e.total_qty, e.on_rent_qty,
  COALESCE((SELECT SUM(oi.actual_qty - oi.returned_qty) FROM order_items oi
     JOIN orders o ON o.id=oi.order_id
     WHERE oi.equipment_id=e.id AND o.status='on_rent'),0) AS actual_on_rent
FROM equipment e ORDER BY e.name`);
for (const x of r.rows) {
  const d = Number(x.on_rent_qty) - Number(x.actual_on_rent);
  console.log(x.name, '| total', x.total_qty, '| stored onRent', x.on_rent_qty, '| actual onRent', x.actual_on_rent, '| diff', d);
}
console.log('\n=== orphan movements (equipment missing) ===');
console.log((await c.query(`SELECT COUNT(*)::int n FROM stock_movements m LEFT JOIN equipment e ON e.id=m.equipment_id WHERE e.id IS NULL`)).rows);
console.log('\n=== movements with null/zero qty ===');
console.log((await c.query(`SELECT COUNT(*)::int n FROM stock_movements WHERE qty IS NULL OR qty=0`)).rows);
console.log('\n=== order statuses ===');
console.log((await c.query(`SELECT status, COUNT(*)::int n FROM orders GROUP BY status ORDER BY n DESC`)).rows);
await c.end();
