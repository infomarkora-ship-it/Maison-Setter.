/* Maison Setter command center — views part 3: Senders Live (what every browser is doing right now)
   and the AI Lab (test drafts and supervisor drills without touching real leads). */
(() => {
"use strict";
const { h, ico, api, fmt, ago, clock, stamp, toast, meter, badge, empty, field, sw, kpi, campaignOptions, clientName, S, VIEWS, stateBadge, guard, openDrawer, closeDrawer } = window.MS;
const $ = (s, r = (r && r) || document) => (r || document).querySelector(s);
const MS = window.MS;

/* ---------------------------------------------------------------- Senders Live */
/* One card per sender: a traffic light, the narrated headline of what it is doing RIGHT NOW (with
   step x/y, why it is waiting and what comes next), today's numbers, and the last steps from that
   browser. The "Wall" toggle switches to one plain-English line per sender — everything all senders
   are doing at this moment on a single screen.
   Runner-driven accounts have no step-level feed (the runner reports its own heartbeats), so their
   card shows the runner's last action and last check-in instead. */
async function viewLive(rootEl) {
  const box = h("div"); rootEl.append(box); let d, timer = null, wall = false;
  const PHASE_TEXT = {
    idle: "Idle — nothing scheduled this minute",
    waiting: "Waiting out a human-like pause before its next move",
    working: "Working on a task",
    browsing: "Browsing Instagram like a person (warm-up)",
    inbox: "Reading the inbox for new replies",
    identity: "Checking which Instagram account is logged in",
    paused: "Paused", quarantined: "Quarantined", offline: "Not connected"
  };
  const TASK_LABEL = { dm: "First message", followup: "Follow-up", reply: "Reply", touch: "Warm-touch", warm: "Warm-up session" };
  const headline = (a) => {
    const s = a.live;
    if (!s) return a.online ? "Connected — waiting for its first status ping" : (a.lastSeenAt ? `Last seen ${ago(a.lastSeenAt)}` : "Never connected");
    if (a.driver === "runner") return s.note || PHASE_TEXT[s.phase] || "Working";
    if (s.phase === "working" || s.phase === "browsing") {
      const who = s.username ? `@${s.username}` : "";
      const label = s.taskLabel || TASK_LABEL[s.taskType] || "Task";
      const stepBit = s.stepIndex && s.stepTotal ? ` (step ${s.stepIndex}/${s.stepTotal})` : "";
      return `${label}${who ? " — " + who : ""}${stepBit}: ${s.step || "in progress"}`;
    }
    return PHASE_TEXT[s.phase] || s.note || "Connected";
  };
  const light = (a) => {
    if (a.state === "quarantined") return ["off", "Quarantined"];
    if (a.state === "paused") return ["off", "Paused"];
    if (!a.online) return ["off", "Browser not connected"];
    if (!a.liveFresh) return ["mid", "Connected, quiet for a while"];
    const p = a.live?.phase;
    if (p === "paused" || p === "quarantined") return ["mid", p];
    if (a.badge === "warming") return ["mid", "Warming up"];
    return ["on", "Working"];
  };
  const card = (a) => {
    const [cls, label] = light(a);
    const s = a.live;
    return h("section", { class: "card live-card" },
      h("div", { class: "card-head" },
        h("h2", null, h("span", { class: "live-dot " + cls, "aria-hidden": "true" }), h("b", { text: a.label }), h("span", { class: "muted small", text: " @" + a.igUsername })),
        h("div", { class: "row" }, badge(label, cls === "on" ? "good" : cls === "mid" ? "warn" : "", true), stateBadge(a),
          a.driver === "runner" ? badge("Runner", "info", true) : badge("Extension", "", true))),
      h("p", { class: "live-now", text: headline(a) }),
      s?.why ? h("p", { class: "small", style: "color:var(--warn)", text: "Why waiting: " + s.why }) : null,
      s?.next ? h("p", { class: "small muted", text: "Next: " + s.next }) : null,
      s?.lastError ? h("p", { class: "small", style: "color:var(--bad)", text: "Last error: " + s.lastError }) : null,
      h("div", { class: "live-facts" },
        h("span", null, h("b", { class: "num", text: `${a.sentToday}/${a.capToday}` }), " sent today"),
        h("span", null, h("b", { class: "num", text: a.program ? `${a.program.day}/${a.program.total}` : "—" }), " warm-up day"),
        h("span", null, h("b", { text: s ? ago(s.at) : a.lastSeenAt ? ago(a.lastSeenAt) : "never" }), " last ping")),
      meter(a.sentToday || 0, Math.max(a.capToday || 0, 1), a.badge === "quarantined" ? "bad" : ""),
      h("ul", { class: "feed small-feed", "aria-label": "Recent steps" },
        (a.log || []).length ? a.log.slice(0, 8).map((l) => h("li", null, h("span", { class: "t num", text: clock(l.at) }), h("span", { class: "grow", text: l.text })))
          : h("li", { class: "empty-li" }, h("span", { class: "muted", text: a.driver === "runner" ? "The runner reports heartbeats, not step-by-step logs. Its last action: " + (a.lastAction || "none yet") + "." : "No steps yet. As soon as this browser starts something, it shows up here." }))),
      a.state === "quarantined" ? h("p", { class: "small", style: "color:var(--bad)", text: a.reason || "Quarantined after an Instagram warning." }) : null);
  };
  const wallRow = (a) => {
    const [cls, label] = light(a);
    return h("div", { class: "alert", style: "align-items:center" },
      h("span", { class: "live-dot " + cls, "aria-hidden": "true" }),
      h("div", { class: "grow" }, h("b", { text: a.label }), h("span", { class: "muted small", text: " @" + a.igUsername + " · " }), h("span", { text: headline(a) }),
        a.live?.why ? h("div", { class: "small muted", text: "why: " + a.live.why }) : null),
      badge(label, cls === "on" ? "good" : cls === "mid" ? "warn" : "", true),
      h("span", { class: "num small muted", text: `${a.sentToday}/${a.capToday}` }));
  };
  const draw = () => {
    const accs = d.accounts || [];
    const live = accs.filter((a) => a.liveFresh && a.online).length, quiet = accs.filter((a) => a.online && !a.liveFresh).length, off = accs.filter((a) => !a.online).length;
    const warn = accs.filter((a) => a.state === "quarantined").length;
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Senders live" }),
        h("p", { text: "What every sender's browser is doing right now, narrated step by step. Green means it is connected and moving. This updates by itself." })),
        h("div", { class: "actions" }, h("div", { class: "tabs", style: "border:0" }, [["cards", "Cards"], ["wall", "Everything right now"]].map(([k, l]) =>
          h("button", { role: "tab", type: "button", "aria-selected": String((wall ? "wall" : "cards") === k), onclick: () => { wall = k === "wall"; draw(); } }, l))),
          h("button", { class: "btn", type: "button", onclick: load, text: "Refresh" }))),
      h("div", { class: "grid kpis" },
        kpi("Moving right now", live, "connected and reporting steps", { icon: "bolt", cls: live ? "accent" : "" }),
        kpi("Connected, quiet", quiet, "no step in the last two minutes", { icon: "clock" }),
        kpi("Not connected", off, "browser closed or asleep", { icon: "x" }),
        kpi("Quarantined", warn, warn ? "waiting for your release" : "nobody in the penalty box", { icon: "alert", cls: warn ? "" : "" })),
      accs.length ? (wall ? h("div", { class: "card stack", style: "margin-top:1rem" }, accs.map(wallRow)) : h("div", { class: "grid two" }, accs.map(card)))
        : empty("No sender accounts yet", "Add one under Sender accounts and pair the extension, and its live card appears here."));
  };
  const load = async () => { d = await api("GET", "/api/live"); draw(); };
  await load();
  timer = setInterval(() => { load().catch(() => {}); }, 5000);
  return {
    onEvent(e) { if (e.t === "live" || e.t === "account" || e.t === "task") load().catch(() => {}); },
    refresh: load,
    unmount() { clearInterval(timer); }
  };
}
VIEWS.live = viewLive;

/* ---------------------------------------------------------------- AI Lab */
async function viewLab(rootEl) {
  const box = h("div"); rootEl.append(box);
  let mode = "draft", busy = false;
  const clientSel = h("select", { id: "labClient", "aria-label": "Campaign" }, campaignOptions(S.clientId || (S.clients[0] || {}).id, false));
  const campRow = h("div", { class: "row" }, h("label", { for: "labClient", class: "small muted", text: "Use campaign:" }), clientSel,
    h("span", { class: "muted small", text: clientName(S.clientId) || (S.clients[0] || {}).name || "" }));
  clientSel.addEventListener("change", () => { campaignPill.textContent = "Testing as: " + clientName(Number(clientSel.value)) || ""; });

  /* ---- draft tester ---- */
  const pName = h("input", { id: "labName", placeholder: "Sam Rivera" }), pBio = h("textarea", { id: "labBio", rows: 3, placeholder: "Owner at a small local service business…" }),
    pCat = h("input", { id: "labCat", placeholder: "Roofing Service" }), pCaps = h("textarea", { id: "labCaps", rows: 2, placeholder: "One recent post caption per line (optional)" });
  const draftKind = h("select", null, h("option", { value: "dm", text: "First message (opener)" }), h("option", { value: "reply", text: "Reply to their last message" }));
  const convWrap = h("div", { class: "stack" });
  const addConv = (dir = "in", text = "") => {
    const row = h("div", { class: "row conv-row" }, h("select", { "aria-label": "Who says it" }, h("option", { value: "in", selected: dir === "in" ? true : null, text: "THEM (lead)" }), h("option", { value: "out", selected: dir === "out" ? true : null, text: "US (sender)" })),
      h("input", { class: "grow", placeholder: "What they said…", value: text }),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Remove line", onclick: () => row.remove() }, ico("x")));
    convWrap.append(row);
  };
  addConv("in", "Hey! How much for a full roof replacement in Austin?");
  const draftOut = h("div"), draftBtn = h("button", { class: "btn primary", type: "button" }, ico("bot"), "Write a test draft");
  draftBtn.onclick = guard(draftBtn, async () => {
    draftOut.replaceChildren(h("p", { class: "muted", text: "Thinking…" }));
    const body = { clientId: Number(clientSel.value), kind: draftKind.value, name: pName.value, bio: pBio.value, category: pCat.value,
      captions: pCaps.value.split("\n").map((x) => x.trim()).filter(Boolean),
      conversation: [...convWrap.querySelectorAll(".conv-row")].map((r) => ({ dir: r.querySelector("select").value, text: r.querySelector("input").value })) };
    const r = await api("POST", "/api/lab/draft", body);
    draftOut.replaceChildren(h("div", { class: "lab-result" },
      h("div", { class: "row between" }, h("b", { text: "Draft (not saved, not sent)" }), badge(`${r.provider} · ${r.model}`, "info", false)),
      h("blockquote", { class: "lab-draft", text: r.text || "(empty draft)" }),
      h("div", { class: "row small muted" }, h("span", { text: `${r.ms} ms` }), r.intent ? h("span", { text: `intent: ${r.intent}` }) : null, r.handoff ? badge("hands off to a human", "warn", true) : badge("confident", "good", true), r.clean ? h("span", { text: "cleaned by the safety filter" }) : null),
      h("div", { class: "row", style: "margin-top:.6rem" }, h("button", { class: "btn", type: "button", text: "Send this to the supervisor drill", onclick: () => { mode = "verdict"; draw(); vText.value = r.text; vKind.value = draftKind.value; toast("Draft moved into the supervisor drill.", "good"); } }))));
  });

  /* ---- supervisor drill ---- */
  const vKind = h("select", null, h("option", { value: "dm", text: "First message" }), h("option", { value: "reply", text: "Reply" }), h("option", { value: "followup", text: "Follow-up" }));
  const vText = h("textarea", { id: "labVerdict", rows: 3, placeholder: "The exact message you want reviewed…" });
  const vUser = h("input", { id: "labUser", placeholder: "lead_username" }), vName = h("input", { placeholder: "Sam Rivera" });
  const vMode = h("select", null, h("option", { value: "", text: "Campaign's own setting" }), h("option", { value: "watch", text: "Watch — approve everything" }), h("option", { value: "supervised", text: "Supervised — hold risk 75+" }), h("option", { value: "autopilot", text: "Autopilot — hold risk 90+" }));
  const vConvWrap = h("div", { class: "stack" });
  const addVConv = (dir = "in", text = "") => {
    const row = h("div", { class: "row conv-row" }, h("select", { "aria-label": "Who says it" }, h("option", { value: "in", selected: dir === "in" ? true : null, text: "THEM (lead)" }), h("option", { value: "out", selected: dir === "out" ? true : null, text: "US (sender)" })),
      h("input", { class: "grow", placeholder: "What they said…", value: text }),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Remove line", onclick: () => row.remove() }, ico("x")));
    vConvWrap.append(row);
  };
  addVConv("in", "Are you a bot or a real person?");
  const vOut = h("div"), vBtn = h("button", { class: "btn primary", type: "button" }, ico("shield"), "Run the drill");
  const VERDICT_CLS = { allow: "good", edit: "info", hold: "warn", block: "bad" };
  vBtn.onclick = guard(vBtn, async () => {
    vOut.replaceChildren(h("p", { class: "muted", text: "Running the same check a real send would run…" }));
    const body = { clientId: Number(clientSel.value), kind: vKind.value, text: vText.value, username: vUser.value.replace(/^@/, ""), name: vName.value, mode: vMode.value || undefined,
      conversation: [...vConvWrap.querySelectorAll(".conv-row")].map((r) => ({ dir: r.querySelector("select").value, text: r.querySelector("input").value })) };
    const r = await api("POST", "/api/lab/verdict", body);
    vOut.replaceChildren(h("div", { class: "lab-result" },
      h("div", { class: "row" }, badge(r.verdict.toUpperCase(), VERDICT_CLS[r.verdict] || "", true), badge(`risk ${r.risk}/100`, r.risk >= 60 ? "bad" : r.risk >= 21 ? "warn" : "good", false), badge(r.mode, "", false)),
      h("p", { text: r.reason || "" }),
      h("p", { class: "muted small", text: "The message that would actually go out:" }),
      h("blockquote", { class: "lab-draft", text: r.text || "(nothing)" }),
      r.aiError ? h("p", { class: "small", style: "color:var(--warn)", text: `Model note: ${r.aiError}` }) : null,
      h("p", { class: "muted small", text: "Recorded in the AI supervisor log as a lab run. Nothing was sent, nothing was saved as a task." })));
    loadHistory();
  });
  const histBox = h("div");
  const loadHistory = async () => {
    try {
      const r = await api("GET", "/api/lab/history?limit=12");
      const table = h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["When", "Test", "Verdict", "Risk", "Why"].map((t) => h("th", { text: t })))),
        h("tbody", null, r.runs.map((x) => h("tr", null,
          h("td", { class: "small muted", text: stamp(x.at) }),
          h("td", { class: "small", text: (x.kind || "").replace("lab:", "") }),
          h("td", null, badge(x.verdict.toUpperCase(), VERDICT_CLS[x.verdict] || "", true)),
          h("td", { class: "num", text: x.risk == null ? "—" : String(x.risk) }),
          h("td", { class: "small", text: x.reason || "" }))))));
      histBox.replaceChildren(r.runs.length ? table : h("p", { class: "muted small", text: "No lab runs yet. Run a drill above and it shows up here." }));
    } catch { histBox.replaceChildren(); }
  };

  const campaignPill = h("span", { class: "muted small", text: "Testing as: " + (clientName(S.clientId) || (S.clients[0] || {}).name || "") });
  const draw = () => {
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "AI Lab" }),
        h("p", { text: "A sandbox. The bot writes drafts and the supervisor reviews them exactly like it would before a real send — but nothing here is ever sent, saved or queued." })),
        h("div", { class: "actions" }, h("div", { class: "tabs", style: "border:0" }, [["draft", "Draft tester"], ["verdict", "Supervisor drill"]].map(([k, l]) =>
          h("button", { role: "tab", type: "button", "aria-selected": String(mode === k), onclick: () => { mode = k; draw(); } }, l))))),
      campRow, h("p", { class: "small muted", style: "margin:.2rem 0 .8rem" }, campaignPill),
      mode === "draft" ? h("div", { class: "grid two" },
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "A lead to test with" })),
          field("labName", "Name", pName), field("labBio", "Bio", pBio), field("labCat", "Category", pCat), field("labCaps", "Recent captions (one per line)", pCaps),
          h("h3", { text: "Conversation so far" }), convWrap, h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onclick: () => addConv("in"), text: "+ their line" }), h("button", { class: "btn sm", type: "button", onclick: () => addConv("out"), text: "+ your line" })),
          h("div", { class: "row", style: "margin-top:.8rem" }, field("labKind", "What to write", draftKind)), draftBtn),
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "What the bot wrote" })), draftOut))
        : null,
      mode === "verdict" ? h("div", { class: "grid two" },
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "The message to review" })),
          h("div", { class: "row" }, field("labKind2", "Kind", vKind), field("labMode", "Autonomy", vMode)),
          field("labVerdict", "Message text", vText), h("div", { class: "field-row" }, field("labUser", "To @username", vUser), field("labName2", "Lead name", vName)),
          h("h3", { text: "Conversation context" }), vConvWrap, h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onclick: () => addVConv("in"), text: "+ their line" }), h("button", { class: "btn sm", type: "button", onclick: () => addVConv("out"), text: "+ your line" })),
          h("p", { class: "hint", text: "Try the traps: an invented promise or discount, a lead saying stop, a request for a phone number, or a draft that ignores what the lead just said. A bot question answered casually is fine now, that is the persona doing its job." }), vBtn),
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "The verdict" })), vOut))
        : null,
      h("section", { class: "card", style: "margin-top:1rem" }, h("div", { class: "card-head" }, h("h2", { text: "Recent lab runs" }), h("button", { class: "btn sm", type: "button", onclick: loadHistory }, ico("refresh"), "Refresh")), histBox));
  };
  draw();
  loadHistory();
  return {};
}
VIEWS.lab = viewLab;
})();
