const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { redis, db, PRODUCT, TOTAL_STOCK, setStatus, resetAll, initIfEmpty } = require('./shared');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Runs atomically inside Redis.
// Returns: -2 = this user already has one, -1 = sold out, otherwise = phones left after taking one
const GRAB_SLOT = `
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return -2 end
local left = redis.call('DECR', KEYS[1])
if left < 0 then
  redis.call('INCR', KEYS[1])
  return -1
end
redis.call('SADD', KEYS[2], ARGV[1])
return left
`;

// ---------- SAFE checkout ----------
app.post('/buy', async (req, res) => {
  const userId = String(req.body.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const result = await redis.eval(GRAB_SLOT, 2, 'stock', 'buyers', userId);

  if (result === -2) return res.status(409).json({ status: 'already_bought' });
  if (result === -1) return res.status(410).json({ status: 'sold_out' });

  // This user won a slot. Queue the order and reply immediately.
  const orderId = crypto.randomUUID();
  await setStatus(orderId, 'queued');
  await redis.lpush('orders', JSON.stringify({ orderId, userId }));
  res.status(202).json({ status: 'queued', orderId, slot: TOTAL_STOCK - result });
});

// ---------- Browser polls this ----------
app.get('/status/:orderId', async (req, res) => {
  const raw = await redis.get(`order:${req.params.orderId}`);
  if (!raw) return res.status(404).json({ status: 'unknown' });
  res.json(JSON.parse(raw));
});

// ---------- Pay: change state ONLY IF still 'reserved' ----------
app.post('/pay/:orderId', async (req, res) => {
  const id = req.params.orderId;
  const r = db.prepare("UPDATE orders SET state='paid' WHERE order_id=? AND state='reserved'").run(id);
  if (r.changes === 1) {
    await setStatus(id, 'paid');
    return res.json({ status: 'paid' });
  }
  const row = db.prepare('SELECT state FROM orders WHERE order_id=?').get(id);
  if (!row) return res.status(404).json({ status: 'not_ready' });
  if (row.state === 'expired') {
    return res.status(409).json({
      status: 'late_refunded',
      message: 'Your payment arrived after the hold expired. It has been refunded.'
    });
  }
  res.json({ status: row.state }); // already paid
});

// ---------- NAIVE checkout (the old, buggy way) ----------
let naiveStock = TOTAL_STOCK;
let naiveSold = 0;
app.post('/buy-naive', async (req, res) => {
  const seen = naiveStock;                          // 1. READ
  await new Promise(r => setTimeout(r, 20));        //    pretend the database is slow
  if (seen > 0) {                                   // 2. CHECK (on the old value!)
    naiveStock = seen - 1;                          // 3. WRITE
    naiveSold++;
    return res.json({ status: 'sold' });
  }
  res.status(410).json({ status: 'sold_out' });
});
app.get('/naive-result', (req, res) => res.json({ naiveSold, naiveStock }));

// ---------- Info + reset (for demos and tests) ----------
app.get('/stock', async (req, res) => {
  const left = Math.max(0, Number(await redis.get('stock')));
  const inv = db.prepare('SELECT stock FROM inventory WHERE product_id=?').get(PRODUCT);
  const rows = db.prepare('SELECT state, COUNT(*) AS n FROM orders GROUP BY state').all();
  res.json({ redisStock: left, dbStock: inv.stock, orders: Object.fromEntries(rows.map(r => [r.state, r.n])) });
});

app.post('/reset', async (req, res) => {
  await resetAll();
  naiveStock = TOTAL_STOCK;
  naiveSold = 0;
  res.json({ ok: true });
});

initIfEmpty().then(() => app.listen(3000, () => console.log('Server on http://localhost:3000')));