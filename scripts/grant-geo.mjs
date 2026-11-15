// Grant geolocation using CDP against BOTH the browser and the page target.
// Chrome refuses (or ignores) Browser.grantPermissions when the request arrives
// on a page session, and a prior DENIED decision is sticky per origin, so the
// grant must be applied on the browser endpoint and the page then reloaded.
import http from "http";
import WebSocket from "ws";

const cdpUrl = process.argv[2];
const base = cdpUrl.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "");
const browserWs = cdpUrl;

const get = (p) =>
  new Promise((res, rej) => {
    http
      .get(base + p, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res(JSON.parse(d)));
      })
      .on("error", rej);
  });

const openWs = (url) =>
  new Promise((res) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
  });

const call = (ws, id, method, params) =>
  new Promise((res) => {
    const handler = (m) => {
      const d = JSON.parse(m.toString());
      if (d.id === id) {
        ws.off("message", handler);
        res(d.error ? { error: d.error } : { result: d.result });
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res({ error: "timeout" }), 5000);
  });

const list = await get("/json/list");
const page = list.find((t) => t.type === "page");
console.log("page:", page?.url);

// 1) Browser-level grant (this is where Browser.grantPermissions belongs).
const bws = await openWs(browserWs);
const g = await call(bws, 1, "Browser.grantPermissions", {
  permissions: ["geolocation"],
  origin: "http://localhost:3000",
});
console.log("browser grant:", JSON.stringify(g));

// 2) Page-level geolocation override + reload so the denied decision is gone.
const pws = await openWs(page.webSocketDebuggerUrl);
const o = await call(pws, 2, "Emulation.setGeolocationOverride", {
  latitude: 27.7172,
  longitude: 85.324,
  accuracy: 15,
});
console.log("override:", JSON.stringify(o));
const r = await call(pws, 3, "Page.reload", { ignoreCache: false });
console.log("reload:", JSON.stringify(r));

bws.close();
pws.close();
setTimeout(() => process.exit(0), 1500);
