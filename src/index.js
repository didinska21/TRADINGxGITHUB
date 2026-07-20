/**
 * 🤖 Futures Trading Bot — Cloudflare Workers edition
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Webhook-based (bukan polling) → hanya "bangun" saat ada pesan masuk dari Telegram.
 * Exchange yang didukung di versi ini: BINANCE saja (yang lain bisa ditambah
 * dengan pola yang sama, lihat komentar di bagian MARKET DATA).
 *
 * Strategi sinyal: 9 panggilan Groq paralel (opini independen) + 1 panggilan
 * konsensus yang voting arah LONG/SHORT/WAIT. Sama seperti versi Python.
 *
 * State per-user disimpan di Cloudflare KV (BOT_KV) karena Workers tidak
 * punya memory yang persist antar-request.
 */

const MODEL = "llama-3.3-70b-versatile";
const N_OPINIONS = 9;
const TF_MAP = {
  high_risk: ["1m", "5m"],
  medium_risk: ["5m", "15m"],
  low_risk: ["15m", "1h"],
};

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
      // Validasi secret token dari Telegram (X-Telegram-Bot-Api-Secret-Token)
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

      // Proses update di background, langsung balas 200 ke Telegram supaya tidak retry/timeout.
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
  // Telegram limit ~4096 char per pesan — potong kalau kepanjangan.
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
  return { exchange: null, mode: null, pair: null, modal: null, state: "idle", history: [], pairs: [], last_opinions: [] };
}

async function saveSession(env, uid, s) {
  await env.BOT_KV.put(`session:${uid}`, JSON.stringify(s), { expirationTtl: 60 * 60 * 24 * 7 }); // 7 hari
}

// ══════════════════════════════════════════════════════════
//  KEYBOARDS
// ══════════════════════════════════════════════════════════
function exchangeKb() {
  // Versi ini baru support Binance. Tombol lain ditampilkan tapi nonaktif (info saja),
  // supaya UI konsisten dengan versi Python — aktifkan setelah adapter-nya diporting.
  return {
    inline_keyboard: [
      [{ text: "🟡 Binance", callback_data: "exch_binance" }],
    ],
  };
}

function mainKb() {
  return {
    keyboard: [
      ["🔴 HIGH RISK", "🟡 MEDIUM RISK"],
      ["🟢 LOW RISK", "📊 Top Pairs"],
      ["📈 Analisis Pasar", "🔎 Lihat Detail 9 AI"],
      ["🏦 Ganti Exchange", "❓ Bantuan"],
    ],
    resize_keyboard: true,
  };
}

function pairsKb(pairList, page = 0, per = 9) {
  const start = page * per;
  const chunk = pairList.slice(start, start + per);
  const rows = [];
  for (let i = 0; i < chunk.length; i += 3) {
    rows.push(chunk.slice(i, i + 3).map((p) => ({ text: p, callback_data: `pair_${p}` })));
  }
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: `page_${page - 1}` });
  if (start + per < pairList.length) nav.push({ text: "➡️", callback_data: `page_${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "✍️ Ketik Manual", callback_data: "pair_custom" }]);
  return { inline_keyboard: rows };
}

// ══════════════════════════════════════════════════════════
//  MARKET DATA — BINANCE
//  (Untuk exchange lain: tiru pola fungsi ini, lalu daftarkan di MARKET_FN
//   dan TOP_PAIRS_FN di bawah, plus tambah tombol di exchangeKb().)
// ══════════════════════════════════════════════════════════
async function binanceTopPairs(limit = 20) {
  const res = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // Bukan JSON valid — tampilkan status + potongan response asli biar ketauan penyebabnya
    throw new Error(
      `Binance response bukan JSON (HTTP ${res.status}). Cuplikan: ${raw.slice(0, 200)}`
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(`Binance response bukan array. Isi: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data
    .filter((p) => p.symbol.endsWith("USDT"))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit);
}

async function fetchJsonLogged(url, label) {
  try {
    const res = await fetch(url);
    const raw = await res.text();
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error(`[binance:${label}] HTTP ${res.status} bukan JSON. Cuplikan: ${raw.slice(0, 200)}`);
      return null;
    }
  } catch (e) {
    console.error(`[binance:${label}] fetch gagal total: ${e.message}`);
    return null;
  }
}

async function binanceMarket(symbol, tf1, tf2) {
  const [tick, ob, fund, kl1, kl2] = await Promise.all([
    fetchJsonLogged(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`, "ticker"),
    fetchJsonLogged(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=5`, "depth"),
    fetchJsonLogged(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, "premiumIndex"),
    fetchJsonLogged(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf1}&limit=100`, "klines1"),
    fetchJsonLogged(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf2}&limit=60`, "klines2"),
  ]);

  const parseKl = (raw) => {
    if (!raw || !Array.isArray(raw)) return null;
    return {
      c: raw.map((k) => parseFloat(k[4])),
      h: raw.map((k) => parseFloat(k[2])),
      l: raw.map((k) => parseFloat(k[3])),
      v: raw.map((k) => parseFloat(k[5])),
    };
  };

  const price = tick ? parseFloat(tick.lastPrice) : 0;
  const change = tick ? parseFloat(tick.priceChangePercent) : 0;
  const vol24 = tick ? parseFloat(tick.quoteVolume) / 1e6 : 0;
  const bids = ob?.bids || [];
  const asks = ob?.asks || [];
  const bidVol = bids.slice(0, 5).reduce((s, b) => s + parseFloat(b[1]), 0);
  const askVol = asks.slice(0, 5).reduce((s, a) => s + parseFloat(a[1]), 0);
  const funding = fund ? parseFloat(fund.lastFundingRate) * 100 : 0;

  return { price, change, vol24, bidVol, askVol, funding, kl1: parseKl(kl1), kl2: parseKl(kl2), tf1, tf2 };
}

const MARKET_FN = { binance: binanceMarket };
const TOP_PAIRS_FN = { binance: binanceTopPairs };
const EXCHANGE_LABEL = { binance: { name: "Binance", emoji: "🟡" } };

// ══════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ══════════════════════════════════════════════════════════
const TA = {
  rsi(c, p = 14) {
    if (c.length < p + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = c.length - p; i < c.length; i++) {
      const diff = c[i] - c[i - 1];
      if (diff > 0) gains += diff; else losses += -diff;
    }
    const ag = gains / p, al = losses / p || 0.001;
    return Math.round((100 - 100 / (1 + ag / al)) * 100) / 100;
  },
  ema(c, p) {
    if (c.length < p) return c[c.length - 1];
    const k = 2 / (p + 1);
    let e = c.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < c.length; i++) e = c[i] * k + e * (1 - k);
    return e;
  },
  macd(c) {
    const e12 = TA.ema(c, 12), e26 = TA.ema(c, 26);
    const m = e12 - e26, s = m * 0.9;
    return [m, s, m - s];
  },
  bb(c, p = 20) {
    if (c.length < p) return [c[c.length - 1], c[c.length - 1], c[c.length - 1]];
    const sl = c.slice(-p);
    const mid = sl.reduce((a, b) => a + b, 0) / p;
    const std = Math.sqrt(sl.reduce((a, x) => a + (x - mid) ** 2, 0) / p);
    return [mid + 2 * std, mid, mid - 2 * std];
  },
  sr(h, l, n = 20) {
    return [Math.max(...h.slice(-n)), Math.min(...l.slice(-n))];
  },
  avgVol(v, p = 20) {
    return v.length ? v.slice(-p).reduce((a, b) => a + b, 0) / p : 1;
  },
};

function fmtSmall(val) {
  if (val === 0) return "0";
  const a = Math.abs(val);
  if (a >= 1) return val.toFixed(4);
  if (a >= 0.01) return val.toFixed(6);
  if (a >= 0.0001) return val.toFixed(8);
  return val.toFixed(10);
}

// ══════════════════════════════════════════════════════════
//  COLLECT — bangun teks data untuk AI
// ══════════════════════════════════════════════════════════
async function collect(exchange, symbol, mode) {
  const [tf1, tf2] = TF_MAP[mode] || ["5m", "15m"];
  const exname = EXCHANGE_LABEL[exchange].name;
  let d;
  try {
    d = await MARKET_FN[exchange](symbol, tf1, tf2);
  } catch (e) {
    return `[ERROR ambil data ${exname}: ${e}]`;
  }

  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const L = [
    `═══ DATA LIVE ${symbol} — ${exname} ═══`,
    `🕐 ${now}\n`,
    `Harga Terkini : $${d.price}`,
    `Perubahan 24H : ${d.change >= 0 ? "+" : ""}${d.change.toFixed(2)}%`,
    `Volume 24H    : $${d.vol24.toFixed(2)}M`,
    `Funding Rate  : ${d.funding.toFixed(4)}% (${d.funding > 0 ? "Longs bayar Shorts" : "Shorts bayar Longs"})`,
    `Order Book    : Bid ${d.bidVol.toFixed(2)} vs Ask ${d.askVol.toFixed(2)} → ${d.bidVol > d.askVol ? "BELI DOMINAN 🟢" : "JUAL DOMINAN 🔴"}\n`,
  ];

  for (const [tfLabel, kl] of [[tf1, d.kl1], [tf2, d.kl2]]) {
    if (!kl) { L.push(`[${tfLabel}] Data tidak tersedia\n`); continue; }
    const { c, h, l, v } = kl;
    const r14 = TA.rsi(c, 14), r7 = TA.rsi(c, 7);
    const [, , hist] = TA.macd(c);
    const [bbu, bbm, bbl] = TA.bb(c);
    const [res, sup] = TA.sr(h, l);
    const e9 = TA.ema(c, 9), e21 = TA.ema(c, 21), e50 = TA.ema(c, 50);
    const avgv = TA.avgVol(v);
    const vratio = avgv ? v[v.length - 1] / avgv : 1;
    const candles = [];
    for (let j = 0; j < 5; j++) candles.push(c[c.length - 1 - j] > c[c.length - 2 - j] ? "🟢" : "🔴");
    candles.reverse();

    const priceNow = c[c.length - 1];
    let dec = 2;
    if (priceNow < 1000) dec = 4;
    if (priceNow < 1) dec = 6;
    if (priceNow < 0.01) dec = 8;
    if (priceNow < 0.0001) dec = 10;

    const rsiLbl = r14 < 30 ? "OVERSOLD 🟢" : r14 > 70 ? "OVERBOUGHT 🔴" : "NETRAL ⚪";
    const macLbl = hist > 0 ? "BULLISH 🟢" : "BEARISH 🔴";
    const emaLbl = e9 > e21 && e21 > e50 ? "BULLISH KUAT 🟢" : e9 < e21 && e21 < e50 ? "BEARISH KUAT 🔴" : "MIXED ⚪";
    const volLbl = vratio > 1.5 ? `SPIKE 🔥 ${vratio.toFixed(1)}x avg` : vratio >= 0.8 ? `Normal ${vratio.toFixed(1)}x avg` : `SEPI ${vratio.toFixed(1)}x avg`;

    L.push(
      `── ${tfLabel.toUpperCase()} ────────────────`,
      `Harga         : $${priceNow.toFixed(dec)}`,
      `RSI(14/7)     : ${r14} / ${r7} → ${rsiLbl}`,
      `MACD Hist     : ${fmtSmall(hist)} → ${macLbl}`,
      `EMA 9/21/50   : ${fmtSmall(e9)} / ${fmtSmall(e21)} / ${fmtSmall(e50)} → ${emaLbl}`,
      `BB U/M/L      : ${fmtSmall(bbu)} / ${fmtSmall(bbm)} / ${fmtSmall(bbl)}`,
      `Resistance    : $${res.toFixed(dec)}`,
      `Support       : $${sup.toFixed(dec)}`,
      `Volume        : ${volLbl}`,
      `5 Candle      : ${candles.join(" ")}\n`
    );
  }
  return L.join("\n");
}

// ══════════════════════════════════════════════════════════
//  SYSTEM PROMPTS
// ══════════════════════════════════════════════════════════
const PROMPTS = {
  high_risk: `Kamu adalah seorang trader futures profesional kelas dunia dengan 15 tahun pengalaman.
Kamu mengelola dana prop firm senilai $10.000.000. Setiap sinyal yang kamu keluarkan adalah NYATA.
Kamu hanya entry ketika data KONFIRMASI (minimal 4 dari 5 indikator searah). Jika tidak, bilang WAIT.

BAHASA & FORMAT ANGKA:
- Bahasa Indonesia. Harga WAJIB desimal biasa, DILARANG scientific notation.

OUTPUT FORMAT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 SINYAL HIGH RISK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Pair      : [PAIR]
📍 Harga     : $[harga]
⭐ Kekuatan  : [KUAT 5/5 / MODERAT 3/5 / ⏳ WAIT]
🎯 Arah      : LONG 🟢 / SHORT 🔴 / ⏳ WAIT
⚡ Entry     : $[harga] atau ⏳ Belum ada setup valid
✅ TP1       : $[harga] (+X%) atau ⏳ —
✅ TP2       : $[harga] (+X%) atau ⏳ —
🛑 SL        : $[harga] (-X%) atau ⏳ —
📊 RSI(14/7) : [nilai] / [nilai] → [label]
📈 MACD Hist : [nilai] → [label]
📉 EMA       : [label]
🎯 Support   : $[nilai] | Resist: $[nilai]
📦 Volume    : [X.X]x rata-rata → [label]
💸 Funding   : [nilai]%
📝 Analisis  :
[Maksimal 4 kalimat Bahasa Indonesia, angka spesifik dari data.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,

  medium_risk: `Kamu adalah fund manager futures profesional dengan track record 12 tahun.
Filosofimu: "Preserve capital first, profit second." R:R minimum 1:2, kalau tidak tercapai jangan entry.

BAHASA & FORMAT ANGKA:
- Bahasa Indonesia. Harga WAJIB desimal biasa, DILARANG scientific notation.

OUTPUT FORMAT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 SINYAL MEDIUM RISK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Pair      : [PAIR]
📍 Harga     : $[harga]
⭐ Kekuatan  : [KUAT 6/6 / MODERAT 4/6 / ⏳ WAIT]
🎯 Arah      : LONG 🟢 / SHORT 🔴 / ⏳ WAIT
⚡ Entry     : $[bawah]–$[atas] atau ⏳ Belum ada setup valid
✅ TP1       : $[harga] (+X%) atau ⏳ —
✅ TP2       : $[harga] (+X%) atau ⏳ —
✅ TP3       : $[harga] (+X%) atau ⏳ —
🛑 SL        : $[harga] (-X%) atau ⏳ —
📊 R:R       : 1:[angka] atau ⏳ —
📊 RSI(14/7) : [nilai] / [nilai] → [label]
📈 MACD Hist : [nilai] → [label]
📉 EMA       : [label]
🎯 Support   : $[nilai] | Resist: $[nilai]
📦 Volume    : [X.X]x rata-rata → [label]
💸 Funding   : [nilai]%
📝 Analisis  :
[Maksimal 5 kalimat Bahasa Indonesia, angka spesifik.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,

  low_risk: `Kamu adalah chief risk officer sekaligus senior trader hedge fund dengan AUM $50.000.000.
Filosofimu: "Jika ragu, tidak usah masuk." R:R minimum 1:3, di bawah itu tolak setup.

BAHASA & FORMAT ANGKA:
- Bahasa Indonesia. Harga WAJIB desimal biasa, DILARANG scientific notation.

OUTPUT FORMAT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 SINYAL LOW RISK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Pair      : [PAIR]
📍 Harga     : $[harga]
⭐ Kekuatan  : [PREMIUM 8/8 / KUAT 6/8 / MODERAT 5/8 / ⏳ WAIT]
🎯 Arah      : LONG 🟢 / SHORT 🔴 / ⏳ WAIT
⚡ Entry     : $[harga] atau ⏳ Belum ada setup valid
✅ TP1       : $[harga] (+X%) atau ⏳ —
✅ TP2       : $[harga] (+X%) atau ⏳ —
✅ TP3       : $[harga] (+X%) atau ⏳ —
🛑 SL        : $[harga] (-X%) atau ⏳ —
📊 R:R       : 1:[angka] (min 1:3) atau ⏳ —
📊 RSI(14/7) : [nilai] / [nilai] → [label]
📈 MACD Hist : [nilai] → [label]
📉 EMA       : [label]
🎯 S&R Major : Support $[nilai] | Resist $[nilai]
📦 Volume    : [X.X]x rata-rata → [label]
💸 Funding   : [nilai]%
📝 Analisis  :
[Maksimal 6 kalimat Bahasa Indonesia, angka spesifik.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
};

const GENERAL_PROMPT = `Kamu adalah trader dan analis crypto futures profesional yang ramah.
Jawab pertanyaan seputar futures trading, teknikal analisis, manajemen risiko dalam Bahasa Indonesia.`;

const CONSENSUS_PROMPT = `Kamu adalah Chief Analyst yang mengawasi 9 AI trader independen yang sudah menganalisis pair yang sama.
Tugasmu MENYIMPULKAN, bukan membuat analisis baru:
1. Tentukan arah tiap analisis: LONG, SHORT, atau WAIT. Abaikan yang error.
2. Hitung suara tiap arah. Suara terbanyak = konsensus final. Kalau seri di posisi teratas → WAIT.
3. Rata-ratakan Entry/TP1/TP2/SL dari AI yang searah konsensus.
4. Ringkas argumen mayoritas, sebutkan kalau ada perbedaan pendapat signifikan.

BAHASA & FORMAT ANGKA:
- Bahasa Indonesia. Harga WAJIB desimal biasa, DILARANG scientific notation.

FORMAT OUTPUT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 KONSENSUS 9 AI TRADER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Voting    : LONG [n] | SHORT [n] | WAIT [n]
🏆 Konsensus : LONG 🟢 / SHORT 🔴 / ⏳ WAIT
📌 Pair      : [PAIR]
⚡ Entry     : $[rata-rata] atau ⏳ —
✅ TP1       : $[rata-rata] (+X%) atau ⏳ —
✅ TP2       : $[rata-rata] (+X%) atau ⏳ —
🛑 SL        : $[rata-rata] (-X%) atau ⏳ —
📝 Ringkasan Argumen:
[Maksimal 5 kalimat.]
⚠️ Catatan   : Ini konsensus dari 9 panggilan model AI yang SAMA dengan variasi random sampling,
bukan 9 model berbeda — anggap sebagai pengecekan konsistensi, bukan validasi independen penuh.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

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

async function callGroqIndexed(env, idx, messages, maxTokens = 1500, temperature = 0.7) {
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
  throw new Error(`Semua key Groq gagal (opini #${idx + 1}): ${lastErr}`);
}

async function genConsensusSignal(env, exchange, mode, symbol, modal) {
  const mdata = await collect(exchange, symbol, mode);
  const exname = EXCHANGE_LABEL[exchange].name;
  const basePrompt =
    `DATA LIVE DARI ${exname.toUpperCase()}:\n${mdata}\n\n` +
    `USER INFO:\n• Exchange: ${exname}\n• Pair: ${symbol}\n• Modal: $${modal}\n• Mode: ${mode.replace("_", " ").toUpperCase()}\n\n` +
    `Berikan sinyal trading futures ${symbol} lengkap berdasarkan data di atas. Gunakan harga NYATA dari data.`;

  const oneOpinion = async (idx) => {
    const temp = 0.5 + (idx % 5) * 0.1;
    const msgs = [{ role: "system", content: PROMPTS[mode] }, { role: "user", content: basePrompt }];
    try {
      return await callGroqIndexed(env, idx, msgs, 1500, temp);
    } catch (e) {
      return `[ERROR AI #${idx + 1}: ${e}]`;
    }
  };

  const opinions = await Promise.all(Array.from({ length: N_OPINIONS }, (_, i) => oneOpinion(i)));

  let consensusInput = "Berikut 9 analisis independen dari AI trader untuk pair yang sama:\n\n";
  opinions.forEach((op, i) => {
    consensusInput += `=== ANALISIS AI #${i + 1} ===\n${op}\n\n`;
  });
  consensusInput += `Pair: ${symbol} | Modal: $${modal} | Mode: ${mode.replace("_", " ").toUpperCase()}\nSimpulkan sesuai instruksi sistem.`;

  const consensusMsgs = [{ role: "system", content: CONSENSUS_PROMPT }, { role: "user", content: consensusInput }];
  const final = await callGroqIndexed(env, N_OPINIONS, consensusMsgs, 1500, 0.3);
  return { final, opinions };
}

async function genSignal(env, exchange, mode, symbol, modal, userMsg, history) {
  const mdata = await collect(exchange, symbol, mode);
  const exname = EXCHANGE_LABEL[exchange].name;
  const prompt =
    `DATA LIVE DARI ${exname.toUpperCase()}:\n${mdata}\n\n` +
    `USER INFO:\n• Exchange: ${exname}\n• Pair: ${symbol}\n• Modal: $${modal}\n• Mode: ${mode.replace("_", " ").toUpperCase()}\n\n` +
    `PERMINTAAN: ${userMsg}\n\nGunakan harga NYATA dari data di atas.`;
  const msgs = [{ role: "system", content: PROMPTS[mode] }, ...history.slice(-6), { role: "user", content: prompt }];
  const answer = await callGroqIndexed(env, 0, msgs, 2000, 0.7);
  history.push({ role: "user", content: `[${symbol}] ${userMsg}` });
  history.push({ role: "assistant", content: answer });
  return answer;
}

async function genGeneral(env, mode, msg) {
  const sys = PROMPTS[mode] || GENERAL_PROMPT;
  const msgs = [{ role: "system", content: sys }, { role: "user", content: msg }];
  return callGroqIndexed(env, 0, msgs, 1200, 0.7);
}

// ══════════════════════════════════════════════════════════
//  TOP PAIRS TEXT
// ══════════════════════════════════════════════════════════
async function getTopPairsText(exchange, limit = 20) {
  const info = EXCHANGE_LABEL[exchange];
  let raw;
  try {
    raw = await TOP_PAIRS_FN[exchange](limit);
  } catch (e) {
    return { text: `❌ Gagal ambil pairs dari ${info.name}: ${e}`, symbols: [] };
  }
  const lines = [`🔥 *TOP PAIRS — ${info.emoji} ${info.name} (Live)*\n`];
  const symbols = [];
  raw.forEach((p, i) => {
    const sym = p.symbol;
    const pr = parseFloat(p.lastPrice);
    const chg = parseFloat(p.priceChangePercent);
    const vol = parseFloat(p.quoteVolume) / 1e6;
    const em = chg >= 0 ? "🟢" : "🔴";
    lines.push(`${i + 1}. \`${sym}\` ${em} ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% | $${pr} | Vol: $${vol.toFixed(0)}M`);
    symbols.push(sym);
  });
  return { text: lines.join("\n"), symbols };
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

const MODE_LABEL = { high_risk: "🔴 HIGH RISK", medium_risk: "🟡 MEDIUM RISK", low_risk: "🟢 LOW RISK" };
const MODE_BTN = { "🔴 HIGH RISK": "high_risk", "🟡 MEDIUM RISK": "medium_risk", "🟢 LOW RISK": "low_risk" };

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
    Object.assign(s, { exchange: null, mode: null, pair: null, modal: null, state: "idle", history: [], last_opinions: [] });
    await saveSession(env, uid, s);
    await sendMessage(
      env, chatId,
      `🤖 *FUTURES TRADING BOT — Konsensus 9 AI*\n\nHalo *${message.from.first_name}*!\n\n` +
      `Bot ini full manual: pilih pair, bot memanggil Groq 9x paralel lalu menyimpulkan hasil voting-nya jadi 1 sinyal.\n\n` +
      `⚠️ Hanya alat bantu analisis, bukan jaminan profit. Tidak ada eksekusi order otomatis.\n\n*Pilih exchange:*`,
      { reply_markup: exchangeKb() }
    );
    return;
  }

  if (txt === "/help") {
    await sendMessage(env, chatId,
      "❓ *BANTUAN*\n\n1. /start → pilih exchange\n2. Pilih mode risiko\n3. Pilih pair\n4. Masukkan modal\n" +
      "5. Bot jalankan 9 AI + 1 konsensus → sinyal muncul\n6. '🔎 Lihat Detail 9 AI' untuk lihat opini individual\n" +
      "7. Chat bebas untuk follow-up (pakai 1 AI, lebih cepat)\n\n" +
      "Versi Cloudflare Workers ini baru support Binance. Tidak ada eksekusi order otomatis."
    );
    return;
  }

  if (!s.exchange) {
    await sendMessage(env, chatId, "⚠️ Pilih exchange dulu! Ketik /start.");
    return;
  }

  if (MODE_BTN[txt]) {
    s.mode = MODE_BTN[txt]; s.pair = null; s.modal = null; s.history = []; s.state = "selecting_pair"; s.last_opinions = [];
    await sendMessage(env, chatId, "⏳ Mengambil pairs live...");
    const { symbols } = await getTopPairsText(s.exchange, 20);
    s.pairs = symbols;
    await saveSession(env, uid, s);
    await sendMessage(env, chatId, `*${MODE_LABEL[s.mode]}* — Pilih pair:`, { reply_markup: pairsKb(symbols) });
    return;
  }

  if (txt === "📊 Top Pairs") {
    const { text } = await getTopPairsText(s.exchange, 20);
    await sendMessage(env, chatId, text);
    return;
  }

  if (txt === "🏦 Ganti Exchange") {
    Object.assign(s, { exchange: null, mode: null, pair: null, modal: null, state: "idle", history: [], last_opinions: [] });
    await saveSession(env, uid, s);
    await sendMessage(env, chatId, "Pilih exchange:", { reply_markup: exchangeKb() });
    return;
  }

  if (txt === "📈 Analisis Pasar") {
    const resp = await genGeneral(env, s.mode, "Analisis kondisi pasar crypto futures saat ini. Bullish/bearish? Pair menarik untuk scalping?");
    await sendMessage(env, chatId, `📈 *ANALISIS PASAR*\n\n${resp}`);
    return;
  }

  if (txt === "🔎 Lihat Detail 9 AI") {
    const opinions = s.last_opinions || [];
    if (!opinions.length) { await sendMessage(env, chatId, "📭 Belum ada hasil konsensus. Minta sinyal dulu."); return; }
    await sendMessage(env, chatId, `🔎 *DETAIL ${opinions.length} OPINI AI*`);
    for (let i = 0; i < opinions.length; i++) {
      await sendMessage(env, chatId, `*── AI #${i + 1} ──*\n${opinions[i]}`);
    }
    return;
  }

  if (txt === "❓ Bantuan") { await handleMessage({ ...message, text: "/help" }, env); return; }

  if (s.state === "custom_pair") {
    const pair = txt.toUpperCase().replace(/[/\- ]/g, "");
    s.pair = pair; s.state = "asking_modal";
    await saveSession(env, uid, s);
    await sendMessage(env, chatId, `✅ Pair: *${pair}*\n\nMasukkan modal ($):`);
    return;
  }

  if (s.state === "asking_modal") {
    const modal = parseFloat(txt.replace(/[$,]/g, ""));
    if (!modal || modal <= 0) { await sendMessage(env, chatId, "❌ Masukkan angka yang valid. Contoh: `5`"); return; }
    s.modal = modal; s.state = "chatting"; s.history = [];
    await saveSession(env, uid, s);
    await sendMessage(env, chatId, `✅ *Setup siap!*\n📌 ${s.pair} | Modal: $${modal}\n\n⏳ Menjalankan 9 AI + 1 konsensus... (~10-20 detik)`);
    try {
      const { final, opinions } = await genConsensusSignal(env, s.exchange, s.mode, s.pair, modal);
      s.last_opinions = opinions;
      await saveSession(env, uid, s);
      await sendMessage(env, chatId, final, { reply_markup: mainKb() });
    } catch (e) {
      await sendMessage(env, chatId, `❌ Error: ${e}`, { reply_markup: mainKb() });
    }
    return;
  }

  if (s.state === "chatting") {
    try {
      const resp = await genSignal(env, s.exchange, s.mode, s.pair, s.modal, txt, s.history);
      if (s.history.length > 20) s.history = s.history.slice(-20);
      await saveSession(env, uid, s);
      await sendMessage(env, chatId, resp);
    } catch (e) {
      await sendMessage(env, chatId, `❌ Error: ${e}\n\n/start untuk reset.`);
    }
    return;
  }

  const resp = await genGeneral(env, s.mode, txt);
  await sendMessage(env, chatId, resp + "\n\n💡 Pilih mode dari keyboard atau /start.");
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const uid = cb.from.id;
  const data = cb.data;
  const s = await getSession(env, uid);

  if (!isAllowed(uid, env)) { await answerCallback(env, cb.id, "🔒 Akses ditolak."); return; }
  await answerCallback(env, cb.id, "");

  if (data.startsWith("exch_")) {
    const key = data.slice(5);
    if (!EXCHANGE_LABEL[key]) { await sendMessage(env, chatId, "⚠️ Exchange ini belum diporting ke versi Cloudflare Workers."); return; }
    s.exchange = key; s.state = "idle";
    await saveSession(env, uid, s);
    await editMessageText(env, chatId, cb.message.message_id, `✅ Exchange: *${EXCHANGE_LABEL[key].emoji} ${EXCHANGE_LABEL[key].name}*\n\nPilih mode trading dari keyboard di bawah!`);
    await sendMessage(env, chatId, "Pilih mode trading:", { reply_markup: mainKb() });
    return;
  }

  if (data.startsWith("page_")) {
    const page = parseInt(data.slice(5), 10);
    await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message.message_id, reply_markup: pairsKb(s.pairs, page) });
    return;
  }

  if (data === "pair_custom") {
    s.state = "custom_pair";
    await saveSession(env, uid, s);
    await editMessageText(env, chatId, cb.message.message_id, "✍️ Ketik nama pair:\nContoh: `BTCUSDT` atau `SOLUSDT`");
    return;
  }

  if (data.startsWith("pair_")) {
    const pair = data.slice(5);
    s.pair = pair; s.state = "asking_modal";
    await saveSession(env, uid, s);
    await editMessageText(env, chatId, cb.message.message_id, `✅ Pair: *${pair}*\n\nMasukkan modal ($):`);
    return;
  }
}
