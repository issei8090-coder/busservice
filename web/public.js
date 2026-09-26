/* スクールバスのご案内。来場者が「いつ学校に着きたいか」から便をお選びします。 */

const tokyo = (options) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", ...options });
const todayISO = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

const state = {
  data: null,
  days: [],
  date: "",
  day: "土曜",
  mode: "",
  stops: { inbound: "", outbound: "" },
  stopTouched: { inbound: false, outbound: false },
  wish: { inbound: "", outbound: "" },
  program: "",
  stage: "",
  table: { direction: "inbound", stop: "" },
  loading: true,
  error: "",
};

const $ = (selector) => document.querySelector(selector);
const sentSignals = new Set();
let signalTimer = null;

/* ---------- 時刻 ---------- */

function clockMinutes(value) {
  if (!value) return null;
  const parts = String(value).split(":");
  if (parts.length !== 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

function clockText(value) {
  const minutes = clockMinutes(value);
  if (minutes === null) return "—";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function nowMinutes() {
  const [hour, minute] = tokyo({ hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).split(":");
  return Number(hour) * 60 + Number(minute);
}

const viewingToday = () => state.date !== "" && state.date === todayISO();

function waitText(minutes) {
  if (minutes <= 0) return "まもなく発車";
  if (minutes < 60) return `あと${minutes}分`;
  const hour = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `あと${hour}時間${rest}分` : `あと${hour}時間`;
}

function dateLabel(iso) {
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3) return iso;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getUTCDay()];
  return `${parts[1]}月${parts[2]}日(${weekday})`;
}

/* ---------- 要素 ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- 乗り場 ---------- */

function stopInfo(name) {
  return (state.data?.stops || []).find((stop) => stop.name === name) || null;
}

// iPhoneとiPadはAppleマップ、それ以外はGoogleマップを開きます。
// 座標が未登録のときは駅名で引きます。以前はここで空を返していたので、
// 乗り場のデータに緯度経度が入るまでリンクが一度も出ませんでした。
function mapURL(stop) {
  if (!stop) return "";
  const label = `${stop.name}駅 ${stop.place || "バス乗り場"}`;
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  const located = Boolean(stop.latitude || stop.longitude);
  if (apple) {
    return located
      ? `https://maps.apple.com/?ll=${stop.latitude},${stop.longitude}&q=${encodeURIComponent(label)}`
      : `https://maps.apple.com/?q=${encodeURIComponent(label)}`;
  }
  return located
    ? `https://www.google.com/maps/search/?api=1&query=${stop.latitude},${stop.longitude}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`;
}

// 運行情報の行き先。lines[].railway の頭（事業者）で引きます。
// 既定は Yahoo!路線情報の関東エリアです。東武東上線・JR川越線・西武新宿線の
// どれもこの1ページに載ることを確かめてあります。
// 各社の公式ページへ変えたいときは、事業者ごとにここへURLを足してください
// （公式サイトはURLが変わりやすいので、足すときは必ず開いて確かめてください）。
const RAIL_INFO_DEFAULT = "https://transit.yahoo.co.jp/diainfo/area/4";
const RAIL_INFO = {
  jreast: "https://traininfo.jreast.co.jp/train_info/kanto.aspx",
};

function lineInfoURL(lineName) {
  const found = (state.data?.lines || []).find((line) => line.name === lineName);
  const operator = String(found?.railway || "").split(".")[0];
  return RAIL_INFO[operator] || RAIL_INFO_DEFAULT;
}

// その乗り場に、バスの発車までに着く電車を調べます。
// 到着時刻での検索ができるのは乗換案内なので、地図ではなくそちらへ渡します。
function trainToStopURL(stop, departure) {
  if (!stop) return "";
  const minutes = clockMinutes(departure);
  if (!Number.isFinite(minutes)) return "";
  const by = Math.max(0, minutes - (stop.walkMinutes || 0));
  const parts = String(state.date || "").split("-");
  const when = parts.length === 3
    ? `&y=${parts[0]}&m=${parts[1]}&d=${parts[2]}`
    : "";
  // type=4 は「到着時刻で検索」です。
  return `https://transit.yahoo.co.jp/search/result?to=${encodeURIComponent(`${stop.name}駅`)}`
    + `${when}&hh=${String(Math.floor(by / 60)).padStart(2, "0")}&m1=${Math.floor((by % 60) / 10)}&m2=${(by % 60) % 10}&type=4`;
}

// 帰りの便。その乗り場に着いたあと、そこから乗れる電車を調べます。
// バスを降りてから改札へ入るぶんを足して、出発時刻で引きます。行きの裏返しです。
function trainFromStopURL(stop, arrival) {
  if (!stop) return "";
  const minutes = clockMinutes(arrival);
  if (!Number.isFinite(minutes)) return "";
  // 日をまたぐ組み方はしません。遅い便でもその日のうちで引きます。
  const from = Math.min(23 * 60 + 59, minutes + (stop.walkMinutes || 0));
  const parts = String(state.date || "").split("-");
  const when = parts.length === 3
    ? `&y=${parts[0]}&m=${parts[1]}&d=${parts[2]}`
    : "";
  // type=1 は「出発時刻で検索」です。
  return `https://transit.yahoo.co.jp/search/result?from=${encodeURIComponent(`${stop.name}駅`)}`
    + `${when}&hh=${String(Math.floor(from / 60)).padStart(2, "0")}&m1=${Math.floor((from % 60) / 10)}&m2=${(from % 60) % 10}&type=1`;
}

function mapButton(stop) {
  const url = mapURL(stop);
  if (!url) return null;
  const link = document.createElement("a");
  link.className = "map-button";
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  link.append(document.createTextNode("地図で乗り場を開く"));
  return link;
}

/* ---------- 便の組み立て ---------- */

// direction inbound は駅から学校へ、outbound は学校から駅へ向かう便です。
function journeys(direction, stopName) {
  // 1つの便が同じ駅に2回停まることがあります。
  // 学校から帰る便はいちばん早く着く停車、学校へ行く便はいちばん遅く出る停車を採用します。
  const best = new Map();
  (state.data?.trips || []).forEach((trip) => {
    (trip.points || []).forEach((point) => {
      if (stopName && point.stop !== stopName) return;
      let item = null;
      if (direction === "inbound") {
        if (!point.canBoard) return;
        item = { trip, stop: point.stop, departure: point.departure, arrival: trip.schoolArrival, fromLabel: point.stop, toLabel: "学校" };
      } else {
        if (!point.canAlight) return;
        item = { trip, stop: point.stop, departure: trip.schoolDeparture, arrival: point.arrival, fromLabel: "学校", toLabel: point.stop };
      }
      if (clockMinutes(item.departure) === null || clockMinutes(item.arrival) === null) return;
      const key = `${trip.operationNo}|${trip.columnNo}|${point.stop}`;
      const current = best.get(key);
      if (!current) {
        best.set(key, item);
        return;
      }
      const better = direction === "inbound"
        ? clockMinutes(item.departure) > clockMinutes(current.departure)
        : clockMinutes(item.arrival) < clockMinutes(current.arrival);
      if (better) best.set(key, item);
    });
  });
  return [...best.values()].sort((a, b) => clockMinutes(a.departure) - clockMinutes(b.departure));
}

function running(item) {
  return item.trip.status !== "cancelled";
}

// 希望時刻にいちばん合う便を選びます。
// 学校へ行く便は「着きたい時刻までに着く便」、帰る便は「出たい時刻以降の便」です。
function chooseJourney(direction, all, wish) {
  const active = all.filter(running);
  if (!active.length) return { main: null, rest: [] };
  const limit = clockMinutes(wish);
  const from = viewingToday() ? nowMinutes() : null;
  const departable = from === null ? active : active.filter((item) => clockMinutes(item.departure) >= from);

  if (limit === null) {
    return { main: departable[0] || null, rest: departable.slice(1, 4) };
  }
  if (direction === "inbound") {
    const inTime = departable.filter((item) => clockMinutes(item.arrival) !== null && clockMinutes(item.arrival) <= limit);
    if (inTime.length) {
      const main = inTime[inTime.length - 1];
      const later = departable.filter((item) => clockMinutes(item.departure) > clockMinutes(main.departure));
      return { main, rest: later.slice(0, 3), late: false };
    }
    const first = departable[0] || null;
    return { main: first, rest: departable.slice(1, 4), late: Boolean(first) };
  }
  const after = departable.filter((item) => clockMinutes(item.departure) >= limit);
  if (after.length) return { main: after[0], rest: after.slice(1, 4) };
  const last = departable[departable.length - 1] || null;
  return { main: last, rest: [], afterLast: Boolean(last) };
}

function lastJourney(direction, stopName) {
  const all = journeys(direction, stopName).filter(running);
  return all.length ? all[all.length - 1] : null;
}

/* ---------- 混雑予測 ---------- */

const lineStatusWords = {
  normal: "平常運転",
  trouble: "遅れ・見合わせ",
  info: "お知らせ",
  unknown: "情報なし",
};

// 駅の表示板と同じ記号。色だけに頼らず、形でも具合が分かるようにします。
const lineStatusMarks = {
  normal: "◯",
  trouble: "✕",
  info: "△",
  unknown: "－",
};

const crowdWords = {
  calm: "ゆったりご乗車いただけます",
  crowded: "混み合う見込みです",
  packed: "大変混み合う見込みです",
};

function crowdFor(direction, stopName, clock) {
  const minutes = clockMinutes(clock);
  if (minutes === null) return null;
  const windows = (state.data?.crowd || []).filter((item) => {
    if (item.direction !== "both" && item.direction !== direction) return false;
    if (item.stop && stopName && item.stop !== stopName) return false;
    const start = clockMinutes(item.start);
    const end = clockMinutes(item.end);
    if (start === null || end === null) return false;
    return minutes >= start && minutes < end;
  });
  if (!windows.length) return null;
  return windows.sort((a, b) => b.priority - a.priority)[0];
}

/* ---------- 検索の記録 ---------- */

// 希望時刻を匿名で数えます。混雑予測に使います。個人を特定する情報は送りません。
function sendSignal(direction, stopName, clock) {
  if (!clock || !stopName) return;
  const key = `${state.date}|${direction}|${stopName}|${clock}`;
  if (sentSignals.has(key)) return;
  clearTimeout(signalTimer);
  signalTimer = setTimeout(() => {
    sentSignals.add(key);
    fetch("/api/public/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: state.date, direction, stop: stopName, time: clock }),
      keepalive: true,
    }).catch(() => {});
  }, 900);
}

/* ---------- 画面の部品 ---------- */

// 路線の色。同じ路線はアプリのどこでも同じ色にします。色が路線を表す約束です。
// 各社の公式なラインカラーが分かったら、ここへ書き足してください。
// どの色も、白文字を載せても、白い板の上に置いても 4.5:1 を保ちます。
const LINE_COLORS = {
  東武東上線: ["#0b7d88", "#064f63"],
  JR川越線: ["#2f6bd8", "#1d3f95"],
  西武新宿線: ["#c0356b", "#8a2350"],
};
const LINE_FALLBACK = [
  ["#7a3fb8", "#4f2680"],
  ["#9a6b05", "#6b4802"],
  ["#0b7d88", "#064f63"],
];

function lineColor(lineName) {
  if (LINE_COLORS[lineName]) return LINE_COLORS[lineName];
  const names = [...new Set((state.data?.stops || []).map((item) => item.line).filter(Boolean))];
  const index = Math.max(0, names.indexOf(lineName));
  return LINE_FALLBACK[index % LINE_FALLBACK.length];
}

function paintLine(node, lineName) {
  const [light, deep] = lineColor(lineName);
  node.style.setProperty("--sc", light);
  node.style.setProperty("--sc-deep", deep);
}

function stopPicker(direction) {
  const selected = state.stops[direction];
  const box = element("div", "picker stops");
  (state.data?.stops || []).forEach((stop) => {
    const button = element("button");
    button.type = "button";
    button.dataset.stop = stop.name;
    button.dataset.direction = direction;
    button.setAttribute("aria-pressed", String(selected === stop.name));
    paintLine(button, stop.line);
    button.append(document.createTextNode(stop.name));
    if (stop.line) button.append(element("small", null, stop.line));
    box.append(button);
  });
  return box;
}

function timeRow(direction) {
  const row = element("div", "time-row");
  const input = document.createElement("input");
  input.type = "time";
  input.dataset.wish = direction;
  input.value = state.wish[direction] || "";
  input.setAttribute("aria-label", direction === "inbound" ? "学校に着きたい時刻" : "学校を出たい時刻");
  row.append(input);
  if (state.wish[direction]) {
    const clear = element("button", "link", "指定をやめる");
    clear.type = "button";
    clear.dataset.clearWish = direction;
    row.append(clear);
  } else {
    row.append(element("span", "result-note", viewingToday() ? "指定しない場合は、今から乗れる便をご案内します" : "指定しない場合は、始発からご案内します"));
  }
  return row;
}

function field(title, node) {
  const box = element("div", "field");
  box.append(element("h3", null, title));
  box.append(node);
  return box;
}

// 時刻を1文字ずつの要素にします。順番に立ち上げるためです。
function timeDisplay(text) {
  const strong = element("strong", "num");
  [...text].forEach((character, index) => {
    const cell = element("i", null, character);
    cell.style.setProperty("--i", String(index));
    strong.append(cell);
  });
  return strong;
}

function resultCard(direction, journey, options = {}) {
  const card = element("div", "result");
  const main = element("div", "result-main");
  const stop = stopInfo(journey.stop);

  main.append(element("p", "result-kicker", direction === "inbound"
    ? `${journey.stop}${stop?.line ? `（${stop.line}）` : ""} から 学校へ`
    : `学校から ${journey.stop}${stop?.line ? `（${stop.line}）` : ""} へ`));

  const time = element("div", "result-time");
  time.append(timeDisplay(clockText(journey.departure)));
  time.append(element("span", null, direction === "inbound" ? `${journey.stop} 発` : "学校 発"));
  if (viewingToday()) {
    const remaining = clockMinutes(journey.departure) - nowMinutes();
    if (remaining >= 0) time.append(element("span", `result-wait${remaining <= 15 ? " soon" : ""}`, waitText(remaining)));
  }
  main.append(time);

  const arrow = element("p", "result-arrow");
  arrow.append(document.createTextNode(`${journey.toLabel} `));
  const arrival = document.createElement("b");
  arrival.className = "num";
  arrival.textContent = clockText(journey.arrival);
  arrow.append(arrival, document.createTextNode(" 着"));
  main.append(arrow);

  const duration = clockMinutes(journey.arrival) - clockMinutes(journey.departure);
  if (Number.isFinite(duration) && duration > 0) {
    main.append(element("p", "result-note", `所要およそ${duration}分。道路の状況により前後します。`));
  }
  if (options.late) {
    main.append(element("p", "result-note", "ご希望の時刻までに着く便がないため、いちばん早い便をご案内しています。"));
  }
  if (options.gap && options.gap >= 30) {
    const wait = options.gap >= 60
      ? `${Math.floor(options.gap / 60)}時間${options.gap % 60 ? `${options.gap % 60}分` : ""}`
      : `${options.gap}分`;
    main.append(element("p", "result-note", direction === "inbound"
      ? `ご希望の時刻より${wait}早く学校に着きます。この前後に便はありません。`
      : `ご希望の時刻から${wait}後の発車です。この間に便はありません。`));
  }
  if (options.afterLast) {
    main.append(element("p", "result-note", "ご希望の時刻より後の便がないため、最終の便をご案内しています。"));
  }
  if (journey.trip.delayMinutes) {
    main.append(element("p", "result-note", `この便はおよそ${journey.trip.delayMinutes}分遅れています。`));
  }
  // 便の右に、確かめたいことを並べます。どれも外のページへ渡します。
  // 行きは、乗り場の場所、路線の具合、その便に間に合う電車。
  // 帰りは、路線の具合と、着いた駅から乗れる電車。
  // 路線の具合を電車より先に置くのは行きと同じです。乱れていれば、
  // どの電車かより先にそれを知りたいためです。
  // 地図は帰りには出しません。乗るのは学校で、駅の乗り場は降りる場所です。
  if (stop) {
    const links = element("div", "result-links");
    const add = (href, kind, label, note) => {
      if (!href) return;
      const link = document.createElement("a");
      link.className = "result-link";
      link.dataset.kind = kind;
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener";
      link.append(element("strong", null, label));
      if (note) link.append(element("span", null, note));
      links.append(link);
    };
    const addLine = () => {
      if (!stop.line) return;
      const status = (state.data?.lines || []).find((line) => line.name === stop.line)?.status;
      add(lineInfoURL(stop.line), "line", `${stop.line}の運行情報`, lineStatusWords[status] || "");
    };
    if (direction === "inbound") {
      add(mapURL(stop), "map", "乗り場の地図", `${stop.name}駅`);
      addLine();
      add(trainToStopURL(stop, journey.departure), "train", "この便に間に合う電車",
        `${clockText(journey.departure)}までに${stop.name}駅へ`);
    } else {
      addLine();
      add(trainFromStopURL(stop, journey.arrival), "train", "この便から乗れる電車",
        `${clockText(journey.arrival)}に${stop.name}駅着`);
    }
    if (links.childElementCount) main.append(links);
  }

  card.append(main);

  // 着いたあとに見られる催し。何時に着くかが分かった直後が、いちばん知りたいときです。
  if (direction === "inbound" && options.withPrograms) {
    const arrival = clockMinutes(journey.arrival);
    const later = programsForDay().filter((item) => {
      const end = clockMinutes(item.end) ?? clockMinutes(item.start);
      return end !== null && arrival !== null && end >= arrival;
    });
    const box = element("div", "result-after");
    const head = element("h4", null, `${clockText(journey.arrival)}に着いてから見られる催し`);
    box.append(head);
    if (!later.length) {
      box.append(element("p", "empty", "この時刻より後に始まる催しはありません。"));
    } else {
      const list = element("div", "after-list");
      later.slice(0, 4).forEach((program) => {
        const row = programRow(program);
        // 押すと催しの入口へ渡し、その催しに間に合う便を出します。
        row.dataset.jumpProgram = program.id;
        list.append(row);
      });
      box.append(list);
      if (later.length > 4) {
        box.append(element("p", "after-more", `ほかに${later.length - 4}件あります。「催しに合わせて調べる」でご覧ください。`));
      }
    }
    card.append(box);
  }

  if (direction === "inbound" && stop) {
    const place = element("div", "result-place");
    place.append(element("strong", null, `乗り場　${stop.place || `${stop.name}駅`}`));
    if (stop.landmark) place.append(element("p", null, stop.landmark));
    if (stop.walkMinutes) place.append(element("p", "walk", `改札からおよそ徒歩${stop.walkMinutes}分です。発車の5分前までにお越しください。`));
    // 地図は便の右の「乗り場の地図」から開きます。同じ行き先を二度置きません。
    card.append(place);
  }

  // 乗り降りする駅の路線に遅れがあれば、ここにも出します。
  const line = (state.data?.lines || []).find((item) => stop && item.name === stop.line && item.status === "trouble");
  if (line) {
    const box = element("div", "crowd");
    box.dataset.level = "packed";
    const text = document.createElement("span");
    text.append(element("b", null, `${line.name}に遅れが出ています`));
    if (line.text) text.append(document.createTextNode(`　${line.text}`));
    box.append(text);
    card.append(box);
  }

  const crowd = crowdFor(direction, journey.stop, journey.departure);
  if (crowd) {
    const box = element("div", "crowd");
    box.dataset.level = crowd.level;
    const text = document.createElement("span");
    const label = document.createElement("b");
    label.textContent = crowdWords[crowd.level] || "";
    text.append(label);
    if (crowd.note) text.append(document.createTextNode(`　${crowd.note}`));
    box.append(text);
    card.append(box);
  }
  return card;
}

function followList(direction, rest) {
  if (!rest.length) return null;
  const box = document.createElement("div");
  box.append(element("p", "follow-head", "この次の便"));
  const list = element("ul", "follow");
  rest.forEach((item) => {
    const row = document.createElement("li");
    const time = document.createElement("b");
    time.className = "num";
    time.textContent = clockText(item.departure);
    row.append(time);
    row.append(element("span", null, direction === "inbound"
      ? `${item.stop} 発　学校 ${clockText(item.arrival)} 着`
      : `学校 発　${item.stop} ${clockText(item.arrival)} 着`));
    list.append(row);
  });
  box.append(list);
  return box;
}

/* ---------- 学校へ行く・学校から帰る ---------- */

function renderJourneyBody(direction, container) {
  container.replaceChildren();
  const stopName = state.stops[direction];
  container.append(field(
    direction === "inbound" ? "どの駅からお乗りになりますか" : "どの駅へお帰りになりますか",
    stopPicker(direction),
  ));
  if (direction === "outbound" && stopName && stopName === state.stops.inbound && !state.stopTouched.outbound) {
    container.lastChild.append(element("p", "result-note", "行きと同じ駅を選んでいます。別の駅からお帰りの場合は選び直してください。"));
  }
  if (!stopName) {
    container.append(element("p", "empty", "まず駅をお選びください。"));
    return;
  }

  container.append(field(
    direction === "inbound" ? "何時ごろ学校に着きたいですか" : "何時ごろ学校を出発したいですか",
    timeRow(direction),
  ));

  const all = journeys(direction, stopName);
  if (!all.length) {
    container.append(element("p", "empty", direction === "inbound"
      ? `${stopName}から学校へ向かう便は、この日は運行していません。`
      : `学校から${stopName}へ向かう便は、この日は運行していません。`));
    return;
  }
  const picked = chooseJourney(direction, all, state.wish[direction]);
  if (!picked.main) {
    container.append(element("p", "empty", viewingToday()
      ? "本日ご乗車いただける便は終了しました。"
      : "ご案内できる便がありません。"));
  } else {
    const wish = clockMinutes(state.wish[direction]);
    let gap = 0;
    if (wish !== null && !picked.late) {
      gap = direction === "inbound"
        ? wish - clockMinutes(picked.main.arrival)
        : clockMinutes(picked.main.departure) - wish;
    }
    container.append(resultCard(direction, picked.main,
      { late: picked.late, afterLast: picked.afterLast, gap, withPrograms: direction === "inbound" }));
    const follow = followList(direction, picked.rest);
    if (follow) container.append(follow);
  }

  if (direction === "outbound") {
    const last = lastJourney("outbound", stopName);
    if (last) {
      const box = element("div", "last-bus");
      box.append(element("strong", null, "最終便のご案内"));
      const text = element("p");
      const time = document.createElement("b");
      time.textContent = clockText(last.departure);
      text.append(document.createTextNode("学校発 "), time, document.createTextNode(`　${last.stop} ${clockText(last.arrival)} 着`));
      box.append(text);
      box.append(element("p", null, "この便を過ぎると、スクールバスでのお帰りはできません。"));
      container.append(box);
    }
  }
  sendSignal(direction, stopName, state.wish[direction] || clockText(picked.main ? picked.main.departure : ""));
}

/* ---------- 時刻表 ---------- */

function renderTimetableBody(container) {
  container.replaceChildren();

  const tools = element("div", "table-tools");
  [["inbound", "学校へ行く便"], ["outbound", "学校から帰る便"]].forEach(([value, label]) => {
    const button = element("button", null, label);
    button.type = "button";
    button.dataset.tableDirection = value;
    button.setAttribute("aria-pressed", String(state.table.direction === value));
    tools.append(button);
  });
  container.append(tools);

  const picker = element("div", "picker stops");
  const all = element("button", null, "すべての駅");
  all.type = "button";
  all.dataset.tableStop = "";
  all.setAttribute("aria-pressed", String(state.table.stop === ""));
  picker.append(all);
  (state.data?.stops || []).forEach((stop) => {
    const button = element("button");
    button.type = "button";
    button.dataset.tableStop = stop.name;
    button.setAttribute("aria-pressed", String(state.table.stop === stop.name));
    paintLine(button, stop.line);
    button.append(document.createTextNode(stop.name));
    if (stop.line) button.append(element("small", null, stop.line));
    picker.append(button);
  });
  container.append(field("駅で絞り込む", picker));

  const list = journeys(state.table.direction, state.table.stop);
  if (!list.length) {
    container.append(element("p", "empty", "この日に運行する便はありません。"));
    return;
  }
  const table = element("div", "timetable");
  const limit = viewingToday() ? nowMinutes() : null;
  let currentHour = null;
  let nextMarked = false;
  list.forEach((item) => {
    const minutes = clockMinutes(item.departure);
    const hour = Math.floor(minutes / 60);
    if (hour !== currentHour) {
      currentHour = hour;
      const head = element("div", "hour-head");
      head.append(element("span", "num", `${hour}時台`));
      head.append(element("span", null, `${list.filter((entry) => Math.floor(clockMinutes(entry.departure) / 60) === hour).length}便`));
      table.append(head);
    }
    const row = element("div", "trip");
    const past = limit !== null && minutes < limit;
    const isNext = limit !== null && !past && !nextMarked && running(item);
    if (isNext) nextMarked = true;
    if (past) row.classList.add("is-past");
    if (isNext) row.classList.add("is-next");
    row.append(element("div", "trip-time num", clockText(item.departure)));
    const body = element("div", "trip-body");
    body.append(element("strong", null, state.table.direction === "inbound"
      ? `${item.stop} 発　学校ゆき`
      : `学校 発　${item.stop}ゆき`));
    body.append(element("span", null, `${item.toLabel} ${clockText(item.arrival)} 着`));
    row.append(body);
    if (!running(item)) row.append(element("span", "trip-state stop", "運休"));
    else if (item.trip.delayMinutes) row.append(element("span", "trip-state warn", `約${item.trip.delayMinutes}分遅れ`));
    else if (isNext) row.append(element("span", "trip-state", "次の便"));
    table.append(row);
  });
  container.append(table);
}

/* ---------- 乗り場をさがす ---------- */

function renderStopsBody(container) {
  container.replaceChildren();
  const stops = state.data?.stops || [];
  if (!stops.length) {
    container.append(element("p", "empty", "乗り場の情報を準備しています。"));
    return;
  }
  const list = element("div", "stop-list");
  stops.forEach((stop) => {
    const item = element("div", "stop-item");
    paintLine(item, stop.line);
    item.append(element("h3", null, stop.name));
    if (stop.line) item.append(element("p", "line-name", stop.line));
    item.append(element("p", "stop-place", stop.place || "バス乗り場"));
    if (stop.landmark) item.append(element("p", null, stop.landmark));
    if (stop.walkMinutes) item.append(element("p", "walk", `改札からおよそ徒歩${stop.walkMinutes}分です。`));
    const button = mapButton(stop);
    if (button) item.append(button);
    else item.append(element("p", "walk", "地図は準備中です。"));
    list.append(item);
  });
  container.append(list);
}

/* ---------- 催しに合わせる ---------- */

// 催しに間に合わせるための余裕（分）。
// バスを降りてから会場へ歩く時間があるので、開始と同時に着く便は勧めません。
const PROGRAM_MARGIN = 10;

// その日の催しを、時刻順に。ステージをまたいで並べるのは、
// 来場者が見たいのは「何時に何があるか」であって、舞台の区分ではないためです。
function programsForDay() {
  return (state.data?.programs || [])
    .filter((item) => !item.day || item.day === state.day)
    .slice()
    .sort((a, b) => (clockMinutes(a.start) ?? 0) - (clockMinutes(b.start) ?? 0));
}

function stageNames(items) {
  return [...new Set(items.map((item) => item.stage).filter(Boolean))];
}

// 今日ぶんを見ているときだけ、開催中・終了が分かるようにします。
function programPhase(program) {
  if (!viewingToday()) return "";
  const now = nowMinutes();
  const from = clockMinutes(program.start);
  const to = clockMinutes(program.end) ?? from;
  if (from === null) return "";
  if (now >= from && now <= to) return "now";
  if (now > to) return "done";
  if (from - now <= 30) return "soon";
  return "";
}

const PHASE_WORDS = { now: "開催中", soon: "まもなく", done: "終了" };

function programRow(program, { pressed = false } = {}) {
  const button = element("button", "program");
  button.type = "button";
  button.dataset.program = program.id;
  const phase = programPhase(program);
  if (phase) button.dataset.phase = phase;
  button.setAttribute("aria-pressed", String(pressed));

  const when = element("span", "p-when");
  when.append(element("b", "num", clockText(program.start)));
  if (program.end) when.append(element("i", "num", clockText(program.end)));
  button.append(when);

  const body = element("span", "p-body");
  body.append(element("strong", null, program.title));
  const meta = element("span", "p-meta");
  if (program.stage) meta.append(element("span", "p-stage", program.stage));
  if (phase) meta.append(element("span", "p-phase", PHASE_WORDS[phase]));
  const span = programLength(program);
  if (span) meta.append(element("span", "p-span", span));
  body.append(meta);
  button.append(body);
  return button;
}

function programLength(program) {
  const from = clockMinutes(program.start);
  const to = clockMinutes(program.end);
  if (from === null || to === null || to <= from) return "";
  const minutes = to - from;
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ""}`
    : `${minutes}分`;
}

function renderEventBody(container) {
  container.replaceChildren();
  const all = programsForDay();
  if (!all.length) {
    container.append(element("p", "empty", "この日の催しは準備中です。"));
    return;
  }

  // ステージで絞れるようにします。2つ以上あるときだけ出します。
  const stages = stageNames(all);
  if (stages.length > 1) {
    const picker = element("div", "picker stagebar");
    const add = (value, label) => {
      const button = element("button", null, label);
      button.type = "button";
      button.dataset.stage = value;
      button.setAttribute("aria-pressed", String(state.stage === value));
      picker.append(button);
    };
    add("", "すべて");
    stages.forEach((stage) => add(stage, stage));
    container.append(field("どの舞台をご覧になりますか", picker));
  }

  const shown = state.stage ? all.filter((item) => item.stage === state.stage) : all;
  const list = element("div", "program-list");
  if (!shown.length) {
    list.append(element("p", "empty", "この舞台の催しはありません。"));
  }
  shown.forEach((program) => list.append(programRow(program, { pressed: state.program === program.id })));
  container.append(field(`この日の催し　${shown.length}件`, list));

  const program = all.find((item) => item.id === state.program);
  if (!program) {
    container.append(element("p", "empty", "催しをお選びになると、間に合う便をご案内します。"));
    return;
  }

  // 選んだ催しの詳しい内容。出演者や雨天時の扱いが書かれていることがあります。
  const chosen = element("div", "program-detail");
  chosen.append(element("strong", null, program.title));
  const line = [program.stage, `${clockText(program.start)}${program.end ? `〜${clockText(program.end)}` : ""}`]
    .filter(Boolean).join("　");
  chosen.append(element("p", "p-line", line));
  if (program.details) chosen.append(element("p", "p-details", program.details));
  container.append(chosen);

  container.append(field("どの駅からお越しになりますか", stopPicker("inbound")));
  if (!state.stops.inbound) {
    container.append(element("p", "empty", "駅をお選びください。"));
    return;
  }

  const goingAll = journeys("inbound", state.stops.inbound).filter(running);
  const arriveBy = clockMinutes(program.start);
  const arrived = (item) => clockMinutes(item.arrival);
  // 余裕をもって着く便。開始と同時に着く便はここに入りません。
  const comfy = goingAll.filter((item) => arrived(item) !== null && arrived(item) <= arriveBy - PROGRAM_MARGIN);
  // 間に合いはするが、ぎりぎりの便。
  const tight = goingAll.filter((item) => arrived(item) !== null && arrived(item) <= arriveBy);
  const goBox = element("div", "field");
  goBox.append(element("h3", null, "この便で開始に間に合います"));
  if (comfy.length) {
    const pick = comfy[comfy.length - 1];
    goBox.append(resultCard("inbound", pick));
    const spare = arriveBy - arrived(pick);
    goBox.append(element("p", "result-note", `開始の${spare}分前に着きます。`));
  } else if (tight.length) {
    // 余裕のある便が無いときだけ、ぎりぎりの便を出します。何が起きるかを先に書きます。
    const pick = tight[tight.length - 1];
    const spare = arriveBy - arrived(pick);
    goBox.append(element("p", "result-note", spare > 0
      ? `余裕をもって着く便がありません。この便は開始の${spare}分前に着きます。`
      : "余裕をもって着く便がありません。この便は開始と同じ時刻に着きます。"));
    goBox.append(resultCard("inbound", pick));
  } else {
    goBox.append(element("p", "empty", "開始までに学校へ着く便がありません。"));
  }
  container.append(goBox);

  if (state.stops.inbound) sendSignal("inbound", state.stops.inbound, clockText(program.start));
}

/* ---------- 全体 ---------- */

// 序の題字。縦に組むので、字数を渡して高さの上限を決めさせます。
// 案内設定で別の名前を登録したときはそちらを出します。
function setFestivalTitle(name) {
  const heading = document.querySelector(".pro-fes");
  if (!heading) return;
  if (!heading.dataset.name) heading.dataset.name = heading.textContent.trim();
  const title = (name || heading.dataset.name || "").trim();
  if (!title) return;
  const characters = [...title];
  heading.style.setProperty("--chars", String(characters.length));
  if (heading.children.length === characters.length && heading.textContent === title) return;
  heading.replaceChildren();
  characters.forEach((character, index) => {
    const cell = element("span");
    cell.style.setProperty("--i", String(index));
    // 1字を3枚に分けます。外が退場の変形、中が開幕の動き、内が色です。
    // 色は動かない箱に掛けます。理由は public.css の .pro-fes span b に書いてあります。
    const move = element("i");
    move.append(element("b", null, character));
    cell.append(move);
    heading.append(cell);
  });
}

// 曜日を1字にします。「土曜」→「土」。
const shortDay = (day) => String(day || "").replace(/曜日?$/, "");

// 開催日に添える一言。日付をそのまま鍵にします。
// 序の日付と、ヒーローの日付選びの両方に出ます。増やすときはここへ1行足してください。
const DAY_NOTES = {
  "2026-10-04": "後夜祭 花火",
};

// 題字の右に、開催日を縦で添えます。
// 右が空いたままだと、柿色の面に題字がぽつんと残って殺風景になります。
// 日付は来場者がいちばん先に確かめることなので、飾りではなく案内として置きます。
function renderPrologueDays() {
  const box = document.querySelector("#proDays");
  if (!box) return;
  const days = state.days || [];
  box.replaceChildren();
  box.hidden = days.length === 0;
  days.forEach((item, index) => {
    const row = element("b", "pd-day");
    row.style.setProperty("--i", String(index));
    const parts = String(item.date || "").split("-").map(Number);
    if (parts.length === 3) {
      const line = element("span", "pd-line");
      line.append(element("i", "pd-md", `${parts[1]}.${parts[2]}`));
      line.append(element("span", "pd-dow", `（${shortDay(item.day)}）`));
      row.append(line);
    } else {
      row.append(element("i", "pd-md", item.day || item.label || ""));
    }
    const note = DAY_NOTES[item.date];
    if (note) row.append(element("span", "pd-note", note));
    box.append(row);
  });
}

// 管理から差し替えた写真を反映します。設定が無ければ同梱の既定のままです。
function applyPhotos() {
  const settings = state.data?.settings || {};
  const hero = document.querySelector("#heroPhoto");
  if (hero && settings.heroPhoto) hero.style.backgroundImage = `url("${settings.heroPhoto}")`;
  if (settings.leapPhoto) {
    document.querySelectorAll(".pro-form .leap").forEach((node) => {
      if (node.getAttribute("src") !== settings.leapPhoto) node.setAttribute("src", settings.leapPhoto);
    });
  }
}

function renderHeader() {
  setFestivalTitle((state.data?.settings || {}).eventName);
  applyPhotos();
  renderChairWord();
  renderPrologueDays();

  // 入口のタグには、その日に実際にある数を出します。
  // 数と単位を分けて持ちます。組版で数字だけを大きく見せるためです。
  const tally = (list, unit) => (list || []).length ? { n: (list || []).length, unit } : null;
  const counts = {
    trips: tally(state.data?.trips, "便"),
    stops: tally(state.data?.stops, "駅"),
    programs: tally(state.data?.programs, "件"),
  };
  // 数と単位は分けて組みます。数字だけを大きく見せるためです。
  document.querySelectorAll(".count[data-count]").forEach((slot) => {
    const found = counts[slot.dataset.count];
    slot.replaceChildren();
    if (!found) return;
    slot.append(element("b", "num", String(found.n)));
    slot.append(element("i", "unit", found.unit));
  });

  const bar = $("#lineBar");
  const lines = state.data?.lines || [];
  bar.replaceChildren();
  bar.hidden = lines.length === 0;
  if (lines.length) {
    const inner = element("div", "inner");
    inner.append(element("h2", "line-head", "電車の運行状況"));
    // 1本でも乱れていれば、枠ごと目立たせます。
    if (lines.some((line) => line.status === "trouble")) bar.dataset.alert = "1";
    else delete bar.dataset.alert;

    // 乗り場ごとにまとめます。来場者は自分の乗る駅から見るためです。
    const groups = [];
    lines.forEach((line) => {
      const key = line.group || "";
      let group = groups.find((item) => item.key === key);
      if (!group) groups.push((group = { key, items: [] }));
      group.items.push(line);
    });

    groups.forEach((group) => {
      const box = element("div", "line-group");
      if (group.key) {
        const stop = (state.data?.stops || []).find((item) => item.name === group.key);
        const head = element("h3", "line-group-head", group.key);
        if (stop?.line) head.append(element("span", null, stop.line));
        box.append(head);
      }
      group.items.forEach((line) => {
        const item = element("span", "line-item");
        item.dataset.status = line.status;
        // 路線記章。路線名がすぐ隣にあるので、読み上げには渡しません。
        if (line.badge) {
          const badge = document.createElement("img");
          badge.className = "line-badge";
          badge.src = `/assets/lines/${line.badge}`;
          badge.alt = "";
          badge.loading = "lazy";
          badge.setAttribute("aria-hidden", "true");
          item.append(badge);
        }
        item.append(element("b", "line-name", line.name));
        // 記号は言葉の言い換えなので、読み上げには渡しません。
        const mark = element("i", "line-mark", lineStatusMarks[line.status] || "－");
        mark.setAttribute("aria-hidden", "true");
        item.append(mark);
        item.append(element("span", "line-state", lineStatusWords[line.status] || "情報なし"));
        box.append(item);
      });
      inner.append(box);
    });

    lines.filter((line) => line.status !== "normal" && line.text).forEach((line) => {
      inner.append(element("p", "line-detail", `${line.name}　${line.text}`));
    });
    bar.append(inner);
  }

  const notices = $("#notices");
  const items = state.data?.notices || [];
  notices.replaceChildren();
  notices.hidden = items.length === 0;
  items.forEach((notice) => {
    const box = element("div", "notice");
    box.dataset.level = notice.level;
    box.append(element("strong", null, notice.title));
    if (notice.body) box.append(element("p", null, notice.body));
    notices.append(box);
  });

  const dayBar = $("#dayBar");
  dayBar.replaceChildren();
  state.days.forEach((item) => {
    const button = element("button");
    button.type = "button";
    button.dataset.date = item.date;
    button.dataset.day = item.day;
    button.setAttribute("aria-pressed", String(item.date === state.date && item.day === state.day));
    button.setAttribute("aria-label", item.label);
    const parts = item.date.split("-").map(Number);
    button.append(element("b", "d-day", item.day || item.label));
    if (parts.length === 3) {
      button.append(element("i", "d-date num", `${parts[1]}/${parts[2]}`));
    }
    // 後夜祭のある日には印をつけます。遅い便で帰る方が増えるので、選ぶ前に分かるようにします。
    const note = DAY_NOTES[item.date];
    if (note) button.append(element("span", "d-note", note));
    dayBar.append(button);
  });

  // 貼り付く見出しの実寸を飛び先の余白へ渡します。字の大きさが変わっても合います。
  requestAnimationFrame(() => {
    const height = dayBar.getBoundingClientRect().height;
    if (height > 0) document.documentElement.style.setProperty("--dayhead", `${Math.round(height)}px`);
  });

  const foot = $("#updatedLabel");
  foot.replaceChildren();
  if (state.data?.updatedAt) {
    foot.append(element("span", null, `${tokyo({ hour: "2-digit", minute: "2-digit" }).format(new Date(state.data.updatedAt))} 現在の情報です`));
  }
  (state.data?.attribution || []).forEach((line) => {
    foot.append(element("small", "credit", line));
  });
  // 路線記章のうち、CC BY-SA 4.0 のものは作者の表示が要ります。
  // 本文は web/assets/lines/manifest.json の台帳から起こしています。
  foot.append(element("small", "credit",
    "路線記章は Wikimedia Commons より。西武新宿線（Hide1228 / Syohei Arai）・国分寺線（Kaze315 / ButuCC）・西武池袋線（Hide1228 / Syohei Arai）・拝島線（Hide1228 / Syohei Arai） は CC BY-SA 4.0、他はパブリックドメインです。"));
}

// 時刻を選んでいるあいだは、画面を組み直しません。
// 組み直すと時刻の欄ごと作り直されるので、機種のホイールがその場で閉じてしまいます。
// iOS はホイールから指を離すたびに change を投げるので、ひと回しごとに閉じていました。
// 待たせる先をここ1か所にしておけば、30秒ごとの更新も、読み直しも、
// 表に戻ったときの読み直しも、選んでいる最中に横から閉じることがなくなります。
let heldRender = false;
const choosingTime = () => Boolean(document.activeElement?.matches?.('input[data-wish]'));

function renderBodies() {
  if (choosingTime()) {
    heldRender = true;
    return;
  }
  heldRender = false;
  const map = {
    inbound: $("#bodyInbound"),
    outbound: $("#bodyOutbound"),
    timetable: $("#bodyTimetable"),
    stops: $("#bodyStops"),
    event: $("#bodyEvent"),
  };
  Object.entries(map).forEach(([mode, node]) => {
    const section = document.querySelector(`.choice[data-mode="${mode}"]`);
    const head = section.querySelector(".choice-head");
    const open = state.mode === mode;
    head.setAttribute("aria-expanded", String(open));
    section.toggleAttribute("data-open", open);
    node.hidden = !open;
    if (!open) {
      node.replaceChildren();
      return;
    }
    if (mode === "inbound" || mode === "outbound") renderJourneyBody(mode, node);
    else if (mode === "timetable") renderTimetableBody(node);
    else if (mode === "stops") renderStopsBody(node);
    else renderEventBody(node);
  });
}

function render() {
  if (state.loading) {
    $("#choicesHeading").textContent = "読み込んでいます";
    return;
  }
  $("#choicesHeading").textContent = state.error || "どちらをお調べですか";
  renderHeader();
  renderBodies();
}

/* ---------- 読み込み ---------- */

function buildDays(settings) {
  const days = [];
  if (settings.eventSaturday) days.push({ date: settings.eventSaturday, day: "土曜", label: dateLabel(settings.eventSaturday) });
  if (settings.eventSunday) days.push({ date: settings.eventSunday, day: "日曜", label: dateLabel(settings.eventSunday) });
  if (!days.length) {
    days.push({ date: "", day: "土曜", label: "土曜ダイヤ" });
    days.push({ date: "", day: "日曜", label: "日曜ダイヤ" });
  }
  return days;
}

async function load(options = {}) {
  try {
    const params = new URLSearchParams({ day: state.day });
    if (state.date) params.set("date", state.date);
    const response = await fetch(`/api/public/guide?${params.toString()}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("時刻を読み込めませんでした");
    state.data = await response.json();
    state.days = buildDays(state.data.settings || {});
    if (!state.days.some((item) => item.day === state.day && item.date === state.date)) {
      const today = state.days.find((item) => item.date === todayISO());
      const target = today || state.days[0];
      if (target && (target.day !== state.day || target.date !== state.date)) {
        state.day = target.day;
        state.date = target.date;
        state.loading = true;
        return load(options);
      }
    }
    state.error = "";
  } catch (error) {
    state.error = `${error.message}。通信の状況をご確認ください。`;
  }
  state.loading = false;
  if (options.quiet) {
    // 書きかけの入力や、開いている操作面は触りません。消えてしまうためです。
    // 時間とともに古くなる部分（運行情報・混雑・現在時刻）だけ差し替えます。
    const busy = document.activeElement?.closest?.(".choice-body");
    if (busy) {
      renderHeader();
      return;
    }
  }
  render();
}

/* ---------- URL ---------- */

function readQuery() {
  const params = new URLSearchParams(location.search);
  const day = params.get("day");
  if (day === "土曜" || day === "日曜") state.day = day;
  const date = params.get("date");
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) state.date = date;
  const mode = params.get("mode");
  if (["inbound", "outbound", "timetable", "stops", "event"].includes(mode)) state.mode = mode;
  const from = params.get("from");
  if (from) {
    state.stops.inbound = from;
    state.stopTouched.inbound = true;
  }
  const to = params.get("to");
  if (to) {
    state.stops.outbound = to;
    state.stopTouched.outbound = true;
  } else if (from) {
    state.stops.outbound = from;
  }
  const program = params.get("program");
  if (program) state.program = program;
  const wish = params.get("wish");
  if (wish && /^\d{1,2}:\d{2}$/.test(wish) && (state.mode === "inbound" || state.mode === "outbound")) {
    state.wish[state.mode] = wish;
  }
}

function writeQuery() {
  const params = new URLSearchParams();
  if (state.date) params.set("date", state.date);
  params.set("day", state.day);
  if (state.mode) params.set("mode", state.mode);
  if (state.stops.inbound) params.set("from", state.stops.inbound);
  if (state.stops.outbound) params.set("to", state.stops.outbound);
  if ((state.mode === "inbound" || state.mode === "outbound") && state.wish[state.mode]) params.set("wish", state.wish[state.mode]);
  if (state.mode === "event" && state.program) params.set("program", state.program);
  history.replaceState(null, "", `/?${params.toString()}`);
}

/* ---------- 操作 ---------- */

document.addEventListener("click", (event) => {
  const head = event.target.closest(".choice-head");
  if (head) {
    const mode = head.closest(".choice").dataset.mode;
    state.mode = state.mode === mode ? "" : mode;
    writeQuery();
    renderBodies();
    if (state.mode) head.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const dayButton = event.target.closest("#dayBar button");
  if (dayButton) {
    state.day = dayButton.dataset.day;
    state.date = dayButton.dataset.date;
    state.loading = true;
    writeQuery();
    load();
    return;
  }
  const stopButton = event.target.closest(".picker.stops button[data-stop][data-direction]");
  if (stopButton) {
    const direction = stopButton.dataset.direction;
    const name = stopButton.dataset.stop;
    state.stops[direction] = state.stops[direction] === name ? "" : name;
    state.stopTouched[direction] = true;
    // 多くの方は同じ駅を往復されるため、帰りの駅をまだ選んでいなければ合わせます。
    if (direction === "inbound" && !state.stopTouched.outbound) state.stops.outbound = state.stops.inbound;
    writeQuery();
    renderBodies();
    return;
  }
  const tableDirection = event.target.closest("button[data-table-direction]");
  if (tableDirection) {
    state.table.direction = tableDirection.dataset.tableDirection;
    renderBodies();
    return;
  }
  const tableStop = event.target.closest("button[data-table-stop]");
  if (tableStop) {
    state.table.stop = tableStop.dataset.tableStop;
    renderBodies();
    return;
  }
  const jump = event.target.closest("button[data-jump-program]");
  if (jump) {
    state.program = jump.dataset.jumpProgram;
    state.stage = "";
    state.mode = "event";
    writeQuery();
    renderBodies();
    const section = document.querySelector('.choice[data-mode="event"] .choice-head');
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const programButton = event.target.closest("button[data-program]");
  if (programButton) {
    state.program = state.program === programButton.dataset.program ? "" : programButton.dataset.program;
    writeQuery();
    renderBodies();
    // 選んだ催しの詳細へ送ります。一覧が長いので、選んだ先が画面の外に出るためです。
    if (state.program) {
      requestAnimationFrame(() => {
        document.querySelector(".program-detail")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    return;
  }
  const stageButton = event.target.closest("button[data-stage]");
  if (stageButton) {
    state.stage = stageButton.dataset.stage;
    // 絞り込みから外れた催しを選んだままにしません。
    const stillShown = programsForDay().some((item) =>
      item.id === state.program && (!state.stage || item.stage === state.stage));
    if (!stillShown) state.program = "";
    writeQuery();
    renderBodies();
    return;
  }
  const clearWish = event.target.closest("button[data-clear-wish]");
  if (clearWish) {
    state.wish[clearWish.dataset.clearWish] = "";
    writeQuery();
    renderBodies();
  }
});

document.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-wish]");
  if (!input) return;
  state.wish[input.dataset.wish] = input.value;
  writeQuery();
  renderBodies();
});

// 時刻の欄から離れたところで、待たせていた組み直しを流します。
// focusout の時点ではまだ行き先が決まっていないので、決まってから見ます。
document.addEventListener("focusout", (event) => {
  if (!event.target.matches?.('input[data-wish]')) return;
  setTimeout(() => {
    if (heldRender && !choosingTime()) renderBodies();
  }, 0);
});

setInterval(() => {
  if (!document.hidden && viewingToday()) render();
}, 30000);

setInterval(() => {
  if (!document.hidden && viewingToday()) load();
}, 120000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && viewingToday()) load();
});

readQuery();
render();
load();

/* ---------- 地と図像 ---------- */

// 面はひと続きです。序で柿色が差し、藍へ渡り、ヒーローの下で白へ明けます。
// 濃さを決めるのはスクロールだけなので、読む人の手が進みを握ります。

const calmMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const hold = (value) => Math.min(1, Math.max(0, value));
const ramp = (value, from, to) => hold((value - from) / (to - from));
// 差して、保って、退く帯。
const band = (value, up, upTo, down, downTo) => Math.min(ramp(value, up, upTo), 1 - ramp(value, down, downTo));

// 段の進み具合。段が画面の下に現れたときが 0、上へ抜けきったときが 1。
// inTo までに入りきり、outFrom から抜け始めます。その間が落ち着いた状態で、
// ここが無いと帯と足が交わる瞬間が生まれません。
const BEATS = [
  { el: document.querySelector(".pro-name"), inTo: 0.22, outFrom: 0.52 },
  { el: document.querySelector(".pro-leap"), inTo: 0.34, outFrom: 0.64 },
  { el: document.querySelector(".pro-word"), inTo: 0.34, outFrom: 0.70 },
];

{
  const root = document.documentElement;
  const prologue = $("#prologue");
  const hero = $("#hero");

  let ticking = false;

  const paint = () => {
    ticking = false;
    if (!prologue || !hero) return;

    // 段ごとの出入り。入る量(--enter)と出る量(--exit)を渡し、組版側がそれを使います。
    // 一度きりの合図ではなく連続した値なので、送り戻しても同じ絵になります。
    const vh0 = window.innerHeight;
    BEATS.forEach((beat) => {
      const node = beat.el;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const vh = window.innerHeight;
      // 入り: 段の上端が画面の下から上へ来るまで。収まっていれば 1。
      const appear = hold((vh - rect.top) / Math.max(1, vh));
      // 出: 段が実際に画面の上へ抜けた割合。止まっていれば 0。
      const past = hold(-rect.top / Math.max(1, rect.height));
      const enter = hold(appear / beat.inTo);
      const exit = hold((past - beat.outFrom) / (1 - beat.outFrom));
      node.style.setProperty("--enter", enter.toFixed(4));
      node.style.setProperty("--exit", exit.toFixed(4));
    });

    // 柿色から夜への渡りは、斜めの面が広がることで起こします。
    // 題字の画面を送り終えるころに全面が夜になります。
    const name = document.querySelector(".pro-name");
    const wedge = name
      ? hold(-name.getBoundingClientRect().top / Math.max(1, name.offsetHeight * 0.82))
      : 1;
    root.style.setProperty("--wedge", wedge.toFixed(4));

    // 写真の視点。ヒーローが上がってくるあいだに、左上の空から右下のバスへ送ります。
    const heroRect = hero.getBoundingClientRect();
    hero.style.setProperty("--pan", hold((vh0 - heroRect.top) / vh0).toFixed(4));

    // 案内が近づいたら空も明けます。案内は自前の白い面を持っているので、
    // ここは面の下に濃い色を残さないための仕上げです。
    const guide = document.querySelector(".guide");
    const reach = guide ? guide.getBoundingClientRect().top / Math.max(1, window.innerHeight) : 9;
    const clear = hold((0.9 - reach) / 0.9);

    // 柿色は下に残したままにします。夜の面が上から覆うので、重ねの色が濁りません。
    root.style.setProperty("--o-kaki", "1");
    root.style.setProperty("--night-clear", (1 - clear).toFixed(3));

  };

  const schedule = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(paint);
  };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  schedule();
}

// ガラスの板は、画面に入ったところで一度だけ立ち上がります。
if (!calmMotion.matches && "IntersectionObserver" in window) {
  const watcher = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      watcher.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".linebar,.notices,.lead,.foot,.foot-staff")
    .forEach((node) => {
      node.classList.add("rise");
      watcher.observe(node);
    });

  const choices = $("#choices");
  if (choices) {
    choices.classList.add("is-armed");
    const entry = new IntersectionObserver((rows) => {
      rows.forEach((row) => {
        if (!row.isIntersecting) return;
        row.target.classList.add("is-in");
        entry.unobserve(row.target);
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });
    entry.observe(choices);
  }
}

/* ---------- 跳ぶ姿と GO BEYOND ---------- */

// 文字の中に見える人物を、背後の人物とぴたり重ねます。
// 文字の箱から見た人物の箱の位置と寸法を測って、そのまま background に渡します。
// 足もとの高さもここで出します。絵の中で靴はおおよそ下から2割の位置にあります。
function fitBeyond() {
  const figure = document.querySelector(".pro-form .leap");
  const form = document.querySelector(".pro-form");
  const line = document.querySelector(".beyond-line");
  if (!figure || !form || !line) return;
  if (!figure.complete || !figure.naturalWidth) return;

  // 人物には飛び込みの変形が掛かっています。掛かったまま測ると基準がずれるので、
  // 一度外して、落ち着いた位置の箱を測ります。
  const had = figure.style.transform;
  figure.style.transform = "none";
  const fig = figure.getBoundingClientRect();
  const box = form.getBoundingClientRect();
  if (had) figure.style.transform = had;
  else figure.style.removeProperty("transform");
  if (!fig.width || !box.height) return;

  // 帯は靴のあたりで交わらせます。絵の中で靴は下から2割ほどの位置です。
  const feet = fig.top - box.top + fig.height * 0.78;
  form.style.setProperty("--feet", `${feet.toFixed(1)}px`);
  // 光も同じ高さを芯にします。帯と光と足がひとところで交わります。
  form.style.setProperty("--glowTop", `${(feet - box.height * 0.09).toFixed(1)}px`);

  // 帯（面）の丈は行（文字）の実寸に合わせます。別要素なので測って渡します。
  // 行は傾けてあるので、傾ける前の丈を取ります。
  const was = line.style.transform;
  line.style.transform = "none";
  form.style.setProperty("--lineH", `${line.getBoundingClientRect().height.toFixed(1)}px`);
  if (was) line.style.transform = was;
  else line.style.removeProperty("transform");
}


{
  const figure = document.querySelector(".pro-form .leap");
  if (figure) {
    if (figure.complete) fitBeyond();
    figure.addEventListener("load", fitBeyond);
  }
  addEventListener("resize", fitBeyond);
  if (document.fonts?.ready) document.fonts.ready.then(fitBeyond);
}

/* ---------- 委員長のお言葉 ---------- */

// お言葉は案内設定（/guide）から編集します。コードには持ちません。

// 幕で入れ替えず、下へ並べます。1行ずつ現れるのは、手紙を読む速さに合わせるためです。
function renderChairWord() {
  const box = $("#proWord");
  if (!box) return;
  box.replaceChildren();

  const lines = (state.data?.chairWords || []).map((line) => String(line).trim());
  if (!lines.some((line) => line)) {
    // 仮の文章は置きません。誰の言葉でもない文が本番に残ると困るためです。
    const todo = element("div", "w-todo");
    todo.append(element("strong", null, "【未設定】委員長のお言葉"));
    todo.append(element("p", null, "案内設定（/guide）の「委員長のお言葉」に原文をお入れください。"));
    box.append(todo);
    return;
  }

  const run = element("div", "w-lines");
  lines.forEach((line) => {
    const row = element("p", "w-line", line);
    if (!line) row.classList.add("is-blank");
    run.append(row);
  });
  box.append(run);

  const sign = element("footer", "w-sign", "けやき祭実行委員会　委員長");
  const chairName = (state.data?.settings || {}).chairName || "";
  if (chairName.trim()) sign.append(element("span", null, chairName.trim()));
  box.append(sign);

  if (calmMotion.matches || !("IntersectionObserver" in window)) {
    run.querySelectorAll(".w-line").forEach((row) => row.classList.add("is-in"));
    return;
  }
  const reader = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      reader.unobserve(entry.target);
    });
  }, { threshold: 0.9, rootMargin: "0px 0px -18% 0px" });
  run.querySelectorAll(".w-line").forEach((row) => reader.observe(row));
}

/* ---------- 定期の読み直し ---------- */

// 運行情報と混雑は時間とともに古くなります。5分ごとに静かに取り直します。
// 画面を見ていないあいだは止め、戻ってきたら取り直します。
const REFRESH_MS = 5 * 60 * 1000;
let refreshTimer = null;

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    load({ quiet: true });
  }, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopRefresh();
    return;
  }
  load({ quiet: true });
  startRefresh();
});

startRefresh();
