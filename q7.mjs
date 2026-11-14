import 'dotenv/config';
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
console.log((await c.query(`SELECT id,name FROM equipment ORDER BY name`)).rows);
await c.end();
