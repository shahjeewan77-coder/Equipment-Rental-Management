import { handle } from "@hono/node-server/vercel";
// @ts-ignore
import app from "../dist/index.js";

export default handle(app);