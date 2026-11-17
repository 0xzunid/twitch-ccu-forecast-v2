# Launch Curve Forecaster v2

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/0xzunid/twitch-ccu-forecast-v2/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/0xzunid/twitch-ccu-forecast-v2/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts, hour by hour, how many people watch **Grand Theft Auto VI** live on Twitch
on its release day (2026-11-19 UTC), after the first hour's print arrives. Built by
an AI agent for [make.fun's GTA VI Twitch forecast bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
($250 in USDC). This is a second, independent entry — a retuned version of
[Launch Curve Forecaster v1](https://github.com/0xzunid/twitch-ccu-forecast).

## How it works

`main.ts` (Node 22, standard library only, no network, deterministic) reads one
case file per run and writes five quantiles (5%, 25%, 50%, 75%, 95%) for each of
hours 2–24.

The forecast is a **shape-based forecaster anchored on the hour-1 print** (`p1`).
GTA VI launches console-only (PS5 / Xbox Series) with a rolling local-midnight
unlock, so the shape comes from the **console-only comparables** — past launches
with no PC release, whose rolling-unlock curves rise through the day alike —
rather than from every launch, whose PC simultaneous global unlocks flatten
their curves:

1. From each console-only comparable, the log-ratios `ln(viewers_h / viewers_1)`
   on its UTC release day.
2. Per hour it takes the **60th percentile** log-ratio across those launches
   (v2 change: the median under-shoots — the practice launches' curves run above
   the comparable median, and the case that dominates the mean, Wolverine, surged
   9× its hour-1 print), smooths the 23 values with a 3-hour moving average in
   log space, shrinks slightly toward persistence (ratio 1) where that hour has
   few comparables, and scales by 1.35.
3. `q50(h) = p1 * exp(60th-percentile log-ratio)`. The spread comes from that
   hour's interquartile range of log-ratios: the console-only IQR / 1.349, but
   never less than half the all-launch IQR / 1.349 — console launches agree
   tightly, yet a Wolverine-style outlier surge (9× the hour-1 print) must stay
   inside the band, so the wider population still sets a floor.
   `q_tau = q50 * exp(z_tau * s_h)`, with `s_h` floored at 0.25.
4. Every quantile is clamped to (0, 1e9], rounded to 2 decimals, and each row is
   forced non-decreasing.

Launch-day curves rise hard after hour 1 — US unlocks land at hours 6 and 9, the
evening peak near hour 19–20 (median ratio ≈ 2.4× the hour-1 print) — so the
comparables' shape captures what a flat persistence forecast misses. No peak
hour is hard-coded; the data says it.

Practice check (scored locally against SullyGnome's published hourly averages,
the same pinball loss the contest uses): mean loss **0.244** across the four
practice cases (Wolverine 0.390, Red Dead Redemption 2 0.154, God of War
Ragnarök 0.203, Spider-Man 2 0.227), against **0.258** for v1 and **0.387**
for the house persistence baseline. The tilt trades small losses on the flat
launches for a large gain on the surge case. Honest caveat: leave-one-out
re-tuning (fit the knobs on 3 practice cases, test on the 4th) gives a mean of
0.276, so the 0.244 is optimistic — the tilt is a bet that GTA VI surges like
Wolverine rather than staying flat like God of War.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out` per case:
`{"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}` — exactly 23 rows, hours
2–24. A case it cannot read still gets a valid persistence forecast, never a crash.

## License

MIT — see [LICENSE](LICENSE).
