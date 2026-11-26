// Reserve-gated momentum bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, in plain words: most new pump.fun coins die within minutes, but a coin
// that has already pulled real SOL into its bonding curve has proven demand.
// This bot waits until a fresh coin's real SOL reserves first cross a
// threshold (REAL_THR), then buys a small, fixed slice of it. It exits on a
// take-profit, a stop-loss, a trailing stop once the trade is comfortably
// green, a maximum hold time, or the curve completing. One trade per coin,
// at most five open positions, and every order is sized under 1% of the
// coin's real reserves so the harness's max-order cap never rejects it.
//
// The bot speaks the replay protocol directly over NDJSON on stdin/stdout:
// the harness sends a hello, then one batch per slot (events, marks, fills,
// account), and the bot answers each batch with one reply carrying its
// orders. No network, no randomness, no clock: the same input tape always
// produces the same reply tape, byte for byte.

import * as readline from "node:readline";

// ---- Strategy parameters (tuned on the dev window, see README) ----
const REAL_THR = 12_000_000_000; // 12 SOL of real reserves before we touch a coin
const SIZE_CAP = 100_000_000; // never spend more than 0.10 SOL on one entry
const SIZE_BPS_OF_REAL = 90; // spend at most 0.90% of real reserves (cap is 1%)
const MIN_BUY = 12_000_000; // smallest entry worth the round-trip fees (0.012 SOL)
const TAKE_PROFIT = 1.3; // sell when the price is 30% above our entry
const STOP_LOSS = 0.85; // sell when the price is 15% below our entry
const TRAIL_ARM = 1.2; // trailing stop only arms once 20% in profit
const TRAIL_DROP = 0.1; // ... then sell on a 10% pullback from the peak
const MAX_HOLD_SLOTS = 2000; // give up on a flat coin after 2000 slots
const MAX_POSITIONS = 5; // harness cap on open positions
const MAX_SLIPPAGE_BPS = 500; // 5%: lenient enough to fill on fast coins
const TX_FEE_LAMPORTS = 105_000; // base (5000) + priority (100000) per order

const LAMPORTS_PER_SOL = 1_000_000_000;

type MintState = {
  p0: number; // price at creation (lamports per token, as a float ratio)
  netBuy: bigint; // cumulative buy SOL minus sell SOL since creation
  real: bigint; // latest real SOL reserves
  price: number; // latest price (virtual SOL / virtual token reserves)
  slot: number; // slot of the latest event for this mint
  armed: boolean; // true once real reserves first crossed REAL_THR
  completed: boolean; // true once a CompleteEvent arrived
};

type Position = {
  tokens: bigint;
  entry: number; // average entry price (lamports per token)
  peak: number; // highest price seen since entry
  entrySlot: number; // slot the position first appeared in our account
};

const coins = new Map<string, MintState>();
const positions = new Map<string, Position>();
const traded = new Set<string>(); // mints we already entered once (one trade each)
let cash = 0n;
let seq = 0;

function priceOf(vSol: bigint, vTok: bigint): number {
  if (vTok === 0n) return 0;
  return Number(vSol) / Number(vTok);
}

function handleHello(msg: any): void {
  cash = BigInt(msg.capital.lamports);
}

function handleBatch(msg: any): { type: string; seq: number; orders: any[] } {
  const slot: number = msg.slot;
  const orders: any[] = [];

  // 1. Refresh our cash from the harness's authoritative account snapshot.
  if (msg.account) {
    cash = BigInt(msg.account.cash_lamports);
  }

  // 2. Fold the batch's events into per-coin state.
  for (const ev of msg.events ?? []) {
    if (ev.event === "CreateEvent") {
      coins.set(ev.mint, {
        p0: priceOf(BigInt(ev.virtual_sol_reserves), BigInt(ev.virtual_token_reserves)),
        netBuy: 0n,
        real: 0n,
        price: priceOf(BigInt(ev.virtual_sol_reserves), BigInt(ev.virtual_token_reserves)),
        slot: ev.slot,
        armed: false,
        completed: false,
      });
    } else if (ev.event === "TradeEvent") {
      const st = coins.get(ev.mint);
      if (!st) continue;
      const amt = BigInt(ev.sol_amount);
      st.netBuy += ev.is_buy ? amt : -amt;
      st.real = BigInt(ev.real_sol_reserves);
      st.price = priceOf(BigInt(ev.virtual_sol_reserves), BigInt(ev.virtual_token_reserves));
      st.slot = ev.slot;
    } else if (ev.event === "CompleteEvent") {
      const st = coins.get(ev.mint);
      if (st) st.completed = true;
    }
  }

  // 3. Marks carry the freshest reserves for every touched mint; prefer them
  // for pricing open positions.
  for (const m of msg.marks ?? []) {
    const st = coins.get(m.mint);
    if (!st) continue;
    st.price = priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
    st.slot = Math.max(st.slot, m.slot);
  }

  // 4. Reconcile open positions from the account snapshot (authoritative).
  const seen = new Set<string>();
  for (const p of msg.account?.positions ?? []) {
    const mint: string = p.mint;
    seen.add(mint);
    const tokens = BigInt(p.token_amount);
    const cost = BigInt(p.cost_lamports);
    const entry = tokens > 0n ? Number(cost) / Number(tokens) : 0;
    const prev = positions.get(mint);
    if (prev) {
      prev.tokens = tokens;
      prev.entry = entry;
      const st = coins.get(mint);
      if (st && st.price > 0) prev.peak = Math.max(prev.peak, st.price);
    } else {
      const st = coins.get(mint);
      const now = st && st.price > 0 ? st.price : entry;
      positions.set(mint, { tokens, entry, peak: Math.max(entry, now), entrySlot: slot });
    }
  }
  for (const mint of [...positions.keys()]) {
    if (!seen.has(mint)) positions.delete(mint);
  }

  // 5. Exits: check every open position against its exit rules.
  let reservedCash = 0n;
  const openCount = positions.size;
  for (const [mint, pos] of [...positions.entries()]) {
    const st = coins.get(mint);
    const price = st && st.price > 0 ? st.price : pos.entry;
    const mult = pos.entry > 0 ? price / pos.entry : 1;
    const trailMult = pos.entry > 0 ? pos.peak / pos.entry : 1;
    const done =
      mult >= TAKE_PROFIT ||
      mult <= STOP_LOSS ||
      (trailMult >= TRAIL_ARM && price <= pos.peak * (1 - TRAIL_DROP)) ||
      slot - pos.entrySlot >= MAX_HOLD_SLOTS ||
      (st?.completed ?? false);
    if (done && pos.tokens > 0n) {
      orders.push({
        side: "sell",
        client_id: `x${msg.seq}-${mint.slice(0, 8)}`,
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      reservedCash += BigInt(TX_FEE_LAMPORTS);
      positions.delete(mint);
      traded.add(mint);
    }
  }

  // 6. Entries: a coin becomes a candidate the first time its real reserves
  // cross REAL_THR. Buy only if buyers are still net positive and the price
  // has not fallen back below its creation price. One shot per coin.
  if (positions.size + orders.filter((o) => o.side === "buy").length < MAX_POSITIONS) {
    const candidates: string[] = [];
    for (const [mint, st] of coins.entries()) {
      if (traded.has(mint) || positions.has(mint)) continue;
      if (!st.armed && st.real >= BigInt(REAL_THR)) {
        st.armed = true;
        if (st.netBuy > 0n && st.price >= st.p0) candidates.push(mint);
      }
    }
    // Deterministic order: sort by mint so the reply never depends on
    // Map insertion order.
    candidates.sort();
    for (const mint of candidates) {
      if (positions.size + orders.filter((o) => o.side === "buy").length >= MAX_POSITIONS) break;
      const st = coins.get(mint)!;
      const byReserve = (st.real * BigInt(SIZE_BPS_OF_REAL)) / 10000n;
      const size = byReserve < BigInt(SIZE_CAP) ? byReserve : BigInt(SIZE_CAP);
      if (size < BigInt(MIN_BUY)) continue;
      if (cash - reservedCash < size + BigInt(TX_FEE_LAMPORTS)) continue;
      orders.push({
        side: "buy",
        client_id: `b${msg.seq}-${mint.slice(0, 8)}`,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      reservedCash += size + BigInt(TX_FEE_LAMPORTS);
      traded.add(mint);
    }
  }

  return { type: "reply", seq: msg.seq, orders };
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      handleHello(msg);
    } else if (msg.type === "batch") {
      seq = msg.seq;
      process.stdout.write(JSON.stringify(handleBatch(msg)) + "\n");
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().catch(() => process.exit(1));
