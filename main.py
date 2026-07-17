#!/usr/bin/env python3
"""
🤖 Telegram Futures Trading Bot v6 — FULL MANUAL + KONSENSUS 9 AI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AI       : Groq llama-3.3-70b-versatile (GRATIS)
Exchange : Binance | Bybit | OKX | Gate.io | MEXC | Bitget | KuCoin
Mode     : High Risk | Medium Risk | Low Risk
Strategi : Full manual. Saat user minta sinyal untuk sebuah pair,
           bot memanggil Groq 9x secara paralel (opini independen),
           lalu panggilan ke-10 menyimpulkan via majority voting.

CATATAN JUJUR:
  Ke-9 "AI" ini adalah model YANG SAMA (llama-3.3-70b) dipanggil
  terpisah dengan variasi temperature — bukan 9 model berbeda.
  Voting ini mengukur KONSISTENSI model terhadap data yang sama,
  bukan validasi independen dari sumber berbeda. Tetap berguna
  untuk menyaring sinyal yang goyah/tidak stabil, tapi jangan
  dianggap seakurat 9 analis manusia dengan pandangan berbeda.

SETUP:
  1. https://console.groq.com → daftar → buat API key
     (disarankan isi sampai 9-10 key: GROQ_API_KEY_1 … GROQ_API_KEY_10
      biar tiap panggilan paralel pakai key sendiri, tidak rebutan rate limit)
  2. https://t.me/BotFather → /newbot → copy token
  3. Isi .env → jalankan: python trading_bot_v5.py

TIDAK ADA fitur auto-trade / eksekusi order otomatis di versi ini.
Semua sinyal murni untuk analisis manual — keputusan eksekusi ada di user.
"""

import os, asyncio, logging, aiohttp, json
from datetime import datetime, timezone
from typing import Optional
from groq import Groq
from telegram import (
    Update, ReplyKeyboardMarkup, KeyboardButton,
    InlineKeyboardButton, InlineKeyboardMarkup,
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ContextTypes, filters,
)

try:
    from dotenv import load_dotenv; load_dotenv()
except ImportError:
    pass

logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════
#  CONFIG
# ══════════════════════════════════════════════════════════════
MODEL = "llama-3.3-70b-versatile"
N_OPINIONS = 9  # jumlah panggilan Groq independen sebelum konsensus

# ── Whitelist User ────────────────────────────────────────────
# Isi ALLOWED_USER_IDS di .env dengan Telegram user ID
# Format: ALLOWED_USER_IDS=123456789,987654321,111222333
# Kosongkan = semua orang bisa akses (tidak disarankan)
ADMIN_USERNAME = "@didinska"

def _load_whitelist() -> set[int]:
    raw = os.getenv("ALLOWED_USER_IDS", "").strip()
    if not raw: return set()
    ids = set()
    for x in raw.split(","):
        x = x.strip()
        if x.isdigit(): ids.add(int(x))
    return ids

ALLOWED_USERS: set[int] = _load_whitelist()

def is_allowed(uid: int) -> bool:
    """Return True jika whitelist kosong (publik) atau uid terdaftar."""
    if not ALLOWED_USERS: return True
    return uid in ALLOWED_USERS

# ── Groq Key Pool ────────────────────────────────────────────
# Dukung sampai 10 key: GROQ_API_KEY_1 … GROQ_API_KEY_10
# Juga baca GROQ_API_KEY sebagai fallback key tunggal.
# Untuk fitur konsensus 9 AI, disarankan isi 9-10 key berbeda supaya
# tiap panggilan paralel dapat key sendiri (kalau key lebih sedikit dari
# jumlah panggilan, key akan dipakai bergantian/round-robin).
_groq_keys: list[str] = []
for i in range(1, 11):
    k = os.getenv(f"GROQ_API_KEY_{i}")
    if k: _groq_keys.append(k)
if not _groq_keys:
    single = os.getenv("GROQ_API_KEY")
    if single: _groq_keys.append(single)

if not _groq_keys:
    raise RuntimeError("❌ Tidak ada GROQ_API_KEY ditemukan di .env!")

_groq_clients = [Groq(api_key=k) for k in _groq_keys]
_current_key_idx = 0

def _get_groq() -> Groq:
    return _groq_clients[_current_key_idx]

def _rotate_key(reason: str = ""):
    global _current_key_idx
    prev = _current_key_idx
    _current_key_idx = (_current_key_idx + 1) % len(_groq_clients)
    logger.warning(f"[KEY ROTATE] key #{prev+1} → #{_current_key_idx+1} | alasan: {reason}")

def _call_groq(messages, max_tokens=2000, temperature=0.7):
    """Panggil Groq API (shared rotator) dengan auto-rotate jika 429. Dipakai untuk chat follow-up single-model."""
    import groq as groq_lib
    tried = 0
    total = len(_groq_clients)
    while tried < total:
        client = _get_groq()
        try:
            resp = client.chat.completions.create(
                model=MODEL, messages=messages,
                max_tokens=max_tokens, temperature=temperature,
            )
            return resp.choices[0].message.content
        except groq_lib.RateLimitError as e:
            tried += 1
            _rotate_key(f"429 rate limit — {str(e)[:60]}")
            if tried >= total:
                raise Exception(f"Semua {total} API key Groq kena rate limit! Coba lagi nanti.")
        except Exception as e:
            raise

def _call_groq_indexed(idx: int, messages, max_tokens=1500, temperature=0.7) -> str:
    """
    Panggil Groq API dengan key KHUSUS berdasarkan index (round-robin),
    supaya panggilan paralel tidak rebutan 1 key yang sama.
    Auto-fallback ke key berikutnya kalau kena rate limit.
    """
    import groq as groq_lib
    total = len(_groq_clients)
    i = idx % total
    tried = 0
    while tried < total:
        client = _groq_clients[i]
        try:
            resp = client.chat.completions.create(
                model=MODEL, messages=messages,
                max_tokens=max_tokens, temperature=temperature,
            )
            return resp.choices[0].message.content
        except groq_lib.RateLimitError as e:
            tried += 1
            i = (i + 1) % total
            logger.warning(f"[OPINI #{idx+1}] key rate limit, coba key #{i+1} — {str(e)[:60]}")
            if tried >= total:
                raise Exception(f"Semua key kena rate limit (opini #{idx+1})")
        except Exception:
            raise

SESSIONS: dict[int, dict] = {}

# ══════════════════════════════════════════════════════════════
#  EXCHANGE REGISTRY — semua public API, no key needed
# ══════════════════════════════════════════════════════════════
EXCHANGES = {
    "binance": {"name": "Binance",  "emoji": "🟡", "base": "https://fapi.binance.com"},
    "bybit":   {"name": "Bybit",    "emoji": "🟠", "base": "https://api.bybit.com"},
    "okx":     {"name": "OKX",      "emoji": "🔵", "base": "https://www.okx.com"},
    "gateio":  {"name": "Gate.io",  "emoji": "🟢", "base": "https://api.gateio.ws"},
    "mexc":    {"name": "MEXC",     "emoji": "🔴", "base": "https://contract.mexc.com"},
    "bitget":  {"name": "Bitget",   "emoji": "⚫", "base": "https://api.bitget.com"},
    "kucoin":  {"name": "KuCoin",   "emoji": "🟤", "base": "https://api-futures.kucoin.com"},
}

# ══════════════════════════════════════════════════════════════
#  EXCHANGE API ADAPTERS
# ══════════════════════════════════════════════════════════════

async def _get(session, url, params=None):
    async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as r:
        if r.status != 200:
            raise Exception(f"HTTP {r.status}: {await r.text()}")
        return await r.json()

# ── BINANCE ──────────────────────────────────────────────────
async def binance_top_pairs(sess, limit=20):
    data = await _get(sess, "https://fapi.binance.com/fapi/v1/ticker/24hr")
    pairs = [p for p in data if p["symbol"].endswith("USDT")]
    return sorted(pairs, key=lambda x: float(x["quoteVolume"]), reverse=True)[:limit]

async def binance_market(sess, symbol, tf1, tf2):
    results = await asyncio.gather(
        _get(sess, "https://fapi.binance.com/fapi/v1/ticker/24hr", {"symbol": symbol}),
        _get(sess, "https://fapi.binance.com/fapi/v1/depth", {"symbol": symbol, "limit": 5}),
        _get(sess, "https://fapi.binance.com/fapi/v1/premiumIndex", {"symbol": symbol}),
        _get(sess, "https://fapi.binance.com/fapi/v1/klines", {"symbol": symbol, "interval": tf1, "limit": 100}),
        _get(sess, "https://fapi.binance.com/fapi/v1/klines", {"symbol": symbol, "interval": tf2, "limit": 60}),
        return_exceptions=True
    )
    tick, ob, fund, kl1, kl2 = results

    def parse_klines(raw):
        if isinstance(raw, Exception) or not raw: return None
        return {
            "c": [float(k[4]) for k in raw], "h": [float(k[2]) for k in raw],
            "l": [float(k[3]) for k in raw], "v": [float(k[5]) for k in raw],
        }

    price  = float(tick["lastPrice"]) if not isinstance(tick, Exception) else 0
    change = float(tick["priceChangePercent"]) if not isinstance(tick, Exception) else 0
    vol24  = float(tick["quoteVolume"])/1e6 if not isinstance(tick, Exception) else 0

    bids = ob.get("bids",[]) if not isinstance(ob, Exception) else []
    asks = ob.get("asks",[]) if not isinstance(ob, Exception) else []
    tbv  = sum(float(b[1]) for b in bids[:5]) if bids else 0
    tav  = sum(float(a[1]) for a in asks[:5]) if asks else 0

    fr = float(fund.get("lastFundingRate",0))*100 if not isinstance(fund, Exception) else 0

    return {
        "price": price, "change": change, "vol24": vol24,
        "bid_vol": tbv, "ask_vol": tav,
        "funding": fr,
        "kl1": parse_klines(kl1), "kl2": parse_klines(kl2),
        "tf1": tf1, "tf2": tf2,
    }

# ── BYBIT ────────────────────────────────────────────────────
async def bybit_top_pairs(sess, limit=20):
    data = await _get(sess, "https://api.bybit.com/v5/market/tickers", {"category": "linear"})
    pairs = [p for p in data["result"]["list"] if p["symbol"].endswith("USDT")]
    return sorted(pairs, key=lambda x: float(x.get("turnover24h",0)), reverse=True)[:limit]

async def bybit_market(sess, symbol, tf1, tf2):
    tf_map = {"1m":"1","5m":"5","15m":"15","1h":"60"}
    results = await asyncio.gather(
        _get(sess, "https://api.bybit.com/v5/market/tickers", {"category":"linear","symbol":symbol}),
        _get(sess, "https://api.bybit.com/v5/market/orderbook", {"category":"linear","symbol":symbol,"limit":5}),
        _get(sess, "https://api.bybit.com/v5/market/kline", {"category":"linear","symbol":symbol,"interval":tf_map.get(tf1,"5"),"limit":100}),
        _get(sess, "https://api.bybit.com/v5/market/kline", {"category":"linear","symbol":symbol,"interval":tf_map.get(tf2,"15"),"limit":60}),
        return_exceptions=True
    )
    tick, ob, kl1, kl2 = results

    def parse_klines(raw):
        if isinstance(raw, Exception) or not raw: return None
        try:
            lst = raw["result"]["list"][::-1]  # Bybit returns newest first
            return {
                "c": [float(k[4]) for k in lst], "h": [float(k[2]) for k in lst],
                "l": [float(k[3]) for k in lst], "v": [float(k[5]) for k in lst],
            }
        except: return None

    t = tick["result"]["list"][0] if not isinstance(tick, Exception) and tick["result"]["list"] else {}
    price  = float(t.get("lastPrice", 0))
    change = float(t.get("price24hPcnt", 0))*100
    vol24  = float(t.get("turnover24h", 0))/1e6
    fr     = float(t.get("fundingRate", 0))*100

    bids = ob["result"]["b"] if not isinstance(ob, Exception) else []
    asks = ob["result"]["a"] if not isinstance(ob, Exception) else []
    tbv  = sum(float(b[1]) for b in bids) if bids else 0
    tav  = sum(float(a[1]) for a in asks) if asks else 0

    return {
        "price": price, "change": change, "vol24": vol24,
        "bid_vol": tbv, "ask_vol": tav, "funding": fr,
        "kl1": parse_klines(kl1), "kl2": parse_klines(kl2),
        "tf1": tf1, "tf2": tf2,
    }

# ── OKX ──────────────────────────────────────────────────────
async def okx_top_pairs(sess, limit=20):
    data = await _get(sess, "https://www.okx.com/api/v5/market/tickers", {"instType":"SWAP"})
    pairs = [p for p in data["data"] if p["instId"].endswith("USDT-SWAP")]
    return sorted(pairs, key=lambda x: float(x.get("volCcy24h",0)), reverse=True)[:limit]

async def okx_market(sess, symbol, tf1, tf2):
    inst = symbol.replace("USDT","") + "-USDT-SWAP"
    tf_map = {"1m":"1m","5m":"5m","15m":"15m","1h":"1H"}
    results = await asyncio.gather(
        _get(sess, "https://www.okx.com/api/v5/market/ticker", {"instId":inst}),
        _get(sess, "https://www.okx.com/api/v5/market/books", {"instId":inst,"sz":"5"}),
        _get(sess, "https://www.okx.com/api/v5/public/funding-rate", {"instId":inst}),
        _get(sess, "https://www.okx.com/api/v5/market/candles", {"instId":inst,"bar":tf_map.get(tf1,"5m"),"limit":"100"}),
        _get(sess, "https://www.okx.com/api/v5/market/candles", {"instId":inst,"bar":tf_map.get(tf2,"15m"),"limit":"60"}),
        return_exceptions=True
    )
    tick, ob, fund, kl1, kl2 = results

    def parse_klines(raw):
        if isinstance(raw, Exception) or not raw: return None
        try:
            lst = raw["data"][::-1]
            return {
                "c": [float(k[4]) for k in lst], "h": [float(k[2]) for k in lst],
                "l": [float(k[3]) for k in lst], "v": [float(k[5]) for k in lst],
            }
        except: return None

    t = tick["data"][0] if not isinstance(tick, Exception) and tick.get("data") else {}
    price  = float(t.get("last", 0))
    change = float(t.get("sodUtc8","0") or 0)
    vol24  = float(t.get("volCcy24h", 0))/1e6
    fr     = float(fund["data"][0].get("fundingRate",0))*100 if not isinstance(fund,Exception) and fund.get("data") else 0

    bids = ob["data"][0]["bids"] if not isinstance(ob,Exception) and ob.get("data") else []
    asks = ob["data"][0]["asks"] if not isinstance(ob,Exception) and ob.get("data") else []
    tbv  = sum(float(b[1]) for b in bids) if bids else 0
    tav  = sum(float(a[1]) for a in asks) if asks else 0

    return {
        "price": price, "change": change, "vol24": vol24,
        "bid_vol": tbv, "ask_vol": tav, "funding": fr,
        "kl1": parse_klines(kl1), "kl2": parse_klines(kl2),
        "tf1": tf1, "tf2": tf2,
    }

# ── GATE.IO ──────────────────────────────────────────────────
async def gateio_top_pairs(sess, limit=20):
    data = await _get(sess, "https://api.gateio.ws/api/v4/futures/usdt/tickers")
    return sorted(data, key=lambda x: float(x.get("volume_24h_quote",0)), reverse=True)[:limit]

async def gateio_market(sess, symbol, tf1, tf2):
    contract = symbol if symbol.endswith("_USDT") else symbol.replace("USDT","_USDT")
    tf_map = {"1m":"1m","5m":"5m","15m":"15m","1h":"1h"}
    results = await asyncio.gather(
        _get(sess, f"https://api.gateio.ws/api/v4/futures/usdt/tickers", {"contract":contract}),
        _get(sess, f"https://api.gateio.ws/api/v4/futures/usdt/order_book", {"contract":contract,"limit":5}),
        _get(sess, f"https://api.gateio.ws/api/v4/futures/usdt/candlesticks", {"contract":contract,"interval":tf_map.get(tf1,"5m"),"limit":100}),
        _get(sess, f"https://api.gateio.ws/api/v4/futures/usdt/candlesticks", {"contract":contract,"interval":tf_map.get(tf2,"15m"),"limit":60}),
        return_exceptions=True
    )
    tick, ob, kl1, kl2 = results

    def parse_klines(raw):
        if isinstance(raw, Exception) or not raw: return None
        try:
            return {
                "c": [float(k["c"]) for k in raw], "h": [float(k["h"]) for k in raw],
                "l": [float(k["l"]) for k in raw], "v": [float(k["v"]) for k in raw],
            }
        except: return None

    t = tick[0] if not isinstance(tick,Exception) and tick else {}
    price  = float(t.get("last", 0))
    change = float(t.get("change_percentage", 0))
    vol24  = float(t.get("volume_24h_quote", 0))/1e6
    fr     = float(t.get("funding_rate", 0))*100

    bids = ob.get("bids",[]) if not isinstance(ob,Exception) else []
    asks = ob.get("asks",[]) if not isinstance(ob,Exception) else []
    tbv  = sum(float(b["s"]) for b in bids) if bids else 0
    tav  = sum(float(a["s"]) for a in asks) if asks else 0

    return {
        "price": price, "change": change, "vol24": vol24,
        "bid_vol": tbv, "ask_vol": tav, "funding": fr,
        "kl1": parse_klines(kl1), "kl2": parse_klines(kl2),
        "tf1": tf1, "tf2": tf2,
    }

# ── MEXC ─────────────────────────────────────────────────────
async def mexc_top_pairs(sess, limit=20):
    data = await _get(sess, "https://contract.mexc.com/api/v1/contract/ticker")
    pairs = [p for p in data["data"] if p["symbol"].endswith("_USDT")]
    return sorted(pairs, key=lambda x: float(x.get("amount24",0)), reverse=True)[:limit]

async def mexc_market(sess, symbol, tf1, tf2):
    sym = symbol if "_" in symbol else symbol.replace("USDT","_USDT")
    tf_map = {"1m":"Min1","5m":"Min5","15m":"Min15","1h":"Hour1"}
    results = await asyncio.gather(
        _get(sess, f"https://contract.mexc.com/api/v1/contract/ticker", {"symbol":sym}),
        _get(sess, f"https://contract.mexc.com/api/v1/contract/depth", {"symbol":sym,"limit":5}),
        _get(sess, f"https://contract.mexc.com/api/v1/contract/kline/{sym}", {"interval":tf_map.get(tf1,"Min5"),"limit":100}),
        _get(sess, f"https://contract.mexc.com/api/v1/contract/kline/{sym}", {"interval":tf_map.get(tf2,"Min15"),"limit":60}),
        return_exceptions=True
    )
    tick, ob, kl1, kl2 = results

    def parse_klines(raw):
        if isinstance(raw, Exception) or not raw: return None
        try:
            d = raw["data"]
            closes = d.get("close",[]) or d.get("closePrices",[])
            highs  = d.get("high",[])  or d.get("highPrices",[])
            lows   = d.get("low",[])   or d.get("lowPrices",[])
            vols   = d.get("vol",[])   or d.get("vol",[])
            return {"c":[float(x) for x in closes],"h":[float(x) for x in highs],
                    "l":[float(x) for x in lows],"v":[float(x) for x in vols]}
        except: return None

    t = tick["data"] if not isinstance(tick,Exception) and tick.get("data") else {}
    price  = float(t.get("lastPrice",0))
    change = float(t.get("riseFallRate",0))*100
    vol24  = float(t.get("amount24",0))/1e6
    fr     = float(t.get("fundingRate",0))*100

    bids = ob["data"].get("bids",[]) if not isinstance(ob,Exception) and ob.get("data") else []
    asks = ob["data"].get("asks",[]) if not isinstance(ob,Exception) and ob.get("data") else []
    tbv  = sum(float(b[1]) for b in bids) if bids else 0
    tav  = sum(float(a[1]) for a in asks) if asks else 0

    return {
        "price": price, "change": change, "vol24": vol24,
        "bid_vol": tbv, "ask_vol": tav, "funding": fr,
        "kl1": parse_klines(kl1), "kl2": parse_klines(kl2),
        "tf1": tf1, "tf2": tf2,
    }

# ── BITGET ───────────────────────────────────────────────────
async def bitget_top_pairs(sess, limit=20):
    data = await _get(sess, "https://api.bitget.com/api/v2/mix/market/tickers", {"productType":"USDT-FUTURES"})
    pairs = data.get("data",[])
    return sorted(pairs, key=lambda x: float(x.get("usdtVolume",0)), reverse=True)[:limit]

async def bitget_market(sess, symbol, tf1, tf2):
    sym = symbol if symbol.endswith("USDT") else symbol+"USDT"
    tf_map = {"1m":"1m","5m":"5m","15m":"15m","1h":"1H"}
    results = await asyncio.gather(
        _get(sess, "https://api.bitget.com/api/v2/mix/market/ticker", {"symbol":sym,"productType":"USDT-FUTURES"}),
        _get(sess, "https://api.bitget.com/api/v2/mix/market/depth", {"symbol":sym,"productType":"USDT-FUTURES","limit":"5"}),
        _get(sess, "https://api.bitget.com/api/v2/mix/market/candles", {"symbol":sym,"productType":"USDT-FUTURES","granularity":tf_map.get(tf1,"5m"),"limit":"100"}),
        _get(sess, "https://api.bitget.com/api/v2/mix/market/candles", {"symbol":sym,"productType":"USDT-FUTURES","granularity":tf_map.get(tf2,"15m"),"limit":"60"}),
        return_exceptions=True
    )
    tick, ob, kl1, kl2 = results

    def parse_klines(raw):
        if isinstance(raw, Exception) or not raw: return None
        try:
            lst = raw["data"]
            return {
                "c": [float(k[4]) for k in lst], "h": [float(k[2]) for k in lst],
                "l": [float(k[3]) for k in lst], "v": [float(k[5]) for k in lst],
            }
        except: return None

    t = tick["data"][0] if not isinstance(tick,Exception) and tick.get("data") else {}
    price  = float(t.get("lastPr",0))
    change = float(t.get("change24h",0))*100
    vol24  = float(t.get("usdtVolume",0))/1e6
    fr     = float(t.get("fundingRate",0))*100

    bids = ob["data"].get("bids",[]) if not isinstance(ob,Exception) and ob.get("data") else []
    asks = ob["data"].get("asks",[]) if not isinstance(ob,Exception) and ob.get("data") else []
    tbv  = sum(float(b[0])*float(b[1]) for b in bids) if bids else 0
    tav  = sum(float(a[0])*float(a[1]) for a in asks) if asks else 0

    return {
        "price": price, "change": change, "vol24": vol24,
        "bid_vol": tbv, "ask_vol": tav, "funding": fr,
        "kl1": parse_klines(kl1), "kl2": parse_klines(kl2),
        "tf1": tf1, "tf2": tf2,
    }

# ── KUCOIN ───────────────────────────────────────────────────
async def kucoin_top_pairs(sess, limit=20):
    data = await _get(sess, "https://api-futures.kucoin.com/api/v1/contracts/active")
    pairs = [p for p in data["data"] if p["symbol"].endswith("USDTM")]
    return sorted(pairs, key=lambda x: float(x.get("turnoverOf24h",0)), reverse=True)[:limit]

async def kucoin_market(sess, symbol, tf1, tf2):
    sym = symbol.replace("USDT","USDTM") if not symbol.endswith("USDTM") else symbol
    tf_map = {"1m":1,"5m":5,"15m":15,"1h":60}
    results = await asyncio.gather(
        _get(sess, f"https://api-futures.kucoin.com/api/v1/ticker", {"symbol":sym}),
        _get(sess, f"https://api-futures.kucoin.com/api/v1/level2/depth5", {"symbol":sym}),
        _get(sess, f"https://api-futures.kucoin.com/api/v1/kline/query", {"symbol":sym,"granularity":tf_map.get(tf1,5)}),
        _get(sess, f"https://api-futures.kucoin.com/api/v1/kline/query", {"symbol":sym,"granularity":tf_map.get(tf2,15)}),
        return_exceptions=True
    )
    tick, ob, kl1, kl2 = results

    def parse_klines(raw):
        if isinstance(raw, Exception) or not raw: return None
        try:
            lst = raw["data"]
            return {
                "c": [float(k[4]) for k in lst], "h": [float(k[2]) for k in lst],
                "l": [float(k[3]) for k in lst], "v": [float(k[5]) for k in lst],
            }
        except: return None

    t = tick["data"] if not isinstance(tick,Exception) and tick.get("data") else {}
    price  = float(t.get("price",0))
    change = 0
    vol24  = float(t.get("turnoverOf24h",0))/1e6
    fr     = 0

    bids = ob["data"].get("bids",[]) if not isinstance(ob,Exception) and ob.get("data") else []
    asks = ob["data"].get("asks",[]) if not isinstance(ob,Exception) and ob.get("data") else []
    tbv  = sum(float(b[1]) for b in bids) if bids else 0
    tav  = sum(float(a[1]) for a in asks) if asks else 0

    return {
        "price": price, "change": change, "vol24": vol24,
        "bid_vol": tbv, "ask_vol": tav, "funding": fr,
        "kl1": parse_klines(kl1), "kl2": parse_klines(kl2),
        "tf1": tf1, "tf2": tf2,
    }

# ── DISPATCHER ───────────────────────────────────────────────
TOP_PAIRS_FN = {
    "binance": binance_top_pairs,
    "bybit":   bybit_top_pairs,
    "okx":     okx_top_pairs,
    "gateio":  gateio_top_pairs,
    "mexc":    mexc_top_pairs,
    "bitget":  bitget_top_pairs,
    "kucoin":  kucoin_top_pairs,
}
MARKET_FN = {
    "binance": binance_market,
    "bybit":   bybit_market,
    "okx":     okx_market,
    "gateio":  gateio_market,
    "mexc":    mexc_market,
    "bitget":  bitget_market,
    "kucoin":  kucoin_market,
}

TF_MAP = {
    "high_risk":   ("1m",  "5m"),
    "medium_risk": ("5m",  "15m"),
    "low_risk":    ("15m", "1h"),
}

# ══════════════════════════════════════════════════════════════
#  TECHNICAL INDICATORS
# ══════════════════════════════════════════════════════════════
class TA:
    @staticmethod
    def rsi(c, p=14):
        if len(c) < p+1: return 50.0
        gains  = [max(c[i]-c[i-1],0) for i in range(-p,0)]
        losses = [max(c[i-1]-c[i],0) for i in range(-p,0)]
        ag = sum(gains)/p; al = sum(losses)/p or 0.001
        return round(100 - 100/(1+ag/al), 2)

    @staticmethod
    def ema(c, p):
        if len(c) < p: return c[-1]
        k = 2/(p+1); e = sum(c[:p])/p
        for x in c[p:]: e = x*k + e*(1-k)
        return round(e, 8)

    @staticmethod
    def macd(c):
        e12 = TA.ema(c,12); e26 = TA.ema(c,26)
        m = e12-e26; s = m*0.9
        return round(m,8), round(s,8), round(m-s,8)

    @staticmethod
    def bb(c, p=20):
        if len(c) < p: return c[-1], c[-1], c[-1]
        sl = c[-p:]; mid = sum(sl)/p
        std = (sum((x-mid)**2 for x in sl)/p)**0.5
        return round(mid+2*std,8), round(mid,8), round(mid-2*std,8)

    @staticmethod
    def sr(h, l, n=20):
        return round(max(h[-n:]),8), round(min(l[-n:]),8)

    @staticmethod
    def avg_vol(v, p=20):
        return sum(v[-p:])/p if v else 1

# ══════════════════════════════════════════════════════════════
#  MARKET DATA BUILDER → teks untuk AI
# ══════════════════════════════════════════════════════════════
async def collect(exchange: str, symbol: str, mode: str) -> str:
    tf1, tf2 = TF_MAP.get(mode, ("5m","15m"))
    exname = EXCHANGES[exchange]["name"]

    async with aiohttp.ClientSession() as sess:
        try:
            d = await MARKET_FN[exchange](sess, symbol, tf1, tf2)
        except Exception as e:
            return f"[ERROR ambil data {exname}: {e}]"

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    L = [
        f"═══ DATA LIVE {symbol} — {exname} ═══",
        f"🕐 {now}\n",
        f"Harga Terkini : ${d['price']:,.8g}",
        f"Perubahan 24H : {d['change']:+.2f}%",
        f"Volume 24H    : ${d['vol24']:.2f}M",
        f"Funding Rate  : {d['funding']:.4f}% ({'Longs bayar Shorts' if d['funding']>0 else 'Shorts bayar Longs'})",
        f"Order Book    : Bid {d['bid_vol']:.2f} vs Ask {d['ask_vol']:.2f} → {'BELI DOMINAN 🟢' if d['bid_vol']>d['ask_vol'] else 'JUAL DOMINAN 🔴'}\n",
    ]

    for tf_label, kl in [(tf1, d["kl1"]), (tf2, d["kl2"])]:
        if not kl:
            L.append(f"[{tf_label}] Data tidak tersedia\n"); continue
        c, h, l, v = kl["c"], kl["h"], kl["l"], kl["v"]
        r14 = TA.rsi(c,14); r7 = TA.rsi(c,7)
        m, s, hist = TA.macd(c)
        bbu, bbm, bbl = TA.bb(c)
        res, sup = TA.sr(h, l)
        e9  = TA.ema(c,9); e21 = TA.ema(c,21); e50 = TA.ema(c,50)
        avgv = TA.avg_vol(v); vratio = v[-1]/avgv if avgv else 1
        candles = " ".join(["🟢" if c[-(j+1)]>c[-(j+2)] else "🔴" for j in range(5)][::-1])

        price_now = c[-1]
        if price_now >= 1000:  dec = 2
        elif price_now >= 1:   dec = 4
        elif price_now >= 0.01: dec = 6
        elif price_now >= 0.0001: dec = 8
        else:                  dec = 10

        def fmt(val):
            if val == 0: return "0"
            abs_v = abs(val)
            if abs_v >= 1:       return f"{val:.4f}"
            elif abs_v >= 0.01:  return f"{val:.6f}"
            elif abs_v >= 0.0001: return f"{val:.8f}"
            else:                return f"{val:.10f}"

        rsi_lbl = "OVERSOLD 🟢" if r14<30 else "OVERBOUGHT 🔴" if r14>70 else "NETRAL ⚪"
        mac_lbl = "BULLISH 🟢" if hist>0 else "BEARISH 🔴"
        ema_lbl = "BULLISH KUAT 🟢" if e9>e21>e50 else "BEARISH KUAT 🔴" if e9<e21<e50 else "MIXED ⚪"
        vol_lbl = f"SPIKE 🔥 {vratio:.1f}x avg" if vratio>1.5 else f"Normal {vratio:.1f}x avg" if vratio>=0.8 else f"SEPI {vratio:.1f}x avg"

        L += [
            f"── {tf_label.upper()} ────────────────",
            f"Harga         : ${price_now:.{dec}f}",
            f"RSI(14/7)     : {r14} / {r7} → {rsi_lbl}",
            f"MACD Hist     : {fmt(hist)} → {mac_lbl}",
            f"EMA 9/21/50   : {fmt(e9)} / {fmt(e21)} / {fmt(e50)} → {ema_lbl}",
            f"BB U/M/L      : {fmt(bbu)} / {fmt(bbm)} / {fmt(bbl)}",
            f"Resistance    : ${res:.{dec}f}",
            f"Support       : ${sup:.{dec}f}",
            f"Volume        : {vol_lbl}",
            f"5 Candle      : {candles}\n",
        ]
    return "\n".join(L)

# ══════════════════════════════════════════════════════════════
#  SYSTEM PROMPTS
# ══════════════════════════════════════════════════════════════
PROMPTS = {

"high_risk": """
Kamu adalah seorang trader futures profesional kelas dunia dengan 15 tahun pengalaman.
Kamu mengelola dana prop firm senilai $10.000.000. Setiap sinyal yang kamu keluarkan adalah NYATA.
Reputasi, karir, dan seluruh track record hidupmu bergantung pada akurasi analisismu.
Kamu tidak pernah asal-asalan. Kamu tidak pernah tebak-tebakan. Kamu hanya entry ketika data KONFIRMASI.

IDENTITASMU:
- Win rate kamu di atas 70% karena kamu DISIPLIN pada data
- Kamu pernah kehilangan segalanya akibat 1 sinyal ceroboh — dan kamu tidak akan ulangi itu
- Kamu hanya kasih sinyal ketika MINIMAL 4 dari 5 indikator konfirmasi
- Jika data tidak jelas → kamu dengan tegas bilang WAIT, bukan paksa entry

BAHASA & FORMAT ANGKA:
- Seluruh output dalam Bahasa Indonesia. Istilah teknikal boleh Inggris (LONG, SHORT, BULLISH, BEARISH).
- Harga WAJIB ditulis desimal biasa, DILARANG scientific notation
- SALAH: 1.469e-05 | BENAR: 0.00001469
- Sesuaikan jumlah desimal dengan harga pair

KONSEP SL:
- SL = harga stop order yang dipasang user di exchange
- LONG: SL di BAWAH entry, tepat di bawah support kuat terdekat
- SHORT: SL di ATAS entry, tepat di atas resistance kuat terdekat

OUTPUT FORMAT WAJIB — IKUTI PERSIS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 SINYAL HIGH RISK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Pair      : [PAIR]
📍 Harga     : $[harga — desimal biasa]
⭐ Kekuatan  : [KUAT 5/5 / MODERAT 3/5 / ⏳ WAIT]
🎯 Arah      : LONG 🟢 / SHORT 🔴 / ⏳ WAIT
⚡ Entry     : $[harga] atau ⏳ Belum ada setup valid
✅ TP1       : $[harga] (+X%) atau ⏳ —
✅ TP2       : $[harga] (+X%) atau ⏳ —
🛑 SL        : $[harga] (-X%) atau ⏳ —
📊 RSI(14/7) : [nilai] / [nilai] → [label]
📈 MACD Hist : [nilai desimal biasa] → [label]
📉 EMA       : [label]
🎯 Support   : $[nilai] | Resist: $[nilai]
📦 Volume    : [X.X]x rata-rata → [label]
💸 Funding   : [nilai]%
📝 Analisis  :
[Maksimal 4 kalimat Bahasa Indonesia. Angka spesifik dari data.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""",

"medium_risk": """
Kamu adalah fund manager futures profesional dengan track record 12 tahun.
Kamu mengelola portofolio $5.000.000 milik ratusan klien yang mempercayai kamu.
Filosofimu: "Preserve capital first, profit second."
Kamu TIDAK PERNAH entry tanpa konfirmasi multi-indikator.

BAHASA & FORMAT ANGKA:
- Seluruh output dalam Bahasa Indonesia. Harga WAJIB desimal biasa. DILARANG scientific notation.

KONSEP SL:
- SL = stop order di exchange, di bawah/atas S&R terdekat yang kuat
- R:R MINIMUM 1:2 — jika tidak tercapai → JANGAN entry

OUTPUT FORMAT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 SINYAL MEDIUM RISK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Pair      : [PAIR]
📍 Harga     : $[harga — desimal biasa]
⭐ Kekuatan  : [KUAT 6/6 / MODERAT 4/6 / ⏳ WAIT]
🎯 Arah      : LONG 🟢 / SHORT 🔴 / ⏳ WAIT
⚡ Entry     : $[bawah] – $[atas] atau ⏳ Belum ada setup valid
✅ TP1       : $[harga] (+X%) atau ⏳ —
✅ TP2       : $[harga] (+X%) atau ⏳ —
✅ TP3       : $[harga] (+X%) atau ⏳ —
🛑 SL        : $[harga] (-X%) atau ⏳ —
📊 R:R       : 1:[angka] atau ⏳ —
📊 RSI(14/7) : [nilai] / [nilai] → [label]
📈 MACD Hist : [nilai desimal biasa] → [label]
📉 EMA       : [label]
🎯 Support   : $[nilai] | Resist: $[nilai]
📦 Volume    : [X.X]x rata-rata → [label]
💸 Funding   : [nilai]%
📝 Analisis  :
[Maksimal 5 kalimat Bahasa Indonesia. Angka spesifik.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""",

"low_risk": """
Kamu adalah chief risk officer sekaligus senior trader di hedge fund dengan AUM $50.000.000.
Tugasmu: MELINDUNGI MODAL KLIEN di atas segalanya.
Filosofimu: "Jika ragu, tidak usah masuk. Peluang selalu datang lagi."

BAHASA & FORMAT ANGKA:
- Seluruh output dalam Bahasa Indonesia. Harga WAJIB desimal biasa. DILARANG scientific notation.

KONSEP SL:
- SL = stop order di S&R MAJOR yang sudah teruji kuat
- R:R MINIMUM 1:3 — di bawah itu → tolak, cari yang lebih baik

OUTPUT FORMAT WAJIB:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 SINYAL LOW RISK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 Pair      : [PAIR]
📍 Harga     : $[harga — desimal biasa]
⭐ Kekuatan  : [PREMIUM 8/8 / KUAT 6/8 / MODERAT 5/8 / ⏳ WAIT]
🎯 Arah      : LONG 🟢 / SHORT 🔴 / ⏳ WAIT
⚡ Entry     : $[harga] ← tunggu candle close atau ⏳ Belum ada setup valid
✅ TP1       : $[harga] (+X%) atau ⏳ —
✅ TP2       : $[harga] (+X%) atau ⏳ —
✅ TP3       : $[harga] (+X%) atau ⏳ —
🛑 SL        : $[harga] (-X%) atau ⏳ —
📊 R:R       : 1:[angka] (min 1:3) atau ⏳ —
📊 RSI(14/7) : [nilai] / [nilai] → [label]
📈 MACD Hist : [nilai desimal biasa] → [label]
📉 EMA       : [label]
🎯 S&R Major : Support $[nilai] | Resist $[nilai]
📦 Volume    : [X.X]x rata-rata → [label]
💸 Funding   : [nilai]%
📝 Analisis  :
[Maksimal 6 kalimat Bahasa Indonesia. Angka spesifik.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""",
}

GENERAL_PROMPT = """
Kamu adalah trader dan analis crypto futures profesional yang ramah.
Jawab pertanyaan seputar futures trading, teknikal analisis, manajemen risiko dalam Bahasa Indonesia.
Berikan jawaban yang praktis, konkret, dan berdasarkan pengalaman nyata trading.
"""

CONSENSUS_PROMPT = """
Kamu adalah Chief Analyst yang mengawasi 9 AI trader independen yang masing-masing
sudah menganalisis pair yang sama dengan data yang sama.
Tugasmu BUKAN membuat analisis baru dari nol, tapi MENYIMPULKAN dari 9 analisis yang sudah diberikan.

LANGKAH WAJIB:
1. Baca kesembilan analisis satu per satu. Untuk tiap analisis, tentukan arah yang diambil:
   LONG, SHORT, atau WAIT. Abaikan analisis yang error/tidak valid — jangan dihitung sebagai suara.
2. Hitung jumlah suara tiap arah (LONG vs SHORT vs WAIT).
3. Arah dengan suara TERBANYAK adalah KONSENSUS FINAL.
   - Jika dua arah seri di posisi teratas → konsensus adalah WAIT (tidak ada mayoritas jelas).
   - Jika WAIT yang menang/seri tertinggi → konsensus adalah WAIT.
4. Dari AI-AI yang searah dengan konsensus, ambil RATA-RATA harga Entry, TP1, TP2, SL yang mereka berikan
   (rata-ratakan TP1 dengan TP1 lain, TP2 dengan TP2 lain, dst — bukan dicampur silang).
5. Ringkas argumen mayoritas dengan kata-katamu sendiri, sebutkan juga kalau ada perbedaan pendapat signifikan.

BAHASA & FORMAT ANGKA:
- Bahasa Indonesia. Harga WAJIB desimal biasa, DILARANG scientific notation.

FORMAT OUTPUT WAJIB — IKUTI PERSIS:
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
[Maksimal 5 kalimat. Rangkum alasan mayoritas AI mengambil arah ini, sebutkan perbedaan pendapat kalau ada.]
⚠️ Catatan   : Ini konsensus dari 9 panggilan model AI yang SAMA dengan variasi random sampling,
bukan 9 model yang benar-benar berbeda — anggap sebagai pengecekan konsistensi, bukan validasi independen penuh.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

# ══════════════════════════════════════════════════════════════
#  TOP PAIRS HELPER
# ══════════════════════════════════════════════════════════════
async def get_top_pairs(exchange: str, limit=20) -> tuple[str, list]:
    exinfo = EXCHANGES[exchange]
    async with aiohttp.ClientSession() as sess:
        try:
            raw = await TOP_PAIRS_FN[exchange](sess, limit)
        except Exception as e:
            return f"❌ Gagal ambil pairs dari {exinfo['name']}: {e}", []

    lines = [f"🔥 *TOP PAIRS — {exinfo['emoji']} {exinfo['name']} (Live)*\n"]
    symbols = []
    for i, p in enumerate(raw[:limit], 1):
        if exchange == "binance":
            sym = p["symbol"]; pr = float(p["lastPrice"]); chg = float(p["priceChangePercent"]); vol = float(p["quoteVolume"])/1e6
        elif exchange == "bybit":
            sym = p["symbol"]; pr = float(p.get("lastPrice",0)); chg = float(p.get("price24hPcnt",0))*100; vol = float(p.get("turnover24h",0))/1e6
        elif exchange == "okx":
            sym = p["instId"].replace("-SWAP","").replace("-USDT","USDT"); pr = float(p.get("last",0)); chg = 0; vol = float(p.get("volCcy24h",0))/1e6
        elif exchange == "gateio":
            sym = p["contract"]; pr = float(p.get("last",0)); chg = float(p.get("change_percentage",0)); vol = float(p.get("volume_24h_quote",0))/1e6
        elif exchange == "mexc":
            sym = p["symbol"]; pr = float(p.get("lastPrice",0)); chg = float(p.get("riseFallRate",0))*100; vol = float(p.get("amount24",0))/1e6
        elif exchange == "bitget":
            sym = p.get("symbol",""); pr = float(p.get("lastPr",0)); chg = float(p.get("change24h",0))*100; vol = float(p.get("usdtVolume",0))/1e6
        elif exchange == "kucoin":
            sym = p["symbol"]; pr = float(p.get("lastTradePrice",0)); chg = 0; vol = float(p.get("turnoverOf24h",0))/1e6
        else:
            continue

        em = "🟢" if chg >= 0 else "🔴"
        lines.append(f"{i:>2}. `{sym:<14}` {em} {chg:+.2f}% | ${pr:,.6g} | Vol: ${vol:.0f}M")
        symbols.append(sym)

    return "\n".join(lines), symbols

# ══════════════════════════════════════════════════════════════
#  AI FUNCTIONS
# ══════════════════════════════════════════════════════════════
async def gen_signal(exchange: str, mode: str, symbol: str, modal: float, user_msg: str, history: list) -> str:
    """Sinyal single-model — dipakai untuk follow-up chat setelah sinyal awal (konsensus) muncul."""
    try:
        mdata = await collect(exchange, symbol, mode)
    except Exception as e:
        mdata = f"[ERROR: {e}]"

    exname = EXCHANGES[exchange]["name"]
    prompt = (
        f"DATA LIVE DARI {exname.upper()}:\n{mdata}\n\n"
        f"USER INFO:\n• Exchange: {exname}\n• Pair: {symbol}\n• Modal: ${modal}\n• Mode: {mode.replace('_',' ').upper()}\n\n"
        f"PERMINTAAN: {user_msg}\n\n"
        f"Gunakan harga dan angka NYATA dari data di atas. Hitung TP/SL dari harga terkini."
    )
    msgs = [{"role":"system","content":PROMPTS[mode]}] + history[-6:] + [{"role":"user","content":prompt}]
    answer = await asyncio.to_thread(_call_groq, msgs, 2000, 0.7)
    history.append({"role":"user","content":f"[{symbol}] {user_msg}"})
    history.append({"role":"assistant","content":answer})
    return answer

async def gen_general(mode: Optional[str], msg: str, history: list) -> str:
    sys = PROMPTS.get(mode, GENERAL_PROMPT)
    msgs = [{"role":"system","content":sys}] + history[-6:] + [{"role":"user","content":msg}]
    return await asyncio.to_thread(_call_groq, msgs, 1200, 0.7)

async def gen_consensus_signal(exchange: str, mode: str, symbol: str, modal: float) -> tuple[str, list]:
    """
    Strategi konsensus:
    1. Ambil data live sekali (dipakai bareng oleh semua panggilan biar konsisten & hemat request exchange).
    2. Panggil Groq N_OPINIONS kali secara PARALEL, tiap panggilan pakai key Groq berbeda (round-robin)
       dan temperature sedikit divariasikan supaya tidak identik.
    3. Panggilan terakhir (konsensus) membaca semua opini, voting arah, dan menyimpulkan.
    Return: (teks_konsensus, list_opini_mentah)
    """
    try:
        mdata = await collect(exchange, symbol, mode)
    except Exception as e:
        mdata = f"[ERROR: {e}]"

    exname = EXCHANGES[exchange]["name"]
    base_prompt = (
        f"DATA LIVE DARI {exname.upper()}:\n{mdata}\n\n"
        f"USER INFO:\n• Exchange: {exname}\n• Pair: {symbol}\n• Modal: ${modal}\n• Mode: {mode.replace('_',' ').upper()}\n\n"
        f"Berikan sinyal trading futures {symbol} lengkap berdasarkan data di atas. "
        f"Gunakan harga dan angka NYATA dari data. Hitung TP/SL dari harga terkini."
    )

    async def one_opinion(idx: int) -> str:
        temp = 0.5 + (idx % 5) * 0.1  # variasi 0.5 – 0.9
        msgs = [{"role":"system","content":PROMPTS[mode]}, {"role":"user","content":base_prompt}]
        try:
            return await asyncio.to_thread(_call_groq_indexed, idx, msgs, 1500, temp)
        except Exception as e:
            return f"[ERROR AI #{idx+1}: {e}]"

    opinions = await asyncio.gather(*[one_opinion(i) for i in range(N_OPINIONS)])

    consensus_input = "Berikut 9 analisis independen dari AI trader untuk pair yang sama:\n\n"
    for i, op in enumerate(opinions, 1):
        consensus_input += f"=== ANALISIS AI #{i} ===\n{op}\n\n"
    consensus_input += f"Pair: {symbol} | Modal: ${modal} | Mode: {mode.replace('_',' ').upper()}\n"
    consensus_input += "Sekarang simpulkan sesuai instruksi sistem."

    consensus_msgs = [
        {"role":"system","content":CONSENSUS_PROMPT},
        {"role":"user","content":consensus_input},
    ]
    final = await asyncio.to_thread(_call_groq_indexed, N_OPINIONS, consensus_msgs, 1500, 0.3)
    return final, opinions

# ══════════════════════════════════════════════════════════════
#  SESSION
# ══════════════════════════════════════════════════════════════
def sess(uid: int) -> dict:
    if uid not in SESSIONS:
        SESSIONS[uid] = {
            "exchange": None, "mode": None, "pair": None,
            "modal": None, "state": "idle", "history": [], "pairs": [],
            "last_opinions": [],
        }
    return SESSIONS[uid]

# ══════════════════════════════════════════════════════════════
#  KEYBOARDS
# ══════════════════════════════════════════════════════════════
def exchange_kb():
    rows = []
    items = list(EXCHANGES.items())
    for i in range(0, len(items), 2):
        row = []
        for key, info in items[i:i+2]:
            row.append(InlineKeyboardButton(f"{info['emoji']} {info['name']}", callback_data=f"exch_{key}"))
        rows.append(row)
    return InlineKeyboardMarkup(rows)

def main_kb():
    return ReplyKeyboardMarkup([
        [KeyboardButton("🔴 HIGH RISK"),  KeyboardButton("🟡 MEDIUM RISK")],
        [KeyboardButton("🟢 LOW RISK"),   KeyboardButton("📊 Top Pairs")],
        [KeyboardButton("📈 Analisis Pasar"), KeyboardButton("🔎 Lihat Detail 9 AI")],
        [KeyboardButton("🏦 Ganti Exchange"), KeyboardButton("❓ Bantuan")],
    ], resize_keyboard=True, input_field_placeholder="Pilih mode atau ketik...")

def pairs_kb(pair_list: list, page=0, per=9):
    start = page*per; chunk = pair_list[start:start+per]
    rows, row = [], []
    for p in chunk:
        row.append(InlineKeyboardButton(p, callback_data=f"pair_{p}"))
        if len(row) == 3: rows.append(row); row = []
    if row: rows.append(row)
    nav = []
    if page > 0: nav.append(InlineKeyboardButton("⬅️", callback_data=f"page_{page-1}"))
    if start+per < len(pair_list): nav.append(InlineKeyboardButton("➡️", callback_data=f"page_{page+1}"))
    if nav: rows.append(nav)
    rows.append([InlineKeyboardButton("✍️ Ketik Manual", callback_data="pair_custom")])
    return InlineKeyboardMarkup(rows)

# ══════════════════════════════════════════════════════════════
#  HANDLERS
# ══════════════════════════════════════════════════════════════
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u = update.effective_user

    if not is_allowed(u.id):
        await update.message.reply_text(
            f"🔒 *Akses Ditolak*\n\n"
            f"Kamu belum terdaftar untuk menggunakan bot ini.\n\n"
            f"Hubungi admin untuk mendaftarkan User ID kamu:\n"
            f"👤 Telegram: *{ADMIN_USERNAME}*\n\n"
            f"Kirim pesan ke admin dengan menyertakan User ID kamu:\n"
            f"`{u.id}`",
            parse_mode="Markdown"
        )
        logger.info(f"[BLOCKED] uid={u.id} name={u.first_name} username={u.username}")
        return

    s = sess(u.id)
    s.update({"exchange":None,"mode":None,"pair":None,"modal":None,"state":"idle","history":[],"last_opinions":[]})
    await update.message.reply_text(
        f"🤖 *FUTURES TRADING BOT — Konsensus 9 AI*\n\n"
        f"Halo *{u.first_name}*!\n\n"
        f"Bot ini full manual: kamu pilih pair, bot memanggil Groq 9x paralel "
        f"lalu menyimpulkan hasil voting-nya jadi 1 sinyal.\n\n"
        f"*Fitur:*\n"
        f"• 3 mode trading (High/Medium/Low Risk)\n"
        f"• Data pair & harga real-time\n"
        f"• Sinyal dari konsensus 9 panggilan AI\n"
        f"• Bisa lihat detail ke-9 opini individual\n\n"
        f"*AI:* Groq llama-3.3-70b (GRATIS)\n\n"
        f"⚠️ Hanya alat bantu analisis, bukan jaminan profit. Tidak ada eksekusi order otomatis.\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n"
        f"*Pilih exchange untuk mulai:*",
        parse_mode="Markdown", reply_markup=exchange_kb()
    )

async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "❓ *BANTUAN*\n\n"
        "*Cara pakai:*\n"
        "1. /start → pilih exchange\n"
        "2. Pilih mode (High/Medium/Low Risk)\n"
        "3. Pilih pair dari daftar live\n"
        "4. Masukkan modal\n"
        "5. Bot panggil 9 AI paralel + 1 konsensus → sinyal muncul\n"
        "6. Ketik '🔎 Lihat Detail 9 AI' untuk lihat ke-9 opini individual\n"
        "7. Tanya apapun tentang pair tersebut (follow-up pakai 1 AI, lebih cepat)\n\n"
        "*Soal SL:*\n"
        "SL yang diberikan adalah HARGA yang kamu pasang di exchange sebagai stop order. "
        "Bukan liquidation otomatis — kamu yang pasang manual di exchange.\n\n"
        "*Soal Konsensus 9 AI:*\n"
        "Ke-9 opini berasal dari model YANG SAMA dipanggil terpisah dengan variasi random sampling, "
        "bukan 9 model berbeda. Voting ini mengecek konsistensi, bukan validasi independen penuh.\n\n"
        "Bot ini TIDAK melakukan eksekusi order otomatis — semua keputusan trading ada di tanganmu.\n\n"
        "/start → reset & ganti exchange",
        parse_mode="Markdown"
    )

async def handle_msg(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u = update.effective_user
    txt = update.message.text.strip()
    s = sess(u.id)

    if not is_allowed(u.id):
        await update.message.reply_text(
            f"🔒 Akses ditolak. Hubungi *{ADMIN_USERNAME}* untuk mendaftar.\nUser ID kamu: `{u.id}`",
            parse_mode="Markdown")
        return

    if not s["exchange"] and txt not in ("/start", "/help"):
        await update.message.reply_text(
            "⚠️ Pilih exchange dulu!\nKetik /start untuk mulai.",
            parse_mode="Markdown")
        return

    MODE_BTN = {
        "🔴 HIGH RISK":  ("high_risk",  "🔴 HIGH RISK"),
        "🟡 MEDIUM RISK":("medium_risk","🟡 MEDIUM RISK"),
        "🟢 LOW RISK":   ("low_risk",   "🟢 LOW RISK"),
    }
    if txt in MODE_BTN:
        key, label = MODE_BTN[txt]
        s.update({"mode":key,"pair":None,"modal":None,"history":[],"state":"selecting_pair","last_opinions":[]})
        wait = await update.message.reply_text("⏳ Mengambil pairs live...")
        ptxt, plst = await get_top_pairs(s["exchange"], 20)
        s["pairs"] = plst
        await wait.delete()
        exinfo = EXCHANGES[s["exchange"]]
        await update.message.reply_text(
            f"*{label}* — {exinfo['emoji']} {exinfo['name']}\nPilih pair:",
            parse_mode="Markdown", reply_markup=pairs_kb(plst))
        return

    if txt == "📊 Top Pairs":
        wait = await update.message.reply_text("⏳ Mengambil data...")
        ptxt, _ = await get_top_pairs(s["exchange"], 20)
        await wait.delete()
        await update.message.reply_text(ptxt, parse_mode="Markdown")
        return

    if txt == "🏦 Ganti Exchange":
        s.update({"exchange":None,"mode":None,"pair":None,"modal":None,"state":"idle","history":[],"last_opinions":[]})
        await update.message.reply_text("Pilih exchange:", reply_markup=exchange_kb())
        return

    if txt == "📈 Analisis Pasar":
        wait = await update.message.reply_text("🔍 Menganalisis pasar...")
        resp = await gen_general(s.get("mode"),
            "Analisis kondisi pasar crypto futures saat ini. Bullish atau bearish? "
            "Pair apa yang menarik untuk scalping? Tips trading konkret.", [])
        await wait.delete()
        await update.message.reply_text(f"📈 *ANALISIS PASAR*\n\n{resp}", parse_mode="Markdown")
        return

    if txt == "🔎 Lihat Detail 9 AI":
        opinions = s.get("last_opinions") or []
        if not opinions:
            await update.message.reply_text("📭 Belum ada hasil konsensus untuk ditampilkan. Minta sinyal dulu.")
            return
        await update.message.reply_text(f"🔎 *DETAIL {len(opinions)} OPINI AI INDIVIDUAL*", parse_mode="Markdown")
        for i, op in enumerate(opinions, 1):
            text = f"*── AI #{i} ──*\n{op}"
            if len(text) > 4000: text = text[:3990] + "\n…(terpotong)"
            await update.message.reply_text(text, parse_mode="Markdown")
        return

    if txt == "❓ Bantuan":
        await cmd_help(update, ctx); return

    # State: custom pair
    if s["state"] == "custom_pair":
        pair = txt.upper().replace("/","").replace("-","").replace(" ","")
        s["pair"] = pair; s["state"] = "asking_modal"
        await update.message.reply_text(f"✅ Pair: *{pair}*\n\nMasukkan modal ($):\nContoh: `5`", parse_mode="Markdown")
        return

    # State: asking modal → jalankan konsensus 9 AI
    if s["state"] == "asking_modal":
        try:
            modal = float(txt.replace("$","").replace(",",""))
            if modal <= 0: raise ValueError
        except ValueError:
            await update.message.reply_text("❌ Masukkan angka yang valid. Contoh: `5`", parse_mode="Markdown"); return
        s["modal"] = modal; s["state"] = "chatting"; s["history"] = []
        ml = {"high_risk":"🔴 HIGH RISK","medium_risk":"🟡 MEDIUM RISK","low_risk":"🟢 LOW RISK"}[s["mode"]]
        exinfo = EXCHANGES[s["exchange"]]
        await update.message.reply_text(
            f"✅ *Setup siap!*\n"
            f"🏦 {exinfo['emoji']} {exinfo['name']} | {ml}\n"
            f"📌 {s['pair']} | Modal: ${modal}\n\n"
            f"⏳ Menjalankan {N_OPINIONS} AI paralel + 1 konsensus... (~10-20 detik)",
            parse_mode="Markdown")
        try:
            final, opinions = await gen_consensus_signal(s["exchange"], s["mode"], s["pair"], modal)
            s["last_opinions"] = opinions
            await update.message.reply_text(final, parse_mode="Markdown", reply_markup=main_kb())
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {e}", reply_markup=main_kb())
        return

    # State: chatting — follow-up pakai 1 model (cepat)
    if s["state"] == "chatting":
        wait = await update.message.reply_text("🤔 Menganalisis...")
        try:
            resp = await gen_signal(s["exchange"], s["mode"], s["pair"], s["modal"], txt, s["history"])
            if len(s["history"]) > 20: s["history"] = s["history"][-20:]
            await wait.delete()
            await update.message.reply_text(resp, parse_mode="Markdown")
        except Exception as e:
            await wait.delete()
            await update.message.reply_text(f"❌ Error: {e}\n\n/start untuk reset.")
        return

    # Default
    resp = await gen_general(s.get("mode"), txt, [])
    await update.message.reply_text(resp + "\n\n💡 Pilih mode dari keyboard atau /start untuk mulai.")

async def handle_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query; await q.answer()
    data = q.data; uid = q.from_user.id; s = sess(uid)

    if not is_allowed(uid):
        await q.answer("🔒 Akses ditolak.", show_alert=True)
        return

    if data.startswith("exch_"):
        key = data[5:]
        s["exchange"] = key
        s["state"] = "idle"
        exinfo = EXCHANGES[key]
        await q.edit_message_text(
            f"✅ Exchange: *{exinfo['emoji']} {exinfo['name']}*\n\nSilakan pilih mode trading dari keyboard di bawah!",
            parse_mode="Markdown")
        await ctx.bot.send_message(uid, f"Pilih mode trading:", reply_markup=main_kb())
        return

    if data.startswith("page_"):
        await q.edit_message_reply_markup(reply_markup=pairs_kb(s["pairs"], int(data[5:]))); return

    if data == "pair_custom":
        s["state"] = "custom_pair"
        await q.edit_message_text("✍️ Ketik nama pair:\nContoh: `BTCUSDT` atau `SOLUSDT`", parse_mode="Markdown"); return

    if data.startswith("pair_"):
        pair = data[5:]; s["pair"] = pair; s["state"] = "asking_modal"
        await q.edit_message_text(f"✅ Pair: *{pair}*\n\nMasukkan modal ($):\nContoh: `5`", parse_mode="Markdown"); return

# ══════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════
def main():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token: raise RuntimeError("❌ Set TELEGRAM_BOT_TOKEN di .env")
    if not _groq_keys: raise RuntimeError("❌ Tidak ada GROQ_API_KEY ditemukan di .env")

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("🤖  Futures Trading Bot v6 — Full Manual + Konsensus 9 AI")
    print(f"🧠  AI      : {MODEL}")
    print(f"🔑  API Keys: {len(_groq_clients)} key aktif (dipakai round-robin untuk {N_OPINIONS} opini + 1 konsensus)")
    print(f"🏦  Exchange: Binance | Bybit | OKX | Gate.io | MEXC | Bitget | KuCoin")
    print("⚡  Auto-trade / auto-signal: DIHAPUS — full manual")
    print("💰  Biaya AI: GRATIS ✅")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help",  cmd_help))
    app.add_handler(CallbackQueryHandler(handle_cb))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_msg))
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
