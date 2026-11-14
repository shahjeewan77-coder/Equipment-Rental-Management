import "dotenv/config";
import pg from "pg";
import { hash } from "bcryptjs";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const pw = await hash("Rent@2026New", 10);
const r = await c.query("update users set password_hash=$1 where email='driver1@driver.local' returning id, email", [pw]);
console.log("updated:", JSON.stringify(r.rows));
await c.end();
