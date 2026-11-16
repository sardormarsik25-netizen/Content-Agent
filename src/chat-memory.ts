import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROJECT_ROOT } from "./opencode-bridge.ts";

export function openChatMemory(databasePath: string, vaultFolder: string) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS chat_turns (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chat_id, user_id, message_id)
    );
  `);
  const recent = db.prepare(`
    SELECT question, answer FROM chat_turns
    WHERE chat_id = ? AND user_id = ? AND message_id < ?
    ORDER BY message_id DESC LIMIT 5
  `);
  const insert = db.prepare(`
    INSERT INTO chat_turns (chat_id, user_id, message_id, question, answer)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);
  const get = db.prepare(`
    SELECT question, answer, created_at FROM chat_turns
    WHERE chat_id = ? AND user_id = ? AND message_id = ?
  `);
  return {
    history(chat: number, user: number, message: number): string {
      return recent.all(chat, user, message).reverse()
        .map(({ question, answer }) => `Foydalanuvchi: ${question}\nAssistent: ${answer}`)
        .join("\n").slice(-12000);
    },
    save(chat: number, user: number, message: number, question: string, answer: string) {
      insert.run(chat, user, message, question, answer);
    },
    exportNote(chat: number, user: number, message: number) {
      const turn = get.get(chat, user, message);
      if (!turn) throw new Error("SQLite yozuvi topilmadi");
      mkdirSync(vaultFolder, { recursive: true });
      const path = join(vaultFolder, `Telegram ${chat} ${user} ${message}.md`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `# Telegram suhbat\n\n${turn.created_at} UTC\n\n## Savol\n\n${turn.question}\n\n## Javob\n\n${turn.answer}\n`, "utf8");
      renameSync(temporary, path);
    },
  };
}

export function projectChatMemory() {
  const store = join(PROJECT_ROOT, "store");
  mkdirSync(store, { recursive: true });
  return openChatMemory(
    join(store, "content.db"),
    process.env.CONTENT_OBSIDIAN_DIR ?? "C:/Users/user/Documents/Obsidian Vault/30-PROJECTS/Content Agent",
  );
}
