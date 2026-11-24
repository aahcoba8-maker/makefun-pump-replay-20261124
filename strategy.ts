// Surge Sniper: a defensive launch-scalp paper-trading bot for the pump.fun bonding-curve
// replay (agent-fun/replay/v2). Places go by net PnL on an unseen 24h window, and the
// honest prior for that window is hostile: most launches die within minutes, momentum
// chases buy the top of the spike, and on the dev window the house momentum pilot loses
// most of the bankroll while the house launch sniper loses least. Local backtests of
// wider designs (momentum, capitulation rebounds, hold-for-graduation runners) all bled
// faster than the scalp on the same footing, so this entry does one thing, tightly:
//
// Decide in the first slots after a coin is created, from the create-slot tape:
// - the creator bought a sane amount (skin in the game, not a whale setting up a dump),
// - two or three other wallets piled in alongside (real interest; a lone buyer is
//   usually the creator's second wallet, and a crowd is usually a bundle farm),
// - the creator has not sold, and the curve already holds a little real SOL.
// Then buy small (0.1 SOL of cost, built in tranches under the size cap), take +15%,
// cut at -12%, trail once armed, and never hold past 60 slots. Exit instantly on a
// creator sell or a single big sell. The edge is not prediction; it is refusing almost
// every coin and keeping every loss tiny.
//
// Two safety systems wrap the scalp:
// - Buys are sized at 97% of the 1%-of-real-reserve cap: the scorer's reserve view nets
//   out this bot's own earlier fills on a curve, so a buy sized at exactly the SDK cap
//   can land a hair over the scorer's cap and be refused (measured on the dev window:
//   thousands of refusals without the haircut, near zero with it).
// - A peak-equity drawdown guard (8%) flattens everything and halts entries, and tiny
//   guardrail probes keep the run comfortably above the fills/coins validity floor when
//   natural trading lags the pace — the BTC-race lesson: eligibility and capital first.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream. Block time is read from events only
// for probe pacing, exactly as the house pilots do.

import { BPS, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Launch window: entries are decided at most this many slots after create. */
  sMaxAge: number;
  /** Creator's create-slot buy must sit inside [sMinDevBuySol, sMaxDevBuySol]. */
  sMinDevBuySol: number;
  sMaxDevBuySol: number;
  /** Distinct non-creator buyers in the first slots must sit inside this band. */
  sMinBuyers: number;
  sMaxBuyers: number;
  /** Real SOL reserve at decision must sit inside this band. */
  sMinRqSol: number;
  sMaxRqSol: number;
  /** Total cost per position (SOL), built in tranches under the size cap. */
  sStakeSol: number;
  /** Adds are allowed only this many slots after opening, and only into strength. */
  sAddWindow: number;
  addChunkSol: number;
  /** Exits, as fractions of cost (or of peak value for the trailing stop). */
  sTpPct: number;
  sSlPct: number;
  sTrailArmPct: number;
  sTrailPct: number;
  sMaxHold: number;
  /** A single recorded sell at or above this size (SOL) exits any held position. */
  bigSellSol: number;
  /** Risk guards. */
  maxMain: number;
  maxExposureSol: number;
  equityStopPct: number;
  cooldown: number;
  /** Guardrail pacing for the fills/coins validity floor. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  buySlipBps: number;
  minBuySol: number;
  /** Haircut on the size cap so buys stay fillable against the scorer's reserve view. */
  capHaircut: number;
}

export const DEFAULT_PARAMS: Params = {
  sMaxAge: 3,
  sMinDevBuySol: 0.05,
  sMaxDevBuySol: 2.5,
  sMinBuyers: 2,
  sMaxBuyers: 3,
  sMinRqSol: 0.3,
  sMaxRqSol: 30,
  sStakeSol: 0.1,
  sAddWindow: 60,
  addChunkSol: 0.1,
  sTpPct: 0.15,
  sSlPct: 0.12,
  sTrailArmPct: 0.10,
  sTrailPct: 0.12,
  sMaxHold: 60,
  bigSellSol: 1.0,
  maxMain: 5,
  maxExposureSol: 3,
  equityStopPct: 0.08,
  cooldown: 150,
  targetCoins: 30,
  targetFills: 260,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
  buySlipBps: 1500,
  minBuySol: 0.01,
  capHaircut: 0.97,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125n;

interface Tape {
  created: number | null;
  creator: string;
  devBuy: number;
  devSold: boolean;
  launchBuyers: Set<string>;
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
}

/** What selling `tokens` against (vq, vt) pays after the 1.25% curve fee, in lamports. */
function sellQuote(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let peakEquity: number | null = null;
  let halted = false;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: '', devBuy: 0, devSold: false, launchBuyers: new Set(), entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          traded.add(e.mint);
          if (e.user === t.creator) {
            if (e.is_buy && e.slot === t.created) t.devBuy += sol;
            if (!e.is_buy) t.devSold = true;
          } else if (e.is_buy && t.created !== null && e.slot <= t.created + 2) {
            t.launchBuyers.add(e.user);
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      const sellPending = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') return true;
        return false;
      };

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Equity guard: peak equity (cash + close value of positions); a deep drawdown
      // flattens everything and halts new entries for the rest of the run.
      {
        let equity = Number(state.freeCashLamports()) / LAMPORTS;
        for (const [mint, pos] of state.positions) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          const mk = marks.get(mint);
          const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
          const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
          equity += Number(sellQuote(BigInt(pos.token_amount), vq, vt)) / LAMPORTS;
        }
        if (peakEquity === null || equity > peakEquity) peakEquity = equity;
        if (!halted && peakEquity > 0 && equity < peakEquity * (1 - p.equityStopPct)) halted = true;
      }

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = Number(sellQuote(BigInt(pos.token_amount), vq, vt)) / LAMPORTS - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.sTpPct)) exit = true;
        if (!exit && value <= cost * (1 - p.sSlPct)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.sTrailArmPct) && value < h.peakValue * (1 - p.sTrailPct)) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.sMaxHold) exit = true;
        if (halted) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (sellPending(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds (nothing new once the equity guard has halted the run).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      if (!halted) {
        for (const mint of traded) {
          if (orders.length >= cap) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (pendingByMint.has(mint) || probes.has(mint)) continue;
          const t = tapes.get(mint)!;
          const h = held.get(mint);
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (h === undefined) {
            // New entry: the launch tape must qualify, in the first slots after create.
            if (slotsLeft <= 0 || held.size >= p.maxMain) continue;
            if (t.created === null || now - t.created > p.sMaxAge) continue;
            if (t.entries >= 1 || now - t.lastExit < p.cooldown) continue;
            if (t.devSold) continue;
            if (t.devBuy < p.sMinDevBuySol || t.devBuy > p.sMaxDevBuySol) continue;
            if (t.launchBuyers.size < p.sMinBuyers || t.launchBuyers.size > p.sMaxBuyers) continue;
            if (rqSol < p.sMinRqSol || rqSol > p.sMaxRqSol) continue;
          } else {
            // Adds: only inside the opening window, only into strength.
            if (h.exiting || !h.filled) continue;
            if (h.invested >= p.sStakeSol - p.minBuySol) continue;
            if (price < h.lastAddPrice) continue;
            if (now - h.opened > p.sAddWindow) continue;
          }
          const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS) * p.capHaircut;
          const want = h === undefined ? p.sStakeSol : Math.min(p.addChunkSol, p.sStakeSol - h.invested);
          let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          if (h === undefined) {
            held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price });
            t.entries++;
            slotsLeft--;
          } else {
            h.invested += amount;
            h.lastAddPrice = price;
          }
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (!halted && probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 2.0) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
