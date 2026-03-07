const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env file if present
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
  }
} catch (_) {}

const handler = require('./lib/handler');

const server = http.createServer(async (req, res) => {
  // Serve static files for local dev
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (req.url === '/dashboard' || req.url === '/dashboard.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Delegate everything else to the shared handler
  try {
    await handler(req, res);
  } catch (e) {
    console.error('Handler error:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
});

server.listen(3456, () => {
  console.log('Enneagram v2 engine running at http://localhost:3456');
});
