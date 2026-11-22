# One-click Telegram join

After a buyer pays on Whop, they land on `warlockwinners.com/welcome.html?receipt_id=pay_...`. The page sends that receipt to this small Cloudflare Worker. The worker checks with Whop that the payment is real and the membership is active, then returns a Telegram invite link that works **for one person, once, for 24 hours**. The buyer taps **Open Telegram & Join** and they're in.

Every hour the worker:
- notes who joined with which link, and
- asks Whop about every member. Anyone whose membership is canceled or expired is removed from the channel. They can rejoin later by buying again.

If Whop's API is down, nobody is removed. If the worker is down, the welcome page falls back to an "Email Us For Your Invite" button with the receipt number filled in.

## Setup (about 20 minutes, all in a browser)

### 1. A new Telegram bot for the worker
Use a **new** bot, not @bettingSznbot. Both read the same feed of join events, and two readers would miss each other's events.
1. In Telegram, message @BotFather and send `/newbot`. Name it something like `Warlock VIP Door`, then copy the token.
2. Add the new bot to the VIP channel as an **admin** with **Invite users via link** and **Ban users** turned on.

### 2. A Whop API key
In your Whop dashboard, find **Developer** (or **Settings → API keys**). Create a company API key that can **read payments** and **read memberships**, and copy it.

### 3. The Cloudflare Worker (free plan)
1. Sign up at dash.cloudflare.com.
2. **Workers & Pages → Create → Create Worker.** Name it `warlock-join`, then click **Deploy**.
3. Click **Edit code**. Delete everything, paste in all of `join-worker/worker.js`, then click **Deploy**.
4. **Storage & Databases → KV → Create** a namespace called `warlock-join`.
5. Back on the worker, go to **Settings → Bindings → Add → KV namespace**. Set the variable name to `KV` exactly, and pick the `warlock-join` namespace.
6. In **Settings → Variables and Secrets**, add:

   | Name | Type | Value |
   |---|---|---|
   | `TELEGRAM_CHANNEL_ID` | Text | `-1004346821376` |
   | `ALLOWED_ORIGIN` | Text | `https://warlockwinners.com` |
   | `TELEGRAM_BOT_TOKEN` | **Secret** | the new bot's token |
   | `WHOP_API_KEY` | **Secret** | the Whop key |

7. In **Settings → Triggers → Cron Triggers**, add `0 * * * *` (every hour).
8. Copy the worker's address. It looks like `https://warlock-join.<your-name>.workers.dev`.

### 4. Switch the welcome page on
Set `JOIN_API` in `welcome.html` to that address, with no slash at the end. Until it's set, the page shows the email button.

### 5. Test, then retire Whop's Telegram app
1. Buy the Daily plan with a second Telegram account. The welcome page should show **Open Telegram & Join**, and tapping it should join the channel.
2. In Cloudflare, open the worker and go to **Observability / Logs**. If you see `join failed ... inactive` on a fresh purchase, Whop is using a status name the worker doesn't expect. Send the log line so the `VALID` list at the top of `worker.js` can be fixed.
3. Once it works, **turn off Whop's Telegram app for the product and remove the Whop bot from the channel**. Otherwise two systems manage the same channel, and Whop's bot may remove people it didn't add.

## Tests
`node join-worker/test.mjs` runs the worker against fake Whop, Telegram and KV services, with no network.
