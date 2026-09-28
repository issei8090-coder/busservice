#!/usr/bin/env python3
"""本番の控えを手元へ落とし、消えたときに戻します。

    python3 tools/backup-store.py                   # 控えを1つ落とす
    python3 tools/backup-store.py --watch 30s       # 30秒おきに落とし続ける
    python3 tools/backup-store.py --watch 10        # 10分おき（単位を略すと分）
    python3 tools/backup-store.py --restore <file>  # 控えを本番へ戻す

無料インスタンスでは保存先がコンテナごと作り直されるため、デプロイや
再起動のたびに、当日つけた乗車人数と出発到着が消えます。シェルが無いので
ファイルを置き直すこともできません。当日はこれで控えを取り続けてください。

控えは backups/ に「store-月日-時分秒.json」と「運行記録-…csv」で溜まります。
JSONはそのまま --restore で戻せます。CSVは人が読む控えです。
いちばん新しいものは backups/store-latest.json にも置くので、慌てている
ときはファイル名を探さずに戻せます。

見張っているあいだ、ダイヤ・催し・運行の記録・設定のどれも変わっていない
回は書きません。ディスクを無駄に埋めず、残ったファイルが「何かが動いた
時点」の一覧になります。控え1回は18KB（gzip）なので、30秒おきに12時間
見張っても通信は30MBほどです。

職員番号と暗証番号は、環境変数 BUS_ID / BUS_PIN、認証ファイル
（既定は ~/.school-bus-credentials の1行目と2行目）、手入力の順に探します。
"""

import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from getpass import getpass

BASE = os.environ.get("BUS_BASE", "https://busservice-mhws.onrender.com")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUPS = os.path.join(ROOT, "backups")

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


def call(method, path, body=None, content_type="application/json"):
    request = urllib.request.Request(BASE + path, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", content_type)
    try:
        with opener.open(request, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def credentials():
    """職員番号と暗証番号を、環境変数 → 認証ファイル → 手入力 の順に探します。"""
    user, pin = os.environ.get("BUS_ID"), os.environ.get("BUS_PIN")
    if user and pin:
        return user, pin

    path = os.path.expanduser(os.environ.get("BUS_CRED", "~/.school-bus-credentials"))
    if os.path.exists(path):
        lines = [line.strip() for line in open(path, encoding="utf-8") if line.strip()]
        if len(lines) >= 2:
            return lines[0], lines[1]
        print(f"{path} は1行目に職員番号、2行目に暗証番号を書いてください")
        return None, None

    if not sys.stdin.isatty():
        print("職員番号と暗証番号の渡し方が要ります。")
        print("  1) 普通のターミナルから直接流す（暗証番号は画面に出ません）")
        print(f"  2) 認証ファイルを作る: nano {path} && chmod 600 {path}")
        return None, None

    return input("職員番号: ").strip(), getpass("暗証番号: ")


def login():
    user, pin = credentials()
    if not user or not pin:
        return False
    status, body = call("POST", "/api/login", json.dumps({"id": user, "pin": pin}).encode())
    if status != 200:
        print(f"ログインできません: {status}")
        return False
    print(f"{BASE} に {json.loads(body).get('user', {}).get('name', user)} で入りました")
    return True


def fingerprint(state):
    """戻すときに効く部分だけを取り出します。沿線の運行情報や操作の記録は
    人が何もしなくても動くので、変化の判定には入れません。"""
    keep = {k: state.get(k) for k in ("timetable", "programs", "runs", "settings", "stops", "legs")}
    return json.dumps(keep, sort_keys=True, ensure_ascii=False)


def backup(last=None):
    """控えをJSONとCSVで1組落とします。(落とせた数, 指紋) を返します。
    last と同じ中身なら書きません。"""
    os.makedirs(BACKUPS, exist_ok=True)
    stamp = datetime.now().strftime("%m%d-%H%M%S")
    saved = 0

    status, body = call("GET", "/api/exports/store")
    if status == 200:
        # 中身を読めない控えは、戻せない控えです。置く前に確かめます。
        try:
            state = json.loads(body)
            count = len(state.get("timetable") or [])
        except ValueError:
            print("  控えがJSONとして読めません。落としません。")
            return 0, last
        if count == 0:
            print("  元ダイヤの入っていない控えでした。落としません。")
            return 0, last
        mark = fingerprint(state)
        if mark == last:
            return 0, last
        path = os.path.join(BACKUPS, f"store-{stamp}.json")
        open(path, "wb").write(body)
        # 慌てているときに探さなくて済むよう、最新の写しも置きます。
        open(os.path.join(BACKUPS, "store-latest.json"), "wb").write(body)
        runs = len(state.get("runs") or {})
        print(f"  {path}  （{count}便 / 運行の記録 {runs}件 / {len(body)}バイト）")
        saved += 1
        last = mark
    else:
        print(f"  控えを取れません: {status}")
        return 0, last

    status, body = call("GET", "/api/exports/runs")
    if status == 200:
        path = os.path.join(BACKUPS, f"運行記録-{stamp}.csv")
        open(path, "wb").write(body)
        print(f"  {path}  （{len(body)}バイト）")
        saved += 1
    else:
        print(f"  運行記録を取れません: {status}")
    return saved, last


def restore(path):
    """控えを本番へ戻します。いまの内容はそっくり入れ替わります。"""
    body = open(path, "rb").read()
    try:
        state = json.loads(body)
    except ValueError:
        print(f"{path} をJSONとして読めません")
        return 1
    print(f"{path} を戻します（{len(state.get('timetable') or [])}便 / "
          f"催し {len(state.get('programs') or [])}件 / 運行の記録 {len(state.get('runs') or {})}件）")
    print("本番のいまの内容はすべて置き換わります。")
    if sys.stdin.isatty() and input("進めますか [y/N]: ").strip().lower() != "y":
        print("やめました。")
        return 1
    status, result = call("POST", "/api/imports/store", body)
    if status != 200:
        print(f"戻せません: {status} {result.decode()[:200]}")
        return 1
    print(f"戻しました: {result.decode()}")
    return 0


def interval(text):
    """30s、5m、10（分）のような指定を秒に直します。"""
    text = text.strip()
    if text.endswith("s"):
        value = float(text[:-1])
    elif text.endswith("m"):
        value = float(text[:-1]) * 60
    else:
        value = float(text) * 60
    if value < 5:
        raise ValueError(text)
    return value


def main(argv):
    # 見張りを長く回すときはログをファイルへ流すので、行ごとに書き出します。
    # 既定のままだと溜め込まれ、動いているのか止まっているのか分かりません。
    sys.stdout.reconfigure(line_buffering=True)

    if "--restore" in argv:
        index = argv.index("--restore")
        if index + 1 >= len(argv):
            print("--restore のあとに控えのファイルを指定してください")
            return 1
        return (0 if login() else 1) or restore(argv[index + 1])

    seconds = 0
    if "--watch" in argv:
        index = argv.index("--watch")
        text = argv[index + 1] if index + 1 < len(argv) else "10"
        try:
            seconds = interval(text)
        except ValueError:
            print(f"--watch には 30s、5m、10（分）のように指定してください: {text}")
            return 1

    if not login():
        return 1
    if not seconds:
        saved, _ = backup()
        return 0 if saved == 2 else 1

    print(f"{text} おきに見ます。中身が変わった回だけ残します。止めるときは Ctrl+C。")
    last = None
    while True:
        try:
            saved, last = backup(last)
            if saved:
                print(f"  ↑ {datetime.now().strftime('%H:%M:%S')} 時点の控えです")
        except Exception as err:            # 一度失敗しても見張りは続けます
            print(f"  {datetime.now().strftime('%H:%M:%S')} 落とせませんでした: {err}")
        time.sleep(seconds)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
