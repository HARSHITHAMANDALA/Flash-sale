const Redis = require('ioredis');
const { DatabaseSync } = require('node:sqlite');

const PRODUCT = 'phone';
const TOTAL_STOCK = 500;
const RESERVE_SECONDS = Number(process.env.RESERVE_SECONDS || 30);

const redis = new Redis();

// SQLite = our "real" database (source of truth)
const db = new DatabaseSync('shop.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    product_id TEXT PRIMARY KEY,
    stock INTEGER NOT NULL CHECK (stock >= 0)
  );
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    state TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// All-or-nothing wrapper (node:sqlite has no built-in db.transaction)
function tx(fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

async function setStatus(orderId, status, expiresAt = null) {
  await redis.set(`order:${orderId}`, JSON.stringify({ status, expiresAt }), 'EX', 3600);
}

async function resetAll() {
  await redis.del('stock', 'buyers', 'orders', 'processing');
  await redis.set('stock', TOTAL_STOCK);
  db.exec('DELETE FROM orders');
  db.prepare('INSERT OR REPLACE INTO inventory (product_id, stock) VALUES (?, ?)')
    .run(PRODUCT, TOTAL_STOCK);
}

async function initIfEmpty() {
  if (!(await redis.exists('stock'))) await resetAll();
}

module.exports = { redis, db, tx, PRODUCT, TOTAL_STOCK, RESERVE_SECONDS, setStatus, resetAll, initIfEmpty };