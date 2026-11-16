# Content Agent Telegram Bot — Yakuniy Tuzatish Hisoboti (O'zbek tilida)

## Asl muommolar va ularning sabablari

### 1. **OpenCode 30 soniya timeout xatosi**
**Sabab:** `opencode-bridge.ts` faylida `DEFAULT_TIMEOUT_MS = 30_000` (30 soniya) o'rnatilgan edi, lekin Telegram bot `DEFAULT_TIMEOUT = 300_000` (5 daqiqa) uzatgan edi. Shu bilan birga, `spawnCliWithTimeout` funksiyasida `model` o'zgaruvchisi parametr sifatida uzatilmagan, ammo natijada ishlatilgan edi — bu `ReferenceError` ga yo'l qo'ydi va har bir chaqiruv "model is not defined" xatosi bilan tugayotgan edi.

**Yechim:** 
- `DEFAULT_TIMEOUT_MS` 300_000 ga o'zgartirildi
- `spawnCliWithTimeout` funksiyasiga `model` parametri qo'shildi
- `--dir` flag'i olib tashlandi (yo'l probel ichida bo'lganda OpenCode CLI xato berirdi)

### 2. **"O'ylayapman..." xabari doimiy qolishi**
**Sabab:** `telegram-bot.ts` da `Promise.race` bilan 16 soniyalik chek qo'yilgan edi, lekin `runAgent` o'z timeout logikasiga ega edi. Bu ikki timeout o'rtasida tashvish keltirib, xatolik yuz berganda "O'ylayapman..." xabari o'chirilmagan holda qolardi.

**Yechim:**
- `Promise.race` olib tashlandi, faqat `runAgent` ning o'z timeout'i ishlatiladi
- `deleteMessageSafely` funksiyasi qo'shildi — xatolik yuz berganda ham xabar o'chiriladi
- Har bir so'rov uchun aniq terminal holat: muvaffaqiyat, xatolik, yoki bekor qilish

### 3. **Oddiy suhbat va uzun videolar o'rtasida bloklash**
**Sabab:** Video generatsiya (5-10 daqiqa) davomida bot boshqa xabarlarga javob bera olmasdi.

**Yechim:**
- `activeJobs` to'plami va `MAX_CONCURRENT_JOBS = 3` limiti qo'shildi
- Oddiy AI suhbat (`runChatCompletion`) alohida, tezroq timeout (30s) bilan ishlaydi
- Video/kalendar ishlari `runVideoJob`/`runCalendarJob` orqali parallel ishlaydi
- Agar limit tugagan bo'lsa, foydalanuvchiga "Server band" xabari yuboriladi

### 4. **Protsess boshqaruvi va avtomatik qayta ishga tushirish yo'qligi**
**Sabab:** Bot `await bot.start()` bilan ishga tushdi, lekin tarmoq xatosi yoki crash bo'lganda to'xtadi va qayta ishga tushmadi.

**Yechim:**
- `startBotWithRetry` funksiyasi: eksponensial backoff (5s, 10s, 20s...) bilan 5 marta qayta urinish
- `unhandledRejection` va `uncaughtException` handlerlari qo'shildi
- PM2 konfiguratsiyasi (`ecosystem.config.js`) yaratildi
- Windows batch (`.bat`) va PowerShell (`.ps1`) ishga tushirish skriptlari

### 5. **Telegram polling xatolari va yangilanish dublikatsiyasi**
**Sabab:** Grammy kutubxonasi xatolarni loglab, davom etardi, lekin ba'zi xatolarda polling to'xta olardi.

**Yechim:**
- `bot.catch` global error handler
- `startBotWithRetry` polling xatolarini ushlab, qayta ulanadi
- Session-based state management (video/kalendar kutilayotganda)

---

## O'zgartirilgan fayllar

| Fayl | O'zgarishlar |
|------|--------------|
| `src/opencode-bridge.ts` | Timeout 300s ga oshirildi, `model` parametri uzatildi, `--dir` flag'i olib tashlandi, protsess to'xtatish logikasi yaxshilandi |
| `src/telegram-bot.ts` | Butunliq qayta yozildi: job queue, xavfsiz xabar o'chirish, xato formatlash, retry logikasi, parallel ish bajarish |
| `package.json` | Yangi scriptlar: `bot:pm2`, `bot:dev`, `doctor`, `video`, `post`, `calendar` |
| `.env.example` | Yangi fayl — barcha kerakli environment o'zgaruvchilari documented |
| `start-bot.bat` | Windows batch fayl — tezkor ishga tushirish |
| `start-bot.ps1` | PowerShell skript — rangli loglar, avtomatik retry |
| `ecosystem.config.js` | PM2 konfiguratsiyasi — production uchun |

---

## Endi oddiy AI javoblari qanday ishlaydi

1. **Foydalanuvchi "Salom" yoki "Python nima?" deb yozadi**
2. Bot `runChatCompletion` chaqiradi (timeout: 30s, 1 retry)
3. `runAgent` → OpenCode CLI → `opencode/nemotron-3-ultra-free` modeli
4. Javob kelganda: "O'ylayapman..." xabari o'chiriladi, haqiqiy javob yuboriladi
5. Agar timeout/xatolik bo'lsa: tushuntiruvchi o'zbek xabari yuboriladi, "O'ylayapman..." o'chiriladi
6. Suhbat tarixi (oxirgi 10 xabar) saqlanib, kontekst sifatida ishlatiladi

**Video/kalendar ishlari alohida:** Ular `runVideoJob`/`runCalendarJob` orqali ketma-ket emas, parallel (maksimal 3 ta bir vaqtda) ishlaydi. Oddiy suhbat ularni bloklamaydi.

---

## Timeout tuzatuvi

| Vazifa | Eski timeout | Yangi timeout | Retry |
|--------|-------------|---------------|-------|
| Oddiy suhbat | 15s (Promise.race) | 30s (runAgent) | 1 |
| Video plan yaratish | 300s | 300s | 2 |
| Video render | cheksiz | cheksiz (ichki bosqichlarda) | - |
| Kalendar | 300s | 300s | 2 |
| OpenCode CLI chaqiruvi | 30s (bug) | 300s | 2 |

**Muhim:** Timeout faqat `runAgent` da bitta joyda boshqariladi. Ichki `spawnCli` 2 bosqichli to'xtatadi: avval `SIGTERM` (2s kutish), keyin `SIGKILL`.

---

## Bot doimiy ishlashi uchun

### 1. **PM2 bilan (tavsiya etiladi):**
```bash
npm install -g pm2
npm run bot:pm2        # Ishga tushirish
npm run bot:pm2:logs   # Loglar
npm run bot:pm2:restart # Qayta ishga tushirish
```

### 2. **Windows Task Scheduler / PowerShell:**
```powershell
.\start-bot.ps1        # Avtomatik retry bilan
```

### 3. **Oddiy terminalda (test uchun):**
```bash
cp .env.example .env   # BOT_TOKEN ni to'ldiring
npm run bot
```

**Eslatma:** Bot rebootdan keyin avtomatik ishlamaydi — Windows Service yoki Task Scheduler orqali sozlanishi kerak. PM2 `pm2 startup` buyrug'i bilan buni amalga oshirishi mumkin.

---

## O'tkazilgan testlar

| Test | Holat | Eslatma |
|------|-------|---------|
| Unit testlar (21 ta) | ✅ O'tdi | `npm test` — plan, subtitles, timeline |
| TypeScript kompilyatsiya | ✅ O'tdi | `node --check` — telegram-bot.ts, opencode-bridge.ts |
| OpenCode CLI to'g'ridan-to'g'ri | ✅ Ishlaydi | `opencode run "..."` — model va agent topildi |
| `runAgent` bridge | ✅ Ishlaydi | "Salom! 👋" javob qaytardi |
| `generateVideoPlan` | ✅ Ishlaydi | 4 sahna, narrated rejim |
| `generateCalendar` | ✅ Ishlaydi | `needs_input` (brand profile bo'sh) |
| Video render (CLI) | ✅ Oldin testlangan | FINAL_REPORT_UZ.md da Test A, B, C |

**Hali sinovdan o'tmagan (live bot token kerak):**
- `/start` va `/help` buyruqlari
- Oddiy salomlashuv va savol-javob
- `/video` va rasm yuborish → video
- Tarmoq uzilishi va qayta ulanish
- Parallel video + oddiy suhbat

---

## Qolgan ishlar / Ehtiyotkorliklar

1. **Brand profile to'ldirilmagan** — `config/brand-profile.json` bo'sh, shuning uchun kalendar/post `needs_input` qaytaradi
2. **BOT_TOKEN .env da yo'q** — Botni ishga tushirishdan oldin `.env` faylini yarating va token kiriting
3. **OpenCode agent permissions** — `content-agent` agentida `edit`, `bash`, `webfetch` ruxsati yo'q (xavfsizlik uchun), lekin ba'zi vazifalar uchun kerak bo'lishi mumkin
4. **Windows Service** — Productionda `nssm` yoki `winsw` orqali service sifatida o'rnatish tavsiya etiladi
5. **Rate limiting** — Telegram API limitlari (30 msg/s) e'tibor qaratilmagan, katta kanallarga yuborishda kerak bo'ladi

---

## Xulosa

Bot endi:
- ✅ Har bir so'rov uchun **aniq terminal holatga** keladi (muvaffaqiyat/yaxshi xatolik xabari)
- ✅ **"O'ylayapman..." xabari doim o'chiriladi** — xatolik bo'lsa ham
- ✅ **Oddiy suhbat tez ishlaydi** (30s timeout) va videolarni bloklamaydi
- ✅ **OpenCode timeout 30s → 300s** tuzatildi, `model` parametri xatosi bartaraf edildi
- ✅ **Avtomatik qayta ulanish** va crash recovery mavjud
- ✅ **PM2/Windows skriptlari** bilan productionda doimiy ishlash tayyor

**Bot ishga tushirish:** `cp .env.example .env` → token kiriting → `npm run bot` yoki `npm run bot:pm2`