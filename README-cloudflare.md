# Deploy ke Cloudflare Workers (Gratis)

Versi ini webhook-based — Worker cuma "bangun" saat Telegram kirim update, bukan nyala 24/7.
**Baru support Binance.** Exchange lain bisa ditambah dengan pola yang sama di `MARKET_FN` / `TOP_PAIRS_FN`.

## 1. Install Wrangler (CLI Cloudflare)
```bash
npm install -g wrangler
wrangler login
```

## 2. Buat KV Namespace (buat simpan session per-user)
```bash
wrangler kv namespace create BOT_KV
```
Copy `id` yang muncul, tempel ke `wrangler.toml` menggantikan `ISI_DENGAN_ID_DARI_WRANGLER_KV_NAMESPACE_CREATE`.

## 3. Set secrets
Jangan taruh ini di `wrangler.toml` — pakai `wrangler secret put` biar aman:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # bikin string acak sendiri, contoh: openssl rand -hex 20
wrangler secret put GROQ_API_KEY_1
wrangler secret put GROQ_API_KEY_2
# ... ulangi sampai GROQ_API_KEY_9 atau _10 (idealnya 9-10 key biar tidak rebutan)
wrangler secret put ALLOWED_USER_IDS          # opsional, contoh: 123456789,987654321
```

## 4. Deploy
```bash
wrangler deploy
```
Setelah sukses, wrangler akan kasih URL, contoh:
`https://futures-trading-bot.<namamu>.workers.dev`

## 5. Daftarkan webhook ke Telegram
Ganti `<TOKEN>`, `<URL>`, dan `<SECRET>` (harus sama dengan yang di-set di step 3):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=<URL>/webhook" \
  -d "secret_token=<SECRET>"
```

Cek status webhook:
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Selesai — chat bot kamu di Telegram, `/start` untuk mulai.

## Menambah exchange lain

1. Bikin fungsi `xxxTopPairs()` dan `xxxMarket()` mengikuti pola `binanceTopPairs` / `binanceMarket`
2. Daftarkan di `MARKET_FN`, `TOP_PAIRS_FN`, `EXCHANGE_LABEL`
3. Tambah baris tombol baru di `exchangeKb()`
4. Sesuaikan parsing field di `getTopPairsText()` (tiap exchange field API-nya beda nama)

## Catatan biaya & limit gratis

- Cloudflare Workers Free: 100.000 request/hari, cukup jauh untuk pemakaian personal
- Cloudflare KV Free: 100.000 read/hari, 1.000 write/hari — cukup untuk beberapa user aktif
- Groq: gratis dengan rate limit per key, makanya disarankan pakai banyak key untuk fitur konsensus 9 AI

## Debug

Log real-time:
```bash
wrangler tail
```
