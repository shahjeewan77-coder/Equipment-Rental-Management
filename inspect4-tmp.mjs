import pg from "pg"; import fs from "fs";
const url = fs.readFileSync("/tmp/dburl.txt","utf8").trim();
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const u = await c.query("select id,email,name from users where id='9d4da48e-9857-4c79-a28c-0e59162897ad'");
console.log("RAM USER:", JSON.stringify(u.rows));
await c.end();
