import { Pool } from 'pg';
import fs from 'fs';
const env = Object.fromEntries(fs.readFileSync('/workspace/app/.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const p = new Pool({connectionString: env.DATABASE_URL});
const r = await p.query(`select name, phone from customers where name ilike '%ganesh%' or phone='9855112233' order by name`);
console.log(JSON.stringify(r.rows));
const bad = await p.query(`select name, phone from customers where name ~ '[0-9]'`);
console.log('names containing digits:', JSON.stringify(bad.rows));
await p.end();
