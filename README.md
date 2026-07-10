# Alpha-terminal

## Local app
- `npm run dev` — writes `config.js` and serves the static app on port 8080
- `npm run lint`
- `npm test`

## Telegram control server
- `npm run control`
- Optional `.env` values:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_ALLOWED_CHAT_IDS`
  - `CONTROL_SERVER_PORT`
  - `CONTROL_POLL_MS`
  - `CONTROL_STATE_FILE`
  - `DEFAULT_CONTROL_SERVER_URL=http://127.0.0.1:8787` to let the browser send bridge heartbeats

The control server persists watches and baselines to `.metabot-control-state.json` by default.

## Telegram commands
- `/status`
- `/help`
- `/watch <mint|collection|contract|x-link> [target=2] [basis=floor|mint] [price=<native>]`
- `/watches`
- `/remove <watch-id|contract|url>`
- `/update <watch-id|contract|url>`
- `/automint <watch-id|url> maxprice=<native> qty=1 target=2 maxgas=80 tip=3`
- `/automint confirm <watch-id>`

Plain pasted URLs are treated like `/watch`.

## Watch behavior
- Default watch mode is `basis=floor target=2`.
- The first verified floor observed after the link is posted becomes the baseline.
- `basis=mint` is only accepted when the mint price is verified or explicitly overridden with `price=<native>`.
- Alerts fire once per crossing and re-arm after the floor drops back below that threshold.

## Examples
- `/watch https://www.tinyvalidators.xyz/mint`
- `/watch https://x.com/tinyvalidators/status/2075256991186833628?s=46 target=2`
- `/watch https://www.tinyvalidators.xyz/mint basis=mint price=0.02 target=2`
- `/update watch_ab12cd`
- `/remove watch_ab12cd`
- `/automint watch_ab12cd maxprice=0.02 qty=1 target=2 maxgas=80 tip=3`

## Pricing output
- Mint price and floor are always reported separately.
- Known values are shown with USD when a fresh native/USD quote is available, for example:
  - `Mint price: 0.02 ETH ($34.70)`
  - `Floor: 0.04 ETH ($69.40)`
- Unknown prices are shown as `unknown` with the reason/source status.
- `FREE` is only shown when a verified mint phase/API explicitly confirms a zero mint price.
