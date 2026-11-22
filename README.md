# Warlock Winners

Static site for warlockwinners.com. Edit `index.html`; search for `TODO` to find what needs real info (record, prices, payment links, email).

## Go live (GitHub Pages)
1. Repo Settings → Pages → Source: deploy from branch, pick the branch, folder `/`.
2. At your domain registrar (Google Workspace uses Squarespace Domains), add DNS records:
   - `A` records for `@`: 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153
   - `CNAME` for `www`: `hapakolea.github.io`
   - Keep the existing `MX` records, or Workspace email stops working.
3. Back in Pages settings, tick "Enforce HTTPS" once the certificate is issued.

## Telegram subscribers (`telegram/subs.py`)
Gives each paying subscriber a one-person invite link to the private channel and removes them when their time runs out. Needs Python 3 only, no packages.

One-time setup:
1. In Telegram, message @BotFather, send `/newbot`, and copy the token.
2. Add the bot to the private channel as an admin with "Invite users via link" and "Ban users" turned on.
3. Get the channel ID (starts with `-100`): forward any post from the channel to @userinfobot, or open the channel in web.telegram.org and copy the number from the URL.
4. `export TELEGRAM_BOT_TOKEN=... TELEGRAM_CHANNEL_ID=-100...`

Day to day:
- Someone pays: `python3 telegram/subs.py add mike@example.com 30`, then send them the link it prints. The link works once, for that person only, and stops working after 7 days if unused.
- Someone renews: run the same `add` command; their days are added on.
- Someone cancels or gets a refund: `python3 telegram/subs.py remove mike@example.com`
- Who's in: `python3 telegram/subs.py list`
- Run `python3 telegram/subs.py expire` once a day (cron or Task Scheduler). It removes everyone whose paid time has ended. **It has to run at least daily**: Telegram only keeps join events for 24 hours, and the script needs them to match a person to their link.

`telegram/subscribers.json` is the roster. It's gitignored, so back it up yourself and never commit it.
