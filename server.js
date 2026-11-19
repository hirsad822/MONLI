const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 80_000) { reject(new Error('درخواست بیش از حد بزرگ است.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('فرمت درخواست معتبر نیست.')); } });
    req.on('error', reject);
  });
}
async function cf(token, endpoint, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.body && typeof options.body === 'string' ? { 'content-type': 'application/json' } : {}), ...options.headers }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    const message = result.errors?.map(e => e.message).filter(Boolean).join('، ') || `Cloudflare خطا داد (HTTP ${response.status})`;
    throw new Error(message);
  }
  return result;
}
function workerSource() {
  return `export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Monli bot is running", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 403 });
    let update;
    try { update = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
    const message = update.message || update.edited_message;
    if (!message || !message.chat || !message.text) return new Response("ok");
    const chatId = String(message.chat.id);
    const text = message.text.trim();
    if (text === "/start") {
      await send(env, chatId, "سلام! من دستیار هوشمند شما هستم. هر سوالی دارید بپرسید.");
      return new Response("ok");
    }
    try {
      const prior = await env.DB.prepare("SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 12").bind(chatId).all();
      const history = (prior.results || []).reverse().map(row => ({ role: row.role, content: row.content }));
      const messages = [{ role: "system", content: env.SYSTEM_PROMPT || "You are a helpful, safe, concise assistant. Reply in the user's language." }, ...history, { role: "user", content: text }];
      await env.DB.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'user', ?)").bind(chatId, text.slice(0, 12000)).run();
      const response = await fetch(env.HERMES_BASE_URL.replace(/\\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + env.HERMES_API_KEY },
        body: JSON.stringify({ model: env.HERMES_MODEL || "hermes-3", messages, temperature: 0.7 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error("Model API returned an error");
      const answer = data.choices?.[0]?.message?.content || data.output || data.response || "پاسخی دریافت نشد. تنظیمات اتصال هوش مصنوعی را بررسی کنید.";
      const cleanAnswer = String(answer).slice(0, 4000);
      await env.DB.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'assistant', ?)").bind(chatId, cleanAnswer).run();
      await env.DB.prepare("DELETE FROM chat_messages WHERE chat_id = ? AND id NOT IN (SELECT id FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 24)").bind(chatId, chatId).run();
      await send(env, chatId, cleanAnswer);
    } catch (error) {
      await send(env, chatId, "اتصال به هوش مصنوعی با مشکل روبه‌رو شد. لطفاً کمی بعد دوباره تلاش کنید.");
    }
    return new Response("ok");
  }
};
async function send(env, chatId, text) {
  await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}
`;
}
function safeName(value) {
  const normalized = String(value || 'monli-bot').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 55);
  return normalized || 'monli-bot';
}
async function provision(input) {
  const { cloudflareToken, accountId, telegramToken, hermesApiKey } = input;
  if (![cloudflareToken, accountId, telegramToken, hermesApiKey].every(v => typeof v === 'string' && v.trim())) throw new Error('همه فیلدهای ضروری را کامل کنید.');
  if (!/^\d{10,}$/.test(accountId.trim())) throw new Error('شناسه حساب Cloudflare باید یک شناسه معتبر باشد.');
  const botName = safeName(input.botName);
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const baseUrl = String(input.hermesBaseUrl || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('نشانی API باید با https:// شروع شود.');
  const model = String(input.model || 'hermes-3').trim().slice(0, 100);
  const prompt = String(input.systemPrompt || 'You are a helpful, safe, concise assistant. Reply in the user’s language.').slice(0, 3000);
  const account = encodeURIComponent(accountId.trim());
  const token = cloudflareToken.trim();

  // Validate both external credentials before creating billable resources.
  await cf(token, `/accounts/${account}/d1/database`);
  const telegramResponse = await fetch(`https://api.telegram.org/bot${encodeURIComponent(telegramToken.trim())}/getMe`);
  const telegramInfo = await telegramResponse.json().catch(() => ({}));
  if (!telegramResponse.ok || !telegramInfo.ok || !telegramInfo.result?.username) throw new Error(`توکن تلگرام معتبر نیست: ${telegramInfo.description || 'توکن @BotFather را بررسی کنید.'}`);

  const dbResult = await cf(token, `/accounts/${account}/d1/database`, {
    method: 'POST', body: JSON.stringify({ name: `${botName}-data`, primary_location: 'WEUR' })
  });
  const dbId = dbResult.result?.uuid;
  if (!dbId) throw new Error('پایگاه داده ساخته شد اما شناسه آن دریافت نشد.');
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    'CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id, id)'
  ]) {
    await cf(token, `/accounts/${account}/d1/database/${encodeURIComponent(dbId)}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
  }

  const metadata = { main_module: 'index.js', compatibility_date: '2025-01-01', bindings: [{ type: 'd1', name: 'DB', id: dbId }] };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set('index.js', new Blob([workerSource()], { type: 'application/javascript+module' }), 'index.js');
  await cf(token, `/accounts/${account}/workers/scripts/${encodeURIComponent(botName)}`, { method: 'PUT', body: form });

  const secrets = [
    ['TELEGRAM_BOT_TOKEN', telegramToken.trim()], ['TELEGRAM_WEBHOOK_SECRET', webhookSecret], ['HERMES_API_KEY', hermesApiKey.trim()],
    ['HERMES_BASE_URL', baseUrl], ['HERMES_MODEL', model], ['SYSTEM_PROMPT', prompt]
  ];
  for (const [name, text] of secrets) {
    await cf(token, `/accounts/${account}/workers/scripts/${encodeURIComponent(botName)}/secrets`, {
      method: 'PUT', body: JSON.stringify({ name, text, type: 'secret_text' })
    });
  }
  await cf(token, `/accounts/${account}/workers/scripts/${encodeURIComponent(botName)}/subdomain`, {
    method: 'PUT', body: JSON.stringify({ enabled: true })
  });
  const subdomainResult = await cf(token, `/accounts/${account}/workers/subdomain`);
  const subdomain = subdomainResult.result?.subdomain;
  if (!subdomain) throw new Error('Worker و پایگاه داده ساخته شدند، اما دامنه workers.dev حساب فعال نیست. ابتدا در Cloudflare بخش Workers & Pages دامنه workers.dev را فعال کنید و سپس دوباره تلاش کنید.');
  const workerUrl = `https://${botName}.${subdomain}.workers.dev`;

  const webhookResponse = await fetch(`https://api.telegram.org/bot${encodeURIComponent(telegramToken.trim())}/setWebhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: workerUrl, secret_token: webhookSecret })
  });
  const webhookResult = await webhookResponse.json().catch(() => ({}));
  if (!webhookResponse.ok || !webhookResult.ok) throw new Error(`ربات روی Cloudflare ساخته شد اما ثبت وب‌هوک تلگرام ناموفق بود: ${webhookResult.description || 'تنظیمات ربات را بررسی کنید.'}`);
  return { success: true, botName, telegramUsername: telegramInfo.result.username, workerUrl, database: `${botName}-data`, message: 'ربات شما با موفقیت راه‌اندازی شد.' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (url.pathname === '/api/provision' && req.method === 'POST') {
    try { const result = await provision(await readBody(req)); return json(res, 200, result); }
    catch (error) { return json(res, 400, { success: false, error: error.message || 'راه‌اندازی ناموفق بود.' }); }
  }
  const filePath = url.pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, path.basename(url.pathname));
  if (!filePath.startsWith(ROOT)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (error, content) => {
    if (error) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(content);
  });
});
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Monli Studio listening on 0.0.0.0:${PORT}`));
module.exports = { safeName, workerSource };
