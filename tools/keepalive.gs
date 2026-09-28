// Renderの無料インスタンスは、外からのアクセスが15分無いと停止します。
// 復帰には30秒から1分かかるため、運転担当が朝に開いた瞬間がその待ち時間になります。
// これを防ぐため、Google Apps Scriptから10分おきに /healthz を叩いて起こしておきます。
//
// 置き方
//   1. script.google.com で新しいプロジェクトを作り、この中身を貼ります。
//   2. TARGET を本番URLに書き換えます。
//   3. 時計のアイコン（トリガー）から、keepAlive を「時間主導型・分ベース・10分おき」で登録します。
//
// 無料枠は月750インスタンス時間です。24時間叩き続けると10月は744時間になり、
// 上限に張り付きます。そのため下のWINDOWSで、人が使う時間帯だけ叩きます。
// 既定は平日8時から20時と土日5時から21時で、月あたり約400時間です。

const TARGET = 'https://busservice-mhws.onrender.com/healthz';
const TIME_ZONE = 'Asia/Tokyo';

// 起こしておく時間帯です。daysは曜日（0が日曜、6が土曜）、fromとtoは時です。
// 復帰に1分かかるので、実際に使い始める30分前から入れておきます。
const WINDOWS = [
  { days: [0, 6], from: 5, to: 21 }, // 運行日
  { days: [1, 2, 3, 4, 5], from: 8, to: 20 }, // ダイヤや案内の準備
];

function keepAlive() {
  if (!insideWindow(new Date())) return;
  ping();
}

function ping() {
  const response = UrlFetchApp.fetch(TARGET, { muteHttpExceptions: true, followRedirects: true });
  const status = response.getResponseCode();
  // 200以外でも例外にしません。失敗が続くとトリガーを止められてしまうためです。
  // 記録はスクリプトの実行数で確認できます。
  if (status !== 200) {
    console.warn('keepAlive %s %s', status, response.getContentText().slice(0, 160));
  }
  return status;
}

// 曜日は「その時刻を東京で見た日付」から出します。曜日を表す書式に頼ると、
// 使えない環境では数字にならず、どの時間帯にも入らないまま何も叩かずに
// 正常終了してしまいます。日付からなら曖昧さがありません。0が日曜です。
function insideWindow(now) {
  const ymd = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(now, TIME_ZONE, 'HH'));
  const day = new Date(ymd + 'T00:00:00Z').getUTCDay();
  if (isNaN(day) || isNaN(hour)) {
    console.warn('keepAlive 時刻を読めません %s %s', ymd, hour);
    return true; // 読めないときは叩きます。止まっているより無駄な方がましです。
  }
  return WINDOWS.some((window) => window.days.indexOf(day) >= 0 && hour >= window.from && hour < window.to);
}

// 貼り付けたあと、トリガーを待たずに確かめるための入口です。手で実行すると、
// いまが叩く時間帯かどうかと、叩いた結果をログに出します。
// トリガーに登録するのは keepAlive です。こちらではありません。
function keepAliveCheck() {
  const now = new Date();
  const inside = insideWindow(now);
  console.log('いまは %s（%s）／叩く時間帯か: %s',
    Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm'),
    ['日', '月', '火', '水', '木', '金', '土'][new Date(Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd') + 'T00:00:00Z').getUTCDay()],
    inside ? 'はい' : 'いいえ');
  console.log('応答: %s', ping());
}
