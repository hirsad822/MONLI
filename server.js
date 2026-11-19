const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { safeName, workerSource, provision } = require('./provision');

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (url.pathname === '/api/provision' && req.method === 'POST') {
    try { const result = await provision(await readBody(req)); return json(res, 200, result); }
    catch (error) { return json(res, 400, { success: false, error: error.message || 'راه‌اندازی ناموفق بود.' }); }
  }
  let relativePath;
  try { relativePath = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)); }
  catch { return json(res, 400, { error: 'Invalid path' }); }
  const publicRoot = path.resolve(ROOT, 'public');
  const filePath = path.resolve(publicRoot, relativePath);
  if (!filePath.startsWith(publicRoot + path.sep) && filePath !== path.join(publicRoot, 'index.html')) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (error, content) => {
    if (error) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(content);
  });
});
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Monli Studio listening on 0.0.0.0:${PORT}`));
module.exports = { safeName, workerSource, provision };
