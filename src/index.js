/**
 * 📰 News & Economic Calendar Analyst Bot — Cloudflare Workers edition
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * v2.2 — Perubahan dari v2.1:
 * 1. FOMC & ECB sekarang HARDCODE dari kalender resmi (federalreserve.gov,
 *    ecb.europa.eu) - bukan hasil search lagi. Ini event yang jadwalnya udah
 *    diumumin resmi jauh-jauh hari, jadi gak ada alasan nembak API buat ini.
 * 2. NFP dihitung otomatis (selalu Jumat pertama tiap bulan, 8:30 AM ET).
 * 3. CPI/PPI & event kripto TETAP pakai search (emang gak bisa dipastikan
 *    tanpa berita terkini) - tapi sekarang Groq CUMA diminta cari tanggalnya,
 *    jam rilisnya (8:30 AM ET, konvensi BLS) dihitung kode secara deterministik.
 * 4. Konversi timezone ET/CET → WIB sekarang dihitung kode (ngerti DST
 *    otomatis), bukan dipercayakan ke perhitungan manual Groq lagi.
 * 5. Kalau semua API key Groq kena rate limit, bot kasih pesan jelas
 *    ("coba lagi besok") bukan error mentah.
 *
 * PENTING: LLM tidak punya akses internet bawaan - makanya event yang TIDAK
 * bisa dihardcode (CPI/PPI persis, berita kripto) WAJIB disuntik data hasil
 * pencarian web dulu (Serper.dev), bukan ditanya langsung ke AI.
 *
 * State per-user disimpan di Cloudflare KV (BOT_KV). Jadwal kripto/CPI/PPI
 * di-cache global selama 6 jam. Jadwal FOMC/ECB/NFP gak perlu cache (murah,
 * dihitung on-the-fly tiap request).
 */

const MODEL = "llama-3.3-70b-versatile";
const SCHEDULE_CACHE_KEY = "news_schedule_cache_v2"; // versi baru, cache lama otomatis basi
const SCHEDULE_CACHE_TTL = 6 * 60 * 60; // 6 jam

// ══════════════════════════════════════════════════════════
//  ENTRY POINT
// ══════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Bot is alive.", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      ctx.waitUntil(handleUpdate(update, env));
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ══════════════════════════════════════════════════════════
//  WHITELIST
// ══════════════════════════════════════════════════════════
function isAllowed(uid, env) {
  const raw = (env.ALLOWED_USER_IDS || "").trim();
  if (!raw) return true;
  const ids = raw.split(",").map((x) => x.trim());
  return ids.includes(String(uid));
}

// ══════════════════════════════════════════════════════════
//  TELEGRAM API HELPERS
// ══════════════════════════════════════════════════════════
async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendMessage(env, chatId, text, extra = {}) {
  const chunks = [];
  let t = text;
  while (t.length > 4000) {
    chunks.push(t.slice(0, 4000));
    t = t.slice(4000);
  }
  chunks.push(t);
  let last;
  for (const c of chunks) {
    last = await tg(env, "sendMessage", { chat_id: chatId, text: c, parse_mode: "Markdown", ...extra });
  }
  return last;
}

async function editMessageText(env, chatId, messageId, text, extra = {}) {
  return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", ...extra });
}

async function answerCallback(env, callbackId, text) {
  return tg(env, "answerCallbackQuery", { callback_query_id: callbackId, text });
}

// ══════════════════════════════════════════════════════════
//  SESSION (Cloudflare KV)
// ══════════════════════════════════════════════════════════
async function getSession(env, uid) {
  const raw = await env.BOT_KV.get(`session:${uid}`);
  if (raw) return JSON.parse(raw);
  return { state: "idle", schedule: [], last_opinions: [], last_event: null };
}

async function saveSession(env, uid, s) {
  await env.BOT_KV.put(`session:${uid}`, JSON.stringify(s), { expirationTtl: 60 * 60 * 24 * 7 }); // 7 hari
}

// ══════════════════════════════════════════════════════════
//  KEYBOARDS
// ══════════════════════════════════════════════════════════
function mainKb() {
  return {
    keyboard: [
      ["📅 Jadwal News", "📰 Analisa News"],
      ["❓ Bantuan"],
    ],
    resize_keyboard: true,
  };
}

function aiCountKb(idx) {
  return {
    inline_keyboard: [
      [
        { text: "⚡ 5 AI (lebih cepat)", callback_data: `an_5_${idx}` },
        { text: "🧠 10 AI (lebih teliti)", callback_data: `an_10_${idx}` },
      ],
    ],
  };
}
// Catatan: "N AI" = N total panggilan AI (N-1 analis independen + 1 yang menyimpulkan).

// ══════════════════════════════════════════════════════════
//  TIMEZONE HELPERS — konversi deterministik, ngerti DST otomatis
//  (Ini yang bikin jam gak perlu ditebak-tebak AI lagi)
// ══════════════════════════════════════════════════════════
function nthWeekdayOfMonth(year, month, weekday, nth) {
  // month: 1-indexed, weekday: 0=Sunday
  const d = new Date(Date.UTC(year, month - 1, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) {
      count++;
      if (count === nth) return d;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(Date.UTC(year, month, 0)); // hari terakhir bulan itu
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function isUSDST(dateUTC) {
  // AS: DST mulai Minggu ke-2 Maret, berakhir Minggu ke-1 November
  const year = dateUTC.getUTCFullYear();
  const start = nthWeekdayOfMonth(year, 3, 0, 2);
  const end = nthWeekdayOfMonth(year, 11, 0, 1);
  return dateUTC >= start && dateUTC < end;
}

function isEUDST(dateUTC) {
  // Eropa: DST mulai Minggu terakhir Maret, berakhir Minggu terakhir Oktober
  const year = dateUTC.getUTCFullYear();
  const start = lastWeekdayOfMonth(year, 3, 0);
  const end = lastWeekdayOfMonth(year, 10, 0);
  return dateUTC >= start && dateUTC < end;
}

// dateStr format "YYYY-MM-DD" (tanggal LOKAL di zona itu), hour/minute jam lokal
function etToWIB(dateStr, hour, minute) {
  const refUTC = new Date(`${dateStr}T12:00:00Z`);
  const offsetET = isUSDST(refUTC) ? -4 : -5; // EDT / EST
  const eventUTC = new Date(`${dateStr}T00:00:00Z`);
  eventUTC.setUTCHours(hour - offsetET, minute, 0, 0);
  return new Date(eventUTC.getTime() + 7 * 3600 * 1000); // WIB = UTC+7
}

function cetToWIB(dateStr, hour, minute) {
  const refUTC = new Date(`${dateStr}T12:00:00Z`);
  const offsetCET = isEUDST(refUTC) ? 2 : 1; // CEST / CET
  const eventUTC = new Date(`${dateStr}T00:00:00Z`);
  eventUTC.setUTCHours(hour - offsetCET, minute, 0, 0);
  return new Date(eventUTC.getTime() + 7 * 3600 * 1000);
}

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function fmtWIBDate(wibDate) {
  return `${wibDate.getUTCDate()} ${MONTH_NAMES[wibDate.getUTCMonth()]}`;
}
function fmtWIBTime(wibDate) {
  const h = String(wibDate.getUTCHours()).padStart(2, "0");
  const m = String(wibDate.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// ══════════════════════════════════════════════════════════
//  JADWAL MACRO YANG SUDAH PASTI (hardcode dari kalender resmi)
//  Sumber: federalreserve.gov/monetarypolicy/fomccalendars.htm
//          ecb.europa.eu (Governing Council monetary policy meetings)
//  Update manual kalau ada jadwal baru diumumin / tahun berganti.
// ══════════════════════════════════════════════════════════
const FOMC_MEETINGS = [
  { start: "2026-01-27", end: "2026-01-28" },
  { start: "2026-03-17", end: "2026-03-18" },
  { start: "2026-04-28", end: "2026-04-29" },
  { start: "2026-06-16", end: "2026-06-17" },
  { start: "2026-07-28", end: "2026-07-29" },
  { start: "2026-09-15", end: "2026-09-16" },
  { start: "2026-10-27", end: "2026-10-28" },
  { start: "2026-12-08", end: "2026-12-09" },
  { start: "2027-01-26", end: "2027-01-27" },
  { start: "2027-03-16", end: "2027-03-17" },
  { start: "2027-04-27", end: "2027-04-28" },
  { start: "2027-06-08", end: "2027-06-09" },
  { start: "2027-07-27", end: "2027-07-28" },
  { start: "2027-09-14", end: "2027-09-15" },
  { start: "2027-10-26", end: "2027-10-27" },
  { start: "2027-12-07", end: "2027-12-08" },
];

// Catatan: daftar ECB 2026 di bawah belum lengkap 8 meeting (baru ketemu 7
// dari sumber yang saya cek), kemungkinan ada 1 meeting awal tahun yang belum
// ke-capture. Kalau nemu jadwal lengkapnya, tambahin di sini.
const ECB_MEETINGS = [
  "2026-03-19", "2026-04-30", "2026-06-11", "2026-07-23",
  "2026-09-10", "2026-10-29", "2026-12-17",
];

function getHardcodedMacroEvents(daysAhead = 45) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 86400000);
  const events = [];

  for (const m of FOMC_MEETINGS) {
    const wib = etToWIB(m.end, 14, 0); // statement dirilis 2:00 PM ET hari terakhir meeting
    if (wib >= now && wib <= cutoff) {
      events.push({ date: fmtWIBDate(wib), time_wib: fmtWIBTime(wib), event: "FOMC Meeting (Keputusan Suku Bunga The Fed)", category: "macro", _sort: wib.getTime() });
    }
  }

  for (const d of ECB_MEETINGS) {
    const wib = cetToWIB(d, 13, 45);
    if (wib >= now && wib <= cutoff) {
      events.push({ date: fmtWIBDate(wib), time_wib: fmtWIBTime(wib), event: "ECB Rate Decision (Keputusan Suku Bunga Bank Eropa)", category: "macro", _sort: wib.getTime() });
    }
  }

  // NFP: selalu Jumat pertama tiap bulan, 8:30 AM ET
  for (let i = 0; i < 3; i++) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const firstFriday = nthWeekdayOfMonth(target.getUTCFullYear(), target.getUTCMonth() + 1, 5, 1);
    const dateStr = firstFriday.toISOString().slice(0, 10);
    const wib = etToWIB(dateStr, 8, 30);
    if (wib >= now && wib <= cutoff) {
      events.push({ date: fmtWIBDate(wib), time_wib: fmtWIBTime(wib), event: "Nonfarm Payrolls (NFP) AS", category: "macro", _sort: wib.getTime() });
    }
  }

  return events;
}

// ══════════════════════════════════════════════════════════
//  SERPER.DEV — WEB & NEWS SEARCH (buat yang GAK bisa dihardcode)
// ══════════════════════════════════════════════════════════
async function serperSearch(env, query, endpoint = "search", num = 10) {
  if (!env.SERPER_API_KEY) throw new Error("SERPER_API_KEY belum di-set di Cloudflare Secrets.");
  const res = await fetch(`https://google.serper.dev/${endpoint}`, {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num, gl: "id", hl: "id" }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Serper response bukan JSON (HTTP ${res.status}). Cuplikan: ${raw.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

function extractItems(result, type) {
  const list = type === "news" ? (result?.news || []) : (result?.organic || []);
  return list.map((o) => ({
    title: o.title,
    snippet: o.snippet || "",
    date: o.date || null,
    source: o.link || o.source || "?",
  }));
}

// ══════════════════════════════════════════════════════════
//  GROQ
// ══════════════════════════════════════════════════════════
function getGroqKeys(env) {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  if (!keys.length && env.GROQ_API_KEY) keys.push(env.GROQ_API_KEY);
  return keys;
}

async function callGroqIndexed(env, idx, messages, maxTokens = 1200, temperature = 0.5) {
  const keys = getGroqKeys(env);
  if (!keys.length) throw new Error("Tidak ada GROQ_API_KEY yang di-set");
  const total = keys.length;
  let i = idx % total;
  let tried = 0;
  let rateLimitCount = 0;
  let lastErr;
  while (tried < total) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[i]}` },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
      });
      if (res.status === 429) {
        rateLimitCount++;
        throw new Error("rate_limit");
      }
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e;
      tried++;
      i = (i + 1) % total;
    }
  }
  if (rateLimitCount === total) {
    const err = new Error("Semua API key Groq kena rate limit.");
    err.isRateLimit = true;
    throw err;
  }
  throw new Error(`Semua key Groq gagal (panggilan #${idx + 1}): ${lastErr}`);
}

// Helper: format pesan error jadi ramah kalau rate limit, biasa kalau bukan
function friendlyErrorMessage(e, context) {
  if (e.isRateLimit) {
    return `🚫 *Limit Groq API tercapai*\n\nSemua API key Groq lagi kena rate limit. Biasanya reset per jam atau per hari tergantung tier akun Groq kamu.\n\n💡 Coba lagi beberapa jam lagi atau besok ya.`;
  }
  return `❌ Gagal ${context}: ${e.message}`;
}

// ══════════════════════════════════════════════════════════
//  JADWAL NEWS — gabungan hardcode (FOMC/ECB/NFP) + search (CPI/PPI/kripto)
// ══════════════════════════════════════════════════════════
const DATE_ONLY_SYSTEM_PROMPT = `Kamu asisten yang mengekstrak TANGGAL RILIS event ekonomi dari hasil pencarian web mentah.
ATURAN KETAT:
- Balas HANYA dengan JSON array valid. TIDAK ADA teks lain, TIDAK ADA markdown code fence.
- Format tiap item persis: {"date_iso":"YYYY-MM-DD","event":"Nama event singkat (CPI AS / PPI AS)"}
- JANGAN sertakan jam - itu akan dihitung terpisah oleh kode.
- KALAU data mentah tidak menyebutkan tanggal yang jelas, JANGAN masukkan event itu. Jangan mengarang tanggal.
- Kalau data mentah sama sekali tidak cukup, balas array kosong: []`;

const CRYPTO_SYSTEM_PROMPT = `Kamu asisten yang menyusun daftar event kripto (regulasi, ETF, listing besar, upgrade jaringan) dari hasil pencarian web mentah.
ATURAN KETAT:
- Balas HANYA dengan JSON array valid. TIDAK ADA teks lain, TIDAK ADA markdown code fence.
- Format tiap item persis: {"date":"DD Bulan","time_wib":"HH:MM" atau "-","event":"Nama event singkat"}
- "time_wib" WAJIB format 24 jam, dikonversi ke WIB (UTC+7) kalau sumber nyebut jam dengan jelas. Kalau gak jelas, isi "-".
- KALAU data mentah tidak menyebutkan tanggal yang jelas, JANGAN masukkan event itu. Jangan mengarang tanggal.
- Ambil maksimal 6 event yang paling relevan/penting.
- Kalau data mentah sama sekali tidak cukup, balas array kosong: []`;

async function getCpiPpiEvents(env) {
  const now = new Date();
  const monthYear = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const result = await serperSearch(env, `CPI PPI inflation release date ${monthYear} BLS`, "search", 6).catch(() => null);
  if (!result) return [];

  const items = extractItems(result, "search");
  if (!items.length) return [];

  const rawItems = items.map((o) => `- ${o.title}: ${o.snippet} (${o.date || "tanggal tidak disebutkan"}) [sumber: ${o.source}]`).join("\n");
  const userMsg = `Hari ini: ${now.toISOString().slice(0, 10)}.\n\nHasil pencarian:\n${rawItems}`;

  const raw = await callGroqIndexed(env, 0, [{ role: "system", content: DATE_ONLY_SYSTEM_PROMPT }, { role: "user", content: userMsg }], 500, 0.1);

  let list;
  try {
    list = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!Array.isArray(list)) return [];
  } catch (e) {
    return [];
  }

  return list
    .map((it) => {
      if (!it.date_iso) return null;
      const wib = etToWIB(it.date_iso, 8, 30); // konvensi BLS: selalu 8:30 AM ET
      return { date: fmtWIBDate(wib), time_wib: fmtWIBTime(wib), event: it.event, category: "macro", _sort: wib.getTime() };
    })
    .filter(Boolean);
}

async function getCryptoEvents(env) {
  const now = new Date();
  const monthYear = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

  const results = await Promise.all([
    serperSearch(env, `crypto regulation ETF news ${monthYear}`, "news", 6).catch(() => null),
    serperSearch(env, `jadwal event kripto ${monthYear} SEC bitcoin ethereum`, "news", 6).catch(() => null),
  ]);

  const rawLines = [];
  results.forEach((r) => {
    if (!r) return;
    extractItems(r, "news").forEach((o) => {
      rawLines.push(`- ${o.title}: ${o.snippet} (${o.date || "tanggal tidak disebutkan"}) [sumber: ${o.source}]`);
    });
  });

  if (!rawLines.length) return [];

  const userMsg = `Hari ini: ${now.toISOString().slice(0, 10)}.\n\nHasil pencarian:\n${rawLines.join("\n")}`;
  const raw = await callGroqIndexed(env, 1, [{ role: "system", content: CRYPTO_SYSTEM_PROMPT }, { role: "user", content: userMsg }], 1000, 0.2);

  try {
    const list = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!Array.isArray(list)) return [];
    return list.map((it) => ({ ...it, category: "crypto", _sort: 0 }));
  } catch (e) {
    return [];
  }
}

async function buildScheduleList(env, forceRefresh = false) {
  const macroHardcoded = getHardcodedMacroEvents(); // selalu fresh, murah, gak perlu cache

  if (!forceRefresh) {
    const cacheRaw = await env.BOT_KV.get(SCHEDULE_CACHE_KEY);
    if (cacheRaw) {
      try {
        const cached = JSON.parse(cacheRaw);
        if (Array.isArray(cached.searchDerived)) {
          return mergeAndSort(macroHardcoded, cached.searchDerived);
        }
      } catch (e) { /* cache korup, lanjut rebuild */ }
    }
  }

  const [cpiPpi, crypto] = await Promise.all([
    getCpiPpiEvents(env).catch(() => []),
    getCryptoEvents(env).catch(() => []),
  ]);
  const searchDerived = [...cpiPpi, ...crypto];

  if (searchDerived.length > 0) {
    await env.BOT_KV.put(SCHEDULE_CACHE_KEY, JSON.stringify({ searchDerived, ts: Date.now() }), { expirationTtl: SCHEDULE_CACHE_TTL });
  }

  return mergeAndSort(macroHardcoded, searchDerived);
}

function mergeAndSort(macroHardcoded, searchDerived) {
  const all = [...macroHardcoded, ...searchDerived];
  all.sort((a, b) => (a._sort || 0) - (b._sort || 0));
  return all.slice(0, 15);
}

function scheduleText(list) {
  if (!list.length) return "📭 Belum ada jadwal event yang berhasil ditemukan. Coba lagi beberapa saat lagi.";
  const lines = ["📅 *JADWAL NEWS TERDEKAT* (waktu WIB)\n"];
  list.forEach((it, i) => {
    const jam = it.time_wib && it.time_wib !== "-" ? `${it.time_wib} WIB` : "jam belum diketahui";
    const tag = it.category === "crypto" ? "🪙" : "🏛️";
    lines.push(`${i + 1}. ${tag} *${it.date}, ${jam}* — ${it.event}`);
  });
  lines.push("\n_🏛️ = data pasti (kalender resmi) · 🪙 = hasil pencarian berita, cek ulang di sumber resmi._");
  return lines.join("\n");
}

function scheduleKb(list) {
  const rows = list.map((it, i) => {
    const jam = it.time_wib && it.time_wib !== "-" ? ` ${it.time_wib}` : "";
    return [{ text: `${it.date}${jam} — ${it.event}`.slice(0, 60), callback_data: `ev_${i}` }];
  });
  rows.push([{ text: "🔄 Refresh Jadwal", callback_data: "refresh_schedule" }]);
  return { inline_keyboard: rows };
}

// ══════════════════════════════════════════════════════════
//  ANALISA NEWS — voting N AI + 1 kesimpulan
// ══════════════════════════════════════════════════════════
const NEWS_ANALYST_PROMPT = `Kamu adalah analis berita ekonomi & pasar profesional.
Berdasarkan KUMPULAN CUPLIKAN BERITA yang diberikan user (bukan pengetahuanmu sendiri), analisa dampak event tersebut ke market (forex/crypto/saham, sesuai relevansi).
JANGAN mengarang angka atau fakta yang tidak ada di cuplikan. Kalau cuplikannya minim, katakan itu terus terang.

FORMAT OUTPUT WAJIB (Bahasa Indonesia, singkat padat):
📰 Ringkasan     : [1-2 kalimat inti berita]
📊 Sentimen      : Bullish 🟢 / Bearish 🔴 / Netral ⚪
💥 Dampak Market : [1-2 kalimat]`;

function newsConsensusPrompt(n) {
  return `Kamu adalah Chief News Analyst yang mengawasi ${n} analis berita independen yang sudah menganalisa event yang sama.
Tugasmu MENYIMPULKAN, bukan membuat analisa baru:
1. Tentukan sentimen tiap analisis: Bullish, Bearish, atau Netral. Abaikan yang error.
2. Hitung suara tiap sentimen. Suara terbanyak = kesimpulan final. Kalau seri → Netral.
3. Ringkas dampak market yang paling sering disebut, sebutkan kalau ada perbedaan pendapat signifikan.

FORMAT OUTPUT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 KESIMPULAN ANALISA NEWS (${n} AI)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📰 Event      : [nama event]
📊 Voting     : Bullish [n] | Bearish [n] | Netral [n]
🏆 Sentimen   : Bullish 🟢 / Bearish 🔴 / Netral ⚪
💥 Dampak     : [ringkas]
📝 Kesimpulan :
[Maksimal 5 kalimat Bahasa Indonesia.]
⚠️ Catatan    : Ini konsensus dari ${n} panggilan model AI yang SAMA dengan variasi random sampling,
bukan ${n} model berbeda — anggap sebagai pengecekan konsistensi, bukan validasi independen penuh.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

async function analyzeEvent(env, event, nTotal) {
  const nOpinions = Math.max(1, nTotal - 1);

  let newsData = await serperSearch(env, `${event.event} dampak market analisis`, "news", 10);
  let newsItems = newsData.news || [];
  if (!newsItems.length) {
    const webData = await serperSearch(env, `${event.event} berita terbaru analisis market`, "search", 10);
    newsItems = webData.organic || [];
  }

  const items = newsItems
    .slice(0, 10)
    .map((o) => `- [${o.date || "?"}] ${o.title}: ${o.snippet || ""} (sumber: ${o.source || o.link || "?"})`)
    .join("\n");

  if (!items) throw new Error("Tidak menemukan cuplikan berita terkait event ini, coba lagi nanti atau pilih event lain.");

  const basePrompt = `EVENT: ${event.event} (${event.date})\n\nCUPLIKAN BERITA TERKAIT (hasil pencarian):\n${items}\n\nAnalisa dampak event ini ke market berdasarkan cuplikan di atas.`;

  const oneOpinion = async (idx) => {
    const temp = 0.4 + (idx % 5) * 0.1;
    try {
      return await callGroqIndexed(
        env, idx,
        [{ role: "system", content: NEWS_ANALYST_PROMPT }, { role: "user", content: basePrompt }],
        700, temp
      );
    } catch (e) {
      if (e.isRateLimit) return `[RATE_LIMIT AI #${idx + 1}]`;
      return `[ERROR AI #${idx + 1}: ${e}]`;
    }
  };

  const opinions = await Promise.all(Array.from({ length: nOpinions }, (_, i) => oneOpinion(i)));

  const allRateLimited = opinions.every((op) => op.startsWith("[RATE_LIMIT"));
  if (allRateLimited) {
    const err = new Error("Semua API key Groq kena rate limit.");
    err.isRateLimit = true;
    throw err;
  }

  let consensusInput = `Berikut ${nOpinions} analisis independen untuk event yang sama:\n\n`;
  opinions.forEach((op, i) => {
    consensusInput += `=== ANALIS #${i + 1} ===\n${op}\n\n`;
  });
  consensusInput += `Event: ${event.event} (${event.date})\nSimpulkan sesuai instruksi sistem.`;

  const final = await callGroqIndexed(
    env, nOpinions,
    [{ role: "system", content: newsConsensusPrompt(nOpinions) }, { role: "user", content: consensusInput }],
    1200, 0.3
  );
  return { final, opinions };
}

// ══════════════════════════════════════════════════════════
//  UPDATE ROUTER
// ══════════════════════════════════════════════════════════
async function handleUpdate(update, env) {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query, env);
    if (update.message?.text) return await handleMessage(update.message, env);
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const uid = message.from.id;
  const txt = (message.text || "").trim();
  const s = await getSession(env, uid);

  if (!isAllowed(uid, env)) {
    await sendMessage(env, chatId, `🔒 Akses ditolak. User ID kamu: \`${uid}\``);
    return;
  }

  if (txt === "/start") {
    Object.assign(s, { state: "idle", schedule: [], last_opinions: [], last_event: null });
    await saveSession(env, uid, s);
    await sendMessage(
      env, chatId,
      `📰 *NEWS & ECONOMIC CALENDAR ANALYST BOT*\n\nHalo *${message.from.first_name}*!\n\n` +
      `Bot ini bantu kamu pantau jadwal event ekonomi & kripto penting dan analisa dampaknya ke market pakai konsensus beberapa AI.\n\n` +
      `⚠️ Hanya alat bantu analisis, bukan nasihat finansial. Selalu cek ulang ke sumber resmi.\n\nPilih menu di bawah:`,
      { reply_markup: mainKb() }
    );
    return;
  }

  if (txt === "/help" || txt === "❓ Bantuan") {
    await sendMessage(env, chatId,
      "❓ *BANTUAN*\n\n" +
      "📅 *Jadwal News* → lihat daftar event ekonomi & kripto terdekat. FOMC/ECB/NFP diambil dari kalender resmi (pasti akurat), CPI/PPI/kripto dari hasil pencarian berita terkini.\n\n" +
      "📰 *Analisa News* → sama seperti Jadwal News, tapi tiap event bisa di-tap. Pilih 5 atau 10 AI, bot akan cari berita terkait event itu dan menyimpulkan sentimen/dampaknya ke market.\n\n" +
      "Data CPI/PPI/kripto di-cache 6 jam. Tap '🔄 Refresh Jadwal' kalau mau paksa update."
    );
    return;
  }

  if (txt === "📅 Jadwal News") {
    await sendMessage(env, chatId, "⏳ Mencari jadwal event terbaru...");
    try {
      const list = await buildScheduleList(env);
      s.schedule = list;
      await saveSession(env, uid, s);
      await sendMessage(env, chatId, scheduleText(list));
    } catch (e) {
      await sendMessage(env, chatId, friendlyErrorMessage(e, "ambil jadwal"));
    }
    return;
  }

  if (txt === "📰 Analisa News") {
    await sendMessage(env, chatId, "⏳ Mencari jadwal event terbaru...");
    try {
      const list = await buildScheduleList(env);
      s.schedule = list;
      await saveSession(env, uid, s);
      if (!list.length) {
        await sendMessage(env, chatId, "📭 Belum ada jadwal event yang bisa dianalisa saat ini. Coba lagi nanti.");
        return;
      }
      await sendMessage(env, chatId, "📰 *ANALISA NEWS*\n\nTap salah satu event buat dianalisa:", { reply_markup: scheduleKb(list) });
    } catch (e) {
      await sendMessage(env, chatId, friendlyErrorMessage(e, "ambil jadwal"));
    }
    return;
  }

  await sendMessage(env, chatId, "💡 Pilih menu dari keyboard, atau ketik /start.", { reply_markup: mainKb() });
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const uid = cb.from.id;
  const data = cb.data;
  const s = await getSession(env, uid);

  if (!isAllowed(uid, env)) { await answerCallback(env, cb.id, "🔒 Akses ditolak."); return; }
  await answerCallback(env, cb.id, "");

  if (data === "refresh_schedule") {
    await editMessageText(env, chatId, cb.message.message_id, "⏳ Refreshing jadwal...");
    try {
      const list = await buildScheduleList(env, true);
      s.schedule = list;
      await saveSession(env, uid, s);
      await editMessageText(env, chatId, cb.message.message_id, "📰 *ANALISA NEWS*\n\nTap salah satu event buat dianalisa:", { reply_markup: scheduleKb(list) });
    } catch (e) {
      await editMessageText(env, chatId, cb.message.message_id, friendlyErrorMessage(e, "refresh"));
    }
    return;
  }

  if (data.startsWith("ev_")) {
    const idx = parseInt(data.slice(3), 10);
    const event = s.schedule[idx];
    if (!event) {
      await sendMessage(env, chatId, "⚠️ Jadwal ini sudah kadaluarsa, buka lagi '📰 Analisa News'.");
      return;
    }
    const jam = event.time_wib && event.time_wib !== "-" ? `, ${event.time_wib} WIB` : "";
    await sendMessage(env, chatId, `📌 *${event.date}${jam} — ${event.event}*\n\nMau dianalisa pakai berapa AI?`, { reply_markup: aiCountKb(idx) });
    return;
  }

  if (data.startsWith("an_")) {
    const [, nStr, idxStr] = data.split("_");
    const n = parseInt(nStr, 10);
    const idx = parseInt(idxStr, 10);
    const event = s.schedule[idx];
    if (!event) {
      await sendMessage(env, chatId, "⚠️ Jadwal ini sudah kadaluarsa, buka lagi '📰 Analisa News'.");
      return;
    }
    await sendMessage(env, chatId, `⏳ Menjalankan ${n} AI (${n - 1} analis + 1 kesimpulan) untuk *${event.event}*... (~10-20 detik)`);
    try {
      const { final } = await analyzeEvent(env, event, n);
      s.last_event = event;
      await saveSession(env, uid, s);
      await sendMessage(env, chatId, final, { reply_markup: mainKb() });
    } catch (e) {
      await sendMessage(env, chatId, friendlyErrorMessage(e, "analisa"), { reply_markup: mainKb() });
    }
    return;
  }
}
