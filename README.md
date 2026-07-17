# 🤖 Futures Trading Bot v6 — Full Manual + Konsensus 9 AI

Bot Telegram untuk analisis futures trading. Full manual — tidak ada eksekusi order otomatis.
Setiap kali kamu minta sinyal, bot memanggil AI (Groq llama-3.3-70b) **9 kali secara paralel**,
lalu panggilan ke-10 menyimpulkan hasilnya lewat **majority voting**.

> ⚠️ **Catatan jujur soal "9 AI":** kesembilan opini berasal dari model yang **sama**
> (llama-3.3-70b), dipanggil terpisah dengan variasi *temperature*. Ini bukan 9 model
> berbeda dengan sudut pandang independen. Voting ini mengukur **konsistensi model**
> terhadap data yang sama — bukan validasi dari sumber yang benar-benar berbeda.
> Tetap berguna untuk menyaring sinyal yang goyah, tapi jangan dianggap seakurat
> 9 analis manusia dengan aliran berbeda.

---

## ✨ Fitur

- 3 mode risiko: **High Risk**, **Medium Risk**, **Low Risk** — masing-masing punya
  gaya analisis, timeframe, dan aturan Risk:Reward sendiri
- 7 exchange didukung: Binance, Bybit, OKX, Gate.io, MEXC, Bitget, KuCoin (semua via public API, tanpa API key exchange)
- Data live: harga, RSI, MACD, EMA, Bollinger Bands, Support/Resistance, volume, funding rate, order book
- **Konsensus 9 AI**: 9 panggilan paralel + 1 panggilan penyimpul dengan voting LONG/SHORT/WAIT
- Bisa lihat detail ke-9 opini mentah kalau mau audit sendiri
- Follow-up chat setelah sinyal awal pakai 1 model saja (lebih cepat & hemat kuota)
- Whitelist user (opsional) supaya bot tidak bisa diakses sembarang orang

## 🚫 Yang TIDAK ada di versi ini

- Tidak ada auto-signal scanner (scan berkala di background)
- Tidak ada auto-trade / eksekusi order otomatis ke exchange manapun
- Semua keputusan entry/exit sepenuhnya di tangan user

---

## 🛠️ Setup

### 1. Install dependency
```bash
pip install python-telegram-bot groq aiohttp python-dotenv
```

### 2. Buat bot Telegram
1. Chat [@BotFather](https://t.me/BotFather) di Telegram
2. `/newbot` → ikuti instruksi → copy **token** yang diberikan

### 3. Buat API key Groq (gratis)
1. Daftar di [console.groq.com](https://console.groq.com)
2. Buat API key
3. **Disarankan buat 9–10 key** (bisa pakai akun berbeda) supaya 9 panggilan paralel
   tidak rebutan satu key yang sama dan lebih jarang kena rate limit

### 4. Buat file `.env`
Taruh di folder yang sama dengan script:

```env
TELEGRAM_BOT_TOKEN=isi_token_dari_botfather

# Groq API keys — isi sebanyak yang kamu punya (minimal 1, ideal 9-10)
GROQ_API_KEY_1=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_2=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_3=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_4=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_5=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_6=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_7=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_8=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_9=gsk_xxxxxxxxxxxxxxxx
GROQ_API_KEY_10=gsk_xxxxxxxxxxxxxxxx

# Opsional — kosongkan kalau mau bot bisa diakses siapa saja (tidak disarankan)
ALLOWED_USER_IDS=123456789,987654321
```

> Kalau cuma punya 1-2 key, bot tetap jalan — key akan dipakai bergantian (round-robin),
> hanya saja lebih rawan kena rate limit saat 9 panggilan jalan bersamaan.

Cara cek User ID Telegram kamu: chat bot apa saja seperti [@userinfobot](https://t.me/userinfobot).

### 5. Jalankan
```bash
python trading_bot_v5.py
```

---

## 📱 Cara Pakai

1. `/start` → pilih exchange
2. Pilih mode: 🔴 High Risk / 🟡 Medium Risk / 🟢 Low Risk
3. Pilih pair dari daftar top volume live, atau ketik manual
4. Masukkan modal (USD) — dipakai AI untuk konteks position sizing di analisisnya
5. Bot menjalankan 9 panggilan AI paralel + 1 konsensus (~10–20 detik) → sinyal muncul
6. Ketik **"🔎 Lihat Detail 9 AI"** kapan saja untuk lihat ke-9 opini individual sebelum konsensus
7. Chat bebas untuk tanya lebih lanjut soal pair yang sama — follow-up ini pakai 1 model saja

Menu lain:
- **📊 Top Pairs** — daftar pair volume tertinggi di exchange yang dipilih
- **📈 Analisis Pasar** — analisis kondisi pasar secara umum
- **🏦 Ganti Exchange** — reset dan pilih exchange lain
- **❓ Bantuan** — ringkasan cara pakai di dalam bot

---

## 🧠 Cara Kerja Konsensus 9 AI

```
Pilih pair
   │
   ▼
Ambil data live (harga, indikator, S&R, volume, funding) — 1x request ke exchange
   │
   ├──► Panggilan AI #1 (key #1, temp 0.5) ─┐
   ├──► Panggilan AI #2 (key #2, temp 0.6) ─┤
   ├──► Panggilan AI #3 (key #3, temp 0.7) ─┤
   ├──► ...                                  ├──► 9 opini independen (paralel)
   └──► Panggilan AI #9 (key #9, temp 0.5) ─┘
                    │
                    ▼
      Panggilan AI #10 (Konsensus, temp 0.3)
      • Hitung suara LONG / SHORT / WAIT
      • Ambil rata-rata Entry/TP/SL dari yang searah mayoritas
      • Ringkas argumen
                    │
                    ▼
            Sinyal final dikirim ke user
```

Aturan voting:
- Arah dengan suara terbanyak = konsensus final
- Kalau LONG dan SHORT seri di posisi teratas → konsensus jatuh ke **WAIT**
- Analisis yang error/gagal tidak dihitung sebagai suara

---

## ⚠️ Disclaimer

- Bot ini adalah **alat bantu analisis**, bukan jaminan profit dan bukan nasihat keuangan
- Tidak ada eksekusi order otomatis — kamu yang memutuskan dan menjalankan trade sendiri di exchange
- Trading futures berisiko tinggi, termasuk potensi kehilangan modal melebihi deposit awal (karena leverage)
- Developer tidak bertanggung jawab atas kerugian trading yang timbul dari penggunaan bot ini
