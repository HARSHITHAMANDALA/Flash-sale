# Flash-Sale Checkout Prototype

A small working prototype of the flash-sale design described in my case-study report.
It sells 500 phones to many simultaneous buyers without overselling.

## What it demonstrates
- **Atomic Redis slot**: a Lua script checks "already bought?" and subtracts 1 in one step, so no read-check-write gap.
- **Queue + 202 reply**: winners are queued and answered instantly; the web server never waits for the database.
- **Worker with acknowledgement**: an order leaves the "processing" list only after it is saved.
- **Idempotency**: a repeated order ID is detected and skipped.
- **Conditional update**: `UPDATE inventory SET stock = stock - 1 WHERE stock > 0` is the final safety net.
- **Reservations**: each order is `reserved`, `paid` or `expired`. Payment and expiry both use "change only if still reserved", so only one can win; stock returns only to whoever expired it. Late payments are refunded.
- **Frontend**: Buy button locks on first click, clear status messages, polling with backoff and jitter, countdown.
- **Naive endpoint** (`/buy-naive`): the old buggy read-check-write, kept to show the overselling bug.

## Not implemented (design only, see report)
CDN, load balancer, autoscaling, rate limiting, CAPTCHA, OTP verification, real payments,
Redis persistence/replication, dead-letter queue.

## Tech
Node.js, Express, Redis (ioredis), SQLite (better-sqlite3), plain HTML/JS.

## Setup
1. Install Node.js and Redis (e.g. `docker run -d --name flash-redis -p 6379:6379 redis`).
2. `npm install`
3. Terminal 1: `npm run server`
4. Terminal 2: `npm run worker`
5. Open http://localhost:3000

## Run the load test
With the server and worker running: `npm run loadtest`

## My results
(Fill in with your own numbers and screenshots.)

| Version | Buyers | Phones sold | Oversold by |
|---|---|---|---|
| Naive read-check-write | 1000 | ... | ... |
| Redis slot + queue + worker | 1000 | ... | 0 |

## Known limitations
- The "processing" recovery on worker startup is only safe with one worker.
- Redis and the database are two copies of the stock; a crash between them can lose an order (reduced by persistence and reconciliation, not removed).
- Payment is simulated with a button.
- Everything runs on one machine, so throughput numbers are not real-world numbers.

## Project structure
- `shared.js` settings, Redis and database setup
- `server.js` API (buy, status, pay, naive buy, reset)
- `worker.js` queue consumer and reservation expiry
- `public/index.html` frontend
- `loadtest.js` concurrency test
