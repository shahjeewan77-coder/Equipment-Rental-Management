import pg from "pg"; import fs from "fs";
import bcrypt from "bcryptjs";
const url = fs.readFileSync("/tmp/dburl.txt","utf8").trim();
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const hash = await bcrypt.hash("Rent@2026New", 10);
await c.query("update users set password_hash=$1 where email='ram@sharma.com'", [hash]);
console.log("password set for ram@sharma.com");
await c.end();
