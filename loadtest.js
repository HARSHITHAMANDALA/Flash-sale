const BASE = 'http://localhost:3000';
const USERS = 1000; // if you see many errors, lower this to 700 (it must stay above 500)

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(path, body = {}) {
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.status;
  } catch (e) {
    return 0; // connection error
  }
}

async function fire(path) {
  const jobs = Array.from({ length: USERS }, (_, i) => post(path, { userId: 'u' + i }));
  return Promise.all(jobs);
}

function count(arr) {
  const out = {};
  arr.forEach(s => (out[s] = (out[s] || 0) + 1));
  return out;
}

(async () => {
  console.log(`\n=== TEST 1: NAIVE read-check-write (${USERS} buyers, 500 phones) ===`);
  await post('/reset');
  let t = Date.now();
  let statuses = await fire('/buy-naive');
  console.log('Time:', Date.now() - t, 'ms | HTTP statuses:', count(statuses));
  const naive = await (await fetch(BASE + '/naive-result')).json();
  console.log(`Phones SOLD: ${naive.naiveSold}  (only 500 exist!)  OVERSOLD BY ${Math.max(0, naive.naiveSold - 500)}`);

  console.log(`\n=== TEST 2: SAFE design - Redis slot + queue + worker (${USERS} buyers) ===`);
  await post('/reset');
  t = Date.now();
  statuses = await fire('/buy');
  console.log('Time:', Date.now() - t, 'ms | HTTP statuses:', count(statuses));
  console.log('(202 = got a slot, 410 = sold out)');

  await sleep(3000); // let the worker finish saving
  const info = await (await fetch(BASE + '/stock')).json();
  console.log('After worker finished:', info);
  console.log(info.orders.reserved === 500 && info.dbStock === 0
    ? 'PASS: exactly 500 orders saved, database stock is 0'
    : 'CHECK: numbers do not match, is the worker running?');
})();