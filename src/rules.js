/* Deterministic pre-filter. Pure functions, no network, no clock except the `now` you pass in.
   Runs on every imported lead BEFORE anything is sent to Claude Haiku, so obvious junk costs nothing.
   evaluate(profile, opts) -> { verdict: "pass" | "reject", reasons[], flags, points, boost, entityHint } */

/* ---------- lists (from the upgrade spec) ---------- */
const CREATOR_LABELS = ["digital creator", "blogger", "video creator", "personal blog", "motivational speaker", "coach", "entrepreneur"];
const COMMERCIAL_LABELS = ["contractor", "construction company", "home improvement", "roofing service", "real estate agent", "medical spa", "dentist", "local business", "service"];
const BOOKING_HOSTS = ["calendly.com", "cal.com", "acuityscheduling.com", "msgsndr.com", "leadconnectorhq.com", "janeapp.com", "vagaro.com", "mindbodyonline.com"];
const GURU_HOSTS = ["stan.store", "skool.com", "whop.com", "gumroad.com"];
const WRAPPER_HOSTS = ["linktr.ee", "linktree.com", "beacons.ai", "bio.link", "lnk.bio", "campsite.bio", "allmylinks.com", "linkin.bio", "taplink.cc", "solo.to", "carrd.co"];
const SOCIAL_HOSTS = ["instagram.com", "facebook.com", "fb.com", "fb.me", "tiktok.com", "youtube.com", "youtu.be", "twitter.com", "x.com", "linkedin.com", "wa.me", "whatsapp.com", "snapchat.com", "pinterest.com", "threads.net", "yelp.com", "maps.app.goo.gl", "g.page", "goo.gl", "bit.ly"];

/* The spec's pattern, with one change: "dm me <any word>" matched honest bios like "DM me for a quote".
   Here it needs "the word" or a quoted word, which is what engagement bait actually looks like. */
const MARKETER_RE = /dm me (the word|["“'‘][a-z]+["”'’])|comment ["“'‘]?[a-z]+["”'’]? below|link in bio to learn|how i helped .* make|free training|\bsmma\b|lead generation|social media marketing|appointment setting|we help (?:.* )?(contractors|coaches|agencies|businesses)/i;

const PHONE_RE = /\d{3}[-.\s]\d{3}[-.\s]\d{4}|\(\d{3}\)\s?\d{3}[-.\s]\d{4}/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const TRUST = [[/licensed\s*(?:&|and|\+)\s*insured/i, 15, "licensed & insured"], [/free\s+estimates?/i, 10, "free estimate"], [/free\s+quotes?/i, 10, "free quote"], [/financing\s+available/i, 10, "financing available"]];

const US = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "district of columbia" };
const CA = { AB: "alberta", BC: "british columbia", MB: "manitoba", NB: "new brunswick", NL: "newfoundland and labrador", NS: "nova scotia", NT: "northwest territories", NU: "nunavut", ON: "ontario", PE: "prince edward island", QC: "quebec", SK: "saskatchewan", YT: "yukon" };
const REGION_NAMES = [...Object.values(US), ...Object.values(CA)];
const REGION_CODES = new Set([...Object.keys(US), ...Object.keys(CA)]);

/* ---------- small helpers ---------- */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
function wordRe(w) {
  w = norm(w); const prefix = w.endsWith("*"); if (prefix) w = w.slice(0, -1).trim(); if (!w) return null;
  return new RegExp(`(?:^|[^a-z0-9])${esc(w).replace(/ /g, "\\s+")}${prefix ? "[a-z0-9]*" : "(?![a-z0-9])"}`, "i");
}
const splitWords = (s) => [...new Set(String(Array.isArray(s) ? s.join("\n") : s || "").split(/[\n,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

/* Instagram wraps outbound links as l.instagram.com/?u=<real address>. Undo that. */
function unshim(url) {
  let u; try { u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url); } catch { return ""; }
  if (/(^|\.)l\.instagram\.com$/i.test(u.hostname) || /(^|\.)l\.facebook\.com$/i.test(u.hostname)) { const real = u.searchParams.get("u"); if (real) return unshim(real); }
  return u.toString();
}
const hostOf = (url) => { try { return new URL(unshim(url) || "http://x").hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const hostIs = (host, list) => list.find((d) => host === d || host.endsWith("." + d)) || "";

/* What kind of links does this person have? */
function classifyLinks(urls) {
  const out = { booking: [], guru: [], wrappers: [], website: false, hosts: [] };
  for (const raw of urls || []) {
    const clean = unshim(String(raw || "").trim()); if (!clean) continue;
    const host = hostOf(clean); if (!host) continue;
    out.hosts.push(host);
    const book = hostIs(host, BOOKING_HOSTS), guru = hostIs(host, GURU_HOSTS), wrap = hostIs(host, WRAPPER_HOSTS), soc = hostIs(host, SOCIAL_HOSTS);
    if (book) out.booking.push(book);
    else if (guru) out.guru.push(guru);
    else if (wrap) out.wrappers.push(clean);
    else if (!soc && /\.(com|ca|co|net|org|us|biz)$/.test(host)) out.website = true;
  }
  return out;
}

const labelHit = (cat, list) => { const c = norm(cat); if (!c) return ""; for (const l of list) { if (c === l || new RegExp(`(^|[^a-z])${esc(l)}s?([^a-z]|$)`).test(c)) return l; } return ""; };

/* First explicit city/state/province mention: "Austin, TX" or "Ontario". Returns the matched text or "". */
function placeIn(text) {
  const t = String(text || "");
  const code = [...t.matchAll(/([A-Z][A-Za-z.' -]{2,24}),\s*([A-Z]{2})(?![A-Za-z])/g)].find((m) => REGION_CODES.has(m[2]));
  if (code) return `${code[1].trim()}, ${code[2]}`;
  const low = norm(t);
  for (const n of REGION_NAMES) if (wordRe(n).test(low)) return n.replace(/\b\w/g, (c) => c.toUpperCase());
  return "";
}

/* ---------- the gate ---------- */
const DEFAULTS = { minFollowers: 150, maxFollowers: 100000, activeWithinDays: 30, allowCreatorLabels: false, requireContact: true, allowAgencies: false, excludeWords: [] };

function evaluate(p, options = {}, now = Date.now()) {
  const o = { ...DEFAULTS, ...options }, full = p.profileData !== false;
  const reasons = [], flags = { has_booking_infra: false, has_website: false, has_contact: false, marketer_pattern: false, activity_unknown: false, category: "" };
  let points = 0, boost = 0, entityHint = "";
  const caps = (p.recentPosts || []).map((x) => x.caption || "").filter(Boolean);
  const text = [p.bio, ...caps, p.adCopy, p.pageName].filter(Boolean).join(" | ");

  /* 4. activity and visibility (only when we actually have the profile; an ad record has none of this) */
  if (full) {
    if (p.isPrivate === true) reasons.push("Private account");
    if (p.followers != null) {
      if (p.followers < o.minFollowers) reasons.push(`Under ${o.minFollowers} followers`);
      if (o.maxFollowers && p.followers > o.maxFollowers) reasons.push(`Over ${o.maxFollowers.toLocaleString("en-US")} followers`);
    }
    if (p.posts === 0) reasons.push("Zero posts");
    else if (o.activeWithinDays) {
      const last = p.lastPostAt || Math.max(0, ...(p.recentPosts || []).map((x) => x.ts || 0));
      if (last) { if (now - last > o.activeWithinDays * 86400000) reasons.push(`No post in the last ${o.activeWithinDays} days`); else points += 5; }
      else flags.activity_unknown = true;
    }
  }

  /* 1. category label */
  if (full && p.category) {
    const bad = labelHit(p.category, CREATOR_LABELS), good = labelHit(p.category, COMMERCIAL_LABELS);
    flags.category = p.category;
    if (bad && !o.allowCreatorLabels) reasons.push(`Creator or guru category: ${p.category}`);
    else if (good) { boost = 1; points += 15; }
  }

  /* 2. links and contact details */
  const urls = [...(p.externalUrls || []), p.adLandingUrl].filter(Boolean);
  const links = classifyLinks(urls);
  if (links.guru.length) reasons.push(`Links to a course platform: ${links.guru[0]}`);
  if (links.booking.length) { flags.has_booking_infra = true; points += 15; }
  if (links.website) { flags.has_website = true; points += 10; }
  const contactText = [p.bio, p.email, p.phone].filter(Boolean).join(" ");
  flags.has_contact = PHONE_RE.test(contactText) || EMAIL_RE.test(contactText) || !!(p.email || p.phone);
  if (flags.has_contact) points += 15;
  if (full && o.requireContact && !urls.length && !flags.has_contact) reasons.push("No bio link, phone number or email");

  /* 3. the marketer firewall */
  const m = MARKETER_RE.exec(text);
  if (m) {
    flags.marketer_pattern = true;
    if (o.allowAgencies) entityHint = "MARKETING_AGENCY";                  // keep it, Haiku sorts it into the agency bucket
    else reasons.push(`Marketer or engagement-bait wording: "${m[0].slice(0, 40)}"`);
  } else for (const [re, pts] of TRUST) if (re.test(text)) points += pts;
  const place = placeIn([p.bio, p.location, p.fullName].filter(Boolean).join(" | ")); if (place && !m) points += 10;

  /* campaign rule-out words */
  const head = [p.bio, p.category, p.fullName, String(p.username || "").replace(/[._]/g, " ")].join(" | ");
  for (const w of o.excludeWords || []) { const re = wordRe(w); if (re && re.test(norm(head))) { reasons.push(`Excluded word: ${w}`); break; } }

  return { verdict: reasons.length ? "reject" : "pass", reasons, flags, points: Math.min(100, points), boost, entityHint, place };
}

module.exports = { evaluate, classifyLinks, unshim, hostOf, placeIn, splitWords, wordRe, norm, CREATOR_LABELS, COMMERCIAL_LABELS, BOOKING_HOSTS, GURU_HOSTS, WRAPPER_HOSTS, MARKETER_RE, DEFAULTS };
