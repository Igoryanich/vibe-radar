// Ad-hoc inspection: node scripts/sql.ts "SELECT ..."
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.DATABASE_PATH ?? "data/radar.db", { readOnly: true });
const rows = db.prepare(process.argv[2]).all();
console.table(rows.map((r) => ({ ...r })));
