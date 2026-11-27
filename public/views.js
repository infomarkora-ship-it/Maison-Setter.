/* Maison Setter command center — views part 1: Overview, Inbox, Leads, Pipeline, Review, Quality, Import. */
(() => {
"use strict";
const { h, ico, api, fmt, money, pct, ago, clock, stamp, day, initial, toast, live, bar, meter, badge, empty, field, sw, scorePill, delta, sparkline,
  PIPELINE, PIPE_LABEL, STAGE_META, STAGE_LABEL, APPT_LABEL, APPT_CLS, INTENT_LABEL, S, VIEWS, stateBadge, miniAccount, feedList, feedPush, stageBars, kpi, campaignOptions, clientName, q, openDrawer, closeDrawer, refreshCounts, guard, copyText, debounced } = window.MS;
const $ = (s, r = document) => (r || document).querySelector(s);
const MS = window.MS;

/* ---------- "New in this build" tour: the fastest way to see every new feature is to be handed a button that opens it.
   Dismissed once per build (remembered in localStorage), so it never becomes noise. */
function whatsNewTour() {
  let stored = ""; try { stored = localStorage.getItem("msWhatsNewTour") || ""; } catch { /* private mode */ }
  if (stored === "3.6.0") return null;
  const item = (title, desc, to, linkText) => h("div", { class: "alert info", style: "padding:.5rem .7rem" },
    h("div", { class: "grow" }, h("b", { class: "small", text: title }), h("div", { class: "small muted", text: desc })),
    h("a", { class: "btn sm", href: to, text: linkText || "Open" }));
  const close = h("button", { class: "btn sm ghost", type: "button", text: "Got it — hide this list" });
  close.onclick = () => { try { localStorage.setItem("msWhatsNewTour", "3.6.0"); } catch { /* private mode */ } document.querySelectorAll("[data-whatsnew]").forEach((n) => n.remove()); };
  return h("section", { class: "card", "data-whatsnew": "1", "aria-label": "New in this build" },
    h("div", { class: "card-head" }, h("h2", { text: "New in this build (v3.6.0) — what arrived and where it lives" }), close),
    h("p", { class: "small muted", text: "Seeing this page means you are on the new build — the login screen says \u201cServer build: v3.6.0\u201d next to the sign-in box. If you ever see v3.3.1 there, the old server code is still what is deployed: replace it with the v3.6.0 zip and restart. Every new feature is one click away below." }),
    h("div", { class: "stack sm" },
      item("Sender test — drive one account by hand", "The sidebar has a new \u201cSender test\u201d page. Pick a sender and make it follow a profile, like a post or send a real DM immediately — no caps, no sending window, no waiting. Built to prove an account works.", "#/test"),
      item("Day diary — every step narrated in plain words", "Senders now tell you what they are doing and why, step by step. The \u201cDay diary\u201d page is the full story; each live card on \u201cSenders live\u201d shows what that browser is doing right now and what comes next.", "#/diary"),
      item("Everything right now — all senders, this second", "On the \u201cSenders live\u201d page, the \u201cEverything right now\u201d tab lists what every account is doing at this exact moment, in one place.", "#/live", "Open Senders live"),
      item("The lead brief — describe who to chase in plain words", "Open any campaign and write who a perfect lead is and who must never be messaged. The AI reads it on every single lead before deciding. \u201cSync rules with AI\u201d turns your brief into pre-filter settings for you to approve.", "#/campaigns", "Open campaigns"),
      item("Auto-book — appointments made without you", "When a reply agrees on a time, the appointment is created and the lead moves to Booked by itself. The Appointments page has \u201cAdd to calendar\u201d on every booked row.", "#/appointments", "Open appointments"),
      item("More human warm-up", "Senders now follow a few real accounts and like extra posts during warm-up, and can follow leads who engage. It all shows up narrated in the Day diary."),
      item("Extension popup — \u201cDoing right now\u201d", "The browser extension popup shows what the browser is doing this second plus its last steps, and its header displays the extension version (v6.6.0). Load the new extension build to get it.", "#/accounts", "Check sender accounts")),
    );
}

/* ---------------------------------------------------------------- Overview — the command center */
async function viewOverview(rootEl) {
  const box = h("div"); rootEl.append(box); let d, pri, ins;
  const draw = () => {
    const g = d.digest, ql = d.quality, accs = d.accounts;
    const liveAccs = accs.filter((x) => x.badge === "active"), cap = liveAccs.reduce((a, x) => a + (x.capToday || 0), 0), sent = accs.reduce((a, x) => a + x.sentToday, 0);
    const p = d.priorities || [], insights = d.insights || [];
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Command center" }), h("p", { text: S.clientId ? clientName(+S.clientId) : "All campaigns" })), h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: load, text: "Refresh" }), h("a", { class: "btn primary", href: "#/import" }, ico("plus"), "Add leads"))),
      whatsNewTour(),
      d.alerts.length ? h("div", { class: "alerts", role: "region", "aria-label": "Needs attention" }, d.alerts.slice(0, 6).map((a) => h("div", { class: "alert " + a.level }, ico(a.level === "info" ? "bolt" : "alert"), h("span", { class: "grow", text: a.text }), a.to ? h("a", { href: a.to, text: "Open" }) : null))) : null,
      h("div", { class: "grid kpis" },
        kpi("Leads sourced", g.imported, `in the last ${g.days} days`, { icon: "users", href: "#/leads", delta: delta(g.imported, d.prev ? d.prev.imported : null) }),
        kpi("Messages sent", g.messagesSent + g.followupsSent, g.messagesSent + " first · " + g.followupsSent + " follow-ups", { icon: "chat", href: "#/inbox", delta: delta(g.messagesSent, d.prev ? d.prev.messagesSent : null) }),
        kpi("Replies", g.replies, g.repliesWaiting ? `${g.repliesWaiting} draft${g.repliesWaiting === 1 ? "" : "s"} waiting for you` : `in the last ${g.days} days`, { icon: "inbox", href: "#/inbox", cls: g.repliesWaiting ? "accent" : "", delta: delta(g.replies, d.prev ? d.prev.replies : null) }),
        kpi("Appointments booked", g.booked, "from this period", { icon: "cal", href: "#/appointments", delta: delta(g.booked, d.prev ? d.prev.booked : null) }),
        kpi("Won revenue", money(d.opportunityTotals ? d.opportunityTotals.won : 0), d.opportunityTotals && d.opportunityTotals.pipeline ? money(d.opportunityTotals.pipeline) + " open pipeline (estimate)" : "no open pipeline yet", { icon: "coin", href: "#/analytics" })),
      h("div", { class: "split" },
        h("div", { class: "stack" },
          h("section", { class: "card" },
            h("div", { class: "card-head" }, h("h2", { text: "Growth activity timeline" }), h("a", { class: "btn sm", href: "#/analytics", text: "Full analytics" })),
            roiSeries(d),
            h("div", { class: "chart-legend" }, h("span", null, h("i", { style: "background:var(--accent)" }), "Leads sourced"), h("span", null, h("i", { style: "background:var(--info)" }), "Appointments"), h("span", null, h("i", { style: "background:var(--good)" }), "Revenue won"))),
          h("section", { class: "card" },
            h("div", { class: "card-head" }, h("h2", { text: "The lead-to-revenue journey" })),
            funnelFlow(d)),
          h("section", { class: "card" },
            h("div", { class: "card-head" }, h("h2", { text: "What happened to your imported leads" }), h("a", { class: "btn sm", href: "#/quality", text: "Details" })),
            ql.imported ? [bar([{ v: ql.real, cls: "good", label: "Real businesses" }, { v: ql.agency, cls: "warn", label: "Agencies kept" }, { v: ql.spam, cls: "off", label: "Filtered out" }, { v: ql.processing + ql.waiting, cls: "proc", label: "Checking" }], true),
              h("div", { class: "legend" }, [["good", "Real businesses", ql.real], ["warn", "Agencies kept separate", ql.agency], ["off", "Filtered out", ql.spam], ["proc", "Being checked", ql.processing + ql.waiting]].map(([c, l, v]) => h("span", null, h("i", { class: "bg-" + c }), l, h("b", { text: fmt(v) })))),
              h("p", { class: "muted small", text: `${pct(ql.real + ql.agency, ql.imported)}% of ${fmt(ql.imported)} imported leads made it through the checks.` })]
              : empty("Nothing imported yet", "Export profiles from Apify and import them. Every lead is checked before anyone is messaged.", h("a", { class: "btn primary", href: "#/import", text: "Import leads" })))),
        h("div", { class: "stack" },
          h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Today's priorities" }), h("span", { class: "muted small", text: "ranked by urgency" })),
            p.length ? h("div", { class: "stack sm" }, p.slice(0, 8).map((x) => h("div", { class: "alert " + (x.priority === "critical" ? "bad" : x.priority === "high" ? "warn" : "info"), style: "padding:.5rem .7rem" },
              h("div", { class: "grow" }, h("b", { class: "small", text: x.title }), h("div", { class: "small muted", text: x.why })), h("a", { class: "btn sm", href: x.to, text: "Open" })))) : h("p", { class: "muted small", text: "Nothing needs your attention right now. Everything is flowing." })),
          h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Performance insights" })),
            insights.length ? h("div", { class: "stack sm" }, insights.map((x) => h("div", { class: "alert " + (x.severity === "warn" ? "warn" : x.severity === "good" ? "good" : "info"), style: "padding:.5rem .7rem" }, h("span", { class: "grow small", text: x.text })))) : h("p", { class: "muted small", text: "Insights appear as soon as there is a few days of activity to learn from." })),
          h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Sender accounts" }), h("a", { class: "btn sm", href: "#/accounts", text: "Manage" })),
            accs.length ? h("div", { class: "stack" }, accs.map(miniAccount)) : empty("No sender accounts", "Add one and pair the extension.", h("a", { class: "btn primary", href: "#/accounts", text: "Add account" }))),
          h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Live activity" }), badge("Live", "good", true)), feedList(d.activity))))
    );
  };
  const roiSeries = (d2) => {
    const r = d2.roiSeries;
    if (!r || !r.length || !r.some((p) => p.leads || p.appointments || p.revenue)) return h("p", { class: "muted small", text: "No activity in this period yet. The timeline fills in as leads are sourced, appointments booked and deals won." });
    return sparkline(r, { keys: ["leads", "appointments", "revenue"], hgt: 150, labels: `last ${d2.digest.days} days` });
  };
  const funnelFlow = (d2) => {
    const f = d2.digest;
    const steps = [["Leads", f.imported], ["Qualified", f.passed], ["Contacted", f.messagesSent], ["Replied", f.replies], ["Interested", null], ["Booked", f.booked]];
    const inter = d2.funnelInterested;
    steps[4][1] = inter;
    return h("div", { class: "funnel-flow" }, steps.map(([label, v]) => h("div", { class: "funnel-step" }, h("b", { class: "num", text: fmt(v) }), h("span", { text: label }))));
  };
  const load = async () => {
    d = await api("GET", `/api/overview?${q()}`);
    const [roi, pr, insr] = await Promise.all([api("GET", `/api/roi?${q()}`).catch(() => null), api("GET", `/api/priorities${S.clientId ? "?clientId=" + S.clientId : ""}`).catch(() => null), api("GET", `/api/insights?${q()}`).catch(() => null)]);
    d.roiSeries = roi ? roi.series : []; d.prev = roi ? roi.prev : null; d.funnelInterested = roi ? roi.funnel.interested : 0;
    d.priorities = pr ? pr.priorities : []; d.insights = insr ? insr.insights : [];
    MS.S.counts = { review: d.digest.pendingReview, replies: d.digest.repliesWaiting, held: d.supervisor ? d.supervisor.waiting : 0, unread: MS.S.counts.unread || 0 };
    MS.drawNav(); draw();
  };
  await load();
  const reload = debounced(() => load().catch(() => {}), 700);
  return { onEvent(e) { if (e.t !== "activity") reload(); }, refresh: load };
}
VIEWS.overview = viewOverview;

/* ---------------------------------------------------------------- Inbox — unified conversations */
async function viewInbox(rootEl) {
  const box = h("div"); rootEl.append(box);
  let convos = [], data = null, tab = "all", currentLeadId = null;
  const TABS = [["all", "All"], ["needs_you", "Needs you"], ["drafts", "AI drafts"], ["interested", "Interested"], ["high_intent", "High intent"], ["questions", "Questions"], ["booked", "Booked"], ["cold", "Not interested"], ["dnc", "Do not contact"]];
  const filterOf = {
    all: (l) => true,
    needs_you: (l) => l.needsHuman,
    drafts: (l) => l._hasDraft,
    interested: (l) => ["interested", "high_intent"].includes(l.pipeline) || l.stage === "interested",
    high_intent: (l) => l.pipeline === "high_intent",
    questions: (l) => l.intent === "question",
    booked: (l) => l.stage === "booked" || ["booked", "booking_pending", "meeting_completed"].includes(l.pipeline),
    cold: (l) => l.stage === "cold" || l.intent === "not_interested",
    dnc: (l) => l.stage === "do_not_contact"
  };
  const load = async () => {
    const r = await api("GET", `/api/leads?review=approved&limit=500${S.clientId ? "&clientId=" + S.clientId : ""}`);
    const rep = await api("GET", "/api/replies").catch(() => ({ replies: [], needsHuman: [] }));
    const draftLeads = new Set((rep.replies || []).map((x) => x.leadId));
    convos = r.leads.filter((l) => l.stage !== "new").map((l) => ({ ...l, _hasDraft: draftLeads.has(l.id), _draft: (rep.replies || []).find((x) => x.leadId === l.id) }));
    if (!currentLeadId && convos.length) { const pri = convos.find((c) => c._hasDraft) || convos.find((c) => c.needsHuman) || convos[0]; currentLeadId = pri.id; }
    data = null; draw();
    if (currentLeadId) openConvo(currentLeadId);
  };
  const draw = () => {
    const list = convos.filter(filterOf[tab] || (() => true));
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Inbox" }), h("p", { text: "Every outbound and inbound conversation in one place. Drafts wait for your approval before anything is sent." })),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: load }, ico("refresh"), "Refresh"))),
      h("div", { class: "tabs", role: "tablist", "aria-label": "Inbox views" }, TABS.map(([k, label]) => {
        const n = k === "all" ? convos.length : convos.filter(filterOf[k]).length;
        return h("button", { role: "tab", type: "button", "aria-selected": String(tab === k), onclick: () => { tab = k; draw(); } }, label, n ? h("span", { class: "n", text: String(n) }) : null);
      })),
      h("div", { class: "inbox", style: "margin-top:1rem" },
        h("div", { class: "card inbox-list", role: "list", "aria-label": "Conversations" },
          list.length ? list.map((l) => convoItem(l)) : empty("No conversations here", "Once leads are approved and messaged, their conversations appear in this inbox.")),
        h("div", { class: "card convo-pane", id: "convoPane" }, h("p", { class: "muted small", text: "Pick a conversation on the left." })),
        h("div", { class: "card ctx-pane", id: "ctxPane" })));
  };
  const convoItem = (l) => {
    const el = h("button", { class: "convo-item", type: "button", role: "listitem", "aria-current": l.id === currentLeadId ? "true" : null, onclick: () => openConvo(l.id) });
    el.append(h("span", { class: "avatar sm", "aria-hidden": "true", text: initial(l.username) }));
    const preview = l._draft ? "✎ " + l._draft.draft.slice(0, 60) : l.intent ? INTENT_LABEL[l.intent] + (l.lastReplyAt ? " · " + ago(l.lastReplyAt) : "") : l.stage === "contacted" ? "Waiting for a reply" : STAGE_LABEL[l.stage] || l.stage;
    const meta = h("div", { class: "grow" },
      h("div", { class: "cv-top" }, h("b", { text: "@" + l.username }), l.name && l.name !== l.username ? h("span", { class: "muted small", text: l.name }) : null, h("time", { text: ago(l.lastActivityAt || l.updatedAt) })),
      h("span", { class: "cv-sub", text: preview }),
      h("div", { class: "cv-meta" }, badge(PIPE_LABEL[l.pipeline] || l.stage, APPT_CLS[l.pipeline] || (l.pipeline === "interested" || l.pipeline === "high_intent" ? "accent" : l.pipeline === "won" ? "good" : l.pipeline === "lost" ? "bad" : "")), scorePill(l.score),
        l._hasDraft ? badge("Draft ready", "accent", true) : null, l.needsHuman ? badge("Needs you", "warn", true) : null, l.intent === "booked" ? badge("Booking signal", "good", true) : null));
    el.append(meta); return el;
  };
  const openConvo = async (leadId) => {
    currentLeadId = leadId;
    for (const el of box.querySelectorAll(".convo-item")) el.setAttribute("aria-current", "false");
    let r;
    try { r = await api("GET", `/api/leads/${leadId}`); } catch (e) { toast(e.message, "err"); return; }
    draw();   // re-render so aria-current updates
    const pane = $("#convoPane", box), ctx = $("#ctxPane", box);
    if (!pane) return;
    const l = r.lead;
    $("#pageSub", document).textContent = "@" + l.username;
    const chat = h("div", { class: "chat" }, r.messages.length ? r.messages.map((m) => h("div", { class: "bubble " + (m.direction === "out" ? "out" : "in"), title: stamp(m.ts * 1000), text: m.text })) : h("p", { class: "muted small", text: "No messages yet." }));
    const draft = convos.find((c) => c.id === leadId)?._draft;
    const ta = draft ? h("textarea", { id: "inboxDraft", rows: 3, maxlength: 500, "aria-label": `Reply to @${l.username}` }) : null;
    if (ta) ta.value = draft.draft;
    const sendBtn = draft ? h("button", { class: "btn good", type: "button" }, ico("check"), "Approve and send") : null;
    const dropBtn = draft ? h("button", { class: "btn danger sm", type: "button" }, ico("x"), "Discard") : null;
    if (sendBtn) sendBtn.onclick = guard(sendBtn, async () => { await api("POST", `/api/tasks/${draft.taskId}/approve`, { text: ta.value }); toast("Reply queued.", "good"); await load(); refreshCounts(); });
    if (dropBtn) dropBtn.onclick = guard(dropBtn, async () => { await api("POST", `/api/tasks/${draft.taskId}/discard`, {}); toast("Draft discarded."); await load(); refreshCounts(); });
    pane.replaceChildren(
      h("div", { class: "card-head" }, h("h3", { text: "@" + l.username }), badge(STAGE_LABEL[l.stage] || l.stage, "info"), l.needsHuman ? badge("Needs you", "warn", true) : null, h("span", { class: "spacer" }), h("button", { class: "btn sm", type: "button", onclick: () => MS.openLead(l.id), text: "Full profile" })),
      chat,
      draft ? h("div", { class: "draft-box" }, h("label", { for: "inboxDraft", text: "AI draft — edit before sending if needed" }), ta, h("div", { class: "row" }, sendBtn, dropBtn)) : null);
    ctx.replaceChildren(
      h("h4", { text: "Lead" }), h("div", { class: "row" }, h("b", { text: l.name || "@" + l.username }), scorePill(l.score)),
      h("h4", { text: "Business" }), h("p", { class: "small muted", text: [l.detectedNiche, l.category, l.serviceLocation || l.location].filter(Boolean).join(" · ") || "—" }),
      h("h4", { text: "Pipeline" }), badge(PIPE_LABEL[l.pipeline] || l.stage, "accent"),
      h("h4", { text: "Attribution" }), h("p", { class: "small muted", text: `${l.sourceType === "meta_ad_library" ? "Meta Ad Library" : "Instagram import"}${l.importBatch ? " · batch " + l.importBatch : ""}` }),
      l.opportunityValue ? [h("h4", { text: "Opportunity" }), h("p", { class: "small", text: money(l.opportunityValue) + " potential" })] : null,
      h("h4", { text: "Next action" }), h("p", { class: "small muted", text: l.nextAction || (l.nextFollowAt ? "Follow-up due " + stamp(l.nextFollowAt) : "Nothing scheduled") }));
  };
  await load();
  const reload = debounced(() => { if (!(document.activeElement && document.activeElement.tagName === "TEXTAREA")) load().catch(() => {}); }, 900);
  return { onEvent(e) { if (["lead", "task"].includes(e.t)) reload(); }, refresh: load };
}
VIEWS.inbox = viewInbox;

/* ---------------------------------------------------------------- Leads — the CRM */
async function viewLeads(rootEl) {
  const box = h("div"); rootEl.append(box);
  let leads = [], total = 0, filters = { pipeline: "", minScore: "", q: "", needsHuman: "" };
  const load = async () => {
    const p = new URLSearchParams({ review: "approved", limit: "500" });
    if (S.clientId) p.set("clientId", S.clientId);
    if (filters.pipeline) p.set("pipeline", filters.pipeline);
    if (filters.minScore) p.set("minScore", filters.minScore);
    if (filters.q) p.set("q", filters.q);
    if (filters.needsHuman) p.set("needsHuman", filters.needsHuman);
    const r = await api("GET", "/api/leads?" + p.toString());
    leads = r.leads; total = r.total; draw();
  };
  const draw = () => {
    const pipeSel = h("select", { id: "lfPipe", "aria-label": "Filter by pipeline stage" }, h("option", { value: "", text: "All pipeline stages" }), PIPELINE.map(([k, l]) => h("option", { value: k, text: l, selected: filters.pipeline === k ? true : null })));
    const scoreSel = h("select", { id: "lfScore", "aria-label": "Filter by minimum score" }, h("option", { value: "", text: "Any score" }), [["75", "75+ (strong)"], ["85", "85+ (best)"], ["50", "50+"], ["0", "Scored"]].map(([v, t]) => h("option", { value: v, text: t, selected: filters.minScore === v ? true : null })));
    const search = h("input", { id: "lfQ", type: "search", placeholder: "Search username, name, bio, notes…", "aria-label": "Search leads", value: filters.q, style: "max-width:260px" });
    pipeSel.onchange = () => { filters.pipeline = pipeSel.value; load(); };
    scoreSel.onchange = () => { filters.minScore = scoreSel.value; load(); };
    search.oninput = MS.debounced(() => { filters.q = search.value.trim(); load(); }, 400);
    const rows = leads.map((l) => h("tr", null,
      h("td", null, h("button", { class: "btn sm ghost", type: "button", onclick: () => MS.openLead(l.id), text: "@" + l.username }), l.name && l.name !== l.username ? h("div", { class: "muted small", text: l.name }) : null),
      h("td", null, badge(PIPE_LABEL[l.pipeline] || l.stage, l.pipeline === "won" ? "good" : l.pipeline === "lost" ? "bad" : ["interested", "high_intent", "qualified_opportunity"].includes(l.pipeline) ? "accent" : "")),
      h("td", null, scorePill(l.score)),
      h("td", { class: "muted small", text: l.detectedNiche || l.category || "—" }),
      h("td", { class: "muted small", text: l.sourceType === "meta_ad_library" ? "Ad Library" : "Instagram" }),
      h("td", { class: "muted small nowrap", text: l.lastActivityAt ? ago(l.lastActivityAt) : "not contacted" }),
      h("td", { class: "num small", text: l.opportunityValue ? money(l.opportunityValue) : "—" })));
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Leads" }), h("p", { text: `${fmt(total)} approved lead${total === 1 ? "" : "s"} in this workspace. Every lead carries its score, conversation history, attribution and opportunity value.` }))),
      h("div", { class: "card" },
        h("div", { class: "row between", style: "margin-bottom:.6rem" }, h("div", { class: "row" }, pipeSel, scoreSel, search), h("button", { class: "btn", type: "button", onclick: load }, ico("refresh"), "Refresh")),
        leads.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Lead", "Pipeline", "Score", "Niche", "Source", "Last activity", "Value"].map((t) => h("th", { text: t })))), h("tbody", null, rows))) : empty("No approved leads match", "Approve leads in Review, or relax the filters.", h("a", { class: "btn primary", href: "#/review", text: "Go to Review" }))));
  };
  await load();
  if (MS.openLeadId) { const id = MS.openLeadId; MS.openLeadId = null; openLead(id); }
  const reload = debounced(() => { if ($("#drawerWrap").hidden) load().catch(() => {}); }, 900);
  return { onEvent(e) { if (["lead", "task"].includes(e.t)) reload(); }, refresh: load };
}
VIEWS.leads = viewLeads;

/* ---------------------------------------------------------------- Lead profile drawer (shared by Leads, Pipeline, Inbox, search) */
async function openLead(id) {
  let r;
  try { r = await api("GET", `/api/leads/${id}`); } catch (e) { toast(e.message, "err"); return; }
  const l = r.lead;
  const stage = h("select", { id: "dstage", "aria-label": "Conversation stage" }, STAGE_META.map(([k, label]) => h("option", { value: k, text: label, selected: l.stage === k ? true : null })));
  const pipe = h("select", { id: "dpipe", "aria-label": "Pipeline stage" }, PIPELINE.map(([k, label]) => h("option", { value: k, text: label, selected: l.pipeline === k ? true : null })));
  const notes = h("textarea", { id: "dnotes", rows: 3, maxlength: 1000 }); notes.value = l.notes || "";
  const value = h("input", { id: "dval", type: "number", min: 0, step: "50", "aria-label": "Estimated opportunity value" }); value.value = l.opportunityValue || "";
  const nextAction = h("input", { id: "dnext", type: "text", maxlength: 200, "aria-label": "Next action" }); nextAction.value = l.nextAction || "";
  const intent = h("select", { id: "dintent", "aria-label": "Reply intent" }, h("option", { value: "", text: "Unknown" }), Object.entries(INTENT_LABEL).map(([k, t]) => h("option", { value: k, text: t, selected: l.intent === k ? true : null })));
  const save = h("button", { class: "btn primary", type: "button", text: "Save changes" });
  save.onclick = guard(save, async () => {
    await api("PATCH", `/api/leads/${l.id}`, { stage: stage.value, pipeline: pipe.value, notes: notes.value, opportunityValue: Number(value.value) || 0, nextAction: nextAction.value, intent: intent.value });
    toast("Saved.", "good"); closeDrawer(); if (S.view?.refresh) S.view.refresh();
  });
  const scoreBlock = h("div", { class: "score-detail" },
    l.score != null ? [h("p", { class: "small" }, h("b", { text: `Lead score: ${l.score} / 100` }), " — ", h("span", { class: "muted", text: l.score >= 90 ? "Exceptional Fit" : l.score >= 75 ? "High Potential" : l.score >= 60 ? "Good Potential" : l.score >= 40 ? "Moderate Fit" : l.score >= 20 ? "Low Potential" : "Poor Fit" })),
      ...l.scoreDetail.map((f) => h("div", { class: "sd-row" }, h("span", { text: f.label }), h("span", { class: "pts " + (f.points > 0 ? "" : f.points < 0 ? "neg" : "zero"), text: (f.points > 0 ? "+" : "") + f.points }), h("span", { class: "why", text: f.why })))] : h("p", { class: "muted small", text: "Not scored yet. Rescore after the next qualification pass." }));
  const rescore = h("button", { class: "btn sm", type: "button" }, ico("refresh"), "Rescore");
  rescore.onclick = guard(rescore, async () => { await api("POST", `/api/leads/${l.id}/score`, {}); toast("Rescored.", "good"); openLead(id); });
  const chat = h("div", { class: "chat" }, r.messages.length ? r.messages.map((m) => h("div", { class: "bubble " + (m.direction === "out" ? "out" : "in"), title: stamp(m.ts * 1000), text: m.text })) : h("p", { class: "muted small", text: "No messages yet." }));
  const apptRows = r.appointments.map((a) => h("div", { class: "row between small" }, h("span", { text: `${a.title || "Appointment"} · ${a.scheduled_at ? stamp(a.scheduled_at) : "no date"}` }), badge(APPT_LABEL[a.status] || a.status, APPT_CLS[a.status] || "")));
  const taskRows = r.tasks.filter((t) => !t.done).map((t) => h("div", { class: "row between small" }, h("span", { text: t.title }), badge(t.priority, t.priority === "high" ? "bad" : t.priority === "low" ? "" : "warn")));
  const activityRows = r.activity.slice(0, 12).map((a) => h("div", { class: "row small" }, h("span", { class: "muted nowrap", text: stamp(a.at) }), h("span", { class: "grow", text: a.text })));
  openDrawer("@" + l.username, h("div", null,
    h("div", { class: "row" }, h("span", { class: "avatar lg", "aria-hidden": "true", text: initial(l.username) }), h("div", { class: "grow" },
      h("b", { text: l.name || "@" + l.username }), h("p", { class: "small muted", text: [l.detectedNiche, l.category, l.followers != null ? fmt(l.followers) + " followers" : "", l.serviceLocation || l.location].filter(Boolean).join(" · ") || "—" })),
      h("a", { class: "btn sm", href: "https://www.instagram.com/" + encodeURIComponent(l.username) + "/", target: "_blank", rel: "noopener noreferrer" }, ico("out"), "Instagram")),
    h("div", { class: "chips" }, l.entityClassification === "REAL_BUSINESS" ? badge("Real business", "good") : l.entityClassification === "AGENCY" ? badge("Agency", "warn") : null, badge("Score " + (l.score ?? "—"), "accent"), l.confidence != null ? badge(l.confidence + "% sure", "") : null, l.sourceType === "meta_ad_library" ? badge("Ad Library", "info") : null, l.personalizationHook ? badge("Hook: " + l.personalizationHook.slice(0, 40), "") : null),
    h("h3", { text: "Why this score" }), scoreBlock, h("div", { class: "row" }, rescore),
    h("h3", { text: "Conversation" }), chat,
    h("h3", { text: "Pipeline & outcome" }),
    h("div", { class: "field-row" }, field("dpipe", "Pipeline stage", pipe), field("dstage", "Conversation status", stage)),
    h("div", { class: "field-row" }, field("dval", "Estimated value ($)", value), field("dnext", "Next action", nextAction)),
    field("dintent", "Last reply intent", intent),
    r.opportunity ? h("p", { class: "small" }, "Opportunity: ", h("b", { text: money(r.opportunity.value) }), " — ", h("span", { class: "muted", text: r.opportunity.status })) : null,
    h("h3", { text: "Appointments" }), apptRows.length ? h("div", { class: "stack sm" }, apptRows) : h("p", { class: "muted small", text: "None yet." }),
    h("h3", { text: "Open tasks" }), taskRows.length ? h("div", { class: "stack sm" }, taskRows) : h("p", { class: "muted small", text: "Nothing open." }),
    h("h3", { text: "Activity" }), activityRows.length ? h("div", { class: "stack sm" }, activityRows) : null,
    h("h3", { text: "Notes" }), notes, h("div", { class: "row" }, save)));
}
MS.openLead = openLead;

/* ---------------------------------------------------------------- Pipeline — kanban */
async function viewPipeline(rootEl) {
  const box = h("div"); rootEl.append(box); let leads = [];
  const COLS = [["ready", "Ready"], ["contacted", "Contacted"], ["awaiting_reply", "Awaiting Reply"], ["replied", "Replied"], ["interested", "Interested"], ["qualified_opportunity", "Opportunity"], ["booked", "Booked"]];
  const load = async () => { leads = (await api("GET", `/api/leads?review=approved&limit=500${S.clientId ? "&clientId=" + S.clientId : ""}`)).leads; draw(); };
  const draw = () => {
    if (!leads.length) return box.replaceChildren(h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Pipeline" }))), empty("No approved leads yet", "Approve leads in Review and follow them here.", h("a", { class: "btn primary", href: "#/review", text: "Go to Review" })));
    const other = leads.filter((l) => !COLS.some(([k]) => k === l.pipeline));
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Pipeline" }), h("p", { text: "Drag-free kanban: open a lead to move its stage. Columns follow the CRM pipeline, not the sending automation." }))),
      h("div", { class: "kanban" }, COLS.map(([k, label]) => { const items = leads.filter((l) => l.pipeline === k); return h("section", { class: "col", "aria-label": label }, h("h3", null, h("span", { text: label }), badge(String(items.length), "")), items.length ? items.slice(0, 60).map(pCard) : h("p", { class: "muted small", text: "Empty" })); }),
        other.length ? h("section", { class: "col", "aria-label": "Elsewhere" }, h("h3", null, h("span", { text: "Elsewhere" }), badge(String(other.length), "")), other.slice(0, 60).map(pCard)) : null));
  };
  const pCard = (l) => {
    const el = h("button", { class: "pcard", type: "button", onclick: () => openLead(l.id) },
      h("b", { text: "@" + l.username }),
      h("span", { class: "p-sub", text: [l.detectedNiche || l.category, l.lastActivityAt ? ago(l.lastActivityAt) : "not sent yet"].filter(Boolean).join(" · ") }));
    const foot = h("div", { class: "p-foot" });
    if (l.score != null) foot.append(scorePill(l.score));
    if (l.opportunityValue) foot.append(h("span", { class: "muted small num", text: money(l.opportunityValue) }));
    if (l.needsHuman) foot.append(badge("Needs you", "warn"));
    if (foot.childNodes.length) el.append(foot);
    return el;
  };
  await load(); const reload = debounced(() => { if ($("#drawerWrap").hidden) load().catch(() => {}); }, 900);
  return { onEvent(e) { if (e.t === "lead" || e.t === "task") reload(); }, refresh: load };
}
VIEWS.pipeline = viewPipeline;

/* ---------------------------------------------------------------- Review */
async function viewReview(rootEl) {
  const box = h("div"); rootEl.append(box); let tab = "real", leads = [], arrived = 0, processing = 0;
  const wrap = box;
  const bucketOf = (l) => l.entityClassification === "REAL_BUSINESS" ? "real" : l.entityClassification === "AGENCY" ? "agency" : "look";
  const load = async () => {
    const r = await api("GET", `/api/leads?review=pending&limit=200${S.clientId ? "&clientId=" + S.clientId : ""}`);
    leads = r.leads.filter((l) => l.gate !== ""); processing = r.leads.length - leads.length; arrived = 0; draw();
  };
  const draw = () => {
    const by = { real: [], agency: [], look: [] }; for (const l of leads) by[bucketOf(l)].push(l);
    if (!by[tab].length && by.real.length) tab = "real"; else if (!by[tab].length) tab = by.agency.length ? "agency" : by.look.length ? "look" : tab;
    const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Lead groups" }, [["real", "Real businesses"], ["agency", "Agencies"], ["look", "Needs a look"]].map(([k, label]) =>
      h("button", { role: "tab", type: "button", "aria-selected": String(tab === k), onclick: () => { tab = k; draw(); } }, label, h("span", { class: "n", text: String(by[k].length) }))));
    const list = by[tab], strong = list.filter((l) => (l.confidence || 0) >= 85);
    wrap.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Review" }), h("p", { text: "Every lead that passed the automatic checks waits here for your decision before anyone is messaged." }))),
      arrived ? h("div", { class: "banner good", role: "status" }, ico("bolt"), `${arrived} new lead${arrived === 1 ? "" : "s"} just arrived.`, h("button", { class: "btn sm primary", type: "button", onclick: () => load(), text: "Show them" })) : null,
      processing ? h("p", { class: "muted small" }, `${processing} more lead${processing === 1 ? " is" : "s are"} still being checked and will appear here on their own.`) : null,
      tabs,
      tab === "real" && strong.length > 1 ? h("div", { class: "banner", style: "margin:.8rem 0" }, h("span", { class: "grow", text: `${strong.length} leads are 85% sure or better.` }), (() => { const b = h("button", { class: "btn good sm", type: "button", text: `Approve these ${strong.length}` }); b.onclick = guard(b, async () => { if (!confirm(`Approve ${strong.length} leads and queue their first messages?`)) return; const r = await api("POST", "/api/leads/bulk", { action: "approve", ids: strong.map((l) => l.id) }); toast(`Approved ${r.done.length}${r.failed.length ? `, ${r.failed.length} could not be approved` : ""}.`, "good"); await load(); refreshCounts(); }); return b; })()) : null,
      tab === "agency" ? h("p", { class: "muted small", text: "These are marketing agencies. They get the separate agency script from the campaign settings, never the business script." }) : null,
      list.length ? h("div", { class: "stack", style: "margin-top:.8rem" }, list.map((l) => leadCard(l, tab, (done) => { leads = leads.filter((x) => x.id !== done); draw(); refreshCounts(); }))) :
        empty(tab === "look" ? "Nothing needs a second look" : "Nothing to review", tab === "real" ? "New leads show up here as soon as they pass the checks." : tab === "agency" ? "Flip the \"Filter out marketing agencies\" switch off on a campaign to collect agencies here." : "Leads the AI could not judge wait here for you.", h("a", { class: "btn primary", href: "#/import", text: "Import leads" })));
  };
  await load();
  return { refresh: load, onEvent(e) { if (e.t === "lead") { if (e.review === "pending") arrived++; reloadSoon(); } } };
  function reloadSoon() { clearTimeout(reloadSoon.t); reloadSoon.t = setTimeout(async () => { const open = document.activeElement && document.activeElement.tagName === "TEXTAREA"; if (open) { arrived++; draw(); return; } const before = new Set(leads.map((l) => l.id)); const r = await api("GET", `/api/leads?review=pending&limit=200${S.clientId ? "&clientId=" + S.clientId : ""}`).catch(() => null); if (!r) return; const fresh = r.leads.filter((l) => l.gate !== ""); processing = r.leads.length - fresh.length; const added = fresh.filter((l) => !before.has(l.id)).length; if (!leads.length) { leads = fresh; arrived = 0; } else { arrived = added; leads = leads.map((l) => fresh.find((f) => f.id === l.id) || l).filter((l) => fresh.some((f) => f.id === l.id)); } draw(); }, 800); }
}
VIEWS.review = viewReview;
function leadCard(l, mode, onDone) {
  const igUrl = "https://www.instagram.com/" + encodeURIComponent(l.username) + "/", ad = l.sourceType === "meta_ad_library";
  const opener = h("textarea", { id: "op" + l.id, "aria-label": `First message to @${l.username}`, rows: 3, maxlength: 500 }); opener.value = l.opener || "";
  const reason = l.haiku.status === "failed" ? "The AI could not give a usable answer, so it needs your eyes." : l.haiku.status === "unavailable" ? "The AI checker is not connected. This lead passed the automatic checks only." : l.entityClassification === "REJECT" ? "The AI would reject this one: " + (l.disqualificationReason || "") : "";
  const approve = h("button", { class: "btn good", type: "button" }, ico("check"), "Approve and queue"), reject = h("button", { class: "btn danger", type: "button" }, ico("x"), "Reject");
  approve.onclick = guard(approve, async () => { await api("POST", `/api/leads/${l.id}/approve`, { opener: opener.value.trim() && opener.value.trim() !== l.opener ? opener.value.trim() : undefined }); toast(`@${l.username} approved.`, "good"); onDone(l.id); });
  reject.onclick = guard(reject, async () => { await api("POST", `/api/leads/${l.id}/reject`, {}); toast(`@${l.username} rejected.`); onDone(l.id); });
  const recheck = mode === "look" ? h("button", { class: "btn", type: "button" }, ico("refresh"), "Check again") : null;
  if (recheck) recheck.onclick = guard(recheck, async () => { await api("POST", `/api/leads/${l.id}/requalify`, {}); toast("Checking again. It will reappear in a moment."); onDone(l.id); });
  const conf = l.confidence != null ? l.confidence : null;
  return h("article", { class: "card lead", "aria-label": "@" + l.username },
    h("div", { class: "row", style: "align-items:flex-start" },
      h("span", { class: "avatar", "aria-hidden": "true", text: initial(l.username) }),
      h("div", { class: "grow" },
        h("div", { class: "row between" }, h("a", { class: "user", href: igUrl, target: "_blank", rel: "noopener noreferrer" }, "@" + l.username), l.name && l.name !== l.username ? h("span", { class: "muted", text: l.name }) : null,
          conf != null ? h("span", { class: "score-pill", text: conf + "% sure" }) : null),
        h("div", { class: "chips", style: "margin:.35rem 0" }, ad ? badge("Meta Ad Library", "info") : badge("Instagram", ""), l.detectedNiche ? badge(l.detectedNiche, "accent") : null, l.serviceLocation ? badge(l.serviceLocation, "") : null, l.category ? badge(l.category, "") : null,
          l.followers != null ? badge(fmt(l.followers) + " followers", "") : null, l.hasBookingInfra ? badge("Booking link", "good") : null, l.hasWebsite ? badge("Own website", "good") : null, l.priorityBoost ? badge("Commercial category", "good") : null),
        reason ? h("p", { class: "small muted", text: reason }) : null,
        l.personalizationHook ? h("p", { class: "small" }, h("b", { text: "Hook: " }), l.personalizationHook) : null)),
    h("label", { for: "op" + l.id, text: mode === "agency" ? "First message (agency script)" : "First message" }), opener,
    h("details", null, h("summary", { text: "Why it passed, and what we saw" }),
      l.bio ? h("blockquote", { text: l.bio }) : null, l.adCopy ? h("blockquote", { text: "Ad: " + l.adCopy }) : null, l.captions.map((c) => h("blockquote", { text: c })),
      h("p", { class: "small muted", text: `Pre-filter score ${l.qualityPoints}/100${l.links.length ? " · links: " + l.links.slice(0, 4).join(", ") : ""}` })),
    h("div", { class: "row", style: "margin-top:.7rem" }, approve, reject, recheck));
}

/* ---------------------------------------------------------------- Lead quality */
async function viewQuality(rootEl) {
  const box = h("div"); rootEl.append(box); let d;
  const draw = () => {
    const ag = d.agency + d.agencyRejected, hk = d.haiku, tokenPctv = pct(hk.usedToday, hk.dailyCap);
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Lead quality" }), h("p", { text: "How the checks judged what you imported, and how much the AI checker costs." }))),
      h("div", { class: "grid kpis" }, kpi("Passed real businesses", d.real, `${pct(d.real, d.imported)}% of ${fmt(d.imported)} imported`, { cls: "accent", icon: "check" }),
        kpi("Filtered agencies", ag, d.agency ? `${d.agency} kept for the agency script` : "Marketing and lead-gen firms", { icon: "shield" }), kpi("Rejected spam", d.spamOnly, "Creators, courses, personal pages", { icon: "x" }),
        kpi("Waiting on checks", d.processing + d.waiting, d.waiting ? `${d.waiting} need the AI or a person` : "Being processed now", { icon: "refresh" })),
      h("div", { class: "split" },
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Disqualification reasons" })),
          d.reasons.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, h("th", { text: "Reason" }), h("th", { text: "Caught by" }), h("th", { class: "r", text: "Leads" }), h("th", { text: "Share" }))),
            h("tbody", null, d.reasons.map((r) => h("tr", null, h("td", { text: r.reason }), h("td", null, badge(r.by === "pre-filter" ? "Free pre-filter" : "AI checker", r.by === "pre-filter" ? "good" : "info")), h("td", { class: "r num", text: fmt(r.count) }), h("td", null, meter(r.count, d.reasons[0].count, "off"))))))) : empty("No rejections yet", "Reasons appear here once leads have been checked.")),
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "AI checker" }), badge(hk.configured ? "Connected" : "Not connected", hk.configured ? "good" : "warn", true)),
          h("dl", { class: "facts" }, h("dt", { text: "Model" }), h("dd", { text: hk.model }), h("dt", { text: "Calls today" }), h("dd", { class: "num", text: fmt(hk.calls) }), h("dt", { text: "Tokens today" }), h("dd", { class: "num", text: `${fmt(hk.usedToday)} of ${fmt(hk.dailyCap)}` }), h("dt", { text: "Prompt cache hit rate" }), h("dd", { class: "num", text: hk.calls ? hk.cacheHitRate + "%" : "-" })),
          meter(hk.usedToday, hk.dailyCap, tokenPctv > 85 ? "bad" : ""),
          h("p", { class: "hint", text: hk.calls && !hk.cacheReadTokens ? "The cache is not being hit yet. The first call of each batch writes the cache and later calls read it." : "Most of each call's input is the same instructions, so cached reads cut that cost." }))),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Recent decisions" }), h("span", { class: "muted small", text: `Average confidence ${d.avgConfidence}%` })),
        d.recent.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Lead", "Result", "Sure", "Niche", "Why", "When"].map((t) => h("th", { text: t })))),
          h("tbody", null, d.recent.map((r) => h("tr", null, h("td", null, h("button", { class: "btn sm ghost", type: "button", onclick: () => MS.openLead(r.id), text: "@" + r.username })),
            h("td", null, r.cls === "REAL_BUSINESS" ? badge("Real business", "good") : r.cls === "AGENCY" ? badge("Agency", "warn") : badge(r.gate === "rejected" ? "Pre-filter" : "AI rejected", "bad")),
            h("td", { class: "num", text: r.confidence != null ? r.confidence + "%" : "-" }), h("td", { text: r.niche || "-" }), h("td", { text: r.why || (r.place || "") }), h("td", { class: "nowrap muted", text: stamp(r.at) })))))) : empty("No decisions yet", "Import some leads to see how the checks judge them.")));
  };
  const load = async () => { d = await api("GET", `/api/quality?${q()}`); draw(); };
  await load(); const reload = debounced(() => load().catch(() => {}), 1200);
  return { onEvent(e) { if (e.t === "lead") reload(); }, refresh: load };
}
VIEWS.quality = viewQuality;

/* ---------------------------------------------------------------- Import */
function parseCsv(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else if (c === '"') inQ = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; } else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== "")) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((x) => x.trim()); return rows.slice(1).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ""])));
}
function parseRecords(text) {
  const t = text.trim(); if (!t) return { records: [] };
  if (t[0] === "[" || t[0] === "{") { try { const j = JSON.parse(t); const arr = Array.isArray(j) ? j : j.items || j.records || j.leads || (j.username || j.ig_username ? [j] : null); if (!arr) return { error: "That JSON has no list of records. Use an array like [{...}, {...}]." }; return { records: arr }; } catch { /* maybe JSON lines */ } }
  if (t[0] === "{") { try { return { records: t.split(/\n+/).map((l) => JSON.parse(l)) }; } catch { return { error: "That is not valid JSON." }; } }
  const recs = parseCsv(t); return recs.length ? { records: recs } : { error: "Could not read that as JSON or CSV. A CSV needs a header row and at least one line." };
}
async function viewImport(rootEl) {
  const settings = await api("GET", "/api/settings"); let records = [], showKey = false;
  if (!S.clients.length) return rootEl.append(empty("Create a campaign first", "Imported leads belong to a campaign.", h("a", { class: "btn primary", href: "#/campaigns", text: "Create a campaign" })));
  const camp = h("select", { id: "impC" }, campaignOptions(S.clientId || S.clients[0].id, false)), src = h("select", { id: "impS" }, [["", "Detect automatically"], ["ig_organic", "Instagram profiles (Apify)"], ["meta_ad_library", "Meta Ad Library ads"]].map(([v, t]) => h("option", { value: v, text: t })));
  const text = h("textarea", { id: "impT", rows: 8, placeholder: '[{"username":"joes_roofing","biography":"...","followersCount":900}]', spellcheck: "false" }), file = h("input", { type: "file", id: "impF", accept: ".json,.csv,.txt,.jsonl" });
  const info = h("p", { class: "small muted", role: "status", "aria-live": "polite", text: "Paste records or choose a file." }), go2 = h("button", { class: "btn primary", type: "button", disabled: true }, ico("upload"), "Import leads"), result = h("div");
  const parse = () => { const r = parseRecords(text.value); records = r.records || []; go2.disabled = !records.length; info.textContent = r.error || (records.length ? `${fmt(records.length)} record${records.length === 1 ? "" : "s"} ready. First: ${records.slice(0, 3).map((x) => "@" + String(x.username || x.ig_username || x.handle || "?").replace(/^@/, "")).join(", ")}${records.length > 3 ? "…" : ""}` : "Paste records or choose a file."); info.className = "small " + (r.error ? "msg err" : "muted"); };
  text.addEventListener("input", parse);
  file.addEventListener("change", async () => { const f = file.files[0]; if (!f) return; if (f.size > 25_000_000) return toast("That file is over 25 MB. Split it into smaller files.", "err"); text.value = await f.text(); parse(); });
  go2.onclick = guard(go2, async () => {
    const r = await api("POST", "/api/leads/import", { clientId: Number(camp.value), records, sourceType: src.value || undefined });
    result.replaceChildren(h("div", { class: "card", style: "margin-top:1rem" }, h("h3", { text: "Imported" }), h("div", { class: "grid kpis" }, kpi("Queued", r.queued, "being checked now"), kpi("Already known", r.duplicates, "skipped"), kpi("Unreadable", r.invalid, r.errors[0] || "no problems"), kpi("Skipped", r.skipped, "your own accounts or skip list")), r.truncated ? h("p", { class: "msg err", text: "Only the first 1,000 records were taken. Import the rest in another batch." }) : null, h("a", { class: "btn primary", href: "#/review", text: "Watch them arrive in Review" })));
    text.value = ""; records = []; go2.disabled = true; info.textContent = "Paste records or choose a file."; toast(`${r.queued} leads queued.`, "good"); loadBatches();
  });
  const batchBox = h("div"); const loadBatches = async () => { const b = (await api("GET", "/api/imports")).batches; batchBox.replaceChildren(b.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["When", "Campaign", "Source", "Leads", "Real", "Agency", "Filtered", "Checking"].map((t) => h("th", { class: ["Leads", "Real", "Agency", "Filtered", "Checking"].includes(t) ? "r" : "", text: t })))), h("tbody", null, b.map((x) => h("tr", null, h("td", { class: "nowrap", text: stamp(x.at) }), h("td", { text: clientName(x.clientId) }), h("td", { text: x.sourceType === "meta_ad_library" ? "Ad Library" : "Instagram" }), h("td", { class: "r num", text: fmt(x.total) }), h("td", { class: "r num", text: fmt(x.real) }), h("td", { class: "r num", text: fmt(x.agency) }), h("td", { class: "r num", text: fmt(x.rejected) }), h("td", { class: "r num", text: fmt(x.processing) })))))) : h("p", { class: "muted", text: "No imports yet." })); };
  await loadBatches();
  const keyBox = h("div"), drawKey = () => { const url = `${location.origin}/hooks/import?campaignId=${camp.value}`; const curl = `curl -X POST "${url}" \\\n  -H "x-import-key: ${showKey ? settings.importKey : "YOUR_IMPORT_KEY"}" \\\n  -H "content-type: application/json" \\\n  -d '[{"username":"joes_roofing","biography":"..."}]'`;
    const toggle = h("button", { class: "btn sm", type: "button", text: showKey ? "Hide key" : "Show key", onclick: () => { showKey = !showKey; drawKey(); } }), cp = h("button", { class: "btn sm", type: "button" }, ico("copy"), "Copy command"); cp.onclick = () => copyText(curl.replace("YOUR_IMPORT_KEY", settings.importKey), "Command copied with your key");
    keyBox.replaceChildren(h("p", { class: "small muted", text: "Anything that can send an HTTP request can push leads in: Make, Zapier, n8n, a script, or an Apify webhook. Send the records as a JSON array with your import key." }), h("pre", { class: "code", tabindex: "0", text: curl }), h("div", { class: "row" }, toggle, cp)); };
  camp.addEventListener("change", drawKey); drawKey();
  const reload = debounced(() => loadBatches().catch(() => {}), 1000);
  rootEl.append(
    h("div", { class: "split" }, h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Add leads" })),
      h("p", { class: "muted small", text: "Export profiles from Apify (JSON is best) or Meta Ad Library records. Every lead goes through the free pre-filter, then the AI bouncer, before it reaches Review." }),
      h("div", { class: "field-row" }, field("impC", "Campaign", camp), field("impS", "Source", src)), h("label", { for: "impT", text: "Paste JSON or CSV" }), text,
      h("label", { for: "impF", text: "Or choose a file" }), file, info, h("div", { class: "row" }, go2), result),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Send leads automatically" })), keyBox)),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Recent imports" })), batchBox));
  return { onEvent(e) { if (e.t === "lead") reload(); } };
}
VIEWS.import = viewImport;
})();
