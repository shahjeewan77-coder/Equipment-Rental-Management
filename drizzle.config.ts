import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: "postgresql://neondb_owner:npg_h2AgDBrEWP0S@ep-patient-bird-bbg0i39z-pooler.c-15.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  },
});