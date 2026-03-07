const handler = require('../lib/handler');

module.exports = async (req, res) => {
  try {
    await handler(req, res);
  } catch (e) {
    console.error('Unhandled error:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
  }
};
