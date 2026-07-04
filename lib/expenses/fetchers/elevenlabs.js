// lib/expenses/fetchers/elevenlabs.js
// One-line: AUTO fetcher — ElevenLabs plan + usage via GET /v1/user/subscription.
//
// Uses the existing ELEVENLABS_API_KEY. Captures tier, character usage, and the
// reset date into raw. ElevenLabs is a flat plan, so amount_usd is the tier's
// monthly price ("plan price ... once Mark supplies the tier" — the tier comes
// straight from the API). Unknown tier -> amount_usd null with a clear note so
// it can be set manually.

const SUB_URL = "https://api.elevenlabs.io/v1/user/subscription";

// Published monthly USD price by ElevenLabs tier (lowercased API `tier` value).
const TIER_PRICES = {
  free: 0,
  starter: 5,
  creator: 22,
  pro: 99,
  scale: 330,
  business: 1320,
};

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function monthRange(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    period_start: iso(new Date(Date.UTC(y, m, 1))),
    period_end: iso(new Date(Date.UTC(y, m + 1, 0))),
  };
}

export async function fetchSource(source) {
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  const now = new Date();
  const { period_start, period_end } = monthRange(now);

  if (!key) {
    return {
      ok: false,
      skipped: true,
      fetch_mode_effective: "manual",
      period_start,
      period_end,
      note: "ELEVENLABS_API_KEY missing — falling back to manual for this run.",
    };
  }

  const resp = await fetch(SUB_URL, { headers: { "xi-api-key": key } });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs subscription ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const sub = await resp.json();

  const tierRaw = String(sub?.tier || "").trim();
  const tierKey = tierRaw.toLowerCase();
  const mapped = TIER_PRICES[tierKey];
  const amount_usd = mapped == null ? null : mapped;
  const priceSource = mapped == null ? "unknown_tier" : "tier_map";

  const resetUnix = sub?.next_character_count_reset_unix ?? null;
  const raw = {
    source: "elevenlabs.subscription",
    tier: tierRaw,
    price_source: priceSource,
    character_count: sub?.character_count ?? null,
    character_limit: sub?.character_limit ?? null,
    next_character_count_reset_unix: resetUnix,
    next_reset_iso:
      typeof resetUnix === "number" ? new Date(resetUnix * 1000).toISOString() : null,
    status: sub?.status ?? null,
    subscription: sub,
  };

  const usageStr = `${sub?.character_count ?? "?"}/${sub?.character_limit ?? "?"} chars`;
  const note =
    amount_usd != null
      ? `${tierRaw || "?"} plan $${amount_usd.toFixed(2)}/mo · ${usageStr}`
      : `Unknown tier "${tierRaw}" — enter the plan price manually. ${usageStr}`;

  return {
    ok: true,
    fetch_mode_effective: "auto",
    method: "auto",
    amount_usd,
    period_start,
    period_end,
    raw,
    note,
  };
}

export default fetchSource;
