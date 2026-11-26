/* A stand-in for Dolphin Anty's local API. "Starting a profile" launches a real Chromium with remote debugging on, and
   returns { port, wsEndpoint } the same way Dolphin does, so the runner attaches exactly as it will on the VPS. */
const http = require("node:http");

function createFakeDolphin(chromium) {
  const running = new Map(), calls = []; let loggedIn = false, token = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"), send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    calls.push(req.method + " " + url.pathname);
    if (req.method === "POST" && url.pathname === "/v1.0/auth/login-with-token") { let raw = ""; for await (const c of req) raw += c; token = JSON.parse(raw || "{}").token; loggedIn = token === "dolphin-secret"; return loggedIn ? send(200, { success: true }) : send(401, { error: "bad token" }); }
    let m;
    if ((m = /^\/v1\.0\/browser_profiles\/([\w-]+)\/start$/.exec(url.pathname))) {
      if (!loggedIn) return send(401, { error: "not logged in" });
      const id = m[1]; if (running.has(id)) return send(200, { success: false, error: "already running" });
      const port = 19000 + Math.floor(Math.random() * 900), browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-agent=Mozilla/5.0 FakeProfile/${id}`] });
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); running.set(id, browser);
      return send(200, { success: true, automation: { port, wsEndpoint: new URL(info.webSocketDebuggerUrl).pathname } });
    }
    if ((m = /^\/v1\.0\/browser_profiles\/([\w-]+)\/stop$/.exec(url.pathname))) { const b = running.get(m[1]); running.delete(m[1]); if (b) await b.close().catch(() => {}); return send(200, { success: true }); }
    send(404, { error: "not found" });
  });
  return { calls, running, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))), async close() { for (const b of running.values()) await b.close().catch(() => {}); running.clear(); await new Promise((r) => server.close(r)); } };
}
module.exports = { createFakeDolphin };
