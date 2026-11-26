/* Maison Setter command center — views part 5: the sender test bench.
   Make one sender account do one real thing right now — follow someone, like a post, send a message —
   to prove the account (and the pipeline behind it) works. Nothing is scheduled, paced or capped for
   a test: it jumps the queue and runs the moment the browser checks in. */
(() => {
"use strict";
const { h, ico, api, toast, badge, empty, field, ago, clock, S, VIEWS, guard, stateBadge, debounced } = window.MS;
const $ = (s, r = document) => r.querySelector(s);

const VERDICT = {
  followed: "followed", sent: "done", liked: "liked", already_liked: "was already liked", already_following: "was already following",
  invalid_profile: "page does not exist", private_cant_message: "private, cannot message", cant_message: "cannot be messaged",
  no_message_button: "no Message button", no_textbox: "message box never opened", unconfirmed: "sent, but not seen in thread",
  no_follow_button: "no Follow button", follow_unconfirmed: "Follow did not confirm", no_post_to_like: "no post to like",
  no_like_button: "no Like button", like_unconfirmed: "Like did not confirm", aborted: "stopped before it ran",
  login_required: "logged out", blocked: "Instagram warning", checkpoint: "security check", cancelled: "cancelled", error: "error"
};
const what = (t) => t.kind === "follow" ? `Follow @${t.username}`
  : t.kind === "like" ? (t.postUrl ? `Like ${t.postUrl.replace(/^https?:\/\/(www\.)?instagram\.com\//, "")}` : `Like @${t.username}'s latest post`)
  : `Message @${t.username}`;
const statusOf = (t) => t.status === "pending" ? badge("Waiting for the browser", "warn", true)
  : t.status === "done" ? badge("Done", "good", true)
  : t.status === "failed" ? badge("Failed", "bad", true)
  : badge("Cancelled", "", true);

async function viewTest(rootEl) {
  const box = h("div", { class: "stack" }); rootEl.append(box);
  let accs = [], tests = [], chosen = "";

  /* ---------- pick the account (its select, status line and banner redraw; the form never does) ---------- */
  const sel = h("select", { id: "tAcc", "aria-label": "Sender account to test" });
  const stat = h("span", { id: "tStat", class: "muted small", "aria-live": "polite" });
  const note = h("div", { class: "banner", role: "status", hidden: true });
  const cur = () => accs.find((a) => String(a.id) === chosen);
  const who = () => (cur() ? cur().label : "this account");
  function drawSide() {
    sel.replaceChildren(h("option", { value: "", text: "Pick a sender account…" }), ...accs.map((acc) =>
      h("option", { value: String(acc.id), text: `${acc.label} (@${acc.igUsername})${acc.clientName ? " · " + acc.clientName : ""}`, selected: String(acc.id) === chosen ? true : null })));
    const a = cur();
    if (!a) { stat.textContent = ""; note.hidden = true; return; }
    stat.textContent = a.online ? "Connected live — a test runs within seconds." : a.lastSeenAt ? `Last seen ${ago(a.lastSeenAt)} — open that browser so the test can run.` : "Never connected — pair the extension first (Sender accounts).";
    const paused = a.state === "paused", hard = ["quarantined", "cooldown", "restricted", "killed"].includes(a.state);
    note.className = "banner " + (hard ? "bad" : paused ? "warn" : "info");
    note.replaceChildren(...(hard
      ? [ico("alert"), h("span", { text: `${a.label} is ${a.state} right now, so it refuses every test. ${a.reason || ""} Release it first (Sender accounts page).` })]
      : paused ? [h("span", { text: `${a.label} is paused, so its normal campaign stands still — but a test you run here goes ahead anyway. That is the point: you are driving it by hand.` })]
      : [h("span", { text: `A test jumps the whole queue: it runs immediately, whatever the sending hours, caps or warm-up plan say. Everything else about ${a.label} keeps behaving exactly as configured.` })]));
    note.hidden = false;
  }

  /* ---------- the three test cards (built once; typed text is never wiped) ---------- */
  const mkInput = (id, ph) => h("input", { id, maxlength: 60, placeholder: ph, autocapitalize: "none", spellcheck: "false" });
  const followU = mkInput("tFollow", "username to follow, e.g. joes.roofing");
  const likeU = mkInput("tLikeU", "username (their latest post gets the like)");
  const likeP = mkInput("tLikeP", "…or paste a post link: instagram.com/p/…");
  const dmU = mkInput("tDmU", "username to message");
  const dmT = h("textarea", { id: "tDmT", rows: 3, maxlength: 1000, placeholder: "The exact test message. It is really sent from this account, right away." });
  const msg = h("p", { class: "msg", role: "alert" });
  const runBtn = (label, icon, kind, gather, confirmText, validate) => {
    const b = h("button", { class: "btn primary", type: "button" }, ico(icon), label);
    b.onclick = guard(b, async () => {
      msg.textContent = ""; msg.className = "msg";
      if (!chosen) { msg.className = "msg err"; msg.textContent = "Pick a sender account first."; return; }
      const body = { accountId: Number(chosen), kind, ...gather() };
      if (validate) { const v = validate(body); if (v) { msg.className = "msg err"; msg.textContent = v; return; } }
      if (confirmText && !confirm(confirmText())) return;
      try {
        const r = await api("POST", "/api/test/run", body);
        toast(`Test queued on ${r.account.label}: it runs the moment the browser checks in.`, "good");
        await refreshTests();
      } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
    });
    return b;
  };
  const cards = h("div", { class: "grid two" },
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Follow a profile" })),
      h("p", { class: "small muted", text: "Opens the profile, presses Follow like a person would, and checks the button really flipped to Following." }),
      field("tFollow", "Instagram username", followU, "It really follows them. Pick a harmless account you do not mind this sender following."),
      h("div", { class: "row" }, runBtn("Follow now", "user", "follow", () => ({ username: followU.value })))),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Like a post" })),
      h("p", { class: "small muted", text: "Give a post or reel link to like that exact one, or a username and the sender likes their latest post. The Like is verified on the page." }),
      h("div", { class: "field-row" }, field("tLikeU", "Instagram username", likeU), field("tLikeP", "Or a post link", likeP)),
      h("div", { class: "row" }, runBtn("Like now", "spark", "like", () => ({ postUrl: likeP.value.trim(), username: likeU.value })))),
    h("section", { class: "card", style: "grid-column:1/-1" }, h("div", { class: "card-head" }, h("h2", { text: "Send a message" })),
      h("p", { class: "small muted", text: "This sends a REAL direct message from the sender account, immediately — no warm-touch, no pacing, no caps. It sends even when you already have a thread with them. Use your own handle or a colleague's to see it land without touching a lead." }),
      h("div", { class: "field-row" }, field("tDmU", "Instagram username", dmU), field("tDmT", "Test message", dmT)),
      h("div", { class: "row" }, runBtn("Send it now", "chat", "dm", () => ({ username: dmU.value, text: dmT.value }),
        () => `${who()} will really message @${(dmU.value || "").replace(/^@/, "")} right now: "${dmT.value.slice(0, 120)}". Send it?`,
        (body) => { const u = String(body.username || "").toLowerCase().replace(/^@/, "");
          if (!/^[a-z0-9._]{1,30}$/.test(u)) return "Enter the Instagram username to message.";
          return String(body.text || "").trim() ? null : "Write the test message to send."; }))),
  );

  /* ---------- recent tests (this card's body is the only thing that redraws on the timer) ---------- */
  const tableBox = h("div");
  function drawTests() {
    tableBox.replaceChildren(tests.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["When", "Account", "Test", "Result", ""].map((t) => h("th", { text: t })))),
      h("tbody", null, tests.map((t) => h("tr", null,
        h("td", { class: "nowrap muted", text: t.doneAt ? clock(t.doneAt) : clock(t.createdAt) }),
        h("td", { text: t.account }),
        h("td", null, h("b", { text: what(t) }), t.kind === "dm" && t.text ? h("div", { class: "muted small", text: t.text.slice(0, 80) }) : null),
        h("td", null, statusOf(t), t.code ? h("span", { class: "muted small", text: " " + (VERDICT[t.code] || t.code.replace(/_/g, " ")) }) : null),
        h("td", null, t.status === "pending" ? (() => { const b = h("button", { class: "btn sm ghost", type: "button", text: "Cancel" }); b.onclick = guard(b, async () => { try { await api("POST", `/api/test/cancel/${t.id}`, {}); toast("Test cancelled."); } catch (e) { toast(e.message, "err"); } await refreshTests(); }); return b; })() : null))))))
      : empty("No tests yet", "Pick a sender above and run the first one. Every test lands here with its result."));
  }
  const refreshTests = async () => { tests = (await api("GET", "/api/test/tasks" + (chosen ? `?accountId=${chosen}` : ""))).tasks; drawTests(); };

  const load = async () => {
    accs = (await api("GET", "/api/accounts")).accounts;
    if (!chosen || !accs.some((a) => String(a.id) === chosen)) {
      const on = accs.find((a) => a.online) || accs[0];
      chosen = on ? String(on.id) : "";
    }
    drawSide();
    await refreshTests();
  };
  sel.onchange = () => { chosen = sel.value; drawSide(); refreshTests().catch(() => {}); };

  box.replaceChildren(
    h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Sender test" }),
      h("p", { text: "Make one sender account do one real thing right now: follow a profile, like a post, or send a message. Use it to prove the account works — after pairing, after a quarantine release, or whenever something seems off. A test skips the queue entirely: no sending window, no caps, no warm-up gates, no waiting. It runs the moment that browser checks in." })),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => load().catch(() => {}), text: "Refresh" }))),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Which account should act" })),
      h("div", { class: "field-row" }, field("tAcc", "Sender account", sel), field("tStat", "Browser", stat)),
      note),
    cards, msg,
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Recent tests" }),
      h("span", { class: "muted small", text: "The last 25 for this account, newest first" })), tableBox),
  );

  await load();
  const timer = setInterval(async () => { try { drawSide(); await refreshTests(); } catch { /* signed out */ } }, 5000);
  const reload = debounced(() => { if (!rootEl.contains(document.activeElement) || !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) load().catch(() => {}); }, 600);
  return { onEvent(e) { if (["task", "account"].includes(e.t)) reload(); }, refresh: load, unmount() { clearInterval(timer); } };
}
VIEWS.test = viewTest;
})();
