import 'dotenv/config';
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(`SELECT id,name,phone,address FROM customers ORDER BY name`);
console.log('total customers:', r.rows.length);
for (const x of r.rows) console.log(`${x.name} | ${x.phone ?? '(none)'} | ${x.address ?? ''}`);
console.log('\n=== duplicates on (normalized name, normalized phone) ===');
const d = await c.query(`
SELECT lower(btrim(regexp_replace(name,'\\s+',' ','g'))) AS nname,
       regexp_replace(coalesce(phone,''),'\\D','','g') AS nphone,
       COUNT(*)::int AS n, array_agg(name) AS names, array_agg(id) AS ids
FROM customers
GROUP BY 1,2 HAVING COUNT(*) > 1`);
console.log(d.rows.length ? d.rows : 'none');
await c.end();
