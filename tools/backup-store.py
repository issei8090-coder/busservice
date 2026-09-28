#!/usr/bin/env python3
"""本番の控えを手元へ落とし、消えたときに戻します。

    python3 tools/backup-store.py                 # 控えを1つ落とす
    python3 tools/backup-store.py --watch 10      # 10分おきに落とし続ける
    python3 tools/backup-store.py --restore <file>  # 控えを本番へ戻す

無料インスタンスでは保存先がコンテナごと作り直されるため、デプロイや
再起動のたびに、当日つけた乗車人数と出発到着が消えます。シェルが無いので
ファイルを置き直すこともできません。当日はこれで控えを取り続けてください。

控えは backups/ に「store-月日-時分.json」と「運行記録-…csv」で溜まります。
JSONはそのまま --restore で戻せます。CSVは人が読む控えです。

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


def backup():
    """控えをJSONとCSVで1組落とします。落とせた数を返します。"""
    os.makedirs(BACKUPS, exist_ok=True)
    stamp = datetime.now().strftime("%m%d-%H%M")
    saved = 0

    status, body = call("GET", "/api/exports/store")
    if status == 200:
        # 中身を読めない控えは、戻せない控えです。置く前に確かめます。
        try:
            state = json.loads(body)
            count = len(state.get("timetable") or [])
        except ValueError:
            print("  控えがJSONとして読めません。落としません。")
            return 0
        if count == 0:
            print("  元ダイヤの入っていない控えでした。落としません。")
            return 0
        path = os.path.join(BACKUPS, f"store-{stamp}.json")
        open(path, "wb").write(body)
        runs = len(state.get("runs") or {})
        print(f"  {path}  （{count}便 / 運行の記録 {runs}件 / {len(body)}バイト）")
        saved += 1
    else:
        print(f"  控えを取れません: {status}")

    status, body = call("GET", "/api/exports/runs")
    if status == 200:
        path = os.path.join(BACKUPS, f"運行記録-{stamp}.csv")
        open(path, "wb").write(body)
        print(f"  {path}  （{len(body)}バイト）")
        saved += 1
    else:
        print(f"  運行記録を取れません: {status}")
    return saved


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


def main(argv):
    if "--restore" in argv:
        index = argv.index("--restore")
        if index + 1 >= len(argv):
            print("--restore のあとに控えのファイルを指定してください")
            return 1
        return (0 if login() else 1) or restore(argv[index + 1])

    minutes = 0
    if "--watch" in argv:
        index = argv.index("--watch")
        minutes = int(argv[index + 1]) if index + 1 < len(argv) else 10

    if not login():
        return 1
    if not minutes:
        return 0 if backup() == 2 else 1

    print(f"{minutes}分おきに落とします。止めるときは Ctrl+C。")
    while True:
        print(datetime.now().strftime("%H:%M:%S"))
        try:
            backup()
        except Exception as err:            # 一度失敗しても見張りは続けます
            print(f"  落とせませんでした: {err}")
        time.sleep(minutes * 60)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
