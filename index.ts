// @ts-ignore
import app from "../dist/index.js";

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const PUT = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);
export const PATCH = (request: Request) => app.fetch(request);
export const OPTIONS = (request: Request) => app.fetch(request);