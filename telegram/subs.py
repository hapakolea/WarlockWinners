#!/usr/bin/env python3
"""Onboard/offboard subscribers of the private Telegram channel.

  python3 subs.py add NAME DAYS   new subscriber: prints a one-person invite link to send them
                                  existing subscriber: extends their access by DAYS (renewal)
  python3 subs.py remove NAME     kick them from the channel now (they can rejoin with a new link later)
  python3 subs.py expire          kick everyone whose paid period has ended (run daily, e.g. cron)
  python3 subs.py list            show subscribers and paid-through dates
  python3 subs.py sync            record who joined with which link (every command does this first)

Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID (e.g. -1001234567890).
Optional SUBS_DB: roster path (default: subscribers.json next to this file). If it sits in a git clone
(your PRIVATE roster repo), every change is committed and pushed there.
Telegram keeps join events for only 24h, so run any command (or `sync`) at least daily,
otherwise a member's account can't be matched to their name and `remove` can't kick them.
"""
import datetime as dt, json, os, subprocess, sys, urllib.parse, urllib.request

DB = os.environ.get("SUBS_DB") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "subscribers.json")
LINK_VALID_DAYS = 7  # how long an unused invite link stays valid


def api(method, **params):
    url = f"https://api.telegram.org/bot{os.environ['TELEGRAM_BOT_TOKEN'].strip()}/{method}"
    data = urllib.parse.urlencode({k: json.dumps(v) if isinstance(v, (list, bool)) else v for k, v in params.items()}).encode()
    try:
        with urllib.request.urlopen(url, data, timeout=30) as r:
            return json.load(r)["result"]
    except urllib.error.HTTPError as e:
        if e.code in (401, 404):  # Telegram answers 404 for a malformed token, 401 for a revoked one
            sys.exit("Telegram rejected TELEGRAM_BOT_TOKEN. Copy it again from @BotFather (/mybots > your bot > API Token); it looks like 123456789:AAH...")
        sys.exit(f"Telegram {method} failed: {json.load(e).get('description')}")
    except urllib.error.URLError as e:
        sys.exit(f"Can't reach Telegram (check your internet connection): {e.reason}")


def load():
    if not os.path.exists(DB):
        return {"offset": 0, "subs": {}}
    with open(DB) as f:
        return json.load(f)


def save(db):
    tmp = DB + ".tmp"
    with open(tmp, "w") as f:
        json.dump(db, f, indent=2)
    os.replace(tmp, DB)  # atomic, so a crash never leaves a half-written roster


def push_roster(msg):
    d = os.path.dirname(os.path.abspath(DB))
    if not os.path.exists(os.path.join(d, ".git")):
        return
    git = lambda *a: subprocess.run(["git", "-C", d, *a], capture_output=True, text=True)
    git("add", os.path.basename(DB))
    if git("diff", "--cached", "--quiet").returncode:  # only commit when the roster changed
        c = git("commit", "-m", msg)
        if c.returncode:
            print(f"warning: roster saved locally but not backed up; git commit failed: {(c.stderr or c.stdout).strip()}")
            return
        r = git("push", "-u", "origin", "HEAD")  # -u/HEAD: first push into an empty repo has no upstream yet
        if r.returncode:
            print(f"warning: roster saved locally but push failed: {r.stderr.strip()}")


def today():
    return dt.date.today()


def sync(db, chat):
    for u in api("getUpdates", offset=db["offset"], allowed_updates=["chat_member"], timeout=0):
        db["offset"] = u["update_id"] + 1
        m = u.get("chat_member")
        if not m or str(m["chat"]["id"]) != chat or m["new_chat_member"]["status"] != "member":
            continue
        name = (m.get("invite_link") or {}).get("name")
        user = m["new_chat_member"]["user"]
        if name in db["subs"]:
            db["subs"][name]["user_id"] = user["id"]
            print(f"{name} joined as {user.get('username') or user['id']}")
        else:
            print(f"note: {user.get('username') or user['id']} joined via another link (e.g. Whop); not tracked by this script")


def kick(db, chat, name):
    s = db["subs"].pop(name)
    if s.get("link"):
        api("revokeChatInviteLink", chat_id=chat, invite_link=s["link"])
    if s.get("user_id"):
        api("banChatMember", chat_id=chat, user_id=s["user_id"])
        api("unbanChatMember", chat_id=chat, user_id=s["user_id"], only_if_banned=True)
        print(f"removed {name}")
    else:
        print(f"{name} never joined (or joined before the last sync window); invite link revoked")


def main(argv):
    if not argv or argv[0] not in ("add", "remove", "expire", "list", "sync"):
        sys.exit(__doc__)
    missing = [v for v in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID") if not os.environ.get(v)]
    if missing:
        sys.exit(f"Set {' and '.join(missing)} first (see README: Telegram subscribers).")
    chat = os.environ["TELEGRAM_CHANNEL_ID"].strip()
    db = load()
    sync(db, chat)
    save(db)
    cmd = argv[0]
    if cmd == "add":
        name, days = argv[1], int(argv[2])
        if len(name) > 32:
            sys.exit("NAME must be 32 characters or fewer (Telegram link-name limit)")
        s = db["subs"].get(name)
        if s:  # renewal: extend from whichever is later, today or current end date
            start = max(today(), dt.date.fromisoformat(s["until"]))
            s["until"] = str(start + dt.timedelta(days=days))
            print(f"{name} renewed through {s['until']}")
            if not s.get("user_id"):
                print(f"they haven't joined yet; invite link: {s['link']}")
        else:
            expire = int((dt.datetime.now() + dt.timedelta(days=LINK_VALID_DAYS)).timestamp())
            link = api("createChatInviteLink", chat_id=chat, name=name, member_limit=1, expire_date=expire)["invite_link"]
            db["subs"][name] = {"until": str(today() + dt.timedelta(days=days)), "user_id": None, "link": link}
            print(f"{name} paid through {db['subs'][name]['until']}. Send them this one-time link:\n{link}")
    elif cmd == "remove":
        if argv[1] not in db["subs"]:
            sys.exit(f"no subscriber named {argv[1]}")
        kick(db, chat, argv[1])
    elif cmd == "expire":
        for name in [n for n, s in db["subs"].items() if dt.date.fromisoformat(s["until"]) < today()]:
            kick(db, chat, name)
    elif cmd == "list":
        for name, s in sorted(db["subs"].items(), key=lambda kv: kv[1]["until"]):
            print(f"{s['until']}  {name}  {'joined' if s.get('user_id') else 'not joined yet'}")
    save(db)
    push_roster(" ".join(argv))


if __name__ == "__main__":
    main(sys.argv[1:])
