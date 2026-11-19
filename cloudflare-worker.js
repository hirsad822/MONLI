import { provision } from './provision.js';

const MAX_BODY_BYTES = 80_000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });

    if (url.pathname === '/api/provision') {
      if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed.' }, 405);
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return json({ success: false, error: 'درخواست از مبدأ نامعتبر پذیرفته نمی‌شود.' }, 403);
      const declaredLength = Number(request.headers.get('content-length') || 0);
      if (declaredLength > MAX_BODY_BYTES) return json({ success: false, error: 'درخواست بیش از حد بزرگ است.' }, 413);
      try {
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ success: false, error: 'درخواست بیش از حد بزرگ است.' }, 413);
        const input = JSON.parse(text || '{}');
        return json(await provision(input));
      } catch (error) {
        return json({ success: false, error: error.message || 'راه‌اندازی ناموفق بود.' }, 400);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
