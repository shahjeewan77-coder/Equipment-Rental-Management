import pg from "pg"; import fs from "fs";
const url = fs.readFileSync("/tmp/dburl.txt","utf8").trim();
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const p = await c.query("select user_id,role,display_name,username from profiles where role='driver'");
console.log("DRIVER PROFILES:", JSON.stringify(p.rows,null,1));
const u = await c.query("select id,email,name from users where id in (select user_id from profiles where role='driver')");
console.log("DRIVER USERS:", JSON.stringify(u.rows,null,1));
await c.end();
