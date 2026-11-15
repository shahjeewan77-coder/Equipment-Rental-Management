import 'dotenv/config';
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(`DELETE FROM customers WHERE name='Annapurna Infra' AND phone='9800000123' RETURNING id,name,phone`);
console.log('removed test row:', r.rows);
console.log('total now:', (await c.query(`SELECT COUNT(*)::int n FROM customers`)).rows[0].n);
await c.end();
