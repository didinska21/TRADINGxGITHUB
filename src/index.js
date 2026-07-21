/**
 * 📰 News & Economic Calendar Analyst Bot — Cloudflare Workers edition
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * v2.4 — Perubahan dari v2.3 (bugfix jadwal nampilin berita LAMA):
 * 1. BUG UTAMA: event crypto yang tanggalnya sudah lewat dulu "diproyeksikan
 *    ke tahun depan" (guess < now → yr += 1), jadi berita LAMA (mis. "harga
 *    BTC turun 25 Juni") ikut lolos filter dan nongol sebagai "akan datang".
 *    FIX: tanggal yang sudah lewat sekarang LANGSUNG DIBUANG, tidak pernah
 *    diproyeksikan ke tahun depan. Event sekali-kejadian (crypto) tidak
 *    butuh logic "tahunan berulang" seperti itu.
 * 2. Prompt crypto diperketat: AI hanya boleh masukkan tanggal yang memang
 *    berupa JADWAL/DEADLINE MENDATANG (keputusan SEC, listing, upgrade),
 *    BUKAN rekap harga/kejadian yang sudah terjadi — walau tanggalnya
 *    disebut jelas di cuplikan berita.
 * 3. Query pencarian crypto diganti dari "news {bulan}" (nyari rekap berita)
 *    jadi diarahkan ke jadwal/deadline mendatang.
 * 4. Kegagalan scrape kalender resmi (macro) sekarang di-log via
 *    console.error dengan detail per-sumber, supaya kelihatan di
 *    `wrangler tail` kenapa macro sering kosong — sebelumnya ditelan diam²
 *    lewat catch(() => []).
 * 5. Safety net tambahan: item macro & crypto yang tanggalnya sudah lewat
 *    dibuang lagi sekali di tahap gabung (mergeAndSort), jaga-jaga kalau
 *    ada yang lolos dari filter individual.
 *
 * State per-user disimpan di Cloudflare KV (BOT_KV). Jadwal (macro + kripto)
 * di-cache global 6 jam supaya hemat kuota scrape/search.
 */

const MODEL = "llama-3.3-70b-versatile";
const SCHEDULE_CACHE_KEY = "news_schedule_cache_v4";
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
// ══════════════════════════════════════════════════════════
function nthWeekdayOfMonth(year, month, weekday, nth) {
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
  const d = new Date(Date.UTC(year, month, 0));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function isUSDST(dateUTC) {
  const year = dateUTC.getUTCFullYear();
  const start = nthWeekdayOfMonth(year, 3, 0, 2);
  const end = nthWeekdayOfMonth(year, 11, 0, 1);
  return dateUTC >= start && dateUTC < end;
}

function isEUDST(dateUTC) {
  const year = dateUTC.getUTCFullYear();
  const start = lastWeekdayOfMonth(year, 3, 0);
  const end = lastWeekdayOfMonth(year, 10, 0);
  return dateUTC >= start && dateUTC < end;
}

function etToWIB(dateStr, hour, minute) {
  const refUTC = new Date(`${dateStr}T12:00:00Z`);
  const offsetET = isUSDST(refUTC) ? -4 : -5;
  const eventUTC = new Date(`${dateStr}T00:00:00Z`);
  eventUTC.setUTCHours(hour - offsetET, minute, 0, 0);
  return new Date(eventUTC.getTime() + 7 * 3600 * 1000);
}

function cetToWIB(dateStr, hour, minute) {
  const refUTC = new Date(`${dateStr}T12:00:00Z`);
  const offsetCET = isEUDST(refUTC) ? 2 : 1;
  const eventUTC = new Date(`${dateStr}T00:00:00Z`);
  eventUTC.setUTCHours(hour - offsetCET, minute, 0, 0);
  return new Date(eventUTC.getTime() + 7 * 3600 * 1000);
}

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const MONTH_MAP = { Januari: 0, Februari: 1, Maret: 2, April: 3, Mei: 4, Juni: 5, Juli: 6, Agustus: 7, September: 8, Oktober: 9, November: 10, Desember: 11 };

function fmtWIBDate(wibDate) {
  return `${wibDate.getUTCDate()} ${MONTH_NAMES[wibDate.getUTCMonth()]}`;
}
function fmtWIBTime(wibDate) {
  const h = String(wibDate.getUTCHours()).padStart(2, "0");
  const m = String(wibDate.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// Awal hari ini (UTC) — dipakai sebagai batas bawah "sudah lewat vs akan datang".
// Pakai awal HARI, bukan jam-menit sekarang, supaya event "hari ini" tetap muncul.
function startOfTodayUTC(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ══════════════════════════════════════════════════════════
//  SERPER.DEV — SEARCH, NEWS & SCRAPE
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

async function serperScrape(env, url) {
  if (!env.SERPER_API_KEY) throw new Error("SERPER_API_KEY belum di-set.");
  const res = await fetch("https://scrape.serper.dev", {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Scrape response bukan JSON (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`Scrape HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.text || data.markdown || "";
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

function friendlyErrorMessage(e, context) {
  if (e.isRateLimit) {
    return `🚫 *Limit Groq API tercapai*\n\nSemua API key Groq lagi kena rate limit. Biasanya reset per jam atau per hari tergantung tier akun Groq kamu.\n\n💡 Coba lagi beberapa jam lagi atau besok ya.`;
  }
  return `❌ Gagal ${context}: ${e.message}`;
}

// ══════════════════════════════════════════════════════════
//  MACRO EVENTS — scrape LANGSUNG dari halaman kalender resmi
//  (bukan hardcode, bukan search snippet - baca isi asli halamannya)
// ══════════════════════════════════════════════════════════
const MACRO_SOURCES = [
  { name: "FOMC Meeting Calendar (federalreserve.gov, resmi)", url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" },
  { name: "ECB Governing Council Meetings (ecb.europa.eu, resmi)", url: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html" },
];

function blsScheduleUrl(year) {
  return `https://www.bls.gov/schedule/news_release/${year}_sched.htm`;
}

const MACRO_SCRAPE_PROMPT = `Kamu asisten yang mengekstrak jadwal event ekonomi dari ISI ASLI halaman kalender resmi (bukan hasil search, ini konten asli halaman).
ATURAN KETAT:
- Balas HANYA dengan JSON array valid. TIDAK ADA teks lain, TIDAK ADA markdown code fence.
- Format tiap item persis: {"date_iso":"YYYY-MM-DD","event":"Nama event (FOMC Meeting / ECB Rate Decision / CPI / PPI / Nonfarm Payrolls)","time_local":"HH:MM" atau null,"tz":"ET" atau "CET" atau null}
- Ambil SEMUA tanggal event yang kamu temukan di konten, termasuk yang jauh di masa depan - kode yang akan filter mana yang relevan.
- "time_local" isi HANYA kalau memang tertulis jelas di halaman. Kalau gak ada, isi null - JANGAN mengarang.
- Untuk FOMC: event = "FOMC Meeting", ambil tanggal HARI TERAKHIR tiap meeting (biasanya meeting 2 hari, ambil hari ke-2).
- Untuk ECB: event = "ECB Rate Decision".
- Untuk BLS: pisahkan jadi 3 kategori event berbeda: "CPI" (Consumer Price Index), "PPI" (Producer Price Index), "Nonfarm Payrolls" (Employment Situation).
- Kalau suatu sumber gagal/kosong, skip aja, jangan mengarang datanya.
- Balas array kosong [] kalau semua sumber gagal/gak ada data valid.`;

async function getMacroEventsFromScrape(env) {
  const now = new Date();
  const sources = [...MACRO_SOURCES, { name: "BLS Economic Release Schedule (bls.gov, resmi - CPI/PPI/NFP)", url: blsScheduleUrl(now.getUTCFullYear()) }];

  const scraped = await Promise.all(
    sources.map((s) =>
      serperScrape(env, s.url)
        .then((text) => ({ ...s, text }))
        .catch((e) => ({ ...s, text: null, error: e.message }))
    )
  );

  // Log tiap kegagalan scrape per-sumber, supaya kelihatan jelas di `wrangler tail`
  // kenapa macro kosong (URL berubah, diblokir, dsb) — sebelumnya ditelan diam-diam.
  // Juga log PANJANG konten yang berhasil di-scrape — kalau angkanya kecil/pas-pasan
  // di limit character, itu tanda kontennya kemungkinan terpotong sebelum sampai ke
  // tabel tanggal asli (banyak halaman resmi punya nav/breadcrumb panjang di atas).
  scraped.forEach((s) => {
    if (!s.text) console.error(`[MACRO SCRAPE FAIL] ${s.name} (${s.url}): ${s.error || "kosong tanpa error message"}`);
    else console.log(`[MACRO SCRAPE OK] ${s.name}: ${s.text.length} karakter`);
  });

  // FIX: sebelumnya cuma ambil 4500 karakter pertama per sumber — banyak halaman
  // kalender resmi punya nav/header/breadcrumb panjang duluan sebelum tabel tanggal
  // aslinya, jadi tabelnya kepotong dan gak ke-extract (ini penyebab FOMC/BLS sering
  // kosong). Model Groq yang dipakai context window-nya besar, aman dinaikkan jauh.
  const PER_SOURCE_CHAR_LIMIT = 15000;
  const rawSections = scraped
    .filter((s) => s.text)
    .map((s) => `=== SUMBER RESMI: ${s.name} ===\n${s.text.slice(0, PER_SOURCE_CHAR_LIMIT)}`)
    .join("\n\n");

  if (!rawSections) {
    console.error("[MACRO] Semua sumber gagal di-scrape, tidak ada data macro yang bisa diekstrak.");
    return [];
  }

  const userMsg = `Hari ini: ${now.toISOString().slice(0, 10)} (YYYY-MM-DD).\n\n${rawSections}`;
  const raw = await callGroqIndexed(env, 0, [{ role: "system", content: MACRO_SCRAPE_PROMPT }, { role: "user", content: userMsg }], 4000, 0.1);

  let list;
  try {
    list = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!Array.isArray(list)) {
      console.error("[MACRO] Groq balas bukan array:", raw.slice(0, 300));
      return [];
    }
  } catch (e) {
    console.error("[MACRO] Gagal parse JSON dari Groq:", e.message, "| raw:", raw.slice(0, 300));
    return [];
  }

  const DEFAULT_TIMES = {
    "FOMC Meeting": { hour: 14, minute: 0, tz: "ET" },
    "ECB Rate Decision": { hour: 13, minute: 45, tz: "CET" },
    "CPI": { hour: 8, minute: 30, tz: "ET" },
    "PPI": { hour: 8, minute: 30, tz: "ET" },
    "Nonfarm Payrolls": { hour: 8, minute: 30, tz: "ET" },
  };

  const daysAhead = 60;
  const todayStart = startOfTodayUTC(now);
  const cutoff = new Date(now.getTime() + daysAhead * 86400000);

  return list
    .map((it) => {
      if (!it.date_iso || !it.event) return null;
      const def = DEFAULT_TIMES[it.event] || { hour: 12, minute: 0, tz: "ET" };
      const hour = it.time_local ? parseInt(it.time_local.split(":")[0], 10) : def.hour;
      const minute = it.time_local ? parseInt(it.time_local.split(":")[1], 10) : def.minute;
      const tz = it.tz || def.tz;
      const wib = tz === "CET" ? cetToWIB(it.date_iso, hour, minute) : etToWIB(it.date_iso, hour, minute);
      // Buang kalau sudah lewat (dibanding awal hari ini) atau lebih dari 60 hari ke depan.
      // TIDAK ADA proyeksi "ke tahun depan" di sini — kalau lewat, ya dibuang saja.
      if (wib < todayStart || wib > cutoff) return null;
      return { date: fmtWIBDate(wib), time_wib: fmtWIBTime(wib), event: it.event, category: "macro", _sort: wib.getTime() };
    })
    .filter(Boolean);
}

// ══════════════════════════════════════════════════════════
//  CRYPTO EVENTS — tetap dari search+news (gak ada kalender resmi tunggal)
// ══════════════════════════════════════════════════════════
const CRYPTO_SYSTEM_PROMPT = `Kamu asisten yang menyusun daftar JADWAL/DEADLINE kripto MENDATANG (regulasi, keputusan ETF, listing besar, upgrade jaringan) dari hasil pencarian web mentah.

SANGAT PENTING — bedakan ini:
- BOLEH dimasukkan: tanggal keputusan SEC yang DIJADWALKAN, deadline pengajuan/persetujuan ETF, tanggal listing/upgrade yang DIUMUMKAN akan terjadi.
- JANGAN dimasukkan: rekap harga yang SUDAH terjadi (misal "harga Bitcoin turun ke $X pada tanggal Y", "Bitcoin naik ke $X"), berita yang menceritakan kejadian di masa lalu, atau analisis pasar yang bukan soal jadwal/deadline resmi.
- Kalau ragu apakah suatu tanggal itu jadwal mendatang atau cuma rekap kejadian lama → JANGAN dimasukkan, lebih baik dilewati daripada salah.

ATURAN FORMAT KETAT:
- Balas HANYA dengan JSON array valid. TIDAK ADA teks lain, TIDAK ADA markdown code fence.
- Format tiap item persis: {"date":"DD Bulan","time_wib":"HH:MM" atau "-","event":"Nama event singkat (jelas ini jadwal/deadline apa)"}
- "time_wib" WAJIB format 24 jam, dikonversi ke WIB (UTC+7) kalau sumber nyebut jam dengan jelas. Kalau gak jelas, isi "-".
- KALAU data mentah tidak menyebutkan tanggal MENDATANG yang jelas, JANGAN masukkan event itu. Jangan mengarang tanggal.
- Ambil maksimal 6 event yang paling relevan/penting.
- Kalau data mentah sama sekali tidak cukup / semuanya cuma rekap masa lalu, balas array kosong: []`;

async function getCryptoEvents(env) {
  const now = new Date();
  const monthYear = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

  // Query diarahkan ke JADWAL/DEADLINE MENDATANG, bukan "news" bulan ini
  // (yang isinya kebanyakan rekap harga/kejadian yang sudah lewat).
  const results = await Promise.all([
    serperSearch(env, `crypto ETF SEC decision deadline schedule upcoming`, "news", 8).catch((e) => { console.error("[CRYPTO SEARCH FAIL] query 1:", e.message); return null; }),
    serperSearch(env, `jadwal keputusan regulasi kripto mendatang ${monthYear}`, "news", 8).catch((e) => { console.error("[CRYPTO SEARCH FAIL] query 2:", e.message); return null; }),
  ]);

  const rawLines = [];
  results.forEach((r) => {
    if (!r) return;
    extractItems(r, "news").forEach((o) => {
      rawLines.push(`- ${o.title}: ${o.snippet} (${o.date || "tanggal tidak disebutkan"}) [sumber: ${o.source}]`);
    });
  });

  if (!rawLines.length) {
    console.error("[CRYPTO] Tidak ada hasil pencarian sama sekali untuk jadwal crypto.");
    return [];
  }

  const userMsg = `Hari ini: ${now.toISOString().slice(0, 10)}.\n\nHasil pencarian:\n${rawLines.join("\n")}`;
  const raw = await callGroqIndexed(env, 1, [{ role: "system", content: CRYPTO_SYSTEM_PROMPT }, { role: "user", content: userMsg }], 1000, 0.2);

  let list;
  try {
    list = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!Array.isArray(list)) {
      console.error("[CRYPTO] Groq balas bukan array:", raw.slice(0, 300));
      return [];
    }
  } catch (e) {
    console.error("[CRYPTO] Gagal parse JSON dari Groq:", e.message, "| raw:", raw.slice(0, 300));
    return [];
  }

  const todayStart = startOfTodayUTC(now);
  const daysAhead = 60;
  const cutoff = new Date(now.getTime() + daysAhead * 86400000);

  return list
    .map((it) => {
      const parts = (it.date || "").split(" ");
      if (parts.length !== 2 || MONTH_MAP[parts[1]] === undefined) return null; // tanggal gak jelas → buang
      const day = parseInt(parts[0], 10);
      const month = MONTH_MAP[parts[1]];
      const yr = now.getUTCFullYear();
      const guess = new Date(Date.UTC(yr, month, day));
      // FIX UTAMA: kalau sudah lewat → BUANG. Tidak pernah diproyeksikan ke tahun depan.
      // Event crypto sifatnya sekali-kejadian, bukan tahunan berulang seperti FOMC/ECB.
      if (guess < todayStart || guess > cutoff) return null;
      return { ...it, category: "crypto", _sort: guess.getTime() };
    })
    .filter(Boolean);
}

// ══════════════════════════════════════════════════════════
//  JADWAL NEWS — gabungan macro (scrape) + crypto (search)
// ══════════════════════════════════════════════════════════
async function buildScheduleList(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cacheRaw = await env.BOT_KV.get(SCHEDULE_CACHE_KEY);
    if (cacheRaw) {
      try {
        const cached = JSON.parse(cacheRaw);
        if (Array.isArray(cached.list) && cached.list.length > 0) return cached.list;
      } catch (e) { /* cache korup, lanjut rebuild */ }
    }
  }

  const [macro, crypto] = await Promise.all([
    getMacroEventsFromScrape(env).catch((e) => { console.error("[MACRO] Error tak tertangani:", e.message); return []; }),
    getCryptoEvents(env).catch((e) => { console.error("[CRYPTO] Error tak tertangani:", e.message); return []; }),
  ]);

  const list = mergeAndSort(macro, crypto);
  if (list.length > 0) {
    await env.BOT_KV.put(SCHEDULE_CACHE_KEY, JSON.stringify({ list, ts: Date.now() }), { expirationTtl: SCHEDULE_CACHE_TTL });
  }
  return list;
}

function mergeAndSort(macro, crypto) {
  const now = Date.now();
  // Safety net: buang lagi item yang somehow punya _sort di masa lalu,
  // jaga-jaga ada yang lolos dari filter individual di atas.
  const all = [...macro, ...crypto].filter((it) => typeof it._sort === "number" && it._sort >= now - 24 * 3600 * 1000);
  all.sort((a, b) => (a._sort || 0) - (b._sort || 0));
  return all.slice(0, 15);
}

function scheduleText(list) {
  if (!list.length) return "📭 Belum ada jadwal event mendatang yang berhasil ditemukan. Coba lagi beberapa saat lagi atau tap '🔄 Refresh Jadwal'.";
  const lines = ["📅 *JADWAL NEWS TERDEKAT* (waktu WIB)\n"];
  list.forEach((it, i) => {
    const jam = it.time_wib && it.time_wib !== "-" ? `${it.time_wib} WIB` : "jam belum diketahui";
    const tag = it.category === "crypto" ? "🪙" : "🏛️";
    lines.push(`${i + 1}. ${tag} *${it.date}, ${jam}* — ${it.event}`);
  });
  lines.push("\n_🏛️ = scrape langsung dari kalender resmi · 🪙 = hasil pencarian berita, cek ulang di sumber resmi._");
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

// nTotal = total panggilan AI (sesuai angka di tombol yang user tap, mis. 5 atau 10).
// nOpinions = nTotal - 1 (jumlah analis independen sebelum panggilan penyimpul).
// Header WAJIB pakai nTotal supaya konsisten dengan tombol yang user tap —
// sebelumnya header salah pakai nOpinions, jadi tap "5 AI" malah muncul "(4 AI)".
function newsConsensusPrompt(nTotal, nOpinions) {
  return `Kamu adalah Chief News Analyst yang mengawasi ${nOpinions} analis berita independen yang sudah menganalisa event yang sama.
Tugasmu MENYIMPULKAN, bukan membuat analisa baru:
1. Tentukan sentimen tiap analisis: Bullish, Bearish, atau Netral. Abaikan yang error.
2. Hitung suara tiap sentimen. Suara terbanyak = kesimpulan final. Kalau seri → Netral.
3. Ringkas dampak market yang paling sering disebut, sebutkan kalau ada perbedaan pendapat signifikan.

FORMAT OUTPUT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 KESIMPULAN ANALISA NEWS (${nTotal} AI)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📰 Event      : [nama event]
📊 Voting     : Bullish [n] | Bearish [n] | Netral [n]
🏆 Sentimen   : Bullish 🟢 / Bearish 🔴 / Netral ⚪
💥 Dampak     : [ringkas]
📝 Kesimpulan :
[Maksimal 5 kalimat Bahasa Indonesia.]
⚠️ Catatan    : Ini konsensus dari ${nOpinions} analis independen + 1 panggilan penyimpul (total ${nTotal} panggilan model AI YANG SAMA)
dengan variasi random sampling, bukan ${nTotal} model berbeda — anggap sebagai pengecekan konsistensi, bukan validasi independen penuh.
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
    [{ role: "system", content: newsConsensusPrompt(nTotal, nOpinions) }, { role: "user", content: consensusInput }],
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
      "📅 *Jadwal News* → lihat daftar event ekonomi & kripto terdekat (yang AKAN datang, bukan yang sudah lewat). FOMC/ECB/CPI/PPI/NFP di-scrape langsung dari halaman kalender resmi (federalreserve.gov, ecb.europa.eu, bls.gov). Event kripto dari hasil pencarian jadwal/deadline terkini.\n\n" +
      "📰 *Analisa News* → sama seperti Jadwal News, tapi tiap event bisa di-tap. Pilih 5 atau 10 AI, bot akan cari berita terkait event itu dan menyimpulkan sentimen/dampaknya ke market.\n\n" +
      "Data di-cache 6 jam. Tap '🔄 Refresh Jadwal' kalau mau paksa update."
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
        await sendMessage(env, chatId, "📭 Belum ada jadwal event mendatang yang bisa dianalisa saat ini. Coba lagi nanti.");
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
