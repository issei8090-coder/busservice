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
function mapURL(stop) {
  if (!stop || (!stop.latitude && !stop.longitude)) return "";
  const label = encodeURIComponent(`${stop.name} ${stop.place || "バス乗り場"}`);
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?ll=${stop.latitude},${stop.longitude}&q=${label}`
    : `https://www.google.com/maps/search/?api=1&query=${stop.latitude},${stop.longitude}`;
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

function stopPicker(direction) {
  const selected = state.stops[direction];
  const box = element("div", "picker stops");
  (state.data?.stops || []).forEach((stop) => {
    const button = element("button");
    button.type = "button";
    button.dataset.stop = stop.name;
    button.dataset.direction = direction;
    button.setAttribute("aria-pressed", String(selected === stop.name));
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

function resultCard(direction, journey, options = {}) {
  const card = element("div", "result");
  const main = element("div", "result-main");
  const stop = stopInfo(journey.stop);

  main.append(element("p", "result-kicker", direction === "inbound"
    ? `${journey.stop}${stop?.line ? `（${stop.line}）` : ""} から 学校へ`
    : `学校から ${journey.stop}${stop?.line ? `（${stop.line}）` : ""} へ`));

  const time = element("div", "result-time");
  time.append(element("strong", "num", clockText(journey.departure)));
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
  card.append(main);

  if (direction === "inbound" && stop) {
    const place = element("div", "result-place");
    place.append(element("strong", null, `乗り場　${stop.place || `${stop.name}駅`}`));
    if (stop.landmark) place.append(element("p", null, stop.landmark));
    if (stop.walkMinutes) place.append(element("p", "walk", `改札からおよそ徒歩${stop.walkMinutes}分です。発車の5分前までにお越しください。`));
    const button = mapButton(stop);
    if (button) place.append(button);
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
  container.append(field(
    direction === "inbound" ? "何時ごろ学校に着きたいですか" : "何時ごろ学校を出発したいですか",
    timeRow(direction),
  ));

  if (!stopName) {
    container.append(element("p", "empty", "駅をお選びください。"));
    return;
  }

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
    container.append(resultCard(direction, picked.main, { late: picked.late, afterLast: picked.afterLast, gap }));
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
    button.append(document.createTextNode(stop.name));
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
    item.append(element("h3", null, `${stop.name}　${stop.place || "バス乗り場"}`));
    if (stop.line) item.append(element("p", "line-name", stop.line));
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

function renderEventBody(container) {
  container.replaceChildren();
  const programs = state.data?.programs || [];
  if (!programs.length) {
    container.append(element("p", "empty", "この日の催しは準備中です。"));
    return;
  }
  const list = element("div", "program-list");
  programs.forEach((program) => {
    const button = element("button", "program");
    button.type = "button";
    button.dataset.program = program.id;
    button.setAttribute("aria-pressed", String(state.program === program.id));
    button.append(element("span", "time num", clockText(program.start)));
    const body = element("span", "body");
    body.append(element("strong", null, program.title));
    body.append(element("span", null, `${program.stage}${program.end ? `　${clockText(program.start)}〜${clockText(program.end)}` : ""}`));
    button.append(body);
    list.append(button);
  });
  container.append(field("見たい催しをお選びください", list));

  const program = programs.find((item) => item.id === state.program);
  if (!program) return;

  container.append(field("行き　どの駅からお越しになりますか", stopPicker("inbound")));
  container.append(field("帰り　どの駅へお帰りになりますか", stopPicker("outbound")));
  if (!state.stops.inbound && !state.stops.outbound) {
    container.append(element("p", "empty", "駅をお選びください。"));
    return;
  }

  const goingAll = journeys("inbound", state.stops.inbound).filter(running);
  const arriveBy = clockMinutes(program.start);
  const going = goingAll.filter((item) => clockMinutes(item.arrival) !== null && clockMinutes(item.arrival) <= arriveBy);
  const goBox = element("div", "field");
  goBox.append(element("h3", null, "行き　この便で開始に間に合います"));
  if (!state.stops.inbound) {
    goBox.append(element("p", "empty", "行きの駅をお選びください。"));
  } else if (going.length) {
    goBox.append(resultCard("inbound", going[going.length - 1]));
  } else {
    goBox.append(element("p", "empty", "開始までに学校へ着く便がありません。"));
  }
  container.append(goBox);

  const endAt = clockMinutes(program.end) ?? arriveBy;
  const backAll = journeys("outbound", state.stops.outbound).filter(running);
  const back = backAll.find((item) => clockMinutes(item.departure) >= endAt);
  const backBox = element("div", "field");
  backBox.append(element("h3", null, "帰り　催しの終了後に出る便"));
  if (!state.stops.outbound) {
    backBox.append(element("p", "empty", "帰りの駅をお選びください。"));
  } else if (back) {
    backBox.append(resultCard("outbound", back));
  } else {
    backBox.append(element("p", "empty", "終了後に学校を出る便がありません。"));
  }
  container.append(backBox);

  if (state.stops.inbound) sendSignal("inbound", state.stops.inbound, clockText(program.start));
  if (state.stops.outbound && program.end) sendSignal("outbound", state.stops.outbound, clockText(program.end));
}

/* ---------- 全体 ---------- */

function renderHeader() {
  const settings = state.data?.settings || {};
  const current = state.days.find((item) => item.date === state.date);
  const name = settings.eventName ? `${settings.eventName}　` : "";
  $("#eventLabel").textContent = current
    ? `${name}${current.label}`
    : `${name}${state.day}ダイヤ`;

  const bar = $("#lineBar");
  const lines = state.data?.lines || [];
  bar.replaceChildren();
  bar.hidden = lines.length === 0;
  if (lines.length) {
    const inner = element("div", "inner");
    lines.forEach((line) => {
      const item = element("span", "line-item");
      item.dataset.status = line.status;
      item.append(element("i"));
      item.append(document.createTextNode(`${line.name}　${lineStatusWords[line.status] || "情報なし"}`));
      inner.append(item);
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
  dayBar.hidden = state.days.length < 2;
  state.days.forEach((item) => {
    const button = element("button", null, item.label);
    button.type = "button";
    button.dataset.date = item.date;
    button.dataset.day = item.day;
    button.setAttribute("aria-pressed", String(item.date === state.date && item.day === state.day));
    dayBar.append(button);
  });

  const foot = $("#updatedLabel");
  foot.replaceChildren();
  if (state.data?.updatedAt) {
    foot.append(element("span", null, `${tokyo({ hour: "2-digit", minute: "2-digit" }).format(new Date(state.data.updatedAt))} 現在の情報です`));
  }
  (state.data?.attribution || []).forEach((line) => {
    foot.append(element("small", "credit", line));
  });
}

function renderBodies() {
  const map = {
    inbound: $("#bodyInbound"),
    outbound: $("#bodyOutbound"),
    timetable: $("#bodyTimetable"),
    stops: $("#bodyStops"),
    event: $("#bodyEvent"),
  };
  Object.entries(map).forEach(([mode, node]) => {
    const head = document.querySelector(`.choice[data-mode="${mode}"] .choice-head`);
    const open = state.mode === mode;
    head.setAttribute("aria-expanded", String(open));
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

async function load() {
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
        return load();
      }
    }
    state.error = "";
  } catch (error) {
    state.error = `${error.message}。通信の状況をご確認ください。`;
  }
  state.loading = false;
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
  const programButton = event.target.closest("button[data-program]");
  if (programButton) {
    state.program = state.program === programButton.dataset.program ? "" : programButton.dataset.program;
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
