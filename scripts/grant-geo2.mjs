// Clear the sticky geolocation denial, then grant, then reload.
// Chrome persists a DENIED permission decision per origin; Browser.grantPermissions
// returns {} but the stored decision still wins. Browser.resetPermissions clears
// the stored decisions so the grant can take effect.
import http from "http";
import WebSocket from "ws";

const cdpUrl = process.argv[2];
const base = cdpUrl.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "");

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

const openWs = (url) => new Promise((res) => { const ws = new WebSocket(url); ws.on("open", () => res(ws)); });

const call = (ws, id, method, params) =>
  new Promise((res) => {
    const h = (m) => {
      const d = JSON.parse(m.toString());
      if (d.id === id) { ws.off("message", h); res(d.error ? { error: d.error } : { result: d.result }); }
    };
    ws.on("message", h);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res({ error: "timeout" }), 5000);
  });

const list = await get("/json/list");
const page = list.find((t) => t.type === "page");
console.log("page:", page?.url);

const bws = await openWs(cdpUrl);
console.log("resetPermissions:", JSON.stringify(await call(bws, 1, "Browser.resetPermissions", {})));
console.log("grant:", JSON.stringify(await call(bws, 2, "Browser.grantPermissions", {
  permissions: ["geolocation"], origin: "http://localhost:3000",
})));

const pws = await openWs(page.webSocketDebuggerUrl);
console.log("override:", JSON.stringify(await call(pws, 3, "Emulation.setGeolocationOverride", {
  latitude: 27.7172, longitude: 85.324, accuracy: 15,
})));

// Hard reload so the page re-runs its GPS check against the new permission.
console.log("navigate:", JSON.stringify(await call(pws, 4, "Page.navigate", { url: "http://localhost:3000/tracking" })));

bws.close(); pws.close();
setTimeout(() => process.exit(0), 1200);
