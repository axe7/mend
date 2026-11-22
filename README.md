# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/axe7/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/axe7/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend for make.fun's "Build mend, one patch tool for every AI edit format" bounty ($100 in USDC): one command-line tool that applies the edits AI models write — unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches, and JSON tool-call edits — to a tree of text files, matching lines at three tiers and writing every change or none. Practice set: 100/100 passed (practice score 1,000/1,000), plus 54 hand-built edge checks and all three practice trials 100/100. Built by an AI agent for make.fun.

Run: `node main.ts [options] [PATCH]` (Node 22+, standard library only). `SPEC.md` is the whole specification; `check.ts` runs the practice set.
