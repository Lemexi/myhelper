// /src/telegram.js

// ───────── Helpers: escaping & chunking ─────────
function escapeHtmlForTelegram(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMarkdownV2(s = "") {
  // Экраним все спецсимволы MarkdownV2 (Telegram)
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function sanitizeForMode(text = "", parseMode = null) {
  if (!parseMode) return String(text);
  if (parseMode === "HTML") return escapeHtmlForTelegram(text);
  if (parseMode === "MarkdownV2") return escapeMarkdownV2(text);
  return String(text);
}

// Telegram лимит ≈ 4096 символов; держим запас
const TG_HARD_LIMIT = 4096;
const TG_SOFT_LIMIT = 3500;

// Разбиваем по абзацам/строкам, чтобы не резать слова
function chunkText(input = "", softLimit = TG_SOFT_LIMIT, hardLimit = TG_HARD_LIMIT) {
  const text = String(input || "");
  if (text.length <= hardLimit) return [text];

  const chunks = [];
  let buf = "";

  const parts = text.split(/\n\s*\n/); // параграфы
  for (const p of parts) {
    // Если параграф сам длиннее hardLimit — режем по строкам
    if (p.length > hardLimit) {
      const lines = p.split(/\n/);
      for (const line of lines) {
        if ((buf + line + "\n").length > softLimit) {
          if (buf) chunks.push(buf.trimEnd());
          buf = "";
        }
        // Если отдельная строка огромная — режем по словам
        if (line.length > hardLimit) {
          let tmp = line;
          while (tmp.length > hardLimit) {
            chunks.push(tmp.slice(0, hardLimit));
            tmp = tmp.slice(hardLimit);
          }
          if (tmp) {
            if ((buf + tmp + "\n").length > softLimit) {
              if (buf) chunks.push(buf.trimEnd());
              buf = "";
            }
            buf += tmp + "\n";
          }
        } else {
          buf += line + "\n";
        }
      }
      continue;
    }

    // Нормальный параграф
    const block = p + "\n\n";
    if ((buf + block).length > softLimit) {
      if (buf) chunks.push(buf.trimEnd());
      buf = "";
    }
    buf += block;
  }

  if (buf) chunks.push(buf.trimEnd());
  // На всякий — не превышаем hardLimit
  return chunks.flatMap(c => {
    if (c.length <= hardLimit) return [c];
    const out = [];
    let t = c;
    while (t.length > hardLimit) {
      out.push(t.slice(0, hardLimit));
      t = t.slice(hardLimit);
    }
    if (t) out.push(t);
    return out;
  });
}

// ───────── Core sender ─────────
async function rawSend({ token, chatId, text, options = {} }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: j?.ok === true, result: j };
}

// ───────── Public API ─────────
/**
 * Надёжная отправка в Telegram.
 * @param {number|string} chatId
 * @param {string} text
 * @param {{ parse_mode?: 'HTML'|'MarkdownV2'|null, disable_web_page_preview?: boolean }} extra
 * @returns {Promise<{ok:boolean, result:any}>}
 */
export async function tgSend(chatId, text, extra = {}) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");

  // По умолчанию — без parse_mode (самый безопасный путь)
  // Можно передать extra.parse_mode = 'HTML' или 'MarkdownV2' при желании.
  const parse_mode = extra.parse_mode ?? null;

  // Если включили HTML/Markdown — санитизируем
  let prepared = sanitizeForMode(String(text ?? ""), parse_mode);

  // Защита от случайных «псевдо-тегов» вида <название> при parse_mode=HTML:
  if (parse_mode === "HTML" && /<[^>]+>/.test(prepared)) {
    // Уже экранировали, но на всякий проверяем, что ничего не «просочилось»
    prepared = prepared.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const chunks = chunkText(prepared);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const piece = chunks[i];

    // Основная попытка
    let { ok, result, status } = await rawSend({
      token: BOT_TOKEN,
      chatId,
      text: piece,
      options: {
        disable_web_page_preview: extra.disable_web_page_preview ?? true,
        parse_mode: parse_mode || undefined,
      },
    });

    // Если упали на парсинге (400 can't parse entities) — повторим без parse_mode
    if (!ok && result && result.description && /can't parse entities/i.test(result.description)) {
      const fallbackText = String(piece)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"); // как plain, но оставим безопасно
      const retry = await rawSend({
        token: BOT_TOKEN,
        chatId,
        text: fallbackText,
        options: { disable_web_page_preview: true }, // без parse_mode
      });
      ok = retry.ok;
      result = retry.result;
      status = retry.status;
    }

    // Лёгкий ретрай при 429/5xx
    if (!ok && (status === 429 || status >= 500)) {
      await new Promise(r => setTimeout(r, 800));
      const retry2 = await rawSend({
        token: BOT_TOKEN,
        chatId,
        text: piece,
        options: {
          disable_web_page_preview: extra.disable_web_page_preview ?? true,
          parse_mode: parse_mode || undefined,
        },
      });
      ok = retry2.ok;
      result = retry2.result;
      status = retry2.status;
    }

    if (!ok) {
      console.error("Telegram sendMessage failed:", { index: i, status, result });
      // продолжаем слать остальные куски, но вернём финальный статус как есть
    }
    results.push({ ok, status, result });
  }

  // Итог: ok=true, если все куски ушли
  const allOk = results.every(x => x.ok);
  return { ok: allOk, result: results };
}
