// nexro-pumpfun-sprint — "rq-ladder rider", retuned for the boothlord sprint.
//
// Paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
// Params re-derived on THIS kit (bundle 28dd76e4, dataset b661ceee, the same
// frozen dev window as the jackxyz72 replay edition) by sweeping 8 configs
// with grade-local --driver process:
//   V0 (these params) +0.556 SOL, DD 4.3%, win 27.2%, 125 round trips, 108 mints
//   TP20 +0.492, long-hold +0.550, loose-entry +0.356 (118 mints, same top
//   coins — the extra entries only diluted), big-TP30 +0.303, wide-stop +0.246,
//   scalp TP18/SL06 +0.094, TP25/SL10 +0.209. V0 wins; nothing else came close.
//   Kit pilots for reference: momentum -9.49, reversion -4.00, sniper -0.47.
// What the dev window taught (measured before writing this file):
//   - Random entry loses ~-23% net over 300 slots: most coins bleed out.
//   - Coins whose real SOL first crosses 10 peak at a median 1.41x the cross
//     price within 3000 slots (41% reach >=1.5x), while their last-trade price
//     sits at a median 0.56x: the move is real but brief. Buy the cross, take
//     profit fast, cut losers fast, never hold the bleed.
//   - P(complete) rises steeply with real SOL (10% at 10, 21% at 20, 46% at
//     40, 74% at 60), completed coins run 5.7-14.5x from create. Pyramid into
//     strength as real SOL climbs its rungs, while above water and above the
//     last buy price.
//   - Seller-exhaustion pullbacks alone gave only 16 signals per window (too
//     few for the 20-coin guardrail), so they are a filter here, not an entry.
// Entry: real SOL crosses upward through 8 with dispersed buyers (>=8 distinct,
// largest <=35% of buy SOL), buys >=55% of the last 40 trades, net flow
// positive, creator never sold, price within 5% of its last-100-slot high.
// Exits: sell everything at +22% take profit, -8% stop, trailing stop once
// +12% (exit on a 10% fall from peak), dump-flow / big-sell / stale exits,
// 3000-slot max hold. A drawdown guard halts new entries at -25% equity.
// Concentration caveat (honest): dev net leans on a few coins — top coin
// +0.376 SOL (68% of net), top 3 +0.882 (159% of net), 33 of 109 coins
// positive. The FINAL window is 6h of FRESH data collected after the deadline,
// so this is a diversified lottery ticket, not a proven edge: a paid place
// needs the final window's own runners to land in this 108-coin net.
// Bar on the live dev board for this edition: top +45.27 SOL, 3rd +27.45,
// 592 of 2,656 positive — far above this bot's +0.56. Winner-take-all $2.
// Pure function of the batches: no clock, no randomness, no I/O, so the two
// graded executions produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30
const BPS_DENOM = 10_000n;

// Retuned params (sweep winner V0 on this kit).
const P = {
  entryRqSol: 8, // real SOL that must be crossed upward to trigger an entry
  entryRqMaxSol: 40, // do not chase a coin that already ran past this
  crossFreshSlots: 300, // entry only this soon after the cross
  minBuyers: 8, // distinct buyers in the last FLOW_TRADES trades
  maxTopBuyerShare: 0.35, // largest single buyer's share of buy SOL
  flowTrades: 40, // window for buyer dispersion / net flow
  minBuyShare: 0.55, // buys must be at least this share of flowTrades
  nearHigh: 0.95, // price now at least this share of the last-100-slot high
  initialSol: 0.35, // first tranche per coin
  addSol: 0.35, // each pyramid tranche
  maxPositionSol: 1.0, // most SOL invested in one coin
  addRungs: [16, 32], // real-SOL rungs that unlock the next tranche
  maxExposureSol: 6, // most SOL invested across all positions at once
  takeProfit: 0.22,
  stopLoss: 0.08,
  trailArm: 0.12, // trailing stop arms once value is this far above cost
  trail: 0.1, // exit on a fall of this much from the position's peak value
  maxHoldSlots: 3000,
  staleSlots: 800, // exit if no trade on the coin for this long
  dumpNetSol: -2, // exit when net flow over the last 30 trades is below this
  bigSellSol: 3, // exit when one recorded sell is at least this big
  buySlippageBps: 1500,
  cooldownSlots: 300,
  maxEntriesPerMint: 2,
  ddHalt: 0.25, // halt new entries once equity is this far below its peak
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
  rq: number;
}

interface Coin {
  created: number | null;
  creator: Pubkey | null;
  devSold: boolean;
  ticks: Tick[];
  entries: number;
  lastExit: number;
  lastRq: number;
  crossSlot: number; // slot real SOL last crossed upward through entryRqSol, -1 = none
  lastTradeSlot: number;
}

interface Held {
  firstSlot: number;
  peakValue: number; // SOL
  invested: number; // SOL sent in buys (decision-time amounts)
  rung: number; // how many add rungs have been used
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
}

// Net SOL received for selling `tokens` against curve (vq, vt), after fees.
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS_DENOM - 1n) / BPS_DENOM;
}

// Exit decision for one held position: take-profit, stop-loss, trailing stop
// once armed, max hold, stale coin, a big sell, or dump flow over the last
// 30 ticks. Pure reads only, so the order of the checks cannot change the
// outcome — each condition on its own forces the exit.
function shouldExit(h: Held, value: number, cost: number, now: number, c: Coin | undefined, bigSell: boolean): boolean {
  if (value >= cost * (1 + P.takeProfit)) return true;
  if (value <= cost * (1 - P.stopLoss)) return true;
  if (h.peakValue >= cost * (1 + P.trailArm) && value <= h.peakValue * (1 - P.trail)) return true;
  if (now - h.firstSlot >= P.maxHoldSlots) return true;
  if (c !== undefined && now - c.lastTradeSlot >= P.staleSlots) return true;
  if (bigSell) return true;
  if (c !== undefined) {
    let net = 0;
    const ts = c.ticks;
    for (let i = Math.max(0, ts.length - 30); i < ts.length; i++) net += ts[i]!.buy ? ts[i]!.sol : -ts[i]!.sol;
    if (net < P.dumpNetSol) return true;
  }
  return false;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
let equityPeak = 10; // starting capital in SOL

const bot = {
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / 1e9;
    const touched = new Set<Pubkey>();
    const bigSell = new Set<Pubkey>();

    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let c = coins.get(e.mint);
        if (c === undefined) {
          c = { created: e.slot, creator: e.creator, devSold: false, ticks: [], entries: 0, lastExit: -1e12, lastRq: 0, crossSlot: -1, lastTradeSlot: e.slot };
          coins.set(e.mint, c);
        } else {
          c.created = e.slot;
          c.creator = e.creator;
        }
      } else if (e.event === 'TradeEvent') {
        let c = coins.get(e.mint);
        if (c === undefined) {
          c = { created: null, creator: e.creator, devSold: false, ticks: [], entries: 0, lastExit: -1e12, lastRq: 0, crossSlot: -1, lastTradeSlot: e.slot };
          coins.set(e.mint, c);
        }
        const rq = Number(e.real_quote_reserves) / 1e9;
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        c.ticks.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / 1e9, user: e.user, price, rq });
        if (c.ticks.length > 100) c.ticks.splice(0, c.ticks.length - 100);
        c.lastTradeSlot = e.slot;
        if (!e.is_buy && c.creator !== null && e.user === c.creator) c.devSold = true;
        if (!e.is_buy && Number(e.sol_amount) / 1e9 >= P.bigSellSol) bigSell.add(e.mint);
        if (c.lastRq < P.entryRqSol && rq >= P.entryRqSol) c.crossSlot = e.slot;
        c.lastRq = rq;
        touched.add(e.mint);
      }
    }

    // Fills: track which held positions actually filled, and clear exited ones.
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        const h = held.get(f.mint);
        if (h !== undefined && f.side === 'buy') h.filled = true;
      }
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const curveOf = (mint: Pubkey) => {
      const mk = marks.get(mint);
      if (mk !== undefined) {
        return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: Number(mk.real_quote_reserves) / 1e9 };
      }
      const cv = state.curves.get(mint);
      if (cv === undefined) return null;
      return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves, rq: Number(cv.real_quote_reserves) / 1e9 };
    };
    const positionValue = (mint: Pubkey): number | null => {
      const pos = state.positions.get(mint);
      const cv = curveOf(mint);
      if (pos === undefined || cv === null) return null;
      return Number(sellValueLamports(pos.token_amount, cv.vq, cv.vt) - state.txFeeLamports()) / 1e9;
    };

    // Equity + drawdown guard (cash + marked position values).
    let equity = Number(state.cash) / 1e9;
    for (const mint of state.positions.keys()) {
      const v = positionValue(mint);
      if (v !== null) equity += v;
    }
    if (equity > equityPeak) equityPeak = equity;
    const halted = equity < equityPeak * (1 - P.ddHalt);

    // ---- Exits first. ----
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const c = coins.get(mint);
          if (c !== undefined && h.filled) c.lastExit = now;
          else if (c !== undefined) c.entries = Math.max(0, c.entries - 1);
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = positionValue(mint);
      if (value === null) continue;
      const cost = Number(pos.cost_lamports) / 1e9;
      if (value > h.peakValue) h.peakValue = value;
      const c = coins.get(mint);
      let exit = h.exiting || shouldExit(h, value, cost, now, c, bigSell.has(mint));
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // ---- Entries and pyramid adds. ----
    let free = Number(state.freeCashLamports()) / 1e9;
    let exposure = 0;
    for (const [, h] of held) exposure += h.invested;
    let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();

    for (const mint of touched) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint)) continue;
      const c = coins.get(mint)!;
      const h = held.get(mint);
      const cv = curveOf(mint);
      if (cv === null) continue;
      const price = Number(cv.vq) / Number(cv.vt);

      if (h !== undefined) {
        // Pyramid: next rung unlocked by real SOL, price above last buy, position above water.
        if (h.exiting || !h.filled || h.rung >= P.addRungs.length) continue;
        if (cv.rq < P.addRungs[h.rung]!) continue;
        if (price < h.lastBuyPrice) continue;
        const value = positionValue(mint);
        const pos = state.positions.get(mint);
        if (value === null || pos === undefined) continue;
        if (value < Number(pos.cost_lamports) / 1e9) continue;
        if (h.invested >= P.maxPositionSol - 0.001) continue;
        if (exposure + P.addSol > P.maxExposureSol) continue;
        let amount = Math.min(P.addSol, P.maxPositionSol - h.invested, Number(state.maxBuyLamports(mint)) / 1e9);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * 1e9)), max_slippage_bps: P.buySlippageBps });
        h.invested += amount;
        h.rung += 1;
        h.lastBuyPrice = price;
        free -= amount + tx;
        exposure += amount;
        continue;
      }

      // New entry.
      if (halted || openSlots <= 0) continue;
      if (c.entries >= P.maxEntriesPerMint || now - c.lastExit < P.cooldownSlots) continue;
      if (c.crossSlot < 0 || now - c.crossSlot > P.crossFreshSlots) continue;
      if (cv.rq < P.entryRqSol || cv.rq > P.entryRqMaxSol) continue;
      if (c.devSold) continue;
      const ts = c.ticks;
      if (ts.length < P.flowTrades) continue;
      const window = ts.slice(ts.length - P.flowTrades);
      const buyers = new Map<Pubkey, number>();
      let buySol = 0;
      let buys = 0;
      let net = 0;
      let high = 0;
      for (const t of window) {
        if (t.buy) {
          buys++;
          buySol += t.sol;
          net += t.sol;
          buyers.set(t.user, (buyers.get(t.user) ?? 0) + t.sol);
        } else {
          net -= t.sol;
        }
      }
      if (buys < P.flowTrades * P.minBuyShare) continue;
      if (net < 0) continue;
      if (buyers.size < P.minBuyers) continue;
      let top = 0;
      for (const v of buyers.values()) if (v > top) top = v;
      if (buySol <= 0 || top > P.maxTopBuyerShare * buySol) continue;
      for (let i = ts.length - 1; i >= 0; i--) {
        if (now - ts[i]!.slot > 100) break;
        if (ts[i]!.price > high) high = ts[i]!.price;
      }
      if (high <= 0 || price < high * P.nearHigh) continue;
      if (exposure + P.initialSol > P.maxExposureSol) continue;
      let amount = Math.min(P.initialSol, Number(state.maxBuyLamports(mint)) / 1e9);
      if (amount > free - tx) amount = free - tx;
      if (amount < 0.01) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * 1e9)), max_slippage_bps: P.buySlippageBps });
      held.set(mint, { firstSlot: now, peakValue: 0, invested: amount, rung: 0, exiting: false, filled: false, lastBuyPrice: price });
      c.entries++;
      free -= amount + tx;
      exposure += amount;
      openSlots--;
    }
    return orders;
  },
};

await runBot(bot);
