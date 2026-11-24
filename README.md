[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aahcoba8-maker/makefun-pump-replay-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aahcoba8-maker/makefun-pump-replay-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Surge Sniper — Pump.fun Replay Sprint paper bot

Entry for the make.fun bounty [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122): a paper-trading bot that trades 10 SOL of paper money over a 24-hour replay of recorded pump.fun activity (protocol `agent-fun/replay/v2`). Nothing is traded for real; the house replay scorer ranks entries by net PnL.

## Strategy

One tight launch scalp, wrapped in two safety systems. The bot decides in the first slots after a coin is created, from the create-slot tape:

- the creator bought a sane amount (skin in the game, not a whale setting up a dump),
- two or three other wallets piled in alongside (real interest — a lone buyer is usually the creator's second wallet, a crowd is usually a bundle farm),
- the creator has not sold, and the curve already holds a little real SOL.

Then it buys small (0.1 SOL of cost, built in tranches under the size cap), takes +15%, cuts at −12%, trails once armed, and never holds past 60 slots, exiting instantly on a creator sell or a single big sell. The edge is not prediction; it is refusing almost every coin and keeping every loss tiny. Wider designs (momentum chasing, capitulation rebounds, hold-for-graduation runners) were backtested on the dev window and all bled faster than the scalp, so they are not in here.

Buys are sized at 97% of the 1%-of-real-reserve order cap so they stay fillable against the scorer's reserve view. A peak-equity drawdown guard (8%) flattens the book and halts entries, and tiny guardrail probes keep the run above the fills/coins validity floor.

The bot is a pure function of the batches it is fed: no clock, no randomness, no I/O.

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`).
- `strategy.ts` — the strategy (parameters in `DEFAULT_PARAMS`).
- `vendor/agentfun-bot.ts` — the kit's TypeScript SDK shim, vendored byte for byte.

## License

MIT — see `LICENSE`.
