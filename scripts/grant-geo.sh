#!/bin/bash
# Grant geolocation at the browser level.
#
# `set geo` sets coordinates but does not grant the permission, so
# getCurrentPosition still fails with code 1 (User denied). Chrome remembers a
# DENIED geolocation decision per origin, so that denial is sticky across
# reloads. Granting via CDP Browser.grantPermissions overrides it.
B=agent-browser

CDP=$($B get cdp-url 2>&1 | tail -1 | tr -d '"' | sed 's/^ *//')
echo "cdp: $CDP"

node -e '
const url = process.argv[1];
(async () => {
  const http = require("http");
  const get = (p) => new Promise((res, rej) => {
    http.get(url.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "") + p, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d)));
    }).on("error", rej);
  });
  const list = await get("/json/list");
  const page = list.find((t) => t.type === "page");
  console.log("page:", page ? page.url : "none");
  const WebSocket = require("ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));
  ws.on("open", () => {
    send(1, "Browser.grantPermissions", {
      permissions: ["geolocation", "notifications"],
      origin: "http://localhost:3000",
    });
  });
  ws.on("message", (m) => {
    const d = JSON.parse(m.toString());
    if (d.id === 1) {
      console.log("grant result:", JSON.stringify(d.result || d.error));
      send(2, "Emulation.setGeolocationOverride", { latitude: 27.7172, longitude: 85.324, accuracy: 15 });
    }
    if (d.id === 2) {
      console.log("geo override:", JSON.stringify(d.result || d.error));
      ws.close();
    }
  });
  setTimeout(() => process.exit(0), 8000);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
' "$CDP"
