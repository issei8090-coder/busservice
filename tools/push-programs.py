#!/usr/bin/env python3
"""手元の催しを本番の保存先へ写します。

    python3 tools/push-programs.py --dry-run     # 何が変わるかだけ見る
    python3 tools/push-programs.py               # 実際に登録する

本番の保存先は永続ディスク上にあり、イメージ同梱の data/store.json は
保存先が空のときしか使われません。つまり催しの時間を直してデプロイしても、
本番の進行は入れ替わりません。手元で直したものを本番へ届けるための口が
これです。ダイヤ向けの push-timetable.py と同じ使い方です。

本番から今の進行を読み、data/store.json と見比べて、違う進行だけを
登録し直します。何度流しても同じ結果になります。進行は id で見分けるので、
時間や名前を直しても別物として増えることはありません。

手元に無い進行が本番に残っていたときは、消さずに知らせるだけにします。
当日に本番側で足した進行を巻き込まないためです。消すかどうかは人が決める
ことなので、--delete を付けたときだけ消します。

職員番号と暗証番号は、環境変数 BUS_ID / BUS_PIN、認証ファイル
（既定は ~/.school-bus-credentials の1行目と2行目）、手入力の順に探します。
認証ファイルは chmod 600 にしておいてください。
"""

import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from getpass import getpass

BASE = os.environ.get("BUS_BASE", "https://busservice-mhws.onrender.com")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "data", "store.json")

# 進行を見分ける鍵と、見比べる項目です。保存先が持つ項目を増やしたらここにも足します。
KEY = "id"
FIELDS = ("day", "stage", "title", "start", "end", "details")

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


def call(method, path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(BASE + path, data=body, method=method)
    request.add_header("Content-Type", "application/json")
    try:
        with opener.open(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            return err.code, json.loads(text)
        except ValueError:
            return err.code, {"error": text[:200]}


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
        print("職員番号と暗証番号の渡し方が要ります。どちらかにしてください。")
        print("  1) 普通のターミナルから直接流す（暗証番号は画面に出ません）")
        print(f"  2) 認証ファイルを作る: nano {path} && chmod 600 {path}")
        return None, None

    return input("職員番号: ").strip(), getpass("暗証番号: ")


def label(row):
    end = row.get("end") or "—"
    return f"{row['day']} {row['stage']} {row.get('start') or '—'}-{end} {row['title']}"


def changes(before, after):
    """直った項目だけを「開始 15:00→14:00」の形で並べます。"""
    moved = []
    for field in FIELDS:
        old, new = before.get(field) or "", after.get(field) or ""
        if old == new:
            continue
        name = {"day": "曜日", "stage": "会場", "title": "内容",
                "start": "開始", "end": "終了", "details": "詳細"}[field]
        if field == "details":
            moved.append(name + "を書き換え")
        else:
            moved.append(f"{name} {old or '—'}→{new or '—'}")
    return "、".join(moved)


def main(argv):
    dry_run = "--dry-run" in argv
    allow_delete = "--delete" in argv

    mine = {r[KEY]: r for r in json.load(open(STORE, encoding="utf-8")).get("programs") or []}

    user, pin = credentials()
    if not user or not pin:
        return 1
    status, result = call("POST", "/api/login", {"id": user, "pin": pin})
    if status != 200:
        print(f"ログインできません: {status} {result.get('error', '')}")
        return 1
    print(f"{BASE} に {result.get('user', {}).get('name', user)} で入りました")

    status, result = call("GET", "/api/programs")
    if status != 200:
        print(f"本番の進行を読めません: {status} {result.get('error', '')}")
        return 1
    theirs = {r[KEY]: r for r in result.get("programs") or []}

    def differs(key):
        return any(mine[key].get(f) != theirs[key].get(f) for f in FIELDS)

    added = sorted((k for k in mine if k not in theirs), key=lambda k: label(mine[k]))
    edited = sorted((k for k in mine if k in theirs and differs(k)), key=lambda k: label(mine[k]))
    removed = sorted((k for k in theirs if k not in mine), key=lambda k: label(theirs[k]))

    print(f"手元 {len(mine)}件 / 本番 {len(theirs)}件")
    print(f"追加 {len(added)}件、書き換え {len(edited)}件、本番にだけ残っている進行 {len(removed)}件")
    if not (added or edited or removed):
        print("差はありません。")
        return 0

    for key in added:
        print(f"  追加   {label(mine[key])}")
    for key in edited:
        print(f"  書換え {label(theirs[key])}")
        print(f"         {changes(theirs[key], mine[key])}")
    for key in removed:
        print(f"  余分   {label(theirs[key])}"
              + ("" if allow_delete else "（--delete を付けると消します）"))

    if dry_run:
        print("\n--dry-run なので何も書いていません。")
        return 0

    failed = []
    for key in added + edited:
        status, result = call("PUT", "/api/programs", mine[key])
        if status != 200:
            print(f"  NG  {label(mine[key])}  {status} {result.get('error', '')}")
            failed.append(label(mine[key]))
    if allow_delete:
        for key in removed:
            status, result = call("DELETE", "/api/programs/" + urllib.parse.quote(key))
            if status != 200:
                print(f"  NG  {label(theirs[key])}  {status} {result.get('error', '')}")
                failed.append(label(theirs[key]))

    if failed:
        print(f"\n{len(failed)}件が失敗しました: " + " / ".join(failed))
        print("流し直せば、済んだ分は飛ばして残りだけを直します。")
        return 1

    print("\n登録しました。一般用の件数を読み上げます。")
    for day in ("土曜", "日曜"):
        status, result = call("GET", "/api/public/programs?day=" + urllib.parse.quote(day))
        expected = sum(1 for k in mine if mine[k]["day"] == day)
        got = len(result.get("programs") or [])
        print(f"  {day}: 本番 {got}件 / 手元 {expected}件" + ("" if got == expected else "  ← 合いません"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
