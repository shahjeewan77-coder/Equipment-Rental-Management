import 'dotenv/config';
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
console.log('=== customers named Annapurna Infra ===');
console.log((await c.query(`SELECT id,name,phone FROM customers WHERE name ILIKE 'Annapurna%' ORDER BY phone`)).rows);
console.log('\n=== total customers ===');
console.log((await c.query(`SELECT COUNT(*)::int n FROM customers`)).rows);
await c.end();
