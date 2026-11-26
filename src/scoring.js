/* Explainable lead scoring: a 0-100 score every number of which can be shown and defended.
   No randomness and no invented facts: every factor comes from data already on the lead or the campaign.
   The breakdown is stored on the lead so the dashboard can show exactly why the score is what it is. */

const CATEGORIES = [
  [90, "Exceptional Fit"], [75, "High Potential"], [60, "Good Potential"], [40, "Moderate Fit"], [20, "Low Potential"], [-1, "Poor Fit"]
];
const categoryOf = (s) => (CATEGORIES.find(([min]) => s >= min) || CATEGORIES[CATEGORIES.length - 1])[1];

const STOP = new Set(["and", "or", "the", "for", "with", "in", "of", "a", "an", "to", "local", "us", "usa", "ca", "tx"]);
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z\s&]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const overlap = (needles, hay) => { const set = new Set(words(hay)); let n = 0; for (const w of needles) if (set.has(w)) n++; return n; };

/* lead: a leads row (plus j()-parsed fields already handled here), client: a clients row (may be null).
   signals: { intent, lastInboundMs, replied } filled in by the caller when known. */
function score(lead, client, signals = {}) {
  const f = [];
  const add = (label, points, max, why) => f.push({ label, points, max, why });
  const niche = String(lead.detected_niche || lead.lead_type_name || ""), cat = String(lead.category || "");
  const bio = String(lead.bio || ""), loc = String(lead.service_location || lead.location || "");

  /* 1. Business fit — is this an actual business in a service niche? (max 25) */
  add("Real service business", lead.entity_classification === "REAL_BUSINESS" ? 15 : lead.entity_classification === "AGENCY" ? 6 : 0, 15,
    lead.entity_classification === "REAL_BUSINESS" ? "Confirmed as a real business by the bouncer" : lead.entity_classification === "AGENCY" ? "Marketing agency, not an end-business" : "Not yet confirmed as a real business");
  if (niche) add("Clear niche identified", 5, 5, `Detected niche: ${niche}`);
  else add("Clear niche identified", 0, 5, "No niche detected yet");
  add("Booking infrastructure", lead.has_booking_infra ? 5 : 0, 5, lead.has_booking_infra ? "Has a booking link or scheduler" : "No booking link found");

  /* 2. Ideal customer fit — does it look like who the campaign wants? (max 25) */
  const targetWords = words(client?.target), offerWords = words(client?.offer);
  const hits = targetWords.length ? overlap(targetWords, `${niche} ${cat} ${bio} ${lead.page_name || ""}`) : 0;
  add("Matches the campaign's target", Math.min(10, hits * 4), 10, hits ? `${hits} target signal${hits === 1 ? "" : "s"} match (${(client?.target || "").slice(0, 60)})` : client?.target ? "Nothing in the profile matches the campaign's target yet" : "The campaign has no target description to match against");
  const offerHit = offerWords.length ? overlap(offerWords.slice(0, 12), `${niche} ${cat} ${bio}`) : 0;
  add("Relevant to the offer", Math.min(5, offerHit * 3), 5, offerHit ? "The profile mentions something the offer serves" : "No direct service relevance found");
  const followers = lead.followers ?? null, minF = client?.min_followers ?? 150, maxF = client?.max_followers ?? 100000;
  if (followers != null && followers >= minF && followers <= maxF) add("Audience size in range", 5, 5, `${followers.toLocaleString("en-US")} followers, campaign range ${minF.toLocaleString("en-US")}-${maxF.toLocaleString("en-US")}`);
  else if (followers == null) add("Audience size in range", 2, 5, "Follower count unknown (ad-library record)");
  else add("Audience size in range", 0, 5, `${followers.toLocaleString("en-US")} followers is outside the campaign range`);
  add("Location known", loc ? 5 : 0, 5, loc ? `Serves ${loc}` : "No service location detected");

  /* 3. Profile quality — can this be a real, reachable business? (max 20) */
  add("Own website", lead.has_website ? 8 : 0, 8, lead.has_website ? "Has its own website or a non-link-in-bio URL" : "No website found");
  const contact = (() => { try { return JSON.parse(lead.contact || "{}"); } catch { return {}; } })();
  const hasContact = !!(lead.email || (contact.emails || []).length || (contact.phones || []).length);
  add("Public contact details", hasContact ? 6 : 0, 6, hasContact ? "An email or phone number is visible" : "No email or phone on the profile");
  const daysSincePost = lead.last_post_at ? Math.floor((Date.now() - lead.last_post_at) / 86_400_000) : null;
  const activeDays = client?.active_within_days ?? 30;
  add("Recently active", daysSincePost == null ? 2 : daysSincePost <= activeDays ? 6 : 0, 6, daysSincePost == null ? "No post dates available" : daysSincePost <= activeDays ? `Last posted ${daysSincePost} day${daysSincePost === 1 ? "" : "s"} ago` : `Quiet for ${daysSincePost} days (campaign asks for ${activeDays})`);

  /* 4. Engagement signals (max 10) */
  add("Growing, active business", (daysSincePost != null && daysSincePost <= 14) || (lead.source_type === "meta_ad_library" && lead.ad_start_date) ? 5 : 0, 5,
    lead.source_type === "meta_ad_library" && lead.ad_start_date ? "Running ads right now (Ad Library)" : daysSincePost != null && daysSincePost <= 14 ? "Posted within two weeks" : "No fresh activity signal");
  add("Multiple contact paths", (j2(lead.links).length >= 2 || (lead.has_website && hasContact)) ? 3 : 0, 3, "Several ways to reach or verify them");
  add("Positive pre-filter score", lead.quality_points >= 60 ? 2 : 0, 2, `Pre-filter points: ${lead.quality_points}`);

  /* 5. Conversation signals — what has actually happened between us (max 20) */
  const intent = signals.intent || lead.reply_intent || "";
  if (signals.replied || lead.reply_intent) add("Replied to outreach", 5, 5, signals.replied ? "Replied" : "Has replied before");
  const intentPoints = { interested: 8, question: 5, booked: 7, neutral: 2, not_interested: -4, stop: -10 }[intent];
  add("Conversation intent", intentPoints == null ? 0 : Math.max(intentPoints, -10), 8, intent ? { interested: "Expressed interest", question: "Asked a question", booked: "Booked or asked to book", neutral: "Neutral reply", not_interested: "Said not interested", stop: "Asked to stop being contacted" }[intent] : "No reply yet");
  add("Recent conversation", signals.lastInboundMs ? 3 : 0, 3, signals.lastInboundMs ? "Replied recently" : "");
  add("Waiting on a reply from us", signals.awaitingUs ? 2 : 0, 2, signals.awaitingUs ? "There is a draft or an owed response" : "");

  const raw = f.reduce((a, x) => a + x.points, 0), s = Math.max(0, Math.min(100, Math.round(raw)));
  const positive = f.filter((x) => x.points > 0).sort((a, b) => b.points - a.points), negative = f.filter((x) => x.points < 0);
  const missing = f.filter((x) => x.points === 0 && x.why).map((x) => x.label);
  return { score: s, category: categoryOf(s), factors: f, positive, negative, missing };
}
const j2 = (s) => { try { return JSON.parse(s || "[]"); } catch { return []; } };

module.exports = { score, categoryOf, CATEGORIES };
