/* A stand-in for Instagram, just enough for the runner: feed, profiles, story ring, follow, message thread, inbox JSON,
   a warning dialog and a profile whose Message button has a different label (so the script gets "stuck").
   Which account is logged in comes from the browser's user agent ("FakeProfile/<profile id>"). */
const http = require("node:http");

const WHO = { p1: "acme_one", p2: "acme_two" };
const BTN = "position:absolute;left:400px;top:300px;width:180px;height:44px;border:1px solid #888;background:#eee;font:16px sans-serif;display:flex;align-items:center;justify-content:center;cursor:pointer";
const TRACK = `<script>
  const mm = []; let last = 0;
  addEventListener('mousemove', (e) => { mm.push([Math.round(e.clientX), Math.round(e.clientY), Math.round(performance.now())]); });
  const flush = () => { if (!mm.length) return; navigator.sendBeacon('/_log', JSON.stringify({ t: 'mm', pts: mm.splice(0) })); };
  setInterval(flush, 400); addEventListener('pagehide', flush);
  const log = (o) => navigator.sendBeacon('/_log', JSON.stringify(o));
</script>`;
const page = (body, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif} header{height:80px;border-bottom:1px solid #ddd;padding:10px} article{height:520px;border-bottom:1px solid #eee;padding:20px} .short{height:100vh;overflow:hidden}</style></head><body>${body}${TRACK}${extra}</body></html>`;

function createFakeIg() {
  const events = []; let ip = "203.0.113.10", replyTs = 0;
  const profileFlags = (u) => ({ stuck: u === "stuck_user", priv: u === "private_user", ring: u === "ring_user", warn: u === "warn_user" });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x"), ua = String(req.headers["user-agent"] || ""), profile = (/FakeProfile\/(\w+)/.exec(ua) || [])[1] || "p1", me = WHO[profile] || "acme_one";
    const html = (s) => { res.writeHead(200, { "content-type": "text/html" }); res.end(s); }, json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/_log") { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { try { events.push({ ...JSON.parse(raw), profile, at: Date.now() }); } catch { /* ignore */ } res.writeHead(204); res.end(); }); return; }
    if (url.pathname === "/_ip") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ip })); }
    if (url.pathname === "/api/v1/accounts/current_user/") return json({ user: { username: me } });
    if (url.pathname === "/api/v1/direct_v2/inbox/") {      // the lead answers once, after our message has gone out, and the reply keeps the same timestamp on every read
      if (!replyTs && events.some((e) => e.t === "dm" && e.to === "joes_roofing")) replyTs = Date.now();
      const sent = events.find((e) => e.t === "dm" && e.to === "joes_roofing"), items = sent ? [{ item_type: "text", text: sent.text, user_id: "1", timestamp: sent.at * 1000 }] : [];
      if (replyTs) items.push({ item_type: "text", text: "Hi! How much for an inspection?", user_id: "2", timestamp: replyTs * 1000 });
      return json({ viewer: { pk: "1" }, inbox: { threads: items.length ? [{ thread_id: "T1", users: [{ username: "joes_roofing" }], items }] : [] } });
    }
    if (url.pathname === "/") { const arts = Array.from({ length: 8 }, (_, i) => `<article><h3>post ${i}</h3><div role="button" style="width:40px;height:40px"><svg aria-label="Like" width="24" height="24"><path d="M1 1"/></svg></div></article>`).join("");
      return html(page(`<header>feed (${me})</header>${arts}`, `<script>document.addEventListener('click',(e)=>{const b=e.target.closest('[role=button]');const s=b&&b.querySelector('svg[aria-label=Like]');if(s){s.setAttribute('aria-label','Unlike');log({t:'like'});}});</script>`)); }
    if (url.pathname === "/explore/") return html(page(`<header>explore</header>` + Array.from({ length: 6 }, (_, i) => `<article>tile ${i}</article>`).join("")));
    if (url.pathname === "/direct/inbox/") return html(page(`<header>inbox</header><div id="l"></div>`, `<script>fetch('/api/v1/direct_v2/inbox/').then(r=>r.json()).then(j=>{document.getElementById('l').textContent=j.inbox.threads.length+' threads'})</script>`));
    let m;
    if ((m = /^\/stories\/(\w+)\/1\/$/.exec(url.pathname))) return html(page(`<div class="short"><div role="button" aria-label="Close" style="position:absolute;right:20px;top:20px;width:40px;height:40px;background:#ccc"></div>story of ${m[1]}</div>`, `<script>document.querySelector('[aria-label=Close]').onclick=()=>{log({t:'story_closed'});history.back()};log({t:'story_viewed'})</script>`));
    if (/^\/p\/\w+\/$/.test(url.pathname)) return html(page(`<div class="short"><article><div role="button" style="width:40px;height:40px"><svg aria-label="Like" width="24" height="24"><path d="M1 1"/></svg></div></article></div>`, `<script>document.addEventListener('click',(e)=>{const b=e.target.closest('[role=button]');const s=b&&b.querySelector('svg[aria-label=Like]');if(s){s.setAttribute('aria-label','Unlike');log({t:'like'});}});</script>`));
    if ((m = /^\/direct\/t\/(\w+)\/$/.exec(url.pathname))) { const u = m[1], rows = u === "existing_user" ? `<div role="row">Hi earlier</div>` : "";
      return html(page(`<div class="short"><h2>${u}</h2>${rows}<div id="msgs"></div><div role="textbox" contenteditable="true" aria-label="Message" style="position:absolute;left:300px;top:600px;width:600px;height:40px;border:1px solid #999"></div></div>`,
        `<script>const box=document.querySelector('[role=textbox]');box.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();const t=box.textContent.trim();if(!t)return;const d=document.createElement('div');d.setAttribute('dir','auto');d.textContent=t;document.getElementById('msgs').append(d);box.textContent='';log({t:'dm',to:'${u}',text:t});}});</script>`)); }
    if ((m = /^\/(\w[\w.]*)\/$/.exec(url.pathname))) {
      const u = m[1], f = profileFlags(u);
      const dialog = f.warn ? `<div role="dialog" style="position:absolute;left:300px;top:200px;background:#fff;border:1px solid #000;padding:20px"><h2>Try Again Later</h2><p>We limit how often you can do certain things on Instagram.</p></div>` : "";
      const ring = f.ring ? `<canvas width="80" height="80" style="position:absolute;left:40px;top:90px;width:80px;height:80px;border-radius:50%;border:3px solid #c13584;cursor:pointer"></canvas>` : "";
      const msg = f.priv ? `<p style="position:absolute;left:400px;top:360px">This account is private</p>` : `<div role="button" style="${BTN}" id="msg">${f.stuck ? "Send message" : "Message"}</div>`;
      const grid = [1, 2, 3].map((i, k) => `<a href="/p/abc${i}/" style="position:absolute;left:${40 + k * 130}px;top:420px;width:120px;height:120px;background:#ddd;display:block"></a>`).join("");
      return html(page(`<div class="short"><header><h2 style="margin:0">${u}</h2>${ring}<button id="follow" style="position:absolute;left:400px;top:150px;width:120px;height:40px">Follow</button></header>${msg}${grid}${dialog}</div>`,
        `<script>const ring=document.querySelector('canvas');if(ring)ring.onclick=()=>{location='/stories/${u}/1/'};document.getElementById('follow').onclick=function(){this.textContent='Following';log({t:'follow',user:'${u}'})};const m=document.getElementById('msg');if(m)m.onclick=()=>{log({t:'open_thread',user:'${u}'});location='/direct/t/${u}/'};</script>`));
    }
    res.writeHead(404); res.end("nope");
  });
  return { events, setIp: (v) => { ip = v; }, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
module.exports = { createFakeIg };
