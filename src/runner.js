/* Endpoints for the runner: the program on your Windows VPS that opens each Dolphin Anty profile and drives Instagram.
   Auth: "Authorization: Bearer <runner token>" (Settings, Runner). It can only act for accounts you switched to the runner driver.
   Most routes are the very same handlers the Chrome extension uses, so both drivers behave identically. */
const crypto = require("node:crypto");
const { now, str, num, uid, HttpError } = require("./util");
const { makeHandlers, touchSeen, ROUTES } = require("./ext");

function registerRunner(router, ctx) {
  const { db, accounts, auth, supervisor, vision, bus } = ctx;
  const token = () => { let t = db.setting("runner_token", ""); if (!t) { t = "runner_" + uid(32); db.setSetting("runner_token", t); } return t; };
  const tokenOk = (given) => { const a = Buffer.from(String(given || "")), b = Buffer.from(token()); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  let lastWrite = 0;
  const seen = () => { if (now() - lastWrite > 10_000) { lastWrite = now(); db.setSetting("runner_seen_at", now()); bus.publish({ t: "runner" }); } };

  const gate = (c) => {
    const ip = c.req.socket.remoteAddress || "";
    if (auth.throttled(ip)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
    const m = /^Bearer\s+(\S+)$/i.exec(String(c.req.headers.authorization || ""));
    if (!m || !tokenOk(m[1])) { auth.noteFail(ip); throw new HttpError(401, "Wrong or missing runner token."); }
    seen();
  };
  const withAccount = (handler) => async (c) => {
    gate(c);
    const account = accounts.byId(num(c.params.id));
    if (!account || account.kind !== "sender") throw new HttpError(404, "Unknown account.");
    if (account.driver !== "runner") throw new HttpError(409, "This account is not set to use the runner. Change its driver in the dashboard.");
    touchSeen(ctx, account);
    return handler({ ...c, account });
  };

  router.get("/runner/accounts", (c) => {
    gate(c);
    return { accounts: db.all("SELECT * FROM accounts WHERE kind = 'sender' AND driver = 'runner' AND state != 'killed' ORDER BY id").map((a) => ({ id: a.id, label: a.label, igUsername: a.ig_username, dolphinProfileId: a.dolphin_profile_id, state: accounts.effectiveState(a).state })), serverTime: now() };
  });

  const H = makeHandlers(ctx, "runner");
  for (const [method, path, name] of ROUTES) if (name !== "leads") router[method]("/runner/a/:id" + path, withAccount(H[name]));

  /* Ask the supervisor about one command before it is carried out. */
  router.post("/runner/a/:id/supervise", withAccount(async ({ account, body }) => supervisor.review(account, num(body.taskId))));

  /* Screenshot questions. The body carries a base64 screenshot, so the server's body limit for this path is larger. */
  router.post("/runner/a/:id/vision/:kind", withAccount(async ({ account, params, body }) => {
    const f = { locate: vision.locate, classify: vision.classify, verify_thread: vision.verifyThread, verify_sent: vision.verifySent }[params.kind];
    if (!f) throw new HttpError(404, "Unknown question.");
    return f(account.id, { image: body.image, mediaType: body.mediaType, goal: body.goal, hint: body.hint, width: body.width, height: body.height, username: body.username, text: body.text });
  }));
  return { token, regenerate: () => { db.setSetting("runner_token", "runner_" + uid(32)); return token(); } };
}
module.exports = { registerRunner };
