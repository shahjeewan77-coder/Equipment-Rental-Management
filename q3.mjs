import pg from 'pg';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
const r = await c.query(`SELECT e.name, m.date_ad, m.date_bs, m.type, m.qty, m.created_at, m.reversal_of_id, m.auto_return, m.note
FROM stock_movements m JOIN equipment e ON e.id=m.equipment_id ORDER BY e.name, m.date_ad, m.created_at`);
for (const x of r.rows) console.log(x.name,'|',x.date_ad,'|',x.date_bs,'|',x.type,'|',x.qty,'|rev:',x.reversal_of_id?'Y':'-','|auto:',x.auto_return?'Y':'-','|',x.note??'');
await c.end();
