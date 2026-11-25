# nexro-pumpfun-sprint

Pump.fun paper-trading bot for make.fun competition
`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`
("Pump.fun Paper Sprint: Any Bot Can Win"). Pot $2, winner-take-all.
Deadline 2026-11-26T05:40:00Z (Thu 26 Nov 12:40 WIB).

## Strategy: rq-ladder rider (retuned)

- **Entry:** real SOL crosses upward through 8 with dispersed buyers
  (>=8 distinct, largest <=35% of buy SOL), buys >=55% of the last 40
  trades, net flow positive, creator never sold, price within 5% of its
  last-100-slot high.
- **Pyramid:** to 1.0 SOL at real-SOL rungs 16 / 32, while above water and
  above the last buy price.
- **Exits:** sell all at +22% take profit, -8% stop, trailing stop once
  +12% (exit on a 10% fall from peak), dump-flow / big-sell / stale exits,
  3000-slot max hold. Drawdown guard halts new entries at -25% equity.
- **Deterministic:** pure function of the batches — no clock, no randomness,
  no I/O. Two graded executions produce byte-identical action logs.

## Dev grade (frozen dev window, grade-local --driver process)

- Net PnL **+0.556 SOL**, max drawdown 4.3%, win rate 27.2%,
  125 round trips, 108 mints, 282 fills, fees 0.69 SOL.
- Sweep of 8 configs on this kit: TP20 +0.492, long-hold +0.550,
  loose-entry +0.356, big-TP30 +0.303, wide-stop +0.246, scalp +0.094,
  TP25/SL10 +0.209. This config wins.
- Bar on the live dev board: top +45.27 SOL, 3rd +27.45, 592 of 2,656
  positive — far above this bot. The final window is 6h of fresh data
  collected after the deadline, so this is a diversified lottery ticket,
  not a proven edge. Honest caveat: dev net leans on a few coins
  (top coin +0.376 SOL = 68% of net, top 3 +0.882 = 159% of net).

## Run

`main.ts` (Node 22) + `vendor/makefun-bot.ts` (kit SDK). Grade locally
with the kit: `node cli/makefun.mjs grade-local --kit . --bot <repo>
--driver process`.
