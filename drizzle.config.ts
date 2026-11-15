import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: "postgresql://neondb_owner:npg_BEfkpvwT5bg6@ep-green-violet-bbpah8d0-pooler.c-15.us-east-1.aws.neon.tech/neondb?sslmode=require",
  },
});
