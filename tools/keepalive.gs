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
  const response = UrlFetchApp.fetch(TARGET, { muteHttpExceptions: true, followRedirects: true });
  const status = response.getResponseCode();
  // 200以外でも例外にしません。失敗が続くとトリガーを止められてしまうためです。
  // 記録はスクリプトの実行数で確認できます。
  if (status !== 200) {
    console.warn('keepAlive %s %s', status, response.getContentText().slice(0, 160));
  }
}

function insideWindow(now) {
  const day = Number(Utilities.formatDate(now, TIME_ZONE, 'u')) % 7; // 1が月曜、7が日曜
  const hour = Number(Utilities.formatDate(now, TIME_ZONE, 'H'));
  return WINDOWS.some((window) => window.days.indexOf(day) >= 0 && hour >= window.from && hour < window.to);
}

// 貼り付けたあと、トリガーを待たずに1回だけ確かめるための入口です。
// 実行ログに200が出れば通っています。
function keepAliveOnce() {
  const response = UrlFetchApp.fetch(TARGET, { muteHttpExceptions: true, followRedirects: true });
  console.log('%s %s', response.getResponseCode(), response.getContentText().slice(0, 160));
}
