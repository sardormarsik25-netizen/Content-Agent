import "dotenv/config";
import pkg from "grammy";

const { Bot, Context, session, SessionFlavor } = pkg;

import { produceVideo } from "./video-pipeline.ts";
import { runAgent } from "./opencode-bridge.ts";
import { projectChatMemory } from "./chat-memory.ts";
import { generateVideoPlan } from "./video-planner.ts";
import { generateCalendar } from "./content-calendar.ts";
import { loadBrandProfile } from "./brand-profile.ts";
import { ContentAgentError } from "./types.ts";
import type { NormalizedPlan } from "./video-types.ts";

interface BotSession {
  awaiting?: "video_topic" | "calendar_topic" | "calendar_platforms";
  tempPlan?: NormalizedPlan;
  pendingJobId?: string;
}
type MyContext = Context & SessionFlavor<BotSession>;

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("BOT_TOKEN environment variable is required");
  process.exit(1);
}

const bot = new Bot<MyContext>(TOKEN);
const chatMemory = projectChatMemory();
bot.use(session({ initial: () => ({}) }));

const DEFAULT_MODEL = process.env.CONTENT_AGENT_MODEL ?? "opencode/nemotron-3-ultra-free";
const DEFAULT_AGENT = process.env.CONTENT_AGENT_AGENT ?? "content-agent";
const CHAT_AGENT = process.env.CONTENT_CHAT_AGENT ?? "chat-assistant";
const DEFAULT_TIMEOUT = Number(process.env.CONTENT_AGENT_TIMEOUT_MS ?? 300_000);
const CHAT_TIMEOUT = Number(process.env.CHAT_TIMEOUT_MS ?? 90_000);
const VIDEO_PROJECT = "C:\\Users\\user\\Desktop\\skills\\remotion-video";

const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = Number(process.env.ADMIN_ID ?? 0);

function isAdmin(ctx: MyContext): boolean {
  return ADMIN_ID === 0 || ctx.from?.id === ADMIN_ID;
}

function detectLanguage(text: string): "uz" | "ru" | "en" {
  if (/[\u0400-\u04FF]/.test(text)) return "ru";
  if (/\b(the|and|you|what|how|why|when|where|please|thanks|hello|hi)\b/i.test(text)) return "en";
  return "uz";
}

const LANG_NAMES = { uz: "O'zbek", ru: "Русский", en: "English" } as const;

function parseVideoCommand(text: string): {
  topic: string;
  duration?: number;
  mode?: "narrated" | "music" | "silent";
  aspect?: "9:16" | "16:9" | "1:1";
  language?: string;
} {
  const parts = text.trim().split(/\s+/);
  const topic = parts.slice(1).join(" ") || "Video mavzusi";
  const opts: any = { topic };
  for (const part of parts.slice(1)) {
    if (/^\d+s?$/.test(part)) opts.duration = Number(part.replace("s", ""));
    else if (["narrated", "music", "silent"].includes(part)) opts.mode = part;
    else if (["9:16", "16:9", "1:1"].includes(part)) opts.aspect = part;
    else if (["uz", "ru", "en", "tr"].includes(part)) opts.language = part;
  }
  return opts;
}

interface JobStatus {
  id: string;
  type: "video" | "calendar" | "chat";
  chatId: number;
  userId: number;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: number;
  statusMessageId?: number;
  result?: unknown;
  error?: string;
}

const jobQueue = new Map<string, JobStatus>();
const activeJobs = new Set<string>();
const MAX_CONCURRENT_JOBS = 3;

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function updateJobStatus(jobId: string, updates: Partial<JobStatus>): Promise<void> {
  const job = jobQueue.get(jobId);
  if (job) {
    Object.assign(job, updates);
  }
}

async function sendThinkingMessage(ctx: MyContext, text = "🤔 O'ylayapman..."): Promise<number> {
  const msg = await ctx.reply(text);
  return msg.message_id;
}

async function deleteMessageSafely(ctx: MyContext, messageId: number): Promise<void> {
  try {
    await ctx.api.deleteMessage(ctx.chat.id, messageId);
  } catch {
    // Ignore deletion errors (message might be too old or already deleted)
  }
}

async function editMessageSafely(ctx: MyContext, messageId: number, text: string): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat.id, messageId, text);
  } catch {
    // If edit fails, send new message
    await ctx.reply(text);
  }
}

async function sendVideoResult(ctx: MyContext, plan: NormalizedPlan, label = "Video"): Promise<void> {
  const statusMsg = await ctx.reply(`🎬 ${label} tayyorlanmoqda...`);
  try {
    const result = await produceVideo({
      plan,
      log: (msg) => {
        // Could update statusMsg with progress, but keep simple
      },
    });
    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.replyWithVideo(result.videoPath, {
      caption: `✅ ${plan.title}\n📐 ${plan.aspect} · ${result.durationSeconds}s · ${plan.mode}`,
    });
    if (result.srtPath) {
      await ctx.replyWithDocument(result.srtPath, { caption: "📝 Subtitr (SRT)" });
    }
  } catch (error) {
    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    const msg = error instanceof ContentAgentError ? error.message : String(error);
    await ctx.reply(`❌ Xato: ${msg}`);
  }
}

function formatErrorForUser(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("timeout") || msg.includes("OPENCODE_TIMEOUT")) {
    return "⏱ AI modeli hozircha javob bera olmadi. Iltimos, keyinroq urinib ko'ring yoki /video, /calendar buyruqlarini ishlating.";
  }
  if (msg.includes("OPENCODE_NOT_FOUND") || msg.includes("OPENCODE_SPAWN_FAILED")) {
    return "⚙️ AI xizmati hozircha mavjud emas. Video/kalendar yaratish uchun /video yoki /calendar buyruqlarini ishlating.";
  }
  if (msg.includes("EMPTY_MODEL_OUTPUT") || msg.includes("Bo'sh javob")) {
    return "🤷 AI bo'sh javob qaytardi. Iltimos, savolingizni qayta inglating.";
  }
  if (msg.includes("OPENCODE_MAX_RETRIES_EXCEEDED")) {
    return "🔄 AI xizmati bir necha urinishdan keyin ham javob bermadi. Keyinroq urinib ko'ring.";
  }
  return "❌ Xatolik yuz berdi. Keyinroq urinib ko'ring.";
}

async function runChatCompletion(ctx: MyContext, userText: string): Promise<void> {
  const lang = detectLanguage(userText);
  const langName = LANG_NAMES[lang];

  if (!ctx.chat || !ctx.from || !ctx.message) return;
  const turn = [ctx.chat.id, ctx.from.id, ctx.message.message_id] as const;

  const thinkingMsgId = await sendThinkingMessage(ctx);

  try {
    const profile = loadBrandProfile();
    const brand = profile.brand_name ? `Brand: ${profile.brand_name}. ` : "";
    const tone = profile.tone ? `Tone: ${profile.tone}. ` : "";

    const historyContext = chatMemory.history(...turn);

    const systemPrompt = `Siz foydali, qisqa va do'stona AI maslahatchisiz. Foydalanuvchi tilida (${langName}) javob bering.
JSON qaytarmang — oddiy suhbat matnida javob bering.
${brand}${tone}
Video loyihasi: ${VIDEO_PROJECT}. Videolar Remotion bilan yaratiladi, har bir mavzu 4 tilda (uz, en, ru, tr)
alohida-alohida 9:16 formatda, 18-25 soniya, sokin musiqa bilan. Tayyor fayllar out\\promo_<mavzu>_<til>.mp4.
Natijani chop etish faqat foydalanuvchi aniq ruxsat bergandan keyin amalga oshiriladi.
${historyContext ? `Suhbat tarixi:\n${historyContext}\n` : ""}Foydalanuvchi: ${userText}

Javob:`;

    const result = await runAgent({
      prompt: systemPrompt,
      model: DEFAULT_MODEL,
      agent: CHAT_AGENT,
      timeoutMs: CHAT_TIMEOUT,
      maxRetries: 1,
    });

    const replyText = result.text.trim();
    if (!replyText) throw new Error("Bo'sh javob");

    chatMemory.save(...turn, userText, replyText);
    await deleteMessageSafely(ctx, thinkingMsgId);
    let exportFailed = false;
    try {
      chatMemory.exportNote(...turn);
    } catch (error) {
      exportFailed = true;
      console.error("Obsidian export failed:", error);
    }
    for (let offset = 0; offset < replyText.length; offset += 4000) {
      await ctx.reply(replyText.slice(offset, offset + 4000));
    }
    if (exportFailed) await ctx.reply("Suhbat SQLite’da saqlandi. Obsidian’ga yozishda xato yuz berdi.");
  } catch (error) {
    await deleteMessageSafely(ctx, thinkingMsgId);
    const userMsg = formatErrorForUser(error);
    console.error("AI chat error:", error);
    await ctx.reply(userMsg);
  }
}

async function runVideoJob(ctx: MyContext, topic: string, options: {
  language?: string;
  aspect?: "9:16" | "16:9" | "1:1";
  duration?: number;
  mode?: "narrated" | "music" | "silent";
}): Promise<void> {
  const jobId = generateJobId();
  const job: JobStatus = {
    id: jobId,
    type: "video",
    chatId: ctx.chat.id,
    userId: ctx.from?.id ?? 0,
    status: "pending",
    createdAt: Date.now(),
  };
  jobQueue.set(jobId, job);

  const statusMsg = await ctx.reply(`🎬 Video reja tuzilmoqda: "${topic}"...`);
  job.statusMessageId = statusMsg.message_id;
  job.status = "running";
  activeJobs.add(jobId);

  try {
    const plan = await generateVideoPlan({
      request: topic,
      language: options.language ?? "uz",
      aspect: options.aspect,
      duration: options.duration,
      mode: options.mode,
      model: DEFAULT_MODEL,
      agent: DEFAULT_AGENT,
      timeoutMs: DEFAULT_TIMEOUT,
    });

    await editMessageSafely(ctx, statusMsg.message_id, `🎬 Video render qilinmoqda: "${plan.title}"...`);

    const result = await produceVideo({
      plan,
      log: (msg) => {
        // Progress logging could update the status message
      },
    });

    await deleteMessageSafely(ctx, statusMsg.message_id);
    await ctx.replyWithVideo(result.videoPath, {
      caption: `✅ ${plan.title}\n📐 ${plan.aspect} · ${result.durationSeconds}s · ${plan.mode}`,
    });
    if (result.srtPath) {
      await ctx.replyWithDocument(result.srtPath, { caption: "📝 Subtitr (SRT)" });
    }

    job.status = "completed";
    job.result = result;
  } catch (error) {
    await deleteMessageSafely(ctx, statusMsg.message_id).catch(() => {});
    const userMsg = error instanceof ContentAgentError ? error.message : String(error);
    await ctx.reply(`❌ Video yaratishda xato: ${userMsg}`);
    job.status = "failed";
    job.error = userMsg;
  } finally {
    activeJobs.delete(jobId);
  }
}

async function runCalendarJob(ctx: MyContext, topic: string, days = 7): Promise<void> {
  const jobId = generateJobId();
  const job: JobStatus = {
    id: jobId,
    type: "calendar",
    chatId: ctx.chat.id,
    userId: ctx.from?.id ?? 0,
    status: "pending",
    createdAt: Date.now(),
  };
  jobQueue.set(jobId, job);

  const statusMsg = await ctx.reply("📅 Kalendar yaratilmoqda...");
  job.statusMessageId = statusMsg.message_id;
  job.status = "running";
  activeJobs.add(jobId);

  try {
    const result = await generateCalendar(
      {
        topic,
        days,
        period: "weekly",
        platforms: ["telegram"],
        language: "uz",
        objective: "Engagement va brand oshirish",
      },
      {
        model: DEFAULT_MODEL,
        agent: DEFAULT_AGENT,
        profile: loadBrandProfile(),
      },
    );

    await deleteMessageSafely(ctx, statusMsg.message_id);
    if (result.envelope.status === "ok") {
      await ctx.reply(result.markdown, { parse_mode: "Markdown" });
    } else {
      await ctx.reply("❓ Ma'lumot yetarli emas:\n" + result.envelope.questions.join("\n"));
    }
    job.status = "completed";
    job.result = result;
  } catch (error) {
    await deleteMessageSafely(ctx, statusMsg.message_id).catch(() => {});
    await ctx.reply(`❌ ${error}`);
    job.status = "failed";
    job.error = String(error);
  } finally {
    activeJobs.delete(jobId);
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    `🤖 Content Agent botga xush kelibsiz!\n\n` +
    `💬 Istalgan savolingizni yozing — video g'oyalari, skript, sarlavha va reja bo'yicha maslahat beraman.\n\n` +
    `Buyruqlar:\n` +
    `/video <mavzu> [davomiylik] [rejim] [aspekt] [til]\n` +
    `  Masalan: /video futbol 15s narrated 9:16 uz\n` +
    `/calendar <mavzu> [kunlar] — 7-kunlik reja\n` +
    `/voices — ovozlar ro'yxati\n` +
    `/music — test musiqasi\n` +
    `Rasm yuboring → reklama videosi qaytariladi\n` +
    `/help — yordam`,
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `📋 Yordam:\n\n` +
    `🎬 <b>/video</b> — video yaratish\n` +
    `   /video "Sun'iy intellekt" 15 narrated 9:16 uz\n` +
    `   Parametrlar ixtiyoriy, tartib muhim emas.\n\n` +
    `📅 <b>/calendar</b> — haftalik reja\n` +
    `   /calendar "Yangi mahsulot" 7\n\n` +
    `🎤 <b>/voices</b> — mavjud Edge Neural ovozlar\n\n` +
    `🎵 <b>/music</b> — test musiqasi generatsiya qilish\n\n` +
    `🖼 <b>Rasm yuboring</b> — avtomatik reklama videosiga aylantiradi\n\n` +
    `⚙️ Admin: /post_calendar — kanalga haftalik reja yuborish`,
  );
});

bot.command("voices", async (ctx) => {
  const { listVoices } = await import("./voice.ts");
  const voices = await listVoices();
  const lines = voices.map((v) => `• <code>${v.name}</code> (${v.locale}, ${v.gender})`).join("\n");
  await ctx.reply(`🎤 Mavjud ovozlar:\n${lines}`, { parse_mode: "HTML" });
});

bot.command("music", async (ctx) => {
  const { generateMusic } = await import("./music.ts");
  const status = await ctx.reply("🎵 Musiqa yaratilmoqda...");
  try {
    const result = await generateMusic({ mood: "cinematic", durationSeconds: 10, workDir: "./outputs/music-test" });
    await deleteMessageSafely(ctx, status.message_id);
    await ctx.replyWithAudio(result.file, { caption: "🎵 Test musiqasi (royalty-free)" });
  } catch (error) {
    await deleteMessageSafely(ctx, status.message_id).catch(() => {});
    await ctx.reply(`❌ ${error}`);
  }
});

bot.command("video", async (ctx) => {
  const args = parseVideoCommand(ctx.message?.text ?? "");
  if (!args.topic || args.topic === "Video mavzusi") {
    ctx.session.awaiting = "video_topic";
    await ctx.reply("🎬 Video mavzusini yozing (masalan: \"Futbol tarixi\"):");
    return;
  }
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    await ctx.reply("⏳ Server band, iltimos biroz kuting...");
    return;
  }
  await runVideoJob(ctx, args.topic, {
    language: args.language,
    aspect: args.aspect,
    duration: args.duration,
    mode: args.mode,
  });
});

bot.command("calendar", async (ctx) => {
  const text = ctx.message?.text ?? "";
  const parts = text.trim().split(/\s+/).slice(1);
  const topic = parts[0] ?? "";
  const days = Number(parts[1]) ?? 7;
  if (!topic) {
    ctx.session.awaiting = "calendar_topic";
    await ctx.reply("📅 Kalendar mavzusini yozing:");
    return;
  }
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    await ctx.reply("⏳ Server band, iltimos biroz kuting...");
    return;
  }
  await runCalendarJob(ctx, topic, days);
});

bot.on("message:text", async (ctx) => {
  if (ctx.session.awaiting === "video_topic") {
    ctx.session.awaiting = undefined;
    if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
      await ctx.reply("⏳ Server band, iltimos biroz kuting...");
      return;
    }
    await runVideoJob(ctx, ctx.message.text);
  } else if (ctx.session.awaiting === "calendar_topic") {
    ctx.session.awaiting = undefined;
    await runCalendarJob(ctx, ctx.message.text);
  } else {
    const userText = ctx.message.text.trim();
    if (!userText) return;
    await runChatCompletion(ctx, userText);
  }
});

bot.on("message:photo", async (ctx) => {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    await ctx.reply("⏳ Server band, iltimos biroz kuting...");
    return;
  }

  const jobId = generateJobId();
  const job: JobStatus = {
    id: jobId,
    type: "video",
    chatId: ctx.chat.id,
    userId: ctx.from?.id ?? 0,
    status: "pending",
    createdAt: Date.now(),
  };
  jobQueue.set(jobId, job);

  const status = await ctx.reply("🖼 Rasm qabul qilindi, reklama videosi tayyorlanmoqda...");
  job.statusMessageId = status.message_id;
  job.status = "running";
  activeJobs.add(jobId);

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.getFile(photo.file_id);
    const filePath = `./downloads/${file.file_unique_id}.jpg`;
    await file.download(filePath);
    const plan = {
      title: "Rasmdan reklama",
      language: "uz",
      mode: "music" as const,
      aspect: "9:16" as const,
      duration_seconds: 9,
      music: { enabled: true, mood: "uplifting" as const, volume_db: -9 },
      subtitles: { enabled: false, burn_in: false },
      scenes: [
        { index: 0, image: filePath, headline: "Yangi kolleksiya", subheadline: "Har kuni uchun qulaylik", kicker: "Reklama", duration: 3, palette: ["#050816", "#2563eb", "#22d3ee"], style: "aurora", motion: "zoom-in", transition: "fade" },
        { index: 1, image: filePath, headline: "Sifat", subheadline: "Har bir detalda", kicker: "Mahsulot", duration: 3, palette: ["#06120c", "#059669", "#a3e635"], style: "grid", motion: "pan-left", transition: "dissolve" },
        { index: 2, image: filePath, headline: "Bugun sinab ko'ring", subheadline: "O'zingiz uchun tanlang", kicker: "Taklif", duration: 3, palette: ["#160b05", "#ea580c", "#fbbf24"], style: "spotlight", motion: "zoom-out", transition: "wipeleft" },
      ],
    } as NormalizedPlan;
    await sendVideoResult(ctx, plan, "Reklama videos");
    job.status = "completed";
  } catch (error) {
    await deleteMessageSafely(ctx, status.message_id).catch(() => {});
    await ctx.reply(`❌ ${error}`);
    job.status = "failed";
    job.error = String(error);
  } finally {
    activeJobs.delete(jobId);
  }
});

bot.command("post_calendar", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin emasiz.");
  if (!CHANNEL_ID) return ctx.reply("⛔ CHANNEL_ID o'rnatilmagan.");
  const status = await ctx.reply("📤 Kanalga haftalik reja yuborilmoqda...");
  try {
    const result = await generateCalendar(
      { topic: "Haftalik kontent", days: 7, period: "weekly", platforms: ["telegram"], language: "uz", objective: "Engagement" },
      { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, profile: loadBrandProfile() },
    );
    await deleteMessageSafely(ctx, status.message_id);
    if (result.envelope.status === "ok") {
      await ctx.api.sendMessage(CHANNEL_ID, result.markdown, { parse_mode: "Markdown" });
      await ctx.reply("✅ Kanalga yuborildi.");
    } else {
      await ctx.reply("❓ " + result.envelope.questions.join("\n"));
    }
  } catch (error) {
    await deleteMessageSafely(ctx, status.message_id).catch(() => {});
    await ctx.reply(`❌ ${error}`);
  }
});

bot.catch((err) => {
  console.error("Bot error:", err.message.replaceAll(TOKEN, "[redacted]"));
});

async function startBotWithRetry(): Promise<void> {
  let retries = 0;
  const maxRetries = 5;
  const baseDelay = 5000;

  while (true) {
    try {
      console.log("🤖 Content Agent bot ishga tushirilmoqda...");
      await bot.init(AbortSignal.timeout(20_000));
      await bot.start({
        onStart: (info) => console.log(`✅ Telegram polling: @${info.username}`),
      });
      retries = 0;
      break;
    } catch (error) {
      retries++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Bot ishga tushirishda xato (urinish ${retries}/${maxRetries}):`, msg);

      if (retries >= maxRetries) {
        console.error("💥 Maksimal urinishlar tugadi. Bot to'xtatilmoqda.");
        process.exit(1);
      }

      const delay = baseDelay * Math.pow(2, retries - 1) + Math.random() * 1000;
      console.log(`⏳ ${Math.round(delay / 1000)}s kutish keyin qayta urinish...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("🔴 Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("🔴 Uncaught Exception:", error);
});

console.log("🚀 Content Agent bot boshlanmoqda...");
await startBotWithRetry();
