import { Budget, MemoryStore } from '../dist/index.js';

const USERS = 10_000;
const CALLS = 200_000;

const budget = new Budget({
  store: new MemoryStore(),
  limits: { tokens: 5_000_000, usd: 50, requests: 100_000, window: 'day', rate: { requests: 1_000, perMs: 60_000 } },
});

const users = Array.from({ length: USERS }, (_, i) => `user-${i}`);
const usage = { model: 'gpt-4o-mini', inputTokens: 800, outputTokens: 200 };

console.log(`llm-budget bench - ${USERS.toLocaleString()} principals, ${CALLS.toLocaleString()} check+record cycles, MemoryStore\n`);

const t0 = performance.now();
let blocked = 0;
for (let i = 0; i < CALLS; i++) {
  const user = users[i % USERS];
  const decision = await budget.check(user, 1000);
  if (!decision.allowed) { blocked++; continue; }
  await budget.record(user, usage);
}
const ms = performance.now() - t0;
console.log(`check+record: ${(CALLS / (ms / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })} cycles/s (${(ms / CALLS * 1000).toFixed(1)} us per cycle), blocked: ${blocked}`);

const t1 = performance.now();
for (let i = 0; i < 50_000; i++) await budget.summary(users[i % USERS]);
console.log(`summary:      ${(50_000 / ((performance.now() - t1) / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })} reads/s`);
