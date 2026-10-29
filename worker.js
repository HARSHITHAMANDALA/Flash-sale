const { redis, db, tx, PRODUCT, RESERVE_SECONDS, setStatus } = require('./shared');

const blocker = redis.duplicate(); // separate connection, because blocking waits hold the line
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WORKER_DELAY_MS = Number(process.env.WORKER_DELAY_MS || 0); // simulate a slow database

const orderExists = db.prepare('SELECT 1 FROM orders WHERE order_id=?');
const reduceStock = db.prepare('UPDATE inventory SET stock = stock - 1 WHERE product_id=? AND stock > 0');
const insertOrder = db.prepare("INSERT INTO orders (order_id, user_id, state, expires_at) VALUES (?, ?, 'reserved', ?)");

// All-or-nothing database work
const saveOrder = tx((orderId, userId, expiresAt) => {
  if (orderExists.get(orderId)) return 'duplicate';               // idempotency
  if (reduceStock.run(PRODUCT).changes === 0) return 'rejected';   // conditional update: stock was already 0
  insertOrder.run(orderId, userId, expiresAt);
  return 'confirmed';
});

async function handle(raw) {
  const { orderId, userId } = JSON.parse(raw);
  if (WORKER_DELAY_MS) await sleep(WORKER_DELAY_MS);
  const expiresAt = Date.now() + RESERVE_SECONDS * 1000;
  const result = saveOrder(orderId, userId, expiresAt);
  if (result === 'confirmed') await setStatus(orderId, 'confirmed', expiresAt);
  if (result === 'rejected') await setStatus(orderId, 'rejected');
  // 'duplicate' = already handled earlier, do nothing
  console.log(`order ${orderId.slice(0, 8)} -> ${result}`);
}

async function mainLoop() {
  // On startup, put unfinished orders from a previous crash back in the queue.
  // (Only safe with ONE worker. Real systems use visibility timeouts.)
  while (await redis.lmove('processing', 'orders', 'LEFT', 'RIGHT')) {}

  while (true) {
    const raw = await blocker.blmove('orders', 'processing', 'RIGHT', 'LEFT', 0); // wait for an order
    await handle(raw);
    await redis.lrem('processing', 1, raw); // ACK: only now is it removed
  }
}

// ---------- Reservation expiry ----------
const findExpired = db.prepare("SELECT order_id, user_id FROM orders WHERE state='reserved' AND expires_at < ?");
const markExpired = db.prepare("UPDATE orders SET state='expired' WHERE order_id=? AND state='reserved'");
const giveBack = db.prepare('UPDATE inventory SET stock = stock + 1 WHERE product_id=?');

// Returns true only if THIS call changed the state (so only then is stock returned)
const expireOne = tx(orderId => {
  if (markExpired.run(orderId).changes === 1) {
    giveBack.run(PRODUCT);
    return true;
  }
  return false;
});

setInterval(async () => {
  for (const o of findExpired.all(Date.now())) {
    if (expireOne(o.order_id)) {
      await redis.incr('stock');            // phone goes back on sale
      await redis.srem('buyers', o.user_id); // user may buy again
      await setStatus(o.order_id, 'expired');
      console.log(`order ${o.order_id.slice(0, 8)} expired, stock returned`);
    }
  }
}, 1000);

mainLoop();
console.log('Worker running...');