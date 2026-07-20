/**
 * 📰 News & Economic Calendar Analyst Bot — Cloudflare Workers edition
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Webhook-based (bukan polling) → hanya "bangun" saat ada pesan masuk dari Telegram.
 *
 * Arsitektur (v2 — pengganti versi trading Binance):
 * 1. "Jadwal News"  → search web (Serper.dev) untuk jadwal event ekonomi terdekat,
 *                      AI (Groq) merapikan hasil mentah jadi list terstruktur.
 * 2. "Analisa News" → list yang sama, tapi tiap event bisa di-tap → user pilih
 *                      5 atau 10 "AI" (panggilan Groq paralel dengan variasi
 *                      random sampling) yang masing-masing menganalisa cuplikan
 *                      berita terkait event itu (hasil search baru, spesifik ke
 *                      event tsb) → 1 panggilan Groq terakhir menyimpulkan.
 *
 * PENTING: LLM tidak punya akses internet bawaan dan pengetahuannya berhenti di
 * training cutoff — makanya SEMUA jadwal & analisa di sini WAJIB disuntik data
 * hasil pencarian web dulu (lewat Serper.dev), bukan ditanya langsung ke AI.
 * Kalau di-skip, AI akan "mengarang" tanggal/harga dari ingatan lama.
 *
 * v2.1 — Jadwal News sekarang pakai BEBERAPA query pencarian spesifik
 * (FOMC, CPI, NFP, ECB, kripto) secara paralel, bukan 1 query generik.
 * Query generik sering nyangkut ke halaman kalender yang cuplikannya
 * gak nyebut tanggal presisi, bikin AI (yang sengaja di-instruksiin gak boleh
 * ngarang tanggal) selalu ngasih list kosong. Hasil kosong juga TIDAK di-cache
 * lagi, biar sekali gagal gak macet 6 jam.
 *
 * State per-user disimpan di Cloudflare KV (BOT_KV). Jadwal event di-cache
 * global (bukan per-user) selama 6 jam supaya hemat kuota search.
 */

const MODEL = "llama-3.3-70b-versatile";
const SCHEDULE_CACHE_KEY = "news_schedule_cache";
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
//  SERPER.DEV — WEB & NEWS SEARCH
//  (Sumber data real-time buat jadwal & berita — LLM sendiri TIDAK
//   punya akses internet, jadi ini wajib ada sebelum tanya ke AI.)
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
  let lastErr;
  while (tried < total) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[i]}` },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
      });
      if (res.status === 429) throw new Error("rate_limit");
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e;
      tried++;
      i = (i + 1) % total;
    }
  }
  throw new Error(`Semua key Groq gagal (panggilan #${idx + 1}): ${lastErr}`);
}

// ══════════════════════════════════════════════════════════
//  JADWAL NEWS — build & cache
// ══════════════════════════════════════════════════════════
const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

const SCHEDULE_SYSTEM_PROMPT = `Kamu asisten yang menyusun daftar jadwal event ekonomi & kripto dari hasil pencarian web mentah yang diberikan user.
ATURAN KETAT:
- Balas HANYA dengan JSON array valid. TIDAK ADA teks lain, TIDAK ADA markdown code fence (\`\`\`).
- Format tiap item persis: {"date":"DD Bulan","time_wib":"HH:MM" atau "-","event":"Nama event singkat","category":"macro" atau "crypto"}
- "time_wib" WAJIB format 24 jam (00:00–23:59), dikonversi ke WIB (UTC+7).
  Kalau sumber menyebut jam dalam zona lain (ET/EST/EDT = UTC-4/-5, CET/CEST = UTC+1/+2, GMT/UTC),
  konversi ke WIB dengan hati-hati (perhatikan apakah sedang daylight saving).
  Kalau sumber TIDAK menyebutkan jam sama sekali, isi "time_wib" dengan "-" — JANGAN mengarang jam.
- Prioritaskan data dari sumber resmi (bls.gov, federalreserve.gov, ecb.europa.eu, situs berita finansial/kripto ternama).
  Kalau ada 2 sumber beda untuk event yang sama, pakai yang dari domain resmi/institusi.
- KALAU data mentah tidak menyebutkan tanggal yang jelas untuk suatu event, JANGAN masukkan event itu. Jangan mengarang tanggal.
- Gabungkan event macro (NFP, CPI, PPI, FOMC, ECB) dan event kripto (regulasi, ETF, upgrade jaringan, listing besar) dalam satu list, tandai categorynya.
- Ambil maksimal 12 event yang paling relevan.
- Urutkan dari tanggal & jam paling dekat ke yang paling jauh.
- Kalau data mentah sama sekali tidak cukup, balas array kosong: []`;

function extractItems(result, type) {
  const list = type === "news" ? (result?.news || []) : (result?.organic || []);
  return list.map((o) => ({
    title: o.title,
    snippet: o.snippet || "",
    date: o.date || null,
    source: o.link || o.source || "?",
  }));
}

async function buildScheduleList(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cacheRaw = await env.BOT_KV.get(SCHEDULE_CACHE_KEY);
    if (cacheRaw) {
      try {
        const cached = JSON.parse(cacheRaw);
        if (Array.isArray(cached.list) && cached.list.length > 0) return cached.list;
      } catch (e) {
        /* cache korup, lanjut rebuild */
      }
    }
  }

  const now = new Date();
  const monthYear = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const year = now.getUTCFullYear();

  // Beberapa query SPESIFIK dijalankan paralel, bukan 1 query generik.
  // Query generik ("kalender ekonomi Juli 2026") sering nyangkut ke halaman
  // kalender yang cuplikannya gak nyebut tanggal presisi - bikin AI (yang
  // sengaja dilarang ngarang tanggal) selalu ngasih list kosong.
  const queries = [
    { q: `FOMC meeting schedule interest rate decision ${year}`, type: "search" },
    { q: `CPI inflation release date ${monthYear}`, type: "search" },
    { q: `nonfarm payrolls NFP release date ${monthYear}`, type: "search" },
    { q: `ECB rate decision ${monthYear}`, type: "search" },
    { q: `crypto regulation ETF news ${monthYear}`, type: "news" },
    { q: `jadwal event kripto ${monthYear} SEC bitcoin ethereum`, type: "news" },
  ];

  const results = await Promise.all(
    queries.map((qq) => serperSearch(env, qq.q, qq.type, 6).catch(() => null))
  );

  const rawLines = [];
  results.forEach((r, i) => {
    if (!r) return;
    const items = extractItems(r, queries[i].type);
    items.forEach((o) => {
      rawLines.push(`- [query: ${queries[i].q}] ${o.title}: ${o.snippet} (${o.date || "tanggal tidak disebutkan"}) [sumber: ${o.source}]`);
    });
  });

  const rawItems = rawLines.join("\n");
  const userMsg = `Hari ini: ${now.toISOString().slice(0, 10)} (format YYYY-MM-DD).\n\nHasil pencarian mentah dari beberapa query:\n${rawItems || "(kosong)"}`;

  const raw = await callGroqIndexed(
    env, 0,
    [{ role: "system", content: SCHEDULE_SYSTEM_PROMPT }, { role: "user", content: userMsg }],
    2000, 0.2
  );

  let list;
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    list = JSON.parse(cleaned);
    if (!Array.isArray(list)) throw new Error("hasil parse bukan array");
  } catch (e) {
    throw new Error(`Gagal menyusun jadwal dari hasil AI: ${e.message}. Potongan respons AI: ${raw.slice(0, 200)}`);
  }

  // Jangan cache hasil kosong - biar sekali gagal gak macet 6 jam ke depan.
  if (list.length > 0) {
    await env.BOT_KV.put(SCHEDULE_CACHE_KEY, JSON.stringify({ list, ts: Date.now() }), { expirationTtl: SCHEDULE_CACHE_TTL });
  }
  return list;
}

function scheduleText(list) {
  if (!list.length) return "📭 Belum ada jadwal event yang berhasil ditemukan. Coba lagi beberapa saat lagi.";
  const lines = ["📅 *JADWAL NEWS TERDEKAT* (waktu WIB)\n"];
  list.forEach((it, i) => {
    const jam = it.time_wib && it.time_wib !== "-" ? `${it.time_wib} WIB` : "jam belum diketahui";
    const tag = it.category === "crypto" ? "🪙" : "🏛️";
    lines.push(`${i + 1}. ${tag} *${it.date}, ${jam}* — ${it.event}`);
  });
  lines.push("\n_Data disusun otomatis dari hasil pencarian web, cek ulang di sumber resmi untuk kepastian jam & revisi._");
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
  const nOpinions = Math.max(1, nTotal - 1); // sisakan 1 slot untuk panggilan kesimpulan akhir

  // Query dibikin longgar (tanpa tanggal presisi) supaya search engine tidak "nyasar"
  // gara-gara tanggal spesifik jarang cocok persis dengan judul artikel.
  let newsData = await serperSearch(env, `${event.event} dampak market analisis`, "news", 10);
  let newsItems = newsData.news || [];
  if (!newsItems.length) {
    // Fallback: coba web search biasa kalau search "news" kosong
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
      return `[ERROR AI #${idx + 1}: ${e}]`;
    }
  };

  const opinions = await Promise.all(Array.from({ length: nOpinions }, (_, i) => oneOpinion(i)));

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
      "📅 *Jadwal News* → lihat daftar event ekonomi & kripto terdekat (NFP, CPI, FOMC, ECB, regulasi kripto, dll), diambil otomatis dari hasil pencarian web.\n\n" +
      "📰 *Analisa News* → sama seperti Jadwal News, tapi tiap event bisa di-tap. Pilih 5 atau 10 AI, bot akan cari berita terkait event itu dan menyimpulkan sentimen/dampaknya ke market.\n\n" +
      "Data jadwal di-cache 6 jam. Tap '🔄 Refresh Jadwal' kalau mau paksa update."
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
      await sendMessage(env, chatId, `❌ Gagal ambil jadwal: ${e.message}`);
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
      await sendMessage(env, chatId, `❌ Gagal ambil jadwal: ${e.message}`);
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
      await editMessageText(env, chatId, cb.message.message_id, `❌ Gagal refresh: ${e.message}`);
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
      const { final, opinions } = await analyzeEvent(env, event, n);
      s.last_opinions = opinions;
      s.last_event = event;
      await saveSession(env, uid, s);
      await sendMessage(env, chatId, final, { reply_markup: mainKb() });
    } catch (e) {
      await sendMessage(env, chatId, `❌ Error: ${e.message}`, { reply_markup: mainKb() });
    }
    return;
  }
}
