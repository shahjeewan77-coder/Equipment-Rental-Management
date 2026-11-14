// Compares drizzle/migrations/*.sql against meta/_journal.json.
// An SQL file the journal does not list is ORPHANED: drizzle-kit will never run
// it, so the column it adds exists in the repo but not in any database - and
// publish applies only journalled migrations. That is the v18 publish blocker.
import fs from "fs";

const dir = "drizzle/migrations";
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(".sql", ""))
  .sort();
const journal = JSON.parse(fs.readFileSync(`${dir}/meta/_journal.json`, "utf8"));
const tags = journal.entries.map((e) => e.tag).sort();

const orphaned = files.filter((f) => tags.indexOf(f) === -1);
const missing = tags.filter((t) => files.indexOf(t) === -1);

console.log(`sql files: ${files.length}  journal entries: ${tags.length}`);
console.log(`ORPHANED (file not in journal): ${JSON.stringify(orphaned)}`);
console.log(`MISSING (journal, no file):    ${JSON.stringify(missing)}`);

if (orphaned.length > 0 || missing.length > 0 || files.length !== tags.length) {
  console.log("RESULT: MISMATCH");
  process.exit(1);
}
console.log("RESULT: CLEAN");
