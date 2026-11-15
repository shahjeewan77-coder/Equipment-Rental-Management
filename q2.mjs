import pg from 'pg';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
const t = await c.query(`SELECT COUNT(*)::int n FROM stock_movements`);
console.log('total movements:', t.rows[0].n);
const r = await c.query(`
SELECT e.name,
  COUNT(m.id)::int AS n,
  COALESCE(SUM(CASE WHEN m.type='in' THEN m.qty ELSE 0 END),0) AS all_in,
  COALESCE(SUM(CASE WHEN m.type='out' THEN m.qty ELSE 0 END),0) AS all_out
FROM equipment e LEFT JOIN stock_movements m ON m.equipment_id=e.id
GROUP BY e.name ORDER BY n DESC`);
for (const x of r.rows) console.log(x.name, '| n=', x.n, '| in=', x.all_in, '| out=', x.all_out);
await c.end();
