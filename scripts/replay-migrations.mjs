// Replays every migration into a THROWAWAY schema and drops it afterwards.
//
// Why a separate schema rather than the dev database: dev already has every
// column, so a migration whose CREATE/ALTER collides would silently "succeed"
// there. A fresh schema is the only honest test of "applies from empty".
import { Pool } from "pg";
import fs from "fs";

const env = Object.fromEntries(
  fs
    .readFileSync("/workspace/app/.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")];
    }),
);

const SCHEMA = "mig_replay_check";
const pool = new Pool({ connectionString: env.DATABASE_URL });

const files = fs
  .readdirSync("/workspace/app/drizzle/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();

let applied = 0;
const failures = [];

try {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`SET search_path TO ${SCHEMA}`);

  for (const f of files) {
    const sql = fs.readFileSync(`/workspace/app/drizzle/migrations/${f}`, "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      for (const stmt of statements) {
        await pool.query(stmt);
      }
      applied++;
      console.log(`  OK  ${f}  (${statements.length} stmt)`);
    } catch (e) {
      failures.push({ file: f, error: e.message });
      console.log(`  FAIL ${f}: ${e.message}`);
    }
  }

  const t = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    [SCHEMA],
  );
  console.log(`\napplied ${applied}/${files.length}   failed ${failures.length}`);
  console.log(`tables created: ${t.rows.length}`);

  const cols = await pool.query(
    `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
       WHERE table_schema = $1
         AND (column_name LIKE 'delivery_%' OR column_name IN
              ('auto_return','reversal_of_id','source_customer_id','returned_at',
               'returned_qty','pick_from_customer_id','is_active','archived_at'))
       ORDER BY 1`,
    [SCHEMA],
  );
  console.log(`feature columns: ${cols.rows.map((r) => r.col).join(", ")}`);

  if (failures.length > 0) {
    console.log("\nRESULT: FAILED");
    process.exitCode = 1;
  } else {
    console.log("\nRESULT: ALL APPLIED CLEANLY");
  }
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
}
