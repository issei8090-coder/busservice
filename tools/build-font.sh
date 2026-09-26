#!/bin/zsh
# M PLUS 1（可変ウェイト 300–900）を、このアプリで出る文字だけに絞って書き出します。
#
# 全字だと来場者が529KB落とすことになります。実際に使う漢字は475字ほどなので、
# それに「よく使う漢字 上位500」を足した分だけを持たせて276KBにしています。
#
# お知らせや催しに新しい漢字を書き足して、そこだけ書体が変わって見えるときは、
# このスクリプトを回し直してください。data/store.json も読みに行きます。
#
#   ./tools/build-font.sh
#
# 必要なもの: python3（fonttools と brotli を仮想環境に入れます）
set -e
cd "$(dirname "$0")/.."
WORK="${TMPDIR:-/tmp}/mplus1-build"
mkdir -p "$WORK"

if [ ! -x "$WORK/env/bin/pyftsubset" ]; then
  python3 -m venv "$WORK/env"
  "$WORK/env/bin/pip" install --quiet fonttools brotli
fi

if [ ! -f "$WORK/MPLUS1.ttf" ]; then
  curl -sL -o "$WORK/MPLUS1.ttf" \
    "https://github.com/google/fonts/raw/main/ofl/mplus1/MPLUS1%5Bwght%5D.ttf"
fi

if [ ! -f "$WORK/kanjifreq.json" ]; then
  curl -sL -o "$WORK/kanjifreq.json" \
    "https://raw.githubusercontent.com/scriptin/topokanji/master/data/kanji-frequency/aozora.json"
fi

python3 - "$WORK" <<'PY'
import json, os, sys
work = sys.argv[1]
chars = set()
# ラテン・かな・約物・全角形・記号。ここは必ず入れます。
for a, b in [(0x20,0x7E),(0xA0,0xFF),(0x2000,0x206F),(0x3000,0x303F),(0x3040,0x309F),
             (0x30A0,0x30FF),(0xFF00,0xFF6F),(0xFF70,0xFFEF),(0x25A0,0x25FF)]:
    chars.update(chr(c) for c in range(a, b+1))
# アプリが実際に持っている文字
for p in ["web/public.html","web/public.js","web/public.css","main.go","guide.go","data/store.json"]:
    if os.path.exists(p):
        chars.update(open(p, encoding="utf-8", errors="ignore").read())
# あとで書き足すお知らせへの備え
freq = json.load(open(os.path.join(work,"kanjifreq.json"), encoding="utf-8"))
top = [r[0] for r in freq if isinstance(r[0], str) and len(r[0]) == 1
       and 0x4E00 <= ord(r[0]) <= 0x9FFF][:500]
chars.update(top)
chars = {c for c in chars if ord(c) > 0x1F}
open(os.path.join(work,"chars.txt"), "w", encoding="utf-8").write("".join(sorted(chars)))
print(f"  収録 {len(chars)} 字")
PY

mkdir -p web/assets/fonts
"$WORK/env/bin/pyftsubset" "$WORK/MPLUS1.ttf" \
  --text-file="$WORK/chars.txt" \
  --output-file=web/assets/fonts/mplus1.woff2 \
  --flavor=woff2 \
  --layout-features='kern,palt,vert,vrt2,locl,halt,vhal,vpal' \
  --name-IDs='' --no-hinting

echo "  → web/assets/fonts/mplus1.woff2  $(( $(stat -f%z web/assets/fonts/mplus1.woff2) / 1024 )) KB"

# GO BEYOND の書体。その9文字ぶんだけで足ります。
if [ ! -f "$WORK/ArchivoBlack.ttf" ]; then
  curl -sL -o "$WORK/ArchivoBlack.ttf" \
    "https://github.com/google/fonts/raw/main/ofl/archivoblack/ArchivoBlack-Regular.ttf"
fi
"$WORK/env/bin/pyftsubset" "$WORK/ArchivoBlack.ttf" --text="Go Beyond" \
  --output-file=web/assets/fonts/archivo-goBeyond.woff2 --flavor=woff2 \
  --layout-features='kern' --name-IDs='' --no-hinting
echo "  → web/assets/fonts/archivo-goBeyond.woff2  $(stat -f%z web/assets/fonts/archivo-goBeyond.woff2) バイト"
echo "  ※ web/* は go:embed で焼き込まれます。go build し直してください。"
