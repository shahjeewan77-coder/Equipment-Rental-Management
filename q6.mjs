import 'dotenv/config';
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
console.log('=== future-dated movements (date_ad > today 2026-11-01) ===');
console.log((await c.query(`SELECT COUNT(*)::int n FROM stock_movements WHERE date_ad > '2026-11-01'`)).rows);
console.log('\n=== movements with date_ad NULL ===');
console.log((await c.query(`SELECT COUNT(*)::int n FROM stock_movements WHERE date_ad IS NULL`)).rows);
console.log('\n=== total movements (vs the 200-row cap in listStockMovements) ===');
console.log((await c.query(`SELECT COUNT(*)::int n FROM stock_movements`)).rows);
console.log('\n=== per item: all-time log closing vs Stock closing ===');
const r = await c.query(`
SELECT e.name, e.total_qty, e.on_rent_qty,
  COALESCE(SUM(CASE WHEN m.type='in' THEN m.qty ELSE 0 END),0) AS all_in,
  COALESCE(SUM(CASE WHEN m.type='out' THEN m.qty ELSE 0 END),0) AS all_out
FROM equipment e LEFT JOIN stock_movements m ON m.equipment_id=e.id
GROUP BY e.name,e.total_qty,e.on_rent_qty ORDER BY e.name`);
for (const x of r.rows){
  const closing = Number(x.total_qty)-Number(x.on_rent_qty);
  const logClose = Number(x.total_qty)+Number(x.all_in)-Number(x.all_out);
  console.log(`${x.name} | logClose ${logClose} | stockClose ${closing} | ${logClose===closing?'MATCH':'MISMATCH'}`);
}
await c.end();
