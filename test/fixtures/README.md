# Fixtures

Real responses captured from X on **2026-08-19**, used so tests never touch the network.

| File | Operation | queryId at capture |
|---|---|---|
| `user-by-screen-name.apify.json` | `UserByScreenName` (@apify) | `Gb-d6r0vxPOADdG62OEBpQ` |
| `user-tweets.apify.page1.json` | `UserTweets` (@apify, count 20) | `SXVCYB8XHSS25nzIljNtZA` |
| `tweet-result.20.json` | `TweetResultByRestId` (tweet 20) | `GZsN2Pc4knAoit6pXa4HSA` |

All three returned HTTP 200 with a plain guest token, the public web bearer, and an
**empty** `features` map. Query ids rotate with X's web deploys; they are resolved at
runtime and these values are only the snapshot the fixtures were taken with.

Re-capture with `npm run fixtures:refresh`.
