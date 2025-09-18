// server.js — RenovoGo Bot v0 (Express + Telegram Webhook + Groq LLM)
const { session_id = 'local', text = '' } = req.body || {};
if (!text) return res.status(400).json({ ok: false, error: 'text required' });
try {
const out = await replyCore(session_id, text);
res.json({ ok: true, ...out });
} catch (e) {
console.error('/api/reply error', e);
res.status(500).json({ ok: false, error: e.message });
}
});

// ─── Telegram Webhook ───────────────────────────────────────
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
try {
const update = req.body;
const msg = update?.message || update?.edited_message || update?.channel_post;
if (!msg) return res.status(200).json({ ok: true });

const chatId = msg.chat.id;
const text = msg.text || msg.caption || '';

if (!text) {
await tgSend(chatId, 'Пока обрабатываю только текстовые сообщения.');
return res.status(200).json({ ok: true });
}

const { text: answer } = await replyCore(`tg:${chatId}`, text);
await tgSend(chatId, answer);
res.json({ ok: true });
} catch (e) {
console.error('Telegram webhook error', e);
// Всегда 200 — чтобы Telegram не ретраил бесконечно
res.status(200).json({ ok: true });
}
});

async function tgSend(chatId, text) {
if (!BOT_TOKEN) throw new Error('BOT_TOKEN not set');
const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false };
const r = await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body),
});
const j = await r.json();
if (!j.ok) console.error('Telegram sendMessage failed:', j);
return j;
}

app.listen(PORT, () => {
console.log(`▶ RenovoGo Bot v0 listening on :${PORT}`);
});
