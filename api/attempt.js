// api/attempt.js
export default async function handler(req, res) {
  const ALLOW = new Set([
    "https://prh3j3.csb.app",
    "https://luxurylanguagelearninglab.com",
    "https://luxury-language-api.vercel.app",
  ]);
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOW.has(origin) ? origin : "*"; // tighten if you want

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  // TODO: validate + write to DB (or just ack for now)
  return res.status(200).json({ ok: true });
}
