# markdown-render-speed-02-entry-v4

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/saifulsidik801-ship-it/markdown-render-speed-02-entry-v4/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/saifulsidik801-ship-it/markdown-render-speed-02-entry-v4/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer that matches marked 18.1.3 output byte-for-byte on all 720 practice cases (680 CommonMark 0.31.2 + GFM spec examples and 40 generated READMEs) while running faster than marked itself (~1.3x on the practice set). Single file `parse.js` (no dependencies, no build step) plus a thin `main.ts` driver that reads `/input/cases.json` and writes `/output/html.json`.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=59gqp20q&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
