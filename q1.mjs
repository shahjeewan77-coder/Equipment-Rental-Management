import pg from 'pg';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
const r = await c.query(`
SELECT e.id, e.name, e.total_qty, e.on_rent_qty,
  COALESCE(SUM(CASE WHEN m.type='in' THEN m.qty ELSE 0 END),0) AS total_in,
  COALESCE(SUM(CASE WHEN m.type='out' THEN m.qty ELSE 0 END),0) AS total_out,
  COUNT(m.id) AS n
FROM equipment e LEFT JOIN stock_movements m ON m.equipment_id=e.id
GROUP BY e.id,e.name,e.total_qty,e.on_rent_qty ORDER BY e.name`);
console.log('name | totalQty | onRent | closing | in | out | logClosing | drift | n');
for (const x of r.rows){
  const closing = Number(x.total_qty)-Number(x.on_rent_qty);
  const logClosing = Number(x.total_qty)+Number(x.total_in)-Number(x.total_out);
  console.log([x.name,x.total_qty,x.on_rent_qty,closing,x.total_in,x.total_out,logClosing,(logClosing-closing).toFixed(2),x.n].join(' | '));
}
await c.end();
