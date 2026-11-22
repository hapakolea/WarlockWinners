"""Run: python3 telegram/test_subs.py  (no network; fakes the Telegram API)"""
import datetime as dt, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import subs

os.environ.update(TELEGRAM_BOT_TOKEN="x", TELEGRAM_CHANNEL_ID="-100")
subs.DB = os.path.join(tempfile.mkdtemp(), "subscribers.json")
calls, updates = [], []


def fake_api(method, **p):
    calls.append((method, p))
    if method == "getUpdates":
        out = [u for u in updates if u["update_id"] >= p["offset"]]
        return out
    if method == "createChatInviteLink":
        return {"invite_link": "https://t.me/+" + p["name"]}
    return True


subs.api = fake_api

subs.main(["add", "alice", "7"])
assert subs.load()["subs"]["alice"]["link"] == "https://t.me/+alice"

# alice joins with her link
updates.append({"update_id": 5, "chat_member": {"chat": {"id": -100}, "new_chat_member": {"status": "member", "user": {"id": 42}},
                                                 "invite_link": {"name": "alice"}}})
subs.main(["list"])
db = subs.load()
assert db["subs"]["alice"]["user_id"] == 42 and db["offset"] == 6

# renewal extends from current end date
subs.main(["add", "alice", "30"])
assert subs.load()["subs"]["alice"]["until"] == str(dt.date.today() + dt.timedelta(days=37))

# expire kicks only lapsed subscribers
subs.main(["add", "bob", "1"])
db = subs.load(); db["subs"]["bob"]["until"] = "2000-01-01"; subs.save(db)
calls.clear()
subs.main(["expire"])
assert "bob" not in subs.load()["subs"] and "alice" in subs.load()["subs"]
assert [c[0] for c in calls if c[0] != "getUpdates"] == ["revokeChatInviteLink"]  # bob never joined: link revoked only

# remove kicks a joined member without a permanent ban
calls.clear()
subs.main(["remove", "alice"])
assert [c[0] for c in calls if c[0] != "getUpdates"] == ["revokeChatInviteLink", "banChatMember", "unbanChatMember"]
assert subs.load()["subs"] == {}
# roster inside a git clone is committed after each command (push fails: no remote, only warns)
import subprocess
d = os.path.dirname(subs.DB); subprocess.run(["git", "init", "-q", d]); subprocess.run(["git", "-C", d, "config", "user.email", "t@t"]); subprocess.run(["git", "-C", d, "config", "user.name", "t"])
subs.main(["add", "carol", "7"])
log = subprocess.run(["git", "-C", d, "log", "--format=%s"], capture_output=True, text=True).stdout
assert log.strip() == "add carol 7", log
print("ok")
