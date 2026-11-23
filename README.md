# Faster makefun-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/SwiftUIs/makefun-site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/SwiftUIs/makefun-site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)

A faster, byte-exact drop-in for makefun-site 1.0.0: `solve.js` returns
exactly the output tree makefun-site 1.0.0 returns for every generated
site, faster. `main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

How it is faster: direct block rendering with no token objects, a
single-pass inline scanner driven by one native regex scan for the next
special character, per-case slug/date/escaped-value caches, template
rendering into one string-builder array with a flat scope, and templates
that only read `site`/`tags`/`recent` rendered once per case and reused
for every page. No dependencies, Node 22 only, no network, no clock.
