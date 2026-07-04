// lib/expenses/fetchers/openai.js
// One-line: AUTO fetcher — OpenAI organization month-to-date cost via the Costs API.
//
// Requires OPENAI_ADMIN_KEY (an org Admin key minted at
// platform.openai.com/settings/organization/admin-keys). If it is absent at
// runtime we DO NOT crash: the run is marked manual for this source with a
// clear "admin key needed" note and no snapshot is written.
//
// Attribution: per-key dollar figures are unavailable while the Lux production
// key ("Vercel API") shares the Default project, so we store the ORG TOTAL as
// amount_usd and the full response in raw. Usage grouped by api_key_id is
// captured best-effort into raw for later. Once the Lux key gets its own
// project, switch amount_usd to Costs grouped by project_id.

const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const USAGE_URL = "https://api.openai.com/v1/organization/usage/completions";

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function monthStartUnix(now) {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

export async function fetchSource(source) {
  const key = (process.env.OPENAI_ADMIN_KEY || "").trim();
  const now = new Date();
  const period_start = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const period_end = iso(now);

  if (!key) {
    return {
      ok: false,
      skipped: true,
      fetch_mode_effective: "manual",
      period_start,
      period_end,
      note:
        "OPENAI_ADMIN_KEY needed — mint an org Admin key at " +
        "platform.openai.com/settings/organization/admin-keys and set it in the " +
        "backend env. Falling back to manual for this run.",
    };
  }

  const startTime = monthStartUnix(now);

  // --- Costs (authoritative dollar amount, org total, MTD) ---
  let total = 0;
  const buckets = [];
  let page = null;
  let guard = 0;
  do {
    const url = new URL(COSTS_URL);
    url.searchParams.set("start_time", String(startTime));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);

    const resp = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`OpenAI costs ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const json = await resp.json();
    for (const b of json.data || []) {
      for (const r of b.results || []) {
        const v = Number(r?.amount?.value || 0);
        if (Number.isFinite(v)) total += v;
      }
      buckets.push(b);
    }
    page = json.has_more ? json.next_page : null;
  } while (page && ++guard < 12);

  const amount_usd = Math.round(total * 100) / 100;

  // --- Usage grouped by api_key_id (best-effort; tokens, not dollars).
  //     First page only: this is informational raw context, not used for
  //     amount_usd (which comes from the paginated Costs loop above). ---
  let usageByKey = null;
  try {
    const url = new URL(USAGE_URL);
    url.searchParams.set("start_time", String(startTime));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    url.searchParams.append("group_by", "api_key_id");
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (resp.ok) usageByKey = await resp.json();
  } catch {
    // best-effort only — never fail the fetch over usage attribution
  }

  return {
    ok: true,
    fetch_mode_effective: "auto",
    method: "auto",
    amount_usd,
    period_start,
    period_end,
    raw: {
      source: "openai.costs",
      org_total_usd: amount_usd,
      note:
        "Org-total cost (MTD). Per-key attribution pending the Lux key getting " +
        "its own project; then switch to Costs grouped by project_id.",
      costs: buckets,
      usage_by_key: usageByKey,
    },
    note: `Org MTD cost $${amount_usd.toFixed(2)}`,
  };
}

export default fetchSource;
