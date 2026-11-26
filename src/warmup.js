/* Warm-up program: an Instantly-style day-by-day plan for every sender account.
   Instead of "wait N days and hope", each account walks a fixed number of program days.
   A program day is only counted as completed when that calendar day was CLEAN:
   the browser actually ran (activity exists) and Instagram showed no warning.
     - warning that day      -> the day is HELD: it does not count, the account repeats it
     - browser never ran     -> the day is MISSED: it does not count either (laptop closed = program paused)
     - clean and active      -> the day counts, the account advances
   So a skipped day delays the program instead of skipping ahead, and a warning holds it.
   Phases: browse only -> touches -> first DMs -> ramp. The daily cap rises with every phase.

   Custom plans: the dashboard can edit the phases, the rules and the post-program ramp, save the
   result as a named plan and assign it per account. The three presets below stay exactly as they
   were and remain the fallback ("" assignment = preset for the account's age). Guardrails in
   validatePlan() keep an edited plan from doing anything the presets would never do — the only way
   past them is the explicit "allow unsafe" switch in the editor. */
const { now, DAY, HOUR, MIN } = require("./util");
const tzlib = require("./tz");

/* Program length by account age: a brand-new Instagram account needs three weeks,
   a months-old account two, an established one a fast week. */
const PROGRAM_DAYS = { new: 21, young: 14, established: 7 };
const PRESET_IDS = { new: "preset21", young: "preset14", established: "preset7" };
const WARN_KINDS = "('action_blocked','checkpoint','quarantine')";
const HARD_MAX_DM = 40, HARD_MAX_FOLLOWS = 10, HARD_MAX_SESSIONS = 8, HARD_MAX_DAYS = 90;
const DEFAULT_RAMP = [{ after: 0, cap: 6 }, { after: 3, cap: 10 }, { after: 7, cap: 15 }, { after: 14, cap: 40 }];

/* What day N of the preset program asks for. `plan` overrides this when an account walks a custom plan. */
function dayPlan(day, plan) {
  if (plan && Array.isArray(plan.ranges) && plan.ranges.length) {
    for (const r of plan.ranges) if (day <= r.until) return { phase: r.phase || "custom", label: r.label || "Custom phase", sessions: r.sessions, dms: r.dms, follows: r.follows, plan: r.plan || "" };
    const last = plan.ranges[plan.ranges.length - 1];
    return { phase: last.phase || "custom", label: last.label || "Custom phase", sessions: last.sessions, dms: last.dms, follows: last.follows, plan: last.plan || "" };
  }
  if (day <= 3) return { phase: "browse", label: "Browsing only", sessions: 2, dms: 0, follows: 0,
    plan: "Feed, explore and inbox visits. No messages yet." };
  if (day <= 7) return { phase: "touch", label: "Look around + touches", sessions: 3, dms: 0, follows: 1,
    plan: "Story views and post likes, one follow a day. Still no cold messages." };
  if (day <= 11) return { phase: "first", label: "First DMs", sessions: 4, dms: 3, follows: 1,
    plan: "Cold DMs unlock: up to 3 a day, every one warmed up with a story view or like first." };
  return { phase: "ramp", label: "Ramp up", sessions: 4, dms: Math.min(6, 3 + (day - 11)), follows: 2,
    plan: `Volume rises: up to ${Math.min(6, 3 + (day - 11))} first messages a day.` };
}

/* The editor sends ranges; this turns them into a safe stored plan, or throws with a plain-words reason.
   allowUnsafe lifts the "no DMs in the first days" and "standard caps" guardrails — never the hard 40. */
function validatePlan(input, { allowUnsafe = false } = {}) {
  const p = input && typeof input === "object" ? input : {};
  const name = String(p.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw new Error("Give the plan a name.");
  const ranges = Array.isArray(p.ranges) ? p.ranges : [];
  if (ranges.length < 1 || ranges.length > 24) throw new Error("Use between 1 and 24 phases.");
  let prev = 0;
  const clean = ranges.map((r, i) => {
    const until = Math.round(Number(r.until));
    if (!Number.isFinite(until) || until <= prev) throw new Error(`Phase ${i + 1} must end on a later day than phase ${i} (got day ${until}).`);
    prev = until;
    if (until > HARD_MAX_DAYS) throw new Error(`A program cannot be longer than ${HARD_MAX_DAYS} days.`);
    const sessions = Math.max(0, Math.min(HARD_MAX_SESSIONS, Math.round(Number(r.sessions) || 0)));
    const dms = Math.max(0, Math.min(HARD_MAX_DM, Math.round(Number(r.dms) || 0)));
    const follows = Math.max(0, Math.min(HARD_MAX_FOLLOWS, Math.round(Number(r.follows) || 0)));
    return { until, phase: String(r.phase || "custom").slice(0, 20), label: String(r.label || "").slice(0, 60), sessions, dms, follows, plan: String(r.plan || "").slice(0, 300) };
  });
  // guardrail 1: no cold DMs on the very first days of an Instagram account's life
  if (!allowUnsafe) {
    const early = clean.find((r) => r.until <= 3 && r.dms > 0) || (clean[0].dms > 0 ? clean[0] : null);
    if (early) throw new Error("Instagram watches brand-new accounts hardest: the first 3 days must stay at 0 DMs. Turn on the override only if you really mean it.");
    if (clean[clean.length - 1].until < 7) throw new Error("A program shorter than 7 days only makes sense for accounts that are months old. Turn on the override if you accept the risk.");
    const hot = clean.find((r) => r.dms > 10);
    if (hot) throw new Error(`No phase may exceed 10 DMs a day without the override (phase "${hot.label || hot.phase}" asks for ${hot.dms}).`);
    const followy = clean.find((r) => r.follows > 4);
    if (followy) throw new Error(`No phase may exceed 4 follows a day without the override (phase "${followy.label || followy.phase}" asks for ${followy.follows}).`);
    const busy = clean.find((r) => r.sessions > 6);
    if (busy) throw new Error(`No phase may exceed 6 browsing sessions a day without the override (phase "${busy.label || busy.phase}" asks for ${busy.sessions}).`);
  }
  // the ramp after the program: 0-8 steps, each { after, cap }, caps ascending
  const rampIn = Array.isArray(p.ramp) ? p.ramp : DEFAULT_RAMP;
  if (rampIn.length > 8) throw new Error("Use up to 8 ramp steps.");
  let lastAfter = -1, lastCap = 0;
  const ramp = rampIn.map((r) => {
    const after = Math.round(Number(r.after));
    let cap = Math.round(Number(r.cap));
    if (!Number.isFinite(after) || after < 0 || after <= lastAfter) throw new Error("Ramp steps must each start on a later day than the one before.");
    if (!allowUnsafe && cap > HARD_MAX_DM) throw new Error("The ramp may not exceed the hard cap of 40 DMs a day.");
    if (cap > HARD_MAX_DM) cap = HARD_MAX_DM;
    if (cap < 1) throw new Error("A ramp step cannot be 0 DMs a day.");
    if (cap < lastCap) throw new Error("The ramp may only rise — a step lower than the one before would throttle the account after it just warmed up.");
    lastAfter = after; lastCap = cap;
    return { after, cap };
  });
  const rules = {
    requireActivity: p.rules?.requireActivity === undefined ? true : !!p.rules.requireActivity,   // a day only counts when the browser actually ran
    warnHolds: p.rules?.warnHolds === undefined ? true : !!p.rules.warnHolds                       // an Instagram warning holds that day
  };
  return { name, ranges: clean, ramp, rules };
}

const PLANS_KEY = "warmup_plans";
function loadPlans(db) {
  const all = db.setting(PLANS_KEY, {});
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}
function planById(db, id) {
  if (!id) return null;
  const p = loadPlans(db)[String(id)];
  return p && typeof p === "object" ? p : null;
}

function createWarmup(ctx) {
  const { db, accounts } = ctx;

  const rules = (a) => accounts.rulesFor(a);
  const healthFactor = (a) => ({ healthy: 1, caution: 0.5, risky: 0 }[accounts.health(a).level] ?? 1);

  /* Which plan an account walks: its custom plan, an explicitly chosen preset, else the preset for its age. */
  const PRESET_TOTALS = { preset21: 21, preset14: 14, preset7: 7 };
  function planFor(a) {
    const custom = planById(db, a.warm_plan);
    if (custom && custom.ranges?.length) return { id: a.warm_plan, name: custom.name || "Custom plan", custom: true, total: custom.ranges[custom.ranges.length - 1].until, ranges: custom.ranges, ramp: custom.ramp, rules: custom.rules };
    const age = PROGRAM_DAYS[a.ig_age] ? a.ig_age : "young";
    const presetId = PRESET_TOTALS[a.warm_plan] ? a.warm_plan : PRESET_IDS[age];
    const total = PRESET_TOTALS[presetId] || PROGRAM_DAYS[age];
    return { id: presetId, name: `Preset ${total}-day`, custom: false, total, ranges: null, ramp: DEFAULT_RAMP, rules: { requireActivity: true, warnHolds: true } };
  }
  /* The ramp cap N days after the program finished. */
  const rampCap = (ramp, activeDays) => { let cap = ramp[0].cap; for (const r of ramp) if (activeDays >= r.after) cap = r.cap; return cap; };

  /* What happened on one calendar day: did the browser run, and did Instagram complain? */
  function dayRecord(a, from, to, planRules) {
    const active = db.get(`SELECT
      (SELECT COUNT(*) FROM tasks WHERE account_id = ? AND done_at IS NOT NULL AND done_at >= ? AND done_at < ?) +
      (SELECT COUNT(*) FROM activity WHERE account_id = ? AND at >= ? AND at < ?) +
      (SELECT COUNT(*) FROM events WHERE account_id = ? AND at >= ? AND at < ?) AS n`,
      a.id, from, to, a.id, from, to, a.id, from, to).n;
    const warn = db.get(`SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND kind IN ${WARN_KINDS} AND at >= ? AND at < ?`, a.id, from, to).n;
    if (warn > 0 && planRules?.warnHolds !== false) return { status: "held", active, warn };
    if (active === 0 && planRules?.requireActivity !== false) return { status: "missed", active, warn };
    return { status: "done", active, warn };
  }

  /* Advance the counters over every finished calendar day. Cheap: walks only the days it has not seen yet. */
  function settle(a) {
    if (!a || !a.warm_started_at) return a;
    const tz = rules(a).tz, t = now();
    const start = tzlib.startOfDay(a.warm_started_at, tz);
    const elapsed = Math.floor((tzlib.startOfDay(t, tz) - start) / DAY);   // full calendar days completed
    const cursor = a.warm_cursor || 0;
    if (elapsed <= cursor) return a;
    const planRules = planFor(a).rules;
    let done = a.warm_done || 0, holds = a.warm_holds || 0, missed = a.warm_missed || 0;
    for (let d = cursor; d < elapsed; d++) {   // d = 0-indexed day since start; cursor counts evaluated days
      const rec = dayRecord(a, start + d * DAY, start + (d + 1) * DAY, planRules);
      if (rec.status === "done") done++;
      else if (rec.status === "held") { holds++; accounts.note(a, "warn",
        `Warm-up day held: Instagram showed a warning that day, so the account repeats it (${done} clean days so far).`, "warmup"); }
      else missed++;
    }
    db.run("UPDATE accounts SET warm_done = ?, warm_cursor = ?, warm_holds = ?, warm_missed = ? WHERE id = ?", done, elapsed, holds, missed, a.id);
    const fresh = db.get("SELECT * FROM accounts WHERE id = ?", a.id);
    const total = planFor(fresh).total;
    if (done >= total && (a.warm_done || 0) < done) accounts.note(fresh, "good", `${fresh.label} finished its ${total}-day warm-up program and is cleared for its sending ramp.`, "warmup");
    return fresh;
  }

  /* The object the extension popup and the dashboard show. */
  function program(a) {
    a = settle(db.get("SELECT * FROM accounts WHERE id = ?", a.id)) || a;
    const plan = planFor(a);
    const total = plan.total;
    const done = a.warm_done || 0, active = done >= total;
    const day = Math.min(done + 1, total);
    const p = dayPlan(active ? total : day, plan.custom ? plan : null);
    const tz = rules(a).tz, today = tzlib.startOfDay(now(), tz);
    const sessionsDone = db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type = 'warm' AND status = 'done' AND done_at >= ?", a.id, today).n;
    const dmsSent = db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type IN ('dm','followup') AND status = 'done' AND result_code = 'sent' AND done_at >= ?", a.id, today).n;
    const st = accounts.effectiveState(a);
    const factor = st.state === "active" ? healthFactor(a) : 0;
    let dmsAllowed, rampCapToday;
    if (!active) { dmsAllowed = Math.floor(p.dms * factor); rampCapToday = 0; }
    else {                                     // program finished: the post-program ramp
      const activeDays = Math.max(0, Math.floor((now() - (a.warm_started_at + total * DAY)) / DAY));
      rampCapToday = rampCap(plan.ramp, activeDays);
      const base = Math.min(a.daily_cap_override ?? 20, 40);
      dmsAllowed = Math.floor(Math.min(base, rampCapToday) * factor);
    }
    /* Calendar grid: the last 60 calendar days since the program started, colored by what happened. */
    const cursor = a.warm_cursor || 0, history = [];
    const firstShown = Math.max(0, cursor - 59);
    const startDay = today - cursor * DAY;
    for (let d = firstShown; d <= cursor; d++) {
      const rec = dayRecord(a, startDay + d * DAY, startDay + (d + 1) * DAY, plan.rules);
      const isToday = d === cursor;
      history.push({ day: d + 1, at: startDay + d * DAY, status: isToday ? (rec.warn && plan.rules.warnHolds !== false ? "held" : "today") : rec.status });
    }
    const remaining = Math.max(0, total - done);
    /* When each capability unlocked: the preset day numbers, or the first custom range that asks for it. */
    const firstRange = (pred) => (plan.custom ? (plan.ranges.find(pred) || { until: null }).until : null);
    const touchDay = firstRange((r) => r.follows > 0), dmDay = firstRange((r) => r.dms > 0);
    const unlocked = [];
    if (day > 3 || active) unlocked.push("Browsing routines");
    if (day > 7 || active || (touchDay !== null && day > touchDay)) unlocked.push("Story views, likes, follows");
    if (day > 11 || active || (dmDay !== null && day > dmDay)) unlocked.push("Cold DMs");
    if (active) unlocked.push("Post-program sending ramp");
    return {
      total, done, day, active, phase: p.phase, phaseLabel: active ? "Program finished" : p.label,
      planId: plan.id, planName: plan.name, planCustom: plan.custom,
      sessionsDone, sessionsRequired: active ? 2 : p.sessions, dmsSent, dmsAllowed, rampCapToday,
      warnings: a.warm_holds || 0, missedDays: a.warm_missed || 0,
      plan: active ? "Normal sending. The ramp raises the daily cap over the next two weeks." : p.plan,
      unlocked, nextUnlock: active ? null : (p.dms === 0 && day <= 3 ? { atDay: Math.min(4, total), what: plan.custom ? "Next phase" : "Story views, likes and follows" }
        : p.dms === 0 ? { atDay: plan.custom ? Math.min(total, (plan.ranges.find((r) => r.dms > 0) || { until: total }).until + 1) : 8, what: "First cold DMs" } : null),
      finishAt: now() + remaining * DAY, history, health: accounts.health(a).level
    };
  }

  /* Plans API for the dashboard. */
  function listPlans() {
    const all = loadPlans(db);
    const custom = Object.values(all).filter((p) => p && p.ranges?.length).map((p) => ({ id: p.id, name: p.name, total: p.ranges[p.ranges.length - 1].until, phases: p.ranges.length, ranges: p.ranges, ramp: p.ramp, rules: p.rules, unsafe: p.allowUnsafe || false }));
    const usedBy = {};
    for (const a of db.all("SELECT id, warm_plan FROM accounts WHERE warm_plan != ''")) usedBy[a.warm_plan] = (usedBy[a.warm_plan] || 0) + 1;
    for (const c of custom) c.accounts = usedBy[c.id] || 0;
    return {
      presets: [
        { id: "preset21", name: "Preset — Strict 21 (new accounts)", total: 21, forAge: "new" },
        { id: "preset14", name: "Preset — Standard 14", total: 14, forAge: "young" },
        { id: "preset7", name: "Preset — Fast 7 (established)", total: 7, forAge: "established" }
      ],
      custom,
      defaultRamp: DEFAULT_RAMP
    };
  }
  function savePlan(input, { allowUnsafe = false } = {}) {
    const all = loadPlans(db);
    const id = input.id && String(input.id).startsWith("cp_") && all[input.id] ? input.id : "cp_" + Math.random().toString(36).slice(2, 8);
    const plan = validatePlan(input, { allowUnsafe });
    plan.id = id;
    plan.allowUnsafe = !!allowUnsafe;
    plan.updated_at = now();
    all[id] = plan;
    db.setSetting(PLANS_KEY, all);
    return { id, ...plan };
  }
  function deletePlan(id) {
    const all = loadPlans(db);
    if (!all[id]) throw new (require("./util").HttpError)(404, "That plan does not exist.");
    delete all[id];
    db.setSetting(PLANS_KEY, all);
    for (const a of db.all("SELECT id FROM accounts WHERE warm_plan = ?", id)) db.run("UPDATE accounts SET warm_plan = '' WHERE id = ?", a.id);
    return { ok: true };
  }
  function assignPlan(accountId, planId) {
    const id = String(planId || "");
    if (id && !PRESET_TOTALS[id] && !planById(db, id)) throw new (require("./util").HttpError)(404, "That plan does not exist.");
    db.run("UPDATE accounts SET warm_plan = ? WHERE id = ?", id, accountId);
    return { ok: true };
  }

  return { PROGRAM_DAYS, dayPlan, planFor, program, settle, listPlans, savePlan, deletePlan, assignPlan, validatePlan };
}
module.exports = { createWarmup, PROGRAM_DAYS, dayPlan, validatePlan, DEFAULT_RAMP };
