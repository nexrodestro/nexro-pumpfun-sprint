// nexro-pumpfun-sprint — "rq-ladder rider", retuned for the boothlord sprint.
//
// Paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
// The numbers below were re-derived on THIS kit (bundle 28dd76e4, dataset
// b661ceee — the same frozen dev window as the jackxyz72 replay edition)
// by grading 8 configs with grade-local --driver process:
//   this config +0.556 SOL, DD 4.3%, win 27.2%, 125 round trips, 108 mints
//   TP20 +0.492, long-hold +0.550, loose-entry +0.356 (118 mints, same top
//   coins — the extra entries only diluted), big-TP30 +0.303, wide-stop
//   +0.246, scalp TP18/SL06 +0.094, TP25/SL10 +0.209. This config wins.
//   Kit pilots for reference: momentum -9.49, reversion -4.00, sniper -0.47.
// What the dev window showed, measured before writing this file:
//   - A random entry loses about -23% net over 300 slots: most coins bleed.
//   - Coins whose real SOL first crosses 10 peak at a median 1.41x the cross
//     price within 3000 slots (41% reach 1.5x or more), while their last
//     price sits at a median 0.56x: the move is real but brief. Buy the
//     cross, bank the profit fast, cut losers fast, never hold the bleed.
//   - The chance a coin completes climbs steeply with real SOL (10% at 10,
//     21% at 20, 46% at 40, 74% at 60); completed coins run 5.7-14.5x from
//     create. Add into strength as real SOL climbs its rungs, while the
//     position is above water and above the last buy.
//   - Seller-exhaustion pullbacks alone gave only 16 signals per window —
//     too few for the 20-coin guardrail — so they filter here, not trigger.
// Entry: real SOL crosses up through 8 with spread-out buyers (8+ distinct,
// biggest at most 35% of buy SOL), buys at least 55% of the last 40 trades,
// net flow positive, the creator never sold, price within 5% of its
// last-100-slot top. Exits: sell all at +22% take profit, -8% stop, a
// trailing stop once +12% (out on a 10% fall from peak), dump-flow, big-sell
// and stale exits, 3000-slot max hold. New entries stop at -25% equity.
// Honest caveat: the dev net leans on a few coins — top coin +0.376 SOL
// (68% of net), top 3 +0.882 (159% of net), 33 of 109 coins positive. The
// FINAL window is 6h of FRESH data collected after the deadline, so this is
// a diversified lottery ticket, not a proven edge: a paid place needs the
// final window's own runners to land in this 108-coin net. Bar on the live
// dev board for this edition: top +45.27 SOL, 3rd +27.45, 592 of 2,656
// positive — far above this bot's +0.56. Winner-take-all $2.
// Deterministic: a pure function of the batches — no clock, no randomness,
// no I/O — so the two graded executions produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const FEE = 125n; // protocol 95 + creator 30, in basis points
const DEN = 10_000n;

// Sweep winner on this kit (see header).
const CFG = {
  rqIn: 8, // real SOL that must be crossed upward to trigger an entry
  rqMax: 40, // do not chase a coin that already ran past this
  fresh: 300, // entry only this soon after the cross
  minHands: 8, // distinct buyers in the last FLOWN trades
  maxWhale: 0.35, // largest single buyer's share of buy SOL
  flowN: 40, // window for buyer spread / net flow
  minBuy: 0.55, // buys must be at least this share of flowN
  nearTop: 0.95, // price now at least this share of the last-100-slot top
  first: 0.35, // first tranche per coin
  add: 0.35, // each pyramid tranche
  maxPer: 1.0, // most SOL invested in one coin
  rungs: [16, 32], // real-SOL rungs that unlock the next tranche
  maxAll: 6, // most SOL invested across all positions at once
  tp: 0.22,
  sl: 0.08,
  arm: 0.12, // trailing stop arms once value is this far above cost
  giveback: 0.1, // exit on a fall of this much from the position's peak value
  hold: 3000, // max hold in slots
  stale: 800, // exit if no trade on the coin for this long
  dump: -2, // exit when net flow over the last 30 trades is below this
  whaleSell: 3, // exit when one recorded sell is at least this big
  slip: 1500, // buy slippage in basis points
  cool: 300, // slots to wait after an exit before re-entering a coin
  maxTries: 2, // entries allowed per mint
  haltDd: 0.25, // halt new entries once equity is this far below its peak
};

interface Tick {
  s: number; // slot
  b: boolean; // buy?
  amt: number; // SOL
  who: Pubkey;
  px: number; // price (vq / vt)
  rq: number; // real SOL
}

interface Tape {
  born: number | null;
  dev: Pubkey | null; // creator
  devDumped: boolean;
  tape: Tick[];
  tries: number;
  lastOut: number; // slot of the last exit, -1e12 = never
  prevRq: number;
  crossAt: number; // slot real SOL last crossed upward through rqIn, -1 = none
  lastSeen: number;
}

interface OpenPos {
  openedAt: number;
  peak: number; // peak position value in SOL
  spent: number; // SOL sent in buys (decision-time amounts)
  step: number; // how many rungs have been used
  leaving: boolean;
  live: boolean; // at least one buy filled
  lastPx: number;
}

// Net SOL received for selling `tokens` against curve (vq, vt), after fees.
function exitValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE + DEN - 1n) / DEN;
}

const tapes = new Map<Pubkey, Tape>();
const open = new Map<Pubkey, OpenPos>();
let peakEquity = 10; // starting capital in SOL

// Buyer spread + net flow over the last CFG.flowN ticks of a tape.
function flowStats(t: Tape): { hands: number; buySol: number; buys: number; net: number; top: number } {
  const win = t.tape.slice(t.tape.length - CFG.flowN);
  const hands = new Map<Pubkey, number>();
  let buySol = 0;
  let buys = 0;
  let net = 0;
  for (const tk of win) {
    if (tk.b) {
      buys++;
      buySol += tk.amt;
      net += tk.amt;
      hands.set(tk.who, (hands.get(tk.who) ?? 0) + tk.amt);
    } else {
      net -= tk.amt;
    }
  }
  let top = 0;
  for (const v of hands.values()) if (v > top) top = v;
  return { hands: hands.size, buySol, buys, net, top };
}

// Highest price in the last 100 slots of a tape (0 when the tape is empty).
function recentTop(t: Tape, now: number): number {
  let high = 0;
  for (const tk of t.tape) {
    if (now - tk.s <= 100 && tk.px > high) high = tk.px;
  }
  return high;
}

// Exit decision for one open position. Each condition on its own forces the
// exit; the checks only read state, so their order cannot change the outcome.
function exitNow(h: OpenPos, value: number, cost: number, now: number, t: Tape | undefined, dumped: boolean): boolean {
  if (value >= cost * (1 + CFG.tp)) return true;
  if (value <= cost * (1 - CFG.sl)) return true;
  if (h.peak >= cost * (1 + CFG.arm) && value <= h.peak * (1 - CFG.giveback)) return true;
  if (now - h.openedAt >= CFG.hold) return true;
  if (t !== undefined && now - t.lastSeen >= CFG.stale) return true;
  if (dumped) return true;
  if (t !== undefined) {
    let net = 0;
    const tk = t.tape;
    for (let i = Math.max(0, tk.length - 30); i < tk.length; i++) net += tk[i]!.b ? tk[i]!.amt : -tk[i]!.amt;
    if (net < CFG.dump) return true;
  }
  return false;
}

const bot = {
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / 1e9;
    const touched = new Set<Pubkey>();
    const dumped = new Set<Pubkey>();

    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let t = tapes.get(e.mint);
        if (t === undefined) {
          t = { born: e.slot, dev: e.creator, devDumped: false, tape: [], tries: 0, lastOut: -1e12, prevRq: 0, crossAt: -1, lastSeen: e.slot };
          tapes.set(e.mint, t);
        } else {
          t.born = e.slot;
          t.dev = e.creator;
        }
      } else if (e.event === 'TradeEvent') {
        let t = tapes.get(e.mint);
        if (t === undefined) {
          t = { born: null, dev: e.creator, devDumped: false, tape: [], tries: 0, lastOut: -1e12, prevRq: 0, crossAt: -1, lastSeen: e.slot };
          tapes.set(e.mint, t);
        }
        const rq = Number(e.real_quote_reserves) / 1e9;
        const px = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        t.tape.push({ s: e.slot, b: e.is_buy, amt: Number(e.sol_amount) / 1e9, who: e.user, px, rq });
        if (t.tape.length > 100) t.tape.splice(0, t.tape.length - 100);
        t.lastSeen = e.slot;
        if (!e.is_buy && t.dev !== null && e.user === t.dev) t.devDumped = true;
        if (!e.is_buy && Number(e.sol_amount) / 1e9 >= CFG.whaleSell) dumped.add(e.mint);
        if (t.prevRq < CFG.rqIn && rq >= CFG.rqIn) t.crossAt = e.slot;
        t.prevRq = rq;
        touched.add(e.mint);
      }
    }

    // Fills: mark which open positions actually filled, and clear exited ones.
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        const h = open.get(f.mint);
        if (h !== undefined && f.side === 'buy') h.live = true;
      }
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const curveNow = (mint: Pubkey) => {
      const mk = marks.get(mint);
      if (mk !== undefined) {
        return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: Number(mk.real_quote_reserves) / 1e9 };
      }
      const cv = state.curves.get(mint);
      if (cv === undefined) return null;
      return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves, rq: Number(cv.real_quote_reserves) / 1e9 };
    };
    const posValue = (mint: Pubkey): number | null => {
      const pos = state.positions.get(mint);
      const cv = curveNow(mint);
      if (pos === undefined || cv === null) return null;
      return Number(exitValueLamports(pos.token_amount, cv.vq, cv.vt) - state.txFeeLamports()) / 1e9;
    };

    // Equity + drawdown guard (cash + marked position values).
    let equity = Number(state.cash) / 1e9;
    for (const mint of state.positions.keys()) {
      const v = posValue(mint);
      if (v !== null) equity += v;
    }
    if (equity > peakEquity) peakEquity = equity;
    const halted = equity < peakEquity * (1 - CFG.haltDd);

    // ---- Exits first. ----
    for (const [mint, h] of open) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          open.delete(mint);
          const t = tapes.get(mint);
          if (t !== undefined && h.live) t.lastOut = now;
          else if (t !== undefined) t.tries = Math.max(0, t.tries - 1);
        }
        continue;
      }
      h.live = true;
      if (curve === undefined || curve.complete) continue;
      const value = posValue(mint);
      if (value === null) continue;
      const cost = Number(pos.cost_lamports) / 1e9;
      if (value > h.peak) h.peak = value;
      const t = tapes.get(mint);
      if (h.leaving || exitNow(h, value, cost, now, t, dumped.has(mint))) {
        h.leaving = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }
    }

    // ---- Entries and pyramid adds. ----
    let free = Number(state.freeCashLamports()) / 1e9;
    let exposure = 0;
    for (const [, h] of open) exposure += h.spent;
    let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();

    for (const mint of touched) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = open.get(mint);
      const cv = curveNow(mint);
      if (cv === null) continue;
      const px = Number(cv.vq) / Number(cv.vt);

      if (h !== undefined) {
        // Pyramid: next rung unlocked by real SOL, price above last buy, position above water.
        if (h.leaving || !h.live || h.step >= CFG.rungs.length) continue;
        if (cv.rq < CFG.rungs[h.step]!) continue;
        if (px < h.lastPx) continue;
        const value = posValue(mint);
        const pos = state.positions.get(mint);
        if (value === null || pos === undefined) continue;
        if (value < Number(pos.cost_lamports) / 1e9) continue;
        if (h.spent >= CFG.maxPer - 0.001) continue;
        if (exposure + CFG.add > CFG.maxAll) continue;
        let amount = Math.min(CFG.add, CFG.maxPer - h.spent, Number(state.maxBuyLamports(mint)) / 1e9);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * 1e9)), max_slippage_bps: CFG.slip });
        h.spent += amount;
        h.step += 1;
        h.lastPx = px;
        free -= amount + tx;
        exposure += amount;
        continue;
      }

      // New entry: fresh cross, spread-out buyers, price near its top.
      if (halted || openSlots <= 0) continue;
      if (t.tries >= CFG.maxTries || now - t.lastOut < CFG.cool) continue;
      if (t.crossAt < 0 || now - t.crossAt > CFG.fresh) continue;
      if (cv.rq < CFG.rqIn || cv.rq > CFG.rqMax) continue;
      if (t.devDumped) continue;
      if (t.tape.length < CFG.flowN) continue;
      const fs = flowStats(t);
      if (fs.buys < CFG.flowN * CFG.minBuy) continue;
      if (fs.net < 0) continue;
      if (fs.hands < CFG.minHands) continue;
      if (fs.buySol <= 0) continue;
      if (fs.top > CFG.maxWhale * fs.buySol) continue;
      const high = recentTop(t, now);
      if (high <= 0 || px < high * CFG.nearTop) continue;
      if (exposure + CFG.first > CFG.maxAll) continue;
      let amount = Math.min(CFG.first, Number(state.maxBuyLamports(mint)) / 1e9);
      if (amount > free - tx) amount = free - tx;
      if (amount < 0.01) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * 1e9)), max_slippage_bps: CFG.slip });
      open.set(mint, { openedAt: now, peak: 0, spent: amount, step: 0, leaving: false, live: false, lastPx: px });
      t.tries++;
      free -= amount + tx;
      exposure += amount;
      openSlots--;
    }
    return orders;
  },
};

await runBot(bot);
