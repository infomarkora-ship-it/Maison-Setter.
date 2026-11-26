/* Maison Setter command center — views part 2: Appointments, Campaigns, Analytics, Opportunities, Reports, Onboarding, Profile, Accounts, Runner, Settings, Supervisor. */
(() => {
"use strict";
const { h, ico, api, fmt, money, pct, ago, clock, stamp, day, initial, toast, bar, meter, badge, empty, field, sw, scorePill, delta, sparkline,
  PIPELINE, PIPE_LABEL, STAGE_LABEL, APPT_LABEL, APPT_CLS, S, VIEWS, stateBadge, miniAccount, feedList, kpi, campaignOptions, clientName, q, openDrawer, closeDrawer, refreshCounts, guard, copyText, debounced } = window.MS;
const $ = (s, r = document) => (r || document).querySelector(s);
const MS = window.MS;

/* ---------------------------------------------------------------- Appointments */
async function viewAppointments(rootEl) {
  const box = h("div"); rootEl.append(box); let data, statusFilter = "", mode = "list";
  const load = async () => {
    const p = new URLSearchParams();
    if (S.clientId) p.set("clientId", S.clientId);
    if (statusFilter) p.set("status", statusFilter);
    data = await api("GET", "/api/appointments?" + p.toString()); draw();
  };
  const draw = () => {
    const c = data.counts;
    const rows = data.appointments.map((a) => h("tr", null,
      h("td", null, h("b", { text: a.title || (a.lead ? "Call with @" + a.lead.username : "Appointment") }), a.clientName ? h("div", { class: "muted small", text: a.clientName }) : null),
      h("td", { class: "small muted", text: a.lead ? "@" + a.lead.username : "—" }),
      h("td", { class: "nowrap", text: a.scheduled_at ? stamp(a.scheduled_at) : "No date set" }),
      h("td", null, badge(APPT_LABEL[a.status] || a.status, APPT_CLS[a.status] || "")),
      h("td", { class: "num", text: a.value ? money(a.value) : "—" }),
      h("td", { class: "small muted", text: a.outcomeLabel || "—" }),
      h("td", null, apptActions(a))));
    const cal = monthCal(data.appointments);
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Appointments" }), h("p", { text: "Whether outreach is becoming real conversations on the calendar — and what came out of each one. Booked automatically by the AI when a lead locks in a time." })),
        h("div", { class: "actions" }, data.calendarUrl ? h("a", { class: "btn sm", href: data.calendarUrl, target: "_blank", rel: "noopener", title: "Subscribe to this feed from Google Calendar, Apple Calendar or Outlook" }, ico("cal"), "Add to calendar") : null, h("button", { class: "btn", type: "button", onclick: () => editAppt(null) }, ico("plus"), "New appointment"),
          h("div", { class: "tabs", style: "border:0" }, [["list", "List"], ["calendar", "Calendar"]].map(([k, l]) => h("button", { role: "tab", type: "button", "aria-selected": String(mode === k), onclick: () => { mode = k; draw(); } }, l))))),
      h("div", { class: "grid kpis" }, kpi("Booked", c.booked, "booked or confirmed", { icon: "cal" }), kpi("Upcoming", c.upcoming, "in the future", { icon: "clock" }),
        kpi("Completed", c.completed, "meetings done", { icon: "check" }), kpi("Booking pending", c.bookingPending, "not confirmed yet", { icon: "alert", cls: c.bookingPending ? "accent" : "" }),
        kpi("No-shows", c.noShow, "missed appointments", { icon: "x", cls: c.noShow ? "" : "" }), kpi("Converted", c.converted, "became a deal", { icon: "coin" })),
      mode === "calendar" ? h("section", { class: "card", style: "margin-top:1rem" }, h("div", { class: "card-head" }, h("h2", { text: "This month" })), cal) : null,
      h("section", { class: "card", style: "margin-top:1rem" },
        h("div", { class: "card-head" }, h("h2", { text: "All appointments" }),
          h("div", { class: "row" }, h("select", { id: "apSt", "aria-label": "Filter by status", onchange: (e) => { statusFilter = e.target.value; load(); } },
            h("option", { value: "", text: "All statuses" }), Object.entries(APPT_LABEL).map(([k, l]) => h("option", { value: k, text: l, selected: statusFilter === k ? true : null }))), h("button", { class: "btn sm", type: "button", onclick: load }, ico("refresh"), "Refresh"))),
        data.appointments.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Appointment", "Prospect", "When", "Status", "Value", "Outcome", ""].map((t) => h("th", { text: t })))), h("tbody", null, rows))) : empty("No appointments yet", "When a reply shows booking intent, a pending appointment appears here — or add one by hand.")));
  };
  const apptActions = (a) => {
    const wrap = h("div", { class: "row" });
    const edit = h("button", { class: "btn sm ghost", type: "button", text: "Edit" }); edit.onclick = () => editAppt(a);
    wrap.append(edit);
    if (["booked", "confirmed", "rescheduled"].includes(a.status)) { const done = h("button", { class: "btn sm", type: "button", text: "Mark completed" }); done.onclick = guard(done, async () => { await api("PATCH", `/api/appointments/${a.id}`, { status: "completed" }); toast("Marked completed.", "good"); load(); }); wrap.append(done); }
    return wrap;
  };
  const monthCal = (appts) => {
    const t = new Date(), y = t.getFullYear(), m = t.getMonth();
    const first = new Date(y, m, 1), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const inMonth = d.getMonth() === m;
      const items = appts.filter((a) => a.scheduled_at && new Date(a.scheduled_at).toDateString() === d.toDateString());
      cells.push(h("td", { class: inMonth ? "" : "faint", style: "vertical-align:top;min-width:76px;height:64px;border:1px solid var(--border);padding:.25rem;font-size:.72rem" },
        h("b", { text: String(d.getDate()) }), items.map((a) => h("div", { class: "tag", style: "display:block;margin-top:.15rem", title: a.title || "", text: (a.scheduled_at ? clock(a.scheduled_at) : "") + " " + (a.lead ? "@" + a.lead.username : a.title || "") }))));
    }
    const table = h("table", null, h("thead", null, h("tr", null, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("th", { text: d })))), h("tbody", null));
    const tb = table.querySelector("tbody");
    for (let r = 0; r < 6; r++) tb.append(h("tr", null, cells.slice(r * 7, r * 7 + 7)));
    return table;
  };
  function editAppt(a) {
    const n = !a;
    const title = h("input", { id: "apT", maxlength: 160, placeholder: "Call with @username" }), leadId = h("input", { id: "apL", type: "number", placeholder: "Lead id (optional)", style: "display:none" });
    const dt = h("input", { id: "apD", type: "datetime-local" });
    const status = h("select", { id: "apS" }, Object.entries(APPT_LABEL).map(([k, l]) => h("option", { value: k, text: l, selected: (a?.status || "booked") === k ? true : null })));
    const type = h("select", { id: "apTy" }, [["call", "Call"], ["meeting", "Meeting"], ["video", "Video call"], ["on_site", "On site"]].map(([k, l]) => h("option", { value: k, text: l, selected: (a?.type || "call") === k ? true : null })));
    const value = h("input", { id: "apV", type: "number", min: 0, step: "50" }); value.value = a?.value || "";
    const notes = h("textarea", { id: "apN", rows: 3 }); notes.value = a?.notes || "";
    const outcome = h("select", { id: "apO" }, h("option", { value: "", text: "Not recorded yet" }), [["won", "Deal won"], ["lost", "Deal lost"], ["proposal_sent", "Proposal sent"], ["follow_up_required", "Follow-up required"], ["still_negotiating", "Still negotiating"], ["not_qualified", "Not qualified"], ["no_decision", "No decision"]].map(([k, l]) => h("option", { value: k, text: l, selected: a?.outcome === k ? true : null })));
    if (a?.scheduled_at) { const d2 = new Date(a.scheduled_at); dt.value = new Date(d2.getTime() - d2.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    const sv = h("button", { class: "btn primary", type: "button", text: n ? "Create appointment" : "Save changes" }), msg = h("p", { class: "msg", role: "alert" });
    sv.onclick = guard(sv, async () => {
      const body = { title: title.value, scheduledAt: dt.value ? new Date(dt.value).getTime() : null, status: status.value, type: type.value, value: Number(value.value) || 0, notes: notes.value, outcome: outcome.value, clientId: S.clientId ? Number(S.clientId) : S.clients[0]?.id };
      try { if (n) await api("POST", "/api/appointments", body); else await api("PATCH", `/api/appointments/${a.id}`, body); toast(n ? "Appointment created." : "Saved.", "good"); closeDrawer(); load(); } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
    });
    openDrawer(n ? "New appointment" : a.title || "Appointment", h("div", null, field("apT", "Title", title), h("div", { class: "field-row" }, field("apD", "Date and time", dt), field("apTy", "Type", type)), h("div", { class: "field-row" }, field("apS", "Status", status), field("apV", "Estimated value ($)", value)), field("apN", "Notes", notes), field("apO", "Outcome after the meeting", outcome, "Recording an outcome of “Deal won” marks the lead as won and opens revenue attribution."), h("div", { class: "row" }, sv), msg));
  }
  await load();
  const reload = debounced(() => load().catch(() => {}), 900);
  return { onEvent(e) { if (["appointment", "lead"].includes(e.t)) reload(); }, refresh: load };
}
VIEWS.appointments = viewAppointments;

/* ---------------------------------------------------------------- Campaigns */
async function viewCampaigns(rootEl) {
  const box = h("div", { class: "stack" }); rootEl.append(box);
  const draw = () => {
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Campaigns" }), h("p", { text: "A campaign is one offer, its rules for who to contact, its message scripts and its sender accounts." }), h("p", { class: "small muted", text: "AI tip: open a campaign (or New campaign) and the Build with AI card sits at the top of the form - describe what you want in plain words and it fills the real fields for you." })),
        h("div", { class: "actions" }, (() => { const b = h("button", { class: "btn primary", type: "button" }, ico("plus"), "New campaign"); b.onclick = () => editCampaign(null, async () => { await reloadClients(); draw(); }); return b; })())),
      S.clients.length ? h("div", { class: "grid cards" }, S.clients.map(campaignCard)) : empty("No campaigns yet", "Create your first campaign to start importing leads."));
  };
  function campaignCard(c) {
    const script = h("textarea", { id: "as" + c.id, rows: 3, maxlength: 400, "aria-label": `Agency script for ${c.name}` }); script.value = c.agencyOpenerTemplate;
    const scriptBox = h("div", { hidden: !c.allowAgencies }, h("label", { for: "as" + c.id, text: "Agency script (they never get the business message)" }), script, h("p", { class: "hint", text: "Use {first_name}, {hook}, {niche}, {city}. The hook is written for each lead by the AI." }));
    const agBadge = () => c.allowAgencies ? badge("Agencies kept", "warn") : badge("Filtering agencies", "");
    let ab = agBadge();
    const filter = sw("agf" + c.id, "Filter out marketing agencies", "On: agencies and lead-gen firms are rejected before the AI. Off: they pass and get the agency script below.");
    filter.querySelector("input").checked = !c.allowAgencies;
    const saveAg = async (filterOn) => { const allow = !filterOn; try { await api("PATCH", `/api/clients/${c.id}`, { allowAgencies: allow, agencyOpenerTemplate: script.value }); c.allowAgencies = allow; scriptBox.hidden = !allow; const nb = agBadge(); ab.replaceWith(nb); ab = nb; toast(allow ? `${c.name} will also reach marketing agencies, with their own script.` : `${c.name} is filtering marketing agencies out again.`, "good"); } catch (e) { toast(e.message, "err"); filter.querySelector("input").checked = !allow; } };
    filter.addEventListener("change", () => saveAg(filter.querySelector("input").checked));
    script.addEventListener("change", () => { if (c.allowAgencies) saveAg(false); });
    const edit = h("button", { class: "btn sm", type: "button", text: "Edit settings" }); edit.onclick = () => editCampaign(c, async () => { await reloadClients(); draw(); });
    return h("article", { class: "card", "aria-labelledby": "cn" + c.id }, h("div", { class: "card-head" }, h("h2", { id: "cn" + c.id, text: c.name }), c.active ? badge("On", "good", true) : badge("Off", ""), c.onboarding && c.onboarding.completed ? badge("Setup done", "info") : null, ab, edit),
      h("p", { class: "muted small", text: c.offer || "No offer written yet." }),
      h("div", { class: "row small" }, badge(`${c.accounts} sender${c.accounts === 1 ? "" : "s"}`, ""), badge(`${c.pending} to review`, c.pending ? "accent" : ""), c.preDmTouch ? badge("Warm-touch before DM", "info") : null, c.monthlyCost ? badge(money(c.monthlyCost) + "/mo", "") : null),
      filter, scriptBox);
  }
  draw(); return { refresh: async () => { await reloadClients(); draw(); } };
}
VIEWS.campaigns = viewCampaigns;
async function reloadClients() { S.clients = (await api("GET", "/api/clients")).clients; $("#fClient").replaceChildren(...campaignOptions(S.clientId, true)); }
MS.reloadClients = reloadClients;
function editCampaign(c, done) {
  const n = !c, v = c || { name: "", offer: "", target: "", tone: "friendly, short, casual", bookingLink: "", openerTemplate: "Hey {first_name}! Came across your page and love {hook}. Are you open to new customers right now?", agencyOpenerTemplate: "Hey {first_name}! Came across {hook}. Would you be open to swapping notes on how you bring in new clients?", followups: [{ afterDays: 2, text: "Hey {first_name}, just bumping this in case it got buried. No pressure at all!" }, { afterDays: 5, text: "Last one from me, {first_name}. If now isn't the right time, no worries!" }], minFollowers: 150, maxFollowers: 100000, activeWithinDays: 30, requireContact: true, allowCreatorLabels: false, excludeWords: [], preDmTouch: true, autoApprovePass: false, autoRejectNo: true, autoReply: false, supervision: "supervised", followPool: [], active: true, dailyCap: 20, sendStart: 9, sendEnd: 20, tz: "America/Toronto", allowAgencies: false, monthlyCost: 0, leadBrief: "", autoBook: true, followLeads: false };
  const I = (id, val, extra = {}) => { const el = h("input", { id, type: extra.type || "text", ...extra }); el.value = val ?? ""; return el; }, T = (id, val, rows = 3) => { const el = h("textarea", { id, rows }); el.value = val ?? ""; return el; };
  const fu = h("div"); let rows = v.followups.map((f) => ({ ...f }));
  const drawFu = () => fu.replaceChildren(...rows.map((f, i) => { const d = I("fd" + i, f.afterDays, { type: "number", min: 0.25, max: 30, step: 0.25, "aria-label": `Follow-up ${i + 1}: days after` }), t = T("ft" + i, f.text, 2); t.setAttribute("aria-label", `Follow-up ${i + 1} text`); d.oninput = () => { f.afterDays = Number(d.value); }; t.oninput = () => { f.text = t.value; };
    const rm = h("button", { class: "btn sm danger", type: "button", text: "Remove" }); rm.onclick = () => { rows.splice(i, 1); drawFu(); };
    return h("div", { class: "card" }, h("div", { class: "field-row" }, field("fd" + i, `Follow-up ${i + 1}: send after (days)`, d)), h("label", { for: "ft" + i, text: "Message" }), t, h("div", { class: "row" }, rm)); }), rows.length < 6 ? (() => { const a = h("button", { class: "btn sm", type: "button", text: "Add a follow-up" }); a.onclick = () => { rows.push({ afterDays: 3, text: "" }); drawFu(); }; return a; })() : null);
  drawFu();
  const f = { name: I("cName", v.name, { maxlength: 80 }), offer: T("cOffer", v.offer), target: T("cTarget", v.target, 2), tone: I("cTone", v.tone), book: I("cBook", v.bookingLink, { type: "url", placeholder: "https://" }), op: T("cOp", v.openerTemplate), ag: T("cAg", v.agencyOpenerTemplate), cost: I("cCost", v.monthlyCost, { type: "number", min: 0, step: "10" }),
    min: I("cMin", v.minFollowers, { type: "number", min: 0 }), max: I("cMax", v.maxFollowers, { type: "number", min: 0 }), act: I("cAct", v.activeWithinDays, { type: "number", min: 0 }), ex: T("cEx", (v.excludeWords || []).join("\n"), 3),
    pool: T("cPool", (v.followPool || []).join("\n"), 3), brief: T("cBrief", v.leadBrief, 6), start: I("cStart", v.sendStart, { type: "number", min: 0, max: 23 }), end: I("cEnd", v.sendEnd, { type: "number", min: 1, max: 24 }), cap: I("cCap", v.dailyCap, { type: "number", min: 1, max: 40 }), tz: I("cTz", v.tz) };
  /* Lead brief: describe the leads you want in your own words. The AI bouncer follows it on every lead,
     and "Sync rules with AI" proposes matching pre-filter settings that fill the rule fields below. */
  const briefMsg = h("p", { class: "msg small", role: "status" });
  const syncBtn = h("button", { class: "btn", type: "button" }, ico("bot"), "Sync rules with AI");
  syncBtn.onclick = guard(syncBtn, async () => {
    briefMsg.className = "msg small"; briefMsg.textContent = "Reading your brief…";
    const r = await api("POST", "/api/ai/brief-rules", { clientId: c.id, brief: f.brief.value });
    if (r.fields.minFollowers != null) f.min.value = r.fields.minFollowers;
    if (r.fields.maxFollowers != null) f.max.value = r.fields.maxFollowers;
    if (r.fields.activeWithinDays != null) f.act.value = r.fields.activeWithinDays;
    if (r.fields.requireContact !== undefined) $("cReq").checked = !!r.fields.requireContact;
    if (r.fields.allowCreatorLabels !== undefined) $("cCr").checked = !!r.fields.allowCreatorLabels;
    if (Array.isArray(r.fields.excludeWords)) f.ex.value = r.fields.excludeWords.join("\n");
    briefMsg.className = "msg good"; briefMsg.textContent = (r.explanation || "Rules proposed from your brief.") + " Review the fields below, then press Save changes.";
  });
  const sv = h("button", { class: "btn primary", type: "button", text: n ? "Create campaign" : "Save changes" }), msg = h("p", { class: "msg", role: "alert" });
  /* Build with AI: describe it in plain words, the AI fills the real fields; nothing saves until Save changes. */
  let aiSection = null;
  if (!n) {
    const aiWhat = h("select", { id: "aiWhat", "aria-label": "What the AI fills" },
      h("option", { value: "campaign", text: "The basics (offer, target, tone)" }),
      h("option", { value: "opener", text: "The opener scripts" }),
      h("option", { value: "followups", text: "The follow-up sequence" }));
    const aiDesc = h("textarea", { id: "aiDesc", rows: 3, "aria-label": "Describe what you want", placeholder: "Describe it in plain words. Example: we install pools in Phoenix, target new homeowners and small hotels, sound chill but professional, follow-ups persistent but polite." });
    const aiMsg = h("p", { class: "msg small", role: "status" });
    const aiBtn = h("button", { class: "btn", type: "button" }, ico("bot"), "Build it with AI");
    aiBtn.onclick = guard(aiBtn, async () => {
      aiMsg.className = "msg small"; aiMsg.textContent = "Thinking…";
      const r = await api("POST", "/api/ai/build", { clientId: c.id, what: aiWhat.value, description: aiDesc.value });
      const F = r.fields || {};
      if (F.offer) f.offer.value = F.offer;
      if (F.target) f.target.value = F.target;
      if (F.tone) f.tone.value = F.tone;
      if (F.openerTemplate) f.op.value = F.openerTemplate;
      if (F.agencyOpenerTemplate) f.ag.value = F.agencyOpenerTemplate;
      if (Array.isArray(F.followups)) { rows = F.followups.map((x) => ({ ...x })); drawFu(); }
      aiMsg.className = "msg good"; aiMsg.textContent = r.explanation || "Filled. Review it, tweak anything, then press Save changes.";
    });
    aiSection = h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Build with AI" })),
      field("aiWhat", "What should it fill?", aiWhat), field("aiDesc", "Describe what you want in plain words", aiDesc, "The AI fills the fields below with its recommendation and explains why. Nothing saves until you press Save changes."),
      h("div", { class: "row" }, aiBtn), aiMsg);
  }
  const checks = { req: sw("cReq", "Require a website, phone or email", "Reject profiles with no bio link and no contact details.", v.requireContact), agf: sw("cAgf", "Filter out marketing agencies", "On: agencies and lead-gen firms are rejected before the AI ever runs. Off: they pass and get the agency script in Messages.", v.allowAgencies === undefined ? true : !v.allowAgencies), creator: sw("cCr", "Allow creator and coach categories", "Normally rejected: Digital creator, Blogger, Coach, Entrepreneur and similar.", v.allowCreatorLabels), touch: sw("cTouch", "Warm-touch before the first message", "View their story or like a recent post 10 to 30 minutes before the opener.", v.preDmTouch), aa: sw("cAA", "Approve strong leads automatically", "Real businesses at 80% sure or better skip Review.", v.autoApprovePass), ar: sw("cAR", "Reject AI rejections automatically", "Off means they wait in Needs a look.", v.autoRejectNo), rep: sw("cRep", "Send AI reply drafts without approval", "Off means every reply waits for you in the Inbox.", v.autoReply), ab: sw("cAB", "Book appointments automatically", "The AI reads the DMs; the moment a time is actually agreed on, the appointment lands on the calendar (with the date and time) and the pipeline moves to Booked. No click needed.", v.autoBook), fl: sw("cFL", "Follow the lead before the first message", "The warm-touch also follows the lead, so the DM arrives from a familiar face. Slightly more visible, slightly riskier.", v.followLeads), on: sw("cOn", "Campaign is on", "Off pauses sending for every sender in it.", v.active) };
  sv.onclick = guard(sv, async () => {
    msg.textContent = ""; const val = (id) => $("#" + id), body = { name: f.name.value, offer: f.offer.value, target: f.target.value, tone: f.tone.value, bookingLink: f.book.value, openerTemplate: f.op.value, agencyOpenerTemplate: f.ag.value, followups: rows.filter((r) => r.text.trim()).map((r) => ({ afterDays: r.afterDays, text: r.text })), monthlyCost: Number(f.cost.value) || 0,
      leadBrief: f.brief.value, followPool: f.pool.value, supervision: (document.querySelector('input[name="cSup"]:checked') || {}).value || "supervised", minFollowers: Number(f.min.value), maxFollowers: Number(f.max.value), activeWithinDays: Number(f.act.value), excludeWords: f.ex.value, dailyCap: Number(f.cap.value), sendStart: Number(f.start.value), sendEnd: Number(f.end.value), tz: f.tz.value.trim() || undefined,
      requireContact: val("cReq").checked, allowAgencies: !val("cAgf").checked, allowCreatorLabels: val("cCr").checked, preDmTouch: val("cTouch").checked, autoApprovePass: val("cAA").checked, autoRejectNo: val("cAR").checked, autoReply: val("cRep").checked, autoBook: val("cAB").checked, followLeads: val("cFL").checked, active: val("cOn").checked };
    try { if (n) await api("POST", "/api/clients", body); else await api("PATCH", `/api/clients/${c.id}`, body); toast(n ? "Campaign created." : "Saved.", "good"); closeDrawer(); await done(); } catch (e) { msg.className = "msg err"; msg.textContent = e.message; msg.scrollIntoView?.({ block: "nearest" }); }
  });
  openDrawer(n ? "New campaign" : v.name, h("div", null, aiSection, field("cName", "Campaign name", f.name), field("cOffer", "What you offer", f.offer, "The AI uses this to judge whether a lead is a fit."), field("cTarget", "Who you want to reach", f.target, "For example: local roofers and contractors in Texas."), field("cTone", "Tone of voice", f.tone), field("cBook", "Booking link", f.book), field("cCost", "Monthly client investment ($)", f.cost, "Used for ROI: attributed revenue is compared against this number."),
    h("h3", { text: "Messages" }), field("cOp", "First message (business script)", f.op, "Use {first_name}, {hook}, {niche}, {city}, {booking_link}. {hook} is written for each lead, so no second AI call is needed."), field("cAg", "First message (agency script)", f.ag, "Only used when this campaign also reaches marketing agencies."), h("h3", { text: "Follow-ups" }), fu,
    h("h3", { text: "The lead brief: describe the leads you want" }), field("cBrief", "In your own words: who is a perfect lead, and who must never be messaged?", f.brief, "The AI bouncer reads this on every single lead, before it decides. Say the niches, locations, sizes, must-have signals, and the dealbreakers. Example: family-owned roofers and HVAC companies within 50 miles of Tulsa, at least 300 followers, posting real jobs. Never: plumbers, national franchises, anyone outside Oklahoma."), h("div", { class: "row" }, syncBtn), briefMsg,
    h("h3", { text: "Lead rules (the free pre-filter)" }), h("div", { class: "field-row" }, field("cMin", "Fewest followers", f.min), field("cMax", "Most followers", f.max), field("cAct", "Must have posted in the last (days)", f.act)), field("cEx", "Reject if the bio contains (one per line)", f.ex), checks.req, checks.agf, checks.creator,
    h("h3", { text: "AI supervision" }), h("div", { class: "seg modes", role: "radiogroup", "aria-label": "AI autonomy" }, MODES.map(([k, label, sub]) => h("label", { for: "cSup" + k }, h("input", { type: "radio", name: "cSup", id: "cSup" + k, value: k, checked: v.supervision === k }), label, h("small", { text: sub })))),
    h("h3", { text: "Warm-up follows" }), field("cPool", "Accounts it may follow while warming up (one per line)", f.pool, "Niche pages, local businesses, suppliers. Only a few per day, never the same one twice. The browser also discovers fresh niche accounts on its own while browsing, and adds them here."), checks.fl,
    h("h3", { text: "Sending" }), h("div", { class: "field-row" }, field("cStart", "Starts (hour)", f.start), field("cEnd", "Ends (hour)", f.end), field("cCap", "Most per sender per day", f.cap), field("cTz", "Time zone", f.tz)), checks.touch, checks.ab, checks.aa, checks.ar, checks.rep, checks.on, h("div", { class: "row" }, sv), msg));
}
const MODES = [["watch", "Watch", "The AI reviews every message, but you approve each one."], ["supervised", "Supervised", "The AI sends anything that fits the conversation; questionable sends (risk 75 or more) wait for you."], ["autopilot", "Autopilot", "The AI decides. Only genuinely dangerous sends (risk 90 or more) are held. You read the log."]];
MS.editCampaign = editCampaign;

/* ---------------------------------------------------------------- Analytics & ROI */
async function viewAnalytics(rootEl) {
  const box = h("div"); rootEl.append(box); let d;
  const load = async () => { d = await api("GET", `/api/roi?${q()}`); draw(); };
  const draw = () => {
    const f = d.funnel, cv = d.conversion, rev = d.revenue;
    const steps = [["Leads", f.leads, cv.leadToQualified], ["Qualified", f.qualified, cv.contactedRate], ["Contacted", f.contacted, cv.replyRate], ["Replied", f.replied, cv.interestedRate], ["Interested", f.interested, cv.bookRate], ["Appointments", f.appointments, cv.winRate], ["Deals won", f.won, null]];
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Analytics & ROI" }), h("p", { text: `The last ${d.days} days. ${rev.note || ""}` }))),
      h("div", { class: "grid kpis" },
        kpi("Revenue attributed", money(rev.won), `${d.days}-day window`, { cls: "accent", icon: "coin" }),
        kpi("Open pipeline", money(rev.pipeline), "estimated, not earned", { icon: "flag" }),
        d.roiAvailable ? kpi("ROI", (d.roi > 0 ? "+" : "") + d.roi + "%", `against ${money(d.investment)} of investment`, { icon: "chart", cls: d.roi >= 0 ? "" : "" }) : kpi("ROI", "—", "Set a monthly client investment on the campaign to enable this", { icon: "chart" }),
        kpi("Revenue per appointment", rev.won || f.appointments ? money(d.revenuePerAppointment) : "—", f.appointments + " appointments", { icon: "cal" }),
        d.costPerLead != null ? kpi("Cost per lead", money(d.costPerLead), "investment ÷ leads sourced", { icon: "users" }) : null),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "The lead-to-revenue journey" })),
        h("div", { class: "funnel-flow" }, steps.map(([label, v, conv]) => h("div", { class: "funnel-step" }, h("b", { class: "num", text: fmt(v) }), h("span", { text: label }), conv != null ? h("small", { text: conv + "% onward" }) : null))),
        h("p", { class: "hint", text: "Percentages are hidden when the sample is too small to mean anything." })),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "Revenue, appointments and lead flow over time" })),
        d.series.some((p) => p.leads || p.appointments || p.revenue) ? sparkline(d.series, { keys: ["leads", "appointments", "revenue"], hgt: 170, labels: `last ${d.days} days` }) : h("p", { class: "muted small", text: "No activity in this window yet." }),
        h("div", { class: "chart-legend" }, h("span", null, h("i", { style: "background:var(--accent)" }), "Leads sourced"), h("span", null, h("i", { style: "background:var(--info)" }), "Appointments"), h("span", null, h("i", { style: "background:var(--good)" }), "Revenue won"))),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "Revenue by campaign" })),
        d.perCampaign.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Campaign", "Leads", "Appointments", "Revenue won", "Open pipeline"].map((t) => h("th", { text: t })))),
          h("tbody", null, d.perCampaign.map((c) => h("tr", null, h("td", { text: c.name }), h("td", { class: "num", text: fmt(c.leads) }), h("td", { class: "num", text: fmt(c.appointments) }), h("td", { class: "num", text: money(c.revenue) }), h("td", { class: "num", text: money(c.pipeline) }))))))
        : empty("No campaigns yet", "Create a campaign to see revenue attribution per client.")),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "Revenue attribution, honestly labelled" })),
        h("dl", { class: "facts" }, h("dt", { text: "Won revenue (money attributed)" }), h("dd", { class: "num", text: money(rev.wonTotal) }),
          h("dt", { text: "Open pipeline (estimate)" }), h("dd", { class: "num", text: money(rev.pipeline) }),
          h("dt", { text: "Booked opportunity value (estimate)" }), h("dd", { class: "num", text: money(rev.bookedValue) }),
          h("dt", { text: "Client investment in this window" }), h("dd", { class: "num", text: money(d.investment) })),
        h("p", { class: "hint", text: "Pipeline numbers are what the open opportunities are worth if everything closes — they are never presented as money earned. ROI is only shown when the campaign's monthly investment is set." })));
  };
  await load(); const reload = debounced(() => load().catch(() => {}), 1200);
  return { onEvent(e) { if (["lead", "appointment", "task"].includes(e.t)) reload(); }, refresh: load };
}
VIEWS.analytics = viewAnalytics;

/* ---------------------------------------------------------------- Opportunities & recovery center */
async function viewOpportunities(rootEl) {
  const box = h("div"); rootEl.append(box); let al, op, status = "open";
  const load = async () => {
    const p = new URLSearchParams({ status });
    if (S.clientId) p.set("clientId", S.clientId);
    [al, op] = await Promise.all([api("GET", "/api/alerts?" + p.toString()), api("GET", "/api/opportunities?" + p.toString())]);
    draw();
  };
  const alertCard = (a) => {
    const act = h("div", { class: "row" });
    const openBtn = a.username || a.leadId ? h("button", { class: "btn sm", type: "button", text: "Open lead", onclick: () => MS.openLead(a.leadId) }) : null;
    for (const [st, label, cls] of [["in_progress", "Start", ""], ["resolved", "Resolve", "good"], ["snoozed", "Snooze 24h", ""]]) {
      const b = h("button", { class: "btn sm " + cls, type: "button", text: label }); b.onclick = guard(b, async () => { await api("POST", `/api/alerts/${a.id}`, { status: st, hours: 24 }); toast(label + ".", "good"); load(); refreshCounts(); }); act.append(b);
    }
    return h("div", { class: "alert " + (a.priority === "critical" ? "bad" : a.priority === "high" ? "warn" : a.priority === "medium" ? "info" : ""), style: "align-items:flex-start" },
      h("div", { class: "grow" }, h("b", { text: a.title }), h("p", { class: "small", text: a.detail }),
        h("div", { class: "chips" }, badge(a.priority.toUpperCase(), a.priority === "critical" ? "bad" : a.priority === "high" ? "warn" : ""), a.clientName ? badge(a.clientName, "") : null, a.username ? badge("@" + a.username, "") : null, a.leadScore != null ? scorePill(a.leadScore) : null, h("span", { class: "muted small", text: ago(a.createdAt) }))),
      h("div", null, openBtn, act));
  };
  const oppRow = (o) => h("tr", null,
    h("td", null, h("b", { text: o.lead ? "@" + o.lead.username : "—" }), h("div", { class: "muted small", text: o.clientName })),
    h("td", null, badge(o.status, o.status === "won" ? "good" : o.status === "lost" ? "bad" : "accent")),
    h("td", { class: "num", text: money(o.value) }),
    h("td", { class: "small muted", text: o.status === "won" ? o.wonReason || "won " + ago(o.wonAt) : o.status === "lost" ? o.lostReason || "lost " + ago(o.lostAt) : "open since " + ago(o.createdAt) }),
    h("td", null, oppActions(o)));
  const oppActions = (o) => {
    const w = h("div", { class: "row" });
    const won = h("button", { class: "btn sm good", type: "button", text: "Won" }); won.onclick = guard(won, async () => { const reason = prompt("Why did it close? (optional)") || ""; await api("PATCH", `/api/opportunities/${o.id}`, { status: "won", wonReason: reason }); toast("Marked won.", "good"); load(); });
    const lost = h("button", { class: "btn sm danger", type: "button", text: "Lost" }); lost.onclick = guard(lost, async () => { const reason = prompt("Why was it lost? (optional)") || ""; await api("PATCH", `/api/opportunities/${o.id}`, { status: "lost", lostReason: reason }); toast("Marked lost.", "good"); load(); });
    const val = h("button", { class: "btn sm", type: "button", text: "Value" }); val.onclick = guard(val, async () => { const v = prompt("Opportunity value in $", String(o.value || "")); if (v == null) return; await api("PATCH", `/api/opportunities/${o.id}`, { value: Number(v) || 0 }); load(); });
    w.append(won, lost, val); return w;
  };
  const draw = () => {
    const t = al.totals || {};
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Opportunities" }), h("p", { text: "The recovery center: everything that could be lost if nobody acts, plus the open opportunities and their outcomes." }))),
      h("div", { class: "grid kpis" },
        kpi("Flagged now", al.alerts.length, "across all priorities", { icon: "flag", cls: al.alerts.length ? "accent" : "" }),
        kpi("Resolved all-time", al.resolved, al.avgResolutionHours != null ? `average fix time ${al.avgResolutionHours}h` : "nothing resolved yet", { icon: "check" }),
        kpi("Open pipeline", money(op.totals.pipeline), `${op.totals.openCount} open opportunit${op.totals.openCount === 1 ? "y" : "ies"}`, { icon: "coin" }),
        kpi("Won revenue", money(op.totals.won), `${op.totals.wonCount} deal${op.totals.wonCount === 1 ? "" : "s"} closed`, { icon: "target" })),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "Needs action" }),
          h("div", { class: "row" }, h("select", { id: "alSt", "aria-label": "Alert status", onchange: (e) => { status = e.target.value; load(); } },
            h("option", { value: "open", text: "Open alerts", selected: status === "open" ? true : null }), h("option", { value: "snoozed", text: "Snoozed", selected: status === "snoozed" ? true : null }), h("option", { value: "resolved", text: "Resolved", selected: status === "resolved" ? true : null }), h("option", { value: "all", text: "Everything", selected: status === "all" ? true : null })), h("button", { class: "btn sm", type: "button", onclick: load }, ico("refresh"), "Refresh"))),
        al.alerts.length ? h("div", { class: "stack sm" }, al.alerts.map(alertCard)) : empty("Nothing is slipping through", "When an interested prospect waits too long, a DM goes unanswered or a follow-up becomes overdue, it shows up here.")),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "Opportunities" }), h("button", { class: "btn sm", type: "button", text: "New opportunity", onclick: async () => { const leadId = prompt("Lead id (see a lead's drawer)"); if (!leadId) return; const v = prompt("Potential value in $ (optional)", "0"); try { await api("POST", "/api/opportunities", { leadId: Number(leadId), value: Number(v) || 0 }); toast("Opportunity opened.", "good"); load(); } catch (e) { toast(e.message, "err"); } } })),
        op.opportunities.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Lead", "Status", "Value", "Notes", ""].map((x) => h("th", { text: x })))), h("tbody", null, op.opportunities.map(oppRow)))) : empty("No opportunities tracked yet", "Move a lead to “Qualified Opportunity” or open one by hand to start tracking its value.")));
  };
  await load();
  const reload = debounced(() => load().catch(() => {}), 900);
  return { onEvent(e) { if (["lead", "appointment", "task"].includes(e.t)) reload(); }, refresh: load };
}
VIEWS.opportunities = viewOpportunities;

/* ---------------------------------------------------------------- Reports */
async function viewReports(rootEl) {
  const box = h("div"); rootEl.append(box); let rep, days = S.days;
  const load = async () => { rep = await api("GET", `/api/growth-report?days=${days}${S.clientId ? "&clientId=" + S.clientId : ""}`); draw(); };
  const draw = () => {
    const n = rep.numbers, dsel = h("select", { id: "repDays", "aria-label": "Reporting period" }, [["1", "Today"], ["7", "This week"], ["30", "This month"], ["90", "This quarter"]].map(([v, t]) => h("option", { value: v, text: t, selected: String(days) === v ? true : null })));
    dsel.value = String(days); dsel.onchange = () => { days = Number(dsel.value); load(); };
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Reports" }), h("p", { text: `What happened for ${rep.period.client} in the selected period — in plain words, with the numbers underneath.` })),
        h("div", { class: "actions" }, dsel, (() => { const b = h("button", { class: "btn", type: "button" }, ico("copy"), "Copy report"); b.onclick = () => copyText(rep.narrative.map((x) => "• " + x).join("\n") + "\n\n" + Object.entries(n).map(([k, v]) => `${k}: ${typeof v === "number" && /revenue|pipeline/i.test(k) ? money(v) : fmt(v)}`).join("\n"), "Report copied"); return b; })())),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "The period in plain words" })),
        h("ul", { class: "stack sm", style: "margin:.2rem 0 0;padding-left:1.1rem" }, rep.narrative.map((x) => h("li", { class: "small", text: x })))),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "The numbers" })),
        h("div", { class: "grid kpis" },
          kpi("Leads sourced", n.leadsSourced ?? n.leads, "this period", { icon: "users" }),
          kpi("Qualified", n.qualified, "passed the checks", { icon: "shield" }),
          kpi("Messages sent", n.messagesSent, `+ ${n.followupsSent} follow-ups`, { icon: "chat" }),
          kpi("Replies", n.replies, "unique people", { icon: "inbox" }),
          kpi("Interested", n.interested, "prospects", { icon: "target" }),
          kpi("Appointments", n.appointmentsBooked ?? n.appointments, `${n.appointmentsCompleted} completed`, { icon: "cal" }),
          kpi("Deals won", n.dealsWon, money(n.revenueAttributed) + " attributed", { icon: "coin" }),
          kpi("Open pipeline", money(n.openPipeline), "estimate, not earned", { icon: "flag" }))),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Missed opportunities" })),
        h("div", { class: "row small" }, badge(`${n.openAlerts} open`, n.openAlerts ? "warn" : "good"), badge(`${n.alertsResolved} resolved this period`, "good"), h("span", { class: "muted", text: "Resolved alerts are situations the team acted on before they became lost revenue." }))));
  };
  await load();
  return { refresh: load };
}
VIEWS.reports = viewReports;

/* ---------------------------------------------------------------- Onboarding — multi-slide wizard */
const OB_SLIDES = [
  { id: "welcome", title: "Welcome to Maison Setter", body: "This wizard configures the whole operation around one client: their business, their offer, who they want to reach, how leads are judged, and what happens after someone shows interest. Everything here is editable later in Business profile." },
  { id: "interview", title: "The AI interview", body: "8 questions, one at a time, in your own words. The AI turns the answers into the company brain, drafts the ICP for your approval, and fills the campaign. Rather type? The manual slides follow." },
  { id: "business", key: "business", title: "About your business", body: "Tell the system what this client actually is. It reads this to judge whether a prospect is a fit." },
  { id: "offer", key: "offer", title: "Your offer", body: "What the client sells and roughly what it is worth, so conversations stay concrete." },
  { id: "icp", key: "icp", title: "Ideal customer profile", body: "Who should this campaign attract, and who must never be contacted." },
  { id: "qualification", key: "qualification", title: "Lead quality requirements", body: "What makes a prospect worth pursuing. This drives scoring and review." },
  { id: "goals", key: "goals", title: "Growth goals", body: "What success looks like this month." },
  { id: "outreach", key: "outreach", title: "Outreach preferences", body: "How the client speaks, so messages sound like them." },
  { id: "conversation", key: "conversation", title: "Conversation & qualification guidelines", body: "How replies are judged and when a human must take over." },
  { id: "appointments", key: "appointments", title: "Appointment & sales process", body: "What happens after someone says they are interested." },
  { id: "campaign", key: "campaign", title: "Campaign preferences", body: "Where to hunt and what to avoid." },
  { id: "knowledge", key: "knowledge", title: "Business context & knowledge", body: "Reference material the assistant can use while replying." },
  { id: "review", title: "Review your setup", body: "Everything entered, section by section. Edit anything before completing." },
  { id: "done", title: "Setup complete", body: "" }
];
const OB_FIELDS = {
  business: [["name", "Business name", "text"], ["website", "Website", "url"], ["type", "Business type", "text"], ["industry", "Industry", "text"], ["location", "Location", "text"], ["serviceAreas", "Service areas", "text"], ["description", "What they do, in their own words", "textarea"], ["services", "Primary services (one per line)", "textarea"], ["socialProfiles", "Social profiles", "text"]],
  offer: [["main", "Main service or product", "text"], ["description", "Offer description", "textarea"], ["pricingModel", "Pricing model", "text"], ["startingPrice", "Starting price / range", "text"], ["typicalValue", "Typical client value", "text"], ["benefits", "Main benefits (one per line)", "textarea"], ["differentiators", "Differentiators", "textarea"], ["guarantees", "Guarantees, if any", "text"], ["cta", "Primary call to action", "text"], ["bookingLink", "Booking link", "url"]],
  icp: [["industries", "Target industries (one per line)", "textarea"], ["businessTypes", "Target business types", "textarea"], ["size", "Ideal customer size", "text"], ["geography", "Geography", "text"], ["decisionMakers", "Decision-maker types", "text"], ["needs", "Relevant customer needs", "textarea"], ["painPoints", "Typical pain points", "textarea"], ["positiveSignals", "Positive qualification signals", "textarea"], ["excludedIndustries", "Excluded industries (one per line)", "textarea"], ["excludedTypes", "Excluded business types", "textarea"]],
  qualification: [["mustHave", "Must-have criteria", "textarea"], ["niceToHave", "Nice-to-have criteria", "textarea"], ["disqualifiers", "Disqualifying characteristics", "textarea"], ["minLegitimacy", "Minimum business legitimacy", "text"], ["requiredInfo", "Required information", "text"], ["preferredSources", "Preferred lead sources", "text"], ["expectations", "Lead quality expectations", "textarea"]],
  goals: [["main", "Main goal", "text"], ["leadsPerMonth", "Target leads per month", "number"], ["qualifiedTarget", "Target qualified leads", "number"], ["appointmentsTarget", "Target appointments", "number"], ["salesTarget", "Target sales", "number"], ["revenueTarget", "Target revenue ($)", "number"], ["priority", "Main priority", "text"], ["bottlenecks", "Current bottlenecks", "textarea"]],
  outreach: [["tone", "Brand tone", "text"], ["style", "Communication style", "text"], ["formality", "Friendly vs formal", "text"], ["approach", "Preferred messaging approach", "textarea"], ["terminology", "Important terminology", "text"], ["avoidWords", "Words or claims to avoid", "textarea"], ["cta", "Preferred call to action", "text"], ["examples", "Example messages they like", "textarea"]],
  conversation: [["interest", "What counts as genuine interest", "textarea"], ["qualifiedOpportunity", "What counts as a qualified opportunity", "textarea"], ["questions", "Questions that should be answered", "textarea"], ["humanQuestions", "Questions that require a human", "textarea"], ["pricingGuidance", "Pricing guidance", "textarea"], ["bookingConditions", "Booking conditions", "textarea"], ["escalation", "Escalation requirements", "textarea"], ["sensitive", "Sensitive subjects", "textarea"]],
  appointments: [["bookingLink", "Booking link", "url"], ["types", "Appointment types", "text"], ["duration", "Meeting duration", "text"], ["instructions", "Calendar / booking instructions", "textarea"], ["afterBooking", "What happens after someone books", "textarea"], ["owner", "Who handles appointments", "text"], ["completedMeans", "What counts as a completed appointment", "textarea"], ["wonMeans", "What counts as a won deal", "textarea"]],
  campaign: [["objective", "Campaign objective", "text"], ["segments", "Target segments", "textarea"], ["regions", "Target regions", "text"], ["sources", "Preferred lead sources", "text"], ["exclusions", "Exclusions", "textarea"], ["constraints", "Important constraints", "textarea"]],
  knowledge: [["faqs", "FAQs", "textarea"], ["objections", "Objection handling", "textarea"], ["caseStudies", "Customer examples / case studies", "textarea"], ["policies", "Business policies", "textarea"], ["reference", "Other reference material", "textarea"], ["script", "Script / talking points (paste any script, even rough notes)", "textarea"]]
};
async function viewOnboarding(rootEl) {
  const box = h("div"); rootEl.append(box);
  if (!S.clients.length) return box.append(empty("Create a campaign first", "Onboarding configures one client (campaign) at a time.", h("a", { class: "btn primary", href: "#/campaigns", text: "Create a campaign" })));
  let clientId = S.clientId ? Number(S.clientId) : S.clients[0].id;
  let ob = null, step = 0;
  const load = async () => {
    const r = await api("GET", "/api/onboarding?clientId=" + clientId);
    ob = r.onboarding; step = ob ? Math.min(ob.step, OB_SLIDES.length - 1) : 0;
    draw();
  };
  const sectionOf = (key) => (ob?.data?.[key]) || {};
  const draw = () => {
    const client = S.clients.find((c) => c.id === clientId) || S.clients[0];
    const sel = h("select", { id: "obClient", "aria-label": "Which client" }, S.clients.map((c) => h("option", { value: c.id, text: c.name, selected: c.id === clientId ? true : null })));
    sel.onchange = () => { clientId = Number(sel.value); load(); };
    const slide = OB_SLIDES[step];
    const prog = h("div", { class: "ob-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": OB_SLIDES.length - 1, "aria-valuenow": step }, OB_SLIDES.slice(0, -1).map((s, i) => h("i", { class: i < step || ob?.completed ? "done" : "" })));
    const shell = h("div", { class: "ob-shell" },
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Client onboarding" }), h("p", { text: ob ? `Saved · ${ob.sectionsDone}/${ob.sectionsTotal} sections filled${ob.completed ? " · completed" : ""}` : "Not started yet — every field saves as you go." })), h("div", { class: "actions" }, sel, ob && ob.sectionsDone ? h("button", { class: "btn", type: "button", text: "Review setup", onclick: () => { step = OB_SLIDES.findIndex((s) => s.id === "review"); draw(); } }) : null)),
      prog);
    const card = h("section", { class: "card ob-slide" }, h("h3", { text: slide.title }), slide.body ? h("p", { text: slide.body }) : null);
    if (slide.id === "welcome") {
      card.append(h("p", { class: "small" }, "Client: ", h("b", { text: client.name })), h("p", { class: "muted small", text: "You can leave and come back at any point; every section keeps its saved values." }),
        h("div", { class: "ob-nav" }, h("span"), h("button", { class: "btn primary", type: "button", text: "Start setup", onclick: () => { step = 1; draw(); } })));
    } else if (slide.id === "interview") {
      /* The AI interview: 8 fixed questions, one at a time. The server keeps the state; after the last
         answer it returns the company brain + a draft ICP, which the operator edits and approves here. */
      const ivData = (ob?.data?.interview) || { step: 0, answers: {}, asked: {}, draft: null };
      const ivDone = ivData.draft && ivData.step >= 8;
      const wrap = h("div", { class: "stack" });
      const transcript = h("div", { class: "stack rev" });
      const qSlot = h("div", { class: "stack" });
      const ICP_ROWS = [["industries", "Target industries (one per line)"], ["businessTypes", "Business types (one per line)"], ["size", "Ideal size"], ["geography", "Geography"], ["decisionMakers", "Decision-makers"], ["needs", "Needs (one per line)"], ["painPoints", "Pain points (one per line)"], ["positiveSignals", "Positive signals (one per line)"], ["excludedIndustries", "Excluded industries (one per line)"], ["excludedTypes", "Excluded types (one per line)"]];
      function renderQuestion(q, index) {
        const ta = h("textarea", { id: "ivAnswer", rows: 3, "aria-label": "Your answer", placeholder: "Answer in your own words. One or two sentences is plenty." });
        const next = h("button", { class: "btn primary", type: "button", text: index >= 8 ? "Finish: build the brain" : "Next question" });
        next.onclick = guardBtn(async () => {
          const answer = ta.value.trim();
          if (!answer) { toast("Type an answer first.", "err"); return; }
          next.disabled = true;
          const r = await api("POST", "/api/ai/interview", { clientId, answer });
          transcript.append(h("div", { class: "rev-row" }, h("span", { text: "Q" + index }), h("span", { text: answer })));
          if (r.done) { toast("Interview complete. Review the draft brain below.", "good"); await load(); return; }
          renderQuestion(r.question, r.index);
        });
        qSlot.replaceChildren(h("p", { class: "muted small", text: `Question ${index} of 8` }), h("p", { text: q }), ta, h("div", { class: "row" }, next));
        ta.focus();
      }
      if (ivDone) {
        const d = ivData.draft;
        const summary = h("textarea", { id: "ivSummary", rows: 4 }); summary.value = d.summary || "";
        const brainList = h("div", { class: "rev" }, Object.entries(d.brain || {}).filter(([, v]) => String(v).trim()).map(([k, v]) => h("div", { class: "rev-row" }, h("span", { text: k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) }), h("span", { text: String(v).slice(0, 220) }))));
        const icpBox = h("div", { class: "stack" }); const icpInputs = {};
        for (const [k, label] of ICP_ROWS) { const ta = h("textarea", { id: "ivIcp" + k, rows: 2 }); ta.value = (d.icp || {})[k] || ""; icpInputs[k] = ta; icpBox.append(field("ivIcp" + k, label, ta)); }
        const use = h("button", { class: "btn primary", type: "button", text: "Approve and use for this campaign" });
        use.onclick = guardBtn(async () => {
          const icp = {}; for (const k in icpInputs) icp[k] = icpInputs[k].value.trim();
          await api("POST", "/api/ai/brain", { clientId, brain: d.brain || {}, icp, apply: true });
          toast("Company brain approved. The campaign's offer, target and tone are synced.", "good");
          await load(); step = OB_SLIDES.findIndex((s) => s.id === "review"); draw();
        });
        wrap.append(h("p", { class: "small", text: "The AI turned your answers into this company brain. It feeds every conversation this campaign has. Edit the ICP below, then approve: the brain also fills the campaign's offer, target and tone." }),
          h("h4", { text: "The briefing" }), summary, h("h4", { text: "Company brain" }), brainList, h("h4", { text: "Draft ICP (edit anything)" }), icpBox,
          h("div", { class: "row" }, use));
      } else {
        const answered = Math.min(ivData.step || 0, 8);
        const start = h("button", { class: "btn primary", type: "button", text: answered ? `Continue the interview (${answered} of 8 answered)` : "Start the interview" });
        start.onclick = guardBtn(async () => {
          start.disabled = true;
          const r = await api("POST", "/api/ai/interview", { clientId });
          renderQuestion(r.question, r.index);
        });
        /* rebuild what was already answered from the saved state */
        for (let i = 0; i < answered; i++) { const a = ivData.answers && ivData.answers[Object.keys(ivData.answers)[i]]; if (a) transcript.append(h("div", { class: "rev-row" }, h("span", { text: "Q" + (i + 1) }), h("span", { text: String(a).slice(0, 120) }))); }
        qSlot.append(h("p", { class: "small", text: answered ? "Pick up where you left off." : "8 questions, one at a time. The AI turns the answers into the company brain and drafts your ICP for approval." }), start);
      }
      wrap.append(transcript, qSlot);
      card.append(wrap, h("div", { class: "ob-nav" }, backBtn(), h("button", { class: "btn", type: "button", text: "Skip: fill the forms instead", onclick: () => { step = OB_SLIDES.findIndex((s) => s.id === "business"); draw(); } })));
    } else if (slide.id === "review") {
      const rev = h("div", { class: "ob-review" });
      for (const s of OB_SLIDES.filter((x) => x.key)) {
        const data = sectionOf(s.key), filled = Object.entries(data).filter(([, v]) => String(v || "").trim());
        rev.append(h("h4", { text: OB_SLIDES.find((x) => x.key === s.key).title }), filled.length ? filled.map(([k, v]) => h("div", { class: "rev-row" }, h("span", { text: k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) }), h("span", { text: String(v).slice(0, 120) }))) : h("div", { class: "rev-row muted" }, h("span", { text: "Not filled in" }), h("span")));
      }
      card.append(rev, h("div", { class: "ob-nav" }, backBtn(), h("div", { class: "row" }, h("button", { class: "btn", type: "button", text: "Save & finish later", onclick: () => { saveStep(0); } }), h("button", { class: "btn primary", type: "button", text: "Complete setup", onclick: guardBtn(async () => { await api("POST", "/api/onboarding/complete", { clientId }); toast("Setup completed. The campaign now has its full context.", "good"); await load(); }) }))));
    } else if (slide.id === "done") {
      card.append(h("p", { class: "small", text: "Everything below is now part of how this client's leads are scored, conversations are written and appointments are tracked:" }),
        h("ul", { style: "padding-left:1.2rem" }, ["Business profile completed", "Target audience defined", "Offer configured", "Qualification preferences saved", "Goals defined", "Campaign context prepared"].map((x) => h("li", { class: "small", text: x }))),
        h("p", { class: "muted small", text: "Nothing is pretending campaigns are running: import leads, approve them in Review, and the operation starts from there." }),
        h("div", { class: "ob-nav" }, backBtn(), h("a", { class: "btn primary", href: "#/import", text: "Import the first leads" })));
    } else {
      const key = slide.key, data = { ...sectionOf(key) };
      const inputs = {};
      for (const [fld, label, type] of OB_FIELDS[key]) {
        const id = "ob_" + key + "_" + fld;
        let el;
        if (type === "textarea") { el = h("textarea", { id, rows: 2 }); el.value = data[fld] || ""; }
        else { el = h("input", { id, type: type === "number" ? "number" : type === "url" ? "url" : "text" }); el.value = data[fld] ?? ""; }
        inputs[fld] = el;
        card.append(field(id, label, el));
      }
      card.append(h("div", { class: "ob-nav" }, backBtn(), h("div", { class: "row" }, h("button", { class: "btn", type: "button", text: "Save & finish later", onclick: () => { saveStep(0); } }), h("button", { class: "btn primary", type: "button", text: "Save & continue", onclick: guardBtn(async () => { const body = { clientId, step: step + 1, [key]: {} }; for (const [f2] of OB_FIELDS[key]) body[key][f2] = inputs[f2].value.trim(); await api("PUT", "/api/onboarding", body); step = Math.min(step + 1, OB_SLIDES.length - 1); await load(); }) }))));
    }
    function backBtn() { return h("button", { class: "btn", type: "button", text: "Back", onclick: () => { step = Math.max(0, step - 1); draw(); } }); }
    function guardBtn(fn) { const b = h("button"); return async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, "err"); } finally { b.disabled = false; } }; }
    async function saveStep(next) { const body = { clientId, step: next }; await api("PUT", "/api/onboarding", body).catch(() => {}); toast("Saved.", "good"); location.hash = "#/overview"; }
    shell.append(card); box.replaceChildren(shell);
  };
  await load();
  return { refresh: load };
}
VIEWS.onboarding = viewOnboarding;

/* ---------------------------------------------------------------- Business profile */
async function viewProfile(rootEl) {
  const box = h("div"); rootEl.append(box);
  if (!S.clients.length) return box.append(empty("Create a campaign first", "The business profile belongs to a campaign (client).", h("a", { class: "btn primary", href: "#/campaigns", text: "Create a campaign" })));
  const clientId = S.clientId ? Number(S.clientId) : S.clients[0].id;
  const [ob, client] = await Promise.all([api("GET", "/api/onboarding?clientId=" + clientId), api("GET", "/api/clients")]);
  const c = client.clients.find((x) => x.id === clientId) || client.clients[0];
  const data = ob.onboarding?.data || {};
  const section = (title, rows) => rows.length ? h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: title })), h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("td", { class: "muted", style: "width:220px", text: k }), h("td", { text: String(v || "—") }))))))) : null;
  const rowsOf = (key) => Object.entries(data[key] || {}).filter(([, v]) => String(v || "").trim()).map(([k, v]) => [k.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase()), String(v).slice(0, 300)]);
  box.replaceChildren(
    h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Business profile" }), h("p", { text: `Everything onboarding captured for ${c.name}, viewable and editable at any time. Nothing here disappears into a black box.` })),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", text: ob.onboarding ? "Edit in onboarding" : "Run onboarding", onclick: () => { location.hash = "#/onboarding"; } }))),
    h("div", { class: "grid kpis" }, kpi("Onboarding", ob.onboarding ? (ob.onboarding.completed ? "Completed" : ob.onboarding.sectionsDone + "/" + ob.onboarding.sectionsTotal + " sections") : "Not started", ob.onboarding ? "updated " + ago(ob.onboarding.updatedAt) : "run the wizard", { icon: "book" }),
      kpi("Monthly investment", money(c.monthlyCost), "used for ROI", { icon: "coin" }), kpi("Booking link", c.bookingLink ? "Set" : "Missing", c.bookingLink || "add one in campaign settings", { icon: "cal" })),
    section("Business", rowsOf("business")), section("Offer", rowsOf("offer")), section("Company brain", rowsOf("brain")), section("Ideal customer", rowsOf("icp")), section("Qualification criteria", rowsOf("qualification")),
    section("Goals", rowsOf("goals")), section("Outreach preferences", rowsOf("outreach")), section("Conversation guidelines", rowsOf("conversation")),
    section("Appointment process", rowsOf("appointments")), section("Campaign preferences", rowsOf("campaign")), section("Knowledge", rowsOf("knowledge")));
  return {};
}
VIEWS.profile = viewProfile;

/* ---------------------------------------------------------------- Sender accounts */
async function viewAccounts(rootEl) {
  const box = h("div"), addBox = h("div"), codeBox = h("div"); rootEl.append(h("div", { class: "stack" }, codeBox, box, addBox)); let accs = [];
  const showCode = (title, code) => { const cp = h("button", { class: "btn primary", type: "button" }, ico("copy"), "Copy pairing code"); cp.onclick = () => copyText(code, "Pairing code copied"); codeBox.replaceChildren(h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: title }), h("button", { class: "btn sm ghost", type: "button", text: "Dismiss", onclick: () => codeBox.replaceChildren() })),
    h("ol", { class: "small" }, h("li", { text: "Install the Maison Setter extension in the Chrome profile that is logged in to this Instagram account." }), h("li", { text: "Click the extension, open Settings, and paste this code. Chrome will ask permission to talk to this server: choose Allow." }), h("li", { text: "The dot on this page turns green within a few seconds, and stays live." })), h("pre", { class: "code", tabindex: "0", text: code }), h("div", { class: "row" }, cp), h("p", { class: "hint", text: "The code contains this account's secret token. Anyone with it can act as the account, so don't share it. Making a new code locks out the old one." }))); codeBox.scrollIntoView?.({ block: "nearest" }); };
  const draw = () => box.replaceChildren(accs.length ? h("div", { class: "grid cards" }, accs.map(acctCard)) : empty("No sender accounts yet", "Add the Instagram account that will send your messages. Use the form below."));
  function acctCard(a) {
    const cap = a.capToday || 0, q2 = a.badge === "quarantined", warn = a.loggedInAs && a.loggedInAs.toLowerCase() !== a.igUsername.toLowerCase();
    const act = (label, action, cls, icon, confirmText) => { const b = h("button", { class: "btn sm " + (cls || ""), type: "button" }, icon ? ico(icon) : null, label); b.onclick = guard(b, async () => { if (confirmText && !confirm(confirmText)) return; await api("PATCH", `/api/accounts/${a.id}`, { action }); toast(`${a.label}: done.`, "good"); await load(); }); return b; };
    const rel = q2 ? (() => { const b = h("button", { class: "btn sm good", type: "button", text: "Release now" }); b.onclick = guard(b, async () => { await api("POST", `/api/accounts/${a.id}/release`, {}); toast(`${a.label} released.`, "good"); await load(); }); return b; })() : null;
    const rot = h("button", { class: "btn sm", type: "button", text: "New pairing code" }); rot.onclick = guard(rot, async () => { if (!confirm("This locks out the extension that is paired now. Make a new code?")) return; const r = await api("POST", `/api/accounts/${a.id}/rotate`, {}); showCode(`New pairing code for ${a.label}`, r.pairingCode); });
    const w = a.warm;
    return h("article", { class: "card acct", "aria-labelledby": "an" + a.id },
      h("div", { class: "row" }, h("span", { class: "avatar", "aria-hidden": "true", text: initial(a.igUsername) }), h("div", { class: "grow" }, h("b", { id: "an" + a.id, text: a.label }), h("div", { class: "muted small", text: "@" + a.igUsername + (a.clientName ? " · " + a.clientName : "") })), stateBadge(a)),
      q2 ? h("div", { class: "banner bad", role: "alert" }, a.reason, a.quarantinedUntil ? ` Back at ${stamp(a.quarantinedUntil)}${a.needsReset ? " at the earliest" : ""}.` : "") : (a.reason ? h("div", { class: "banner warn", text: a.reason }) : null),
      h("div", null, h("div", { class: "row between small" }, h("b", { class: "num", text: `${a.sentToday} / ${cap}` }), h("span", { class: "muted", text: "sent today" })), meter(a.sentToday, Math.max(cap, 1), q2 ? "bad" : "")),
      h("dl", { class: "facts" }, h("dt", { text: "Browser" }), h("dd", null, h("span", { class: "online" + (a.online ? " on" : "") }, h("i"), a.online ? "Connected live" : a.lastSeenAt ? "Last seen " + ago(a.lastSeenAt) : "Never connected")),
        h("dt", { text: "Warm-up" }), h("dd", { text: w.stage === "active" ? "Finished" : `Day ${w.day} of ${w.totalDays}` }), h("dt", { text: "Health" }), h("dd", null, badge(`${a.health.score} · ${a.health.level}`, a.health.level === "healthy" ? "good" : a.health.level === "caution" ? "warn" : "bad")),
        h("dt", { text: "Queued first messages" }), h("dd", { class: "num", text: String(a.queued) }), h("dt", { text: "Logged in as" }), h("dd", null, a.loggedInAs ? (warn ? badge("@" + a.loggedInAs + " (wrong account)", "bad") : "@" + a.loggedInAs) : "-"), h("dt", { text: "Driven by" }), h("dd", { text: a.driver === "runner" ? `Runner (Dolphin ${a.dolphinProfileId || "?"})` : "Chrome extension" }), a.driver === "runner" ? [h("dt", { text: "Proxy address" }), h("dd", { class: "num", text: a.proxyIp || "-" })] : null, h("dt", { text: a.driver === "runner" ? "Runner version" : "Extension" }), h("dd", { text: a.lastVersion || "-" })),
      meter(a.health.score, 100, a.health.level === "healthy" ? "good" : a.health.level === "caution" ? "warn" : "bad"),
      h("div", { class: "row" }, rel, a.state === "paused" ? act("Resume", "resume", "good", "play") : a.state === "active" ? act("Pause", "pause", "", "pause") : null, !q2 && a.state !== "killed" ? act("Quarantine now", "quarantine", "danger", "alert", `Quarantine ${a.label} for 48 hours? Its unsent first messages move to your other senders.`) : null, rot, a.state !== "killed" ? act("Switch off", "kill", "ghost", null, `Switch off ${a.label} for good? Its queue moves to other senders.`) : null));
  }
  const load = async () => { accs = (await api("GET", "/api/accounts")).accounts; draw(); };
  const camp = h("select", { id: "naC" }, campaignOptions(S.clientId, false)), lab = h("input", { id: "naL", maxlength: 80, placeholder: "Acme sender 1" }), usr = h("input", { id: "naU", maxlength: 31, placeholder: "instagram_username", autocapitalize: "none", spellcheck: "false" }), age = h("select", { id: "naA" }, [["new", "New (under 3 months)"], ["young", "A few months old"], ["established", "Established (a year or more)"]].map(([v, t], i) => h("option", { value: v, text: t, selected: i === 1 ? true : null }))), add = h("button", { class: "btn primary", type: "submit" }, ico("plus"), "Add sender account"), msg = h("p", { class: "msg", role: "alert" });
  const form = h("form", { class: "card", novalidate: true }, h("div", { class: "card-head" }, h("h2", { text: "Add a sender account" })), h("p", { class: "muted small", text: "Each account sends from its own browser. New accounts warm up for days before sending anything." }),
    h("div", { class: "field-row" }, field("naL", "Label", lab), field("naU", "Instagram username", usr), field("naC", "Campaign", camp), field("naA", "How old is the account?", age)), h("div", { class: "row" }, add), msg);
  form.addEventListener("submit", guard(add, async () => { msg.textContent = ""; if (!S.clients.length) { msg.className = "msg err"; msg.textContent = "Create a campaign first."; return; }
    try { const r = await api("POST", "/api/accounts", { label: lab.value, igUsername: usr.value, clientId: Number(camp.value), igAge: age.value }); lab.value = ""; usr.value = ""; toast("Account added.", "good"); showCode(`Pairing code for ${r.account.label}`, r.pairingCode); await load(); } catch (e) { msg.className = "msg err"; msg.textContent = e.message; } }));
  addBox.append(form); await load(); const reload = debounced(() => { if (!rootEl.contains(document.activeElement) || !["INPUT", "SELECT"].includes(document.activeElement.tagName)) load().catch(() => {}); }, 500);
  return { onEvent(e) { if (e.t === "account" || e.t === "task") reload(); }, refresh: load };
}
VIEWS.accounts = viewAccounts;

/* ---------------------------------------------------------------- Runner */
async function viewRunner(rootEl) {
  const box = h("div", { class: "stack" }); rootEl.append(box); let d, shown = false;
  const draw = () => {
    const keyShown = shown ? d.token : "•".repeat(30), cfgText = `{\n  "server": "${d.serverUrl}",\n  "runnerToken": "${shown ? d.token : "YOUR_RUNNER_TOKEN"}",\n  "dolphin": { "localApi": "http://localhost:3001", "token": "YOUR_DOLPHIN_TOKEN" }\n}`;
    const reveal = h("button", { class: "btn sm", type: "button", text: shown ? "Hide token" : "Show token", onclick: () => { shown = !shown; draw(); } }), cp = h("button", { class: "btn sm", type: "button" }, ico("copy"), "Copy config");
    cp.onclick = () => copyText(cfgText.replace("YOUR_RUNNER_TOKEN", d.token), "Config copied with your runner token. Add your Dolphin token."); const rg = h("button", { class: "btn sm danger", type: "button", text: "Make a new token" });
    rg.onclick = guard(rg, async () => { if (!confirm("The runner on your VPS stops working until you put the new token in its config. Continue?")) return; d = await api("POST", "/api/runner/token", {}); shown = true; draw(); toast("New runner token made.", "good"); });
    const fc = h("input", { id: "fcap", type: "number", min: 0, max: 8, value: d.followCap, style: "max-width:6rem" }), fs = h("button", { class: "btn sm", type: "button", text: "Save" }); fs.onclick = guard(fs, async () => { await api("PUT", "/api/settings", { followCap: Number(fc.value) }); toast("Saved.", "good"); });
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Runner (VPS)" }), h("p", { text: "The Windows program that drives accounts through Dolphin Anty. The extension and the runner share the same queue, pacing and safety rules." }))),
      h("div", { class: "grid two" },
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Runner status" }), badge(d.online ? "Online" : d.seenAt ? "Offline" : "Never connected", d.online ? "good" : "warn", true)),
          h("p", { class: "small muted", text: d.seenAt ? `Last heard from ${ago(d.seenAt)}.` : "Install the runner on your Windows VPS and start it. This turns green within seconds." }),
          h("label", { text: "Runner token" }), h("pre", { class: "code", tabindex: "0", text: keyShown }), h("div", { class: "row" }, reveal, cp, rg)),
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Set it up" })),
          h("ol", { class: "small" }, h("li", { text: "On your Windows VPS, install Node.js and Dolphin Anty, and log in to Dolphin." }), h("li", { text: "In Dolphin, make one profile per account, each with its own sticky proxy, and log in to Instagram by hand in each." }), h("li", { text: "Unzip the runner, copy the config on the left into config.json, add your Dolphin API token, run npm install, then npm start." }), h("li", { text: "Below, switch each account to the runner and enter its Dolphin profile ID." })),
          h("details", null, h("summary", { text: "config.json" }), h("pre", { class: "code", tabindex: "0", text: cfgText })))),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Which program drives each account" })),
        d.all.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Account", "Driven by", "Dolphin profile ID", "Proxy address", "State", ""].map((t) => h("th", { text: t })))), h("tbody", null, d.all.map(accountRow)))) : empty("No sender accounts", "Add one first.", h("a", { class: "btn primary", href: "#/accounts", text: "Sender accounts" }))),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Follows" })), h("p", { class: "small muted", text: "Warm-up sessions follow a few accounts from each campaign's follow list, never the same one twice, and never above this daily cap per account. New accounts follow fewer." }),
        h("div", { class: "row" }, h("label", { for: "fcap", text: "Most follows per account per day" }), fc, fs)));
  };
  function accountRow(a) {
    const drv = h("select", { "aria-label": `Driver for ${a.label}` }, [["extension", "Chrome extension"], ["runner", "Runner + Dolphin"]].map(([v, t]) => h("option", { value: v, text: t, selected: a.driver === v ? true : null })));
    const pid = h("input", { type: "text", "aria-label": `Dolphin profile ID for ${a.label}`, placeholder: "e.g. 123456789", maxlength: 60 }); pid.value = a.dolphinProfileId;
    const save = h("button", { class: "btn sm", type: "button", text: "Save" }); save.onclick = guard(save, async () => { await api("PATCH", `/api/accounts/${a.id}`, { driver: drv.value, dolphinProfileId: pid.value }); toast(`${a.label}: saved.`, "good"); await load(); });
    return h("tr", null, h("td", null, h("b", { text: a.label }), h("div", { class: "muted small", text: "@" + a.igUsername })), h("td", null, drv), h("td", null, pid), h("td", { class: "num", text: a.proxyIp || "-" }), h("td", null, stateBadge(a)), h("td", null, save));
  }
  const load = async () => { const [r, a] = await Promise.all([api("GET", "/api/runner"), api("GET", "/api/accounts")]); d = { ...r, all: a.accounts }; draw(); };
  await load(); const reload = debounced(() => { if (!rootEl.contains(document.activeElement) || !["INPUT", "SELECT"].includes(document.activeElement.tagName)) load().catch(() => {}); }, 800);
  return { onEvent(e) { if (["runner", "account"].includes(e.t)) reload(); }, refresh: load };
}
VIEWS.runner = viewRunner;

/* ---------------------------------------------------------------- AI supervisor */
const MODES2 = MODES;
const verdictBadge = (v) => v === "allow" ? badge("Allowed", "good") : v === "edit" ? badge("Edited", "info") : v === "hold" ? badge("Held", "warn") : badge("Blocked", "bad");
async function viewSupervisor(rootEl) {
  const box = h("div", { class: "stack" }); rootEl.append(box); let d, tab = "issues";
  const draw = () => {
    const st = d.stats, held = d.items.filter((x) => x.status === "held");
    const rows = d.items.filter((x) => (tab === "issues" ? ["block", "hold", "edit"].includes(x.verdict) : true));
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null, h("h2", { text: "AI supervisor" }), h("p", { text: "Reads every conversation and asks one thing: is sending this a good idea? Price talk, bot questions and objection handling pass straight through; only genuinely risky stuff waits for you." }))),
      !d.haiku ? h("div", { class: "banner warn" }, ico("alert"), h("span", { class: "grow", text: "The AI is not connected, so it cannot review messages. Every outgoing message waits for you." }), h("a", { href: "#/settings", text: "Settings" })) : null,
      h("div", { class: "grid kpis" }, kpi("Commands checked", st.checked, "in the last 7 days", { icon: "bot" }), kpi("Waiting for you", st.waiting, st.waiting ? "Review them below" : "Nothing held", { cls: st.waiting ? "accent" : "", icon: "pause" }),
        kpi("Edited by the AI", st.edited, "wording fixed before sending", { icon: "refresh" }), kpi("Blocked", st.blocked, `${st.vision} screenshot checks`, { icon: "shield", cls: st.blocked ? "bad" : "" })),
      held.length ? h("section", { class: "stack" }, held.map(heldCard)) : null,
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "How much the AI decides, per campaign" })),
        S.clients.length ? h("div", { class: "stack" }, S.clients.map(modePicker)) : h("p", { class: "muted", text: "Create a campaign first." })),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "What the supervisor did" }),
        h("div", { class: "tabs", style: "border:0", role: "tablist" }, [["issues", "Edited, held, blocked"], ["all", "Everything"]].map(([k, l]) => h("button", { role: "tab", type: "button", "aria-selected": String(tab === k), onclick: () => { tab = k; draw(); } }, l)))),
        rows.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["When", "Account", "Lead", "Command", "Result", "Risk", "By", "Why"].map((t) => h("th", { text: t })))),
          h("tbody", null, rows.map((x) => h("tr", null, h("td", { class: "nowrap muted", text: stamp(x.at) }), h("td", { text: x.account || "-" }), h("td", { text: x.username ? "@" + x.username : "-" }), h("td", { text: x.kind === "dm" ? "first message" : x.kind }),
            h("td", null, verdictBadge(x.verdict), x.status === "approved" ? " " : null, x.status === "approved" ? badge("You approved", "good") : x.status === "denied" ? badge("You denied", "bad") : null), h("td", { class: "num", text: x.risk != null ? String(x.risk) : "-" }),
            h("td", { text: x.by === "ai" ? "AI" : x.by === "human" ? "You" : "Rules" }), h("td", null, x.reason, x.verdict === "edit" && x.before !== x.after ? h("details", null, h("summary", { text: "See the change" }), h("blockquote", { class: "muted small", text: "Before: " + x.before }), h("blockquote", { class: "small", text: "After: " + x.after })) : null)))))) : empty("Nothing to show yet", "Every message the runner is about to send is checked here first.")));
  };
  function heldCard(x) {
    const ta = h("textarea", { id: "hc" + x.id, rows: 3, maxlength: 500, "aria-label": `Message to @${x.username}` }); ta.value = x.after || x.before;
    const ok = h("button", { class: "btn good", type: "button" }, ico("check"), "Approve and send"), no = h("button", { class: "btn danger", type: "button" }, ico("x"), "Don't send");
    ok.onclick = guard(ok, async () => { await api("POST", `/api/supervisor/${x.id}/approve`, { text: ta.value }); toast("Approved. It goes out next.", "good"); await load(); refreshCounts(); });
    no.onclick = guard(no, async () => { await api("POST", `/api/supervisor/${x.id}/deny`, {}); toast("Not sent."); await load(); refreshCounts(); });
    return h("article", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "@" + (x.username || "?")), badge(x.kind === "dm" ? "first message" : x.kind, "info"), x.risk != null ? badge("risk " + x.risk, x.risk >= 60 ? "warn" : "") : null, h("span", { class: "muted small", text: x.account || "" })),
      h("p", { class: "small", text: x.reason }), h("label", { for: "hc" + x.id, text: "Message (you can edit it)" }), ta, h("div", { class: "row" }, ok, no, x.leadId ? h("button", { class: "btn sm ghost", type: "button", onclick: () => MS.openLead(x.leadId), text: "See the conversation" }) : null));
  }
  function modePicker(c) {
    const name = "mode" + c.id, el = h("div", { class: "seg modes", role: "radiogroup", "aria-label": `AI autonomy for ${c.name}` });
    for (const [k, label, sub] of MODES2) { const r = h("input", { type: "radio", name, id: `${name}${k}`, value: k, checked: c.supervision === k }); r.addEventListener("change", async () => { try { await api("PATCH", `/api/clients/${c.id}`, { supervision: k }); c.supervision = k; toast(`${c.name}: ${label}.`, "good"); } catch (e) { toast(e.message, "err"); } }); el.append(h("label", { for: r.id }, r, label, h("small", { text: sub }))); }
    return h("div", null, h("b", { text: c.name }), el);
  }
  const load = async () => { d = await api("GET", "/api/supervisor?limit=120"); draw(); S.counts.held = d.stats.waiting; MS.drawNav(); };
  await load(); const reload = debounced(() => { if (!(document.activeElement && document.activeElement.tagName === "TEXTAREA")) load().catch(() => {}); }, 800);
  return { onEvent(e) { if (["supervisor", "task", "lead"].includes(e.t)) reload(); }, refresh: load };
}
VIEWS.supervisor = viewSupervisor;

/* ---------------------------------------------------------------- Settings */
async function viewSettings(rootEl) {
  const s = await api("GET", "/api/settings"); let keyShown = false;
  const skip = h("textarea", { id: "sSkip", rows: 4, spellcheck: "false" }); skip.value = s.skipList.join("\n");
  const w = s.defaultWindow, st = h("input", { id: "sSt", type: "number", min: 0, max: 23 }), en = h("input", { id: "sEn", type: "number", min: 1, max: 24 }), tz = h("input", { id: "sTz" }); st.value = w.start; en.value = w.end; tz.value = w.tz;
  const sel = h("textarea", { id: "sSel", rows: 6, spellcheck: "false" }); sel.value = JSON.stringify(s.selectors || {}, null, 2); const blk = h("textarea", { id: "sBlk", rows: 4 }); blk.value = (s.blockPhrases || []).join("\n");
  const excl = sw("sEx", "One business, one campaign", "A username claimed by one campaign can't be messaged by another.", s.exclusiveClaims), msg = h("p", { class: "msg", role: "alert" }), save = h("button", { class: "btn primary", type: "button", text: "Save settings" });
  save.onclick = guard(save, async () => { msg.textContent = ""; let selectors; try { selectors = JSON.parse(sel.value || "{}"); } catch { msg.className = "msg err"; msg.textContent = "The selectors box is not valid JSON."; return; }
    try { await api("PUT", "/api/settings", { skipList: skip.value, exclusiveClaims: $("#sEx").checked, defaultWindow: { start: Number(st.value), end: Number(en.value), tz: tz.value.trim() || undefined }, selectors, blockPhrases: blk.value.split("\n").map((x) => x.trim()).filter(Boolean) }); msg.className = "msg good"; msg.textContent = "Saved. Your senders pick it up now."; toast("Settings saved.", "good"); } catch (e) { msg.className = "msg err"; msg.textContent = e.message; } });
  const keyBox = h("div"), drawKey = () => { const reveal = h("button", { class: "btn sm", type: "button", text: keyShown ? "Hide" : "Show", onclick: () => { keyShown = !keyShown; drawKey(); } }), cp = h("button", { class: "btn sm", type: "button" }, ico("copy"), "Copy"), rg = h("button", { class: "btn sm danger", type: "button", text: "Make a new key" }); cp.onclick = () => copyText(s.importKey, "Import key copied");
    rg.onclick = guard(rg, async () => { if (!confirm("The old key stops working everywhere it is used. Continue?")) return; s.importKey = (await api("POST", "/api/settings/import-key", {})).importKey; keyShown = true; drawKey(); toast("New import key made.", "good"); });
    keyBox.replaceChildren(h("pre", { class: "code", tabindex: "0", text: keyShown ? s.importKey : "•".repeat(28) }), h("div", { class: "row" }, reveal, cp, rg)); }; drawKey();
  const hk = s.haiku;
  /* AI model picker: Claude Haiku or Gemini Flash Lite, with a live test for each. */
  const aiSel = h("select", { id: "sAiProvider" },
    h("option", { value: "", text: "Automatic (Haiku if its key exists, else Gemini)", selected: s.ai.chosen === "" ? true : null }),
    h("option", { value: "haiku", text: `Claude Haiku (${s.ai.status.haiku.model})`, selected: s.ai.chosen === "haiku" ? true : null }),
    h("option", { value: "gemini", text: `Gemini Flash Lite (${s.ai.status.gemini.model})`, selected: s.ai.chosen === "gemini" ? true : null }));
  const gemKey = h("input", { id: "sGemKey", type: "password", placeholder: s.ai.status.gemini.keyFromDashboard ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved in the dashboard)" : "AIza… (or set GEMINI_API_KEY on the server)" });
  const aiMsg = h("p", { class: "msg small", role: "status" });
  const aiSave = h("button", { class: "btn", type: "button", text: "Save AI choice" }, );
  aiSave.onclick = guard(aiSave, async () => { await api("PUT", "/api/settings", { aiProvider: aiSel.value, ...(gemKey.value ? { geminiKey: gemKey.value.trim() } : {}) });
    aiMsg.className = "msg good"; aiMsg.textContent = "Saved. Every new review and draft now uses this model."; toast("AI model saved.", "good"); });
  const testResult = (r) => { aiMsg.className = r.ok ? "msg good" : "msg err"; aiMsg.textContent = r.ok ? `${r.model} answered in ${r.ms} ms — connected.` : `${r.model} failed: ${r.error || "no reply"}`; };
  const testHaiku = h("button", { class: "btn sm", type: "button", text: "Test Haiku" });
  const testGem = h("button", { class: "btn sm", type: "button", text: "Test Gemini" });
  testHaiku.onclick = guard(testHaiku, async () => testResult(await api("POST", "/api/settings/ai/test", { provider: "haiku" })));
  testGem.onclick = guard(testGem, async () => testResult(await api("POST", "/api/settings/ai/test", { provider: "gemini" })));
  rootEl.append(
    h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Settings" }), h("p", { text: "Workspace-wide safety and integration settings." }))),
    h("div", { class: "grid two" },
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Import key" })), h("p", { class: "muted small", text: "Lets Make, Zapier, n8n or Apify push leads to /hooks/import without signing in. Treat it like a password." }), keyBox),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "AI model" }), badge(hk.configured ? "Connected" : "Not connected", hk.configured ? "good" : "warn", true)),
        h("dl", { class: "facts" }, h("dt", { text: "In use right now" }), h("dd", { text: `${hk.provider} · ${hk.model}` }), h("dt", { text: "Used today" }), h("dd", { class: "num", text: `${fmt(hk.usedToday)} of ${fmt(hk.dailyCap)} tokens` })),
        field("sAiProvider", "Which model reviews messages and writes drafts?", aiSel),
        field("sGemKey", "Gemini API key", gemKey, "Only needed to use Gemini. Leave empty to keep what is already saved. ANTHROPIC_API_KEY stays a server environment variable."),
        h("div", { class: "row" }, aiSave, testHaiku, testGem), aiMsg,
        h("p", { class: "hint", text: "If a model is unreachable, messages wait for you instead of going out unchecked — a dead key can slow things down but never makes it unsafe." }))),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Safety and sending" })), excl,
      field("sSkip", "Never contact these usernames (one per line)", skip), h("h3", { text: "Default sending hours" }), h("div", { class: "field-row" }, field("sSt", "Starts (hour)", st), field("sEn", "Ends (hour)", en), field("sTz", "Time zone", tz)),
      h("details", null, h("summary", { text: "Advanced: Instagram page selectors and warning phrases" }), field("sSel", "Selectors (JSON). Only change these if Instagram changed its layout.", sel), field("sBlk", "Warning phrases that quarantine an account (one per line)", blk, "Empty uses the built-in list.")), h("div", { class: "row" }, save), msg));
  return {};
}
VIEWS.settings = viewSettings;

/* ---------------------------------------------------------------- Warm-up programs */
async function viewWarmup(rootEl) {
  const box = h("div"); rootEl.append(box); let d;
  const STATUS_LABEL = { done: "clean day, counted", held: "Instagram warning — the day repeats", missed: "browser never ran — day not counted", today: "today, in progress", future: "planned" };
  const wuCell = (st, label, at) => h("div", { class: "wu-cell " + st, title: (at ? day(at) + " · " : "") + (STATUS_LABEL[st] || st) }, h("span", { class: "num", text: label || "" }));
  const draw = () => {
    box.replaceChildren(
      h("div", { class: "page-head" }, h("div", null,
        h("h2", { text: "Warm-up programs" }),
        h("p", { text: "Every sender walks a fixed program: browse first, then touches, then a few DMs a day. A day only counts when the browser ran and Instagram stayed quiet. A warning holds the day; a closed laptop pauses the program." })),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: load, text: "Refresh" }))),
      d.accounts.length ? null : empty("No sender accounts yet", "Add one under Sender accounts and pair the extension."));
    for (const a of d.accounts) {
      const p = a.program; if (!p) continue;
      const cells = p.history.map((r) => wuCell(r.status, r.status === "held" ? "!" : r.status === "missed" ? "·" : r.status === "today" ? "" : String(r.day), r.at));
      if (!p.active) cells.push(wuCell("today", "", null));
      for (let i = 0; i < Math.max(0, p.total - p.done - (p.active ? 0 : 1)); i++) cells.push(wuCell("future", "", null));
      const healthBadge = badge(a.health === "healthy" ? "Healthy" : a.health === "caution" ? "Caution" : "Risky", a.health === "healthy" ? "good" : a.health === "caution" ? "warn" : "bad", true);
      box.append(h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", null, h("b", { text: a.label }), h("span", { class: "muted small", text: " @" + a.igUsername })),
          badge(p.active ? "Finished" : `Day ${p.day} of ${p.total}`, p.active ? "good" : "info", true), badge(p.phaseLabel, "warn", true), stateBadge(a), healthBadge,
          badge(p.planName + (p.planCustom ? " (custom)" : ""), "info", false),
          h("button", { class: "btn sm", type: "button", text: "Plan…", onclick: () => openPlanDrawer(a) })),
        meter(p.done, p.total, p.active ? "good" : ""),
        h("div", { class: "row between small muted" },
          h("span", { text: `${p.done} of ${p.total} clean days${p.warnings ? `, ${p.warnings} held by warnings` : ""}${p.missedDays ? `, ${p.missedDays} missed` : ""}` }),
          h("span", { text: p.active ? "On the sending ramp" : `On pace to finish around ${day(p.finishAt)} if every day is clean` })),
        h("div", { class: "wu-grid", role: "img", "aria-label": `Warm-up calendar for ${a.label}` }, cells),
        h("div", { class: "wu-facts" },
          h("span", null, h("b", { class: "num", text: `${p.sessionsDone}/${p.sessionsRequired}` }), " sessions today"),
          h("span", null, h("b", { class: "num", text: `${p.dmsSent}/${p.dmsAllowed}` }), " DMs today"),
          h("span", null, h("b", { class: "num", text: String(p.warnings) }), " held"),
          h("span", null, h("b", { class: "num", text: String(p.missedDays) }), " missed")),
        h("p", { class: "small", text: p.plan }),
        h("div", { class: "row" }, p.unlocked.map((x) => badge(x, "good", true)),
          p.nextUnlock ? h("span", { class: "muted small", text: `Day ${p.nextUnlock.atDay} unlocks: ${p.nextUnlock.what}.` }) : null)));
    }
  };
  /* ---- the plan drawer: assign a preset, edit a custom plan, or build a new one ---- */
  let plans = null;
  const loadPlans = async () => { plans = await api("GET", "/api/warmup/plans"); };
  /* rows: [{until, label, sessions, dms, follows, plan}] edited straight in a small table */
  const planEditor = (plan) => {
    const wrap = h("div", { class: "stack" });
    const name = h("input", { value: plan.name || "My warm-up plan", "aria-label": "Plan name" });
    const rowsBox = h("div", { class: "stack plan-rows" });
    const row = (r) => {
      const until = h("input", { type: "number", min: 1, max: 90, value: r.until, "aria-label": "Runs until day" });
      const label = h("input", { value: r.label || "", placeholder: "Phase name", "aria-label": "Phase name" });
      const sessions = h("input", { type: "number", min: 0, max: 8, value: r.sessions ?? 2, "aria-label": "Browsing sessions per day" });
      const dms = h("input", { type: "number", min: 0, max: 40, value: r.dms ?? 0, "aria-label": "DMs per day" });
      const follows = h("input", { type: "number", min: 0, max: 10, value: r.follows ?? 0, "aria-label": "Follows per day" });
      const note = h("input", { value: r.plan || "", placeholder: "What this phase does", "aria-label": "Phase note" });
      const el = h("div", { class: "plan-row" },
        h("div", { class: "row nums" }, h("span", { class: "small muted", text: "until day" }), until, label, h("span", { class: "small muted", title: "Browsing sessions per day", text: "sess" }), sessions, h("span", { class: "small muted", text: "DMs" }), dms, h("span", { class: "small muted", text: "follows" }), follows),
        note, h("button", { class: "icon-btn", type: "button", "aria-label": "Remove phase", onclick: () => { el.remove(); preview(); } }, ico("x")));
      el._get = () => ({ until: Number(until.value), label: label.value, sessions: Number(sessions.value), dms: Number(dms.value), follows: Number(follows.value), plan: note.value });
      el.querySelector("input[max='90']").addEventListener("change", preview);
      el.querySelectorAll("input[type='number']").forEach((i) => i.addEventListener("input", preview));
      return el;
    };
    const addRow = (r) => rowsBox.append(row(r));
    /* preview: color the first 30 days by phase */
    const prevBox = h("div", { class: "wu-grid plan-preview", role: "img", "aria-label": "Plan preview" });
    const preview = () => {
      const ranges = [...rowsBox.children].map((el) => el._get()).sort((x, y) => x.until - y.until);
      prevBox.replaceChildren(...Array.from({ length: 30 }, (_, i) => {
        const d1 = i + 1, r = ranges.find((x) => d1 <= x.until) || ranges[ranges.length - 1] || { dms: 0, label: "?" };
        const total = ranges.length ? ranges[ranges.length - 1].until : 0;
        const cls = d1 > total ? "future" : r.dms > 0 ? "first" : "touch";
        return h("div", { class: "wu-cell " + cls, title: `Day ${d1}: ${r.label || "phase"} — ${r.dms} DMs, ${r.follows} follows` }, h("span", { class: "num", text: d1 > total ? "" : String(r.dms) }));
      }));
    };
    preview();
    (plan.ranges || [{ until: 3, label: "Browsing only", sessions: 2, dms: 0, follows: 0, plan: "" }, { until: 7, label: "Touches", sessions: 3, dms: 0, follows: 1, plan: "" }, { until: 11, label: "First DMs", sessions: 4, dms: 3, follows: 1, plan: "" }, { until: 14, label: "Ramp", sessions: 4, dms: 6, follows: 2, plan: "" }]).forEach(addRow);
    const rulesAct = sw("pAct", "A day only counts if the browser ran", "Laptop closed = day does not count (recommended).", plan.rules ? plan.rules.requireActivity !== false : true);
    const rulesWarn = sw("pWarn", "An Instagram warning holds that day", "The account repeats the day instead of advancing (recommended).", plan.rules ? plan.rules.warnHolds !== false : true);
    /* post-program ramp */
    const rampIn = plan.ramp && plan.ramp.length ? plan.ramp : [{ after: 0, cap: 6 }, { after: 3, cap: 10 }, { after: 7, cap: 15 }, { after: 14, cap: 40 }];
    const rampBox = h("div", { class: "row nums wrap" });
    rampIn.forEach((r) => rampBox.append(h("span", { class: "small muted", text: `after ${r.after}d` }), h("input", { type: "number", min: 1, max: 40, value: r.cap, "aria-label": `DM cap ${r.after} days after the program` })));
    const unsafe = sw("pUnsafe", "Allow an aggressive plan (override the guardrails)", "Lifts \"no DMs in the first 3 days\", phase caps and minimum length. The hard cap of 40 DMs/day stays.", false);
    wrap.append(h("div", { class: "row" }, field("pName", "Plan name", name)),
      h("h3", { text: "Phases (each runs until the day you set)" }), rowsBox,
      h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", text: "+ phase", onclick: () => { const last = [...rowsBox.children].pop(); addRow({ until: (last ? last._get().until : 0) + 3, label: "", sessions: 4, dms: 3, follows: 1, plan: "" }); } })),
      h("h3", { text: "Counting rules" }), rulesAct, rulesWarn,
      h("h3", { text: "Sending ramp after the program (DMs per day)" }), rampBox,
      unsafe, prevBox);
    wrap.save = async (accountId) => {
      const body = { plan: { id: plan.id, name: name.value, ranges: [...rowsBox.children].map((el) => el._get()).sort((x, y) => x.until - y.until),
        ramp: [...rampBox.querySelectorAll("input")].map((inp, i) => ({ after: (rampIn[i] || {}).after ?? i * 4, cap: Number(inp.value) })),
        rules: { requireActivity: $("#pAct").checked, warnHolds: $("#pWarn").checked } }, allowUnsafe: $("#pUnsafe").checked };
      const r = await api("POST", "/api/warmup/plans", body);
      await api("POST", "/api/warmup/assign", { accountId, planId: r.plan.id });
      return r.plan;
    };
    return wrap;
  };
  async function openPlanDrawer(account) {
    await loadPlans();
    const list = h("div", { class: "stack" });
    const choose = h("div", { class: "stack" });
    /* Build with AI: describe the niche and vibe, get a full plan that already passes the guardrails. */
    const aiDesc = h("textarea", { id: "wuAiDesc", rows: 2, "aria-label": "Describe the warm-up you want", placeholder: "Describe it: niche, how old the account is, how aggressive. Example: brand-new account, roofing niche in Texas, cautious, three weeks." });
    const aiMsg = h("p", { class: "msg small", role: "status" });
    const aiBtn = h("button", { class: "btn", type: "button" }, ico("bot"), "Build a plan with AI");
    aiBtn.onclick = guard(aiBtn, async () => {
      aiMsg.className = "msg small"; aiMsg.textContent = "Thinking…";
      const r = await api("POST", "/api/ai/build", { clientId: account.clientId || undefined, what: "warmup", description: aiDesc.value });
      editing = { id: null }; editor = planEditor({ id: null, name: r.fields.plan.name, ranges: r.fields.plan.ranges, ramp: r.fields.plan.ramp, rules: null });
      editSlot.replaceChildren(editor); refreshActions();
      aiMsg.className = "msg good"; aiMsg.textContent = r.explanation || "Plan built. Check the phases, then save and assign.";
    });
    const aiBox = h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Build with AI" })),
      field("wuAiDesc", "Describe the warm-up you want", aiDesc, "The AI writes the whole day-by-day plan, explains why the rhythm fits, and fills the editor below. Nothing is assigned until you save."),
      h("div", { class: "row" }, aiBtn), aiMsg);
    const radio = (id, name, sub, checked) => h("label", { class: "switch", for: id }, h("span", { class: "tx" }, h("b", { text: name }), h("span", { text: sub })), h("input", { type: "radio", name: "planChoice", id, value: id, checked }));
    const current = account.program?.planId || "";
    choose.append(radio("plan:preset21", "Preset — Strict 21", "For brand-new accounts (3 weeks)", current === "preset21"),
      radio("plan:preset14", "Preset — Standard 14", "For accounts a few months old (recommended)", current === "preset14" || current === ""),
      radio("plan:preset7", "Preset — Fast 7", "For established accounts (1 week)", current === "preset7"));
    plans.custom.forEach((c, i) => choose.append(radio("plan:" + c.id, c.name + " (custom)", `${c.total} days · ${c.phases} phases${c.accounts ? ` · used by ${c.accounts} account${c.accounts === 1 ? "" : "s"}` : ""}${c.unsafe ? " · aggressive" : ""}`, current === c.id)));
    const msg = h("p", { class: "msg", role: "alert" });
    let editing = null, editor = null;
    const editSlot = h("div");
    const assignBtn = h("button", { class: "btn primary", type: "button", text: "Use this plan" });
    assignBtn.onclick = guard(assignBtn, async () => {
      if (editing) { const saved = await editor.save(account.id); toast(`Plan "${saved.name}" saved and assigned.`, "good"); }
      else {
        const v = (choose.querySelector("input[name='planChoice']:checked") || {}).value || "";
        const planId = v.startsWith("plan:") ? v.slice(5) : "";
        await api("POST", "/api/warmup/assign", { accountId: account.id, planId });
        toast("Plan assigned. The account follows it from its next session.", "good");
      }
      closeDrawer(); await load(); draw();
    });
    const editBtn = h("button", { class: "btn", type: "button", text: "Edit selected" });
    const newBtn = h("button", { class: "btn", type: "button", text: "+ New custom plan" });
    const delBtn = h("button", { class: "btn danger", type: "button", text: "Delete selected custom plan" });
    const refreshActions = () => {
      const v = (choose.querySelector("input[name='planChoice']:checked") || {}).value || "";
      const isCustom = plans.custom.some((c) => "plan:" + c.id === v);
      delBtn.disabled = !isCustom; editBtn.disabled = !isCustom;
      assignBtn.textContent = editing ? "Save plan and assign it" : "Use this plan";
    };
    choose.addEventListener("change", () => { if (editing) { editing = null; editSlot.replaceChildren(); } refreshActions(); });
    editBtn.onclick = guard(editBtn, async () => {
      const v = (choose.querySelector("input[name='planChoice']:checked") || {}).value || "";
      const c = plans.custom.find((x) => "plan:" + x.id === v); if (!c) return;
      editing = c; editor = planEditor({ id: c.id, name: c.name, ranges: c.ranges, ramp: c.ramp, rules: c.rules });
      editSlot.replaceChildren(editor); refreshActions();
    });
    newBtn.onclick = guard(newBtn, async () => {
      editing = { id: null }; editor = planEditor({ id: null, name: "My warm-up plan", ranges: null, ramp: null, rules: null });
      editSlot.replaceChildren(editor); refreshActions();
    });
    delBtn.onclick = guard(delBtn, async () => {
      const v = (choose.querySelector("input[name='planChoice']:checked") || {}).value || "";
      const id2 = v.startsWith("plan:") ? v.slice(5) : ""; if (!id2) return;
      if (!confirm("Delete this plan? Accounts using it go back to the preset for their age.")) return;
      await api("DELETE", "/api/warmup/plans/" + id2, {});
      await loadPlans(); openPlanDrawer(account);
    });
    list.append(aiBox, choose, h("div", { class: "row wrap" }, assignBtn, editBtn, newBtn, delBtn), msg, editSlot);
    openDrawer(`Warm-up plan — ${account.label}`, list);
    refreshActions();
  }
  const load = async () => { d = await api("GET", "/api/warmup"); draw(); };
  await load();
  return { onEvent(e) { if (["account", "task"].includes(e.t)) load().catch(() => {}); }, refresh: load };
}
VIEWS.warmup = viewWarmup;
})();
