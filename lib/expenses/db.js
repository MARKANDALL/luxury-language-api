// lib/expenses/db.js
// One-line: Supabase read/write helpers for the expense dashboard (sources, snapshots, events).
//
// Runtime reads/writes go through supabase-js with the service-role key
// (lib/supabase.js). Schema DDL is applied separately by the migrate endpoint.

import { getSupabaseAdmin } from "../supabase.js";

function iso(d) {
  return d.toISOString().slice(0, 10);
}

// Current UTC month as { start, end, today } ISO dates.
export function currentMonthRange(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: iso(new Date(Date.UTC(y, m, 1))),
    end: iso(new Date(Date.UTC(y, m + 1, 0))),
    today: iso(now),
  };
}

export async function getSources({ activeOnly = false } = {}) {
  const db = getSupabaseAdmin();
  let q = db.from("expense_sources").select("*").order("category").order("display_name");
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getSourceBySlug(slug) {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("expense_sources")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function insertSnapshot(row) {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("expense_snapshots").insert(row).select().single();
  if (error) throw error;
  return data;
}

// Latest snapshot per source, keyed by source_id. Reads the
// expense_latest_snapshots view (distinct on source_id, newest fetched_at),
// which returns exactly one row per source regardless of table size.
export async function latestSnapshotPerSource() {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("expense_latest_snapshots").select("*");
  if (error) throw error;
  const map = new Map();
  for (const snap of data || []) map.set(snap.source_id, snap);
  return map;
}

export async function getEvents({ limit = 50 } = {}) {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("expense_events")
    .select("*")
    .order("event_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
