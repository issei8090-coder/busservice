/* スクールバス時刻案内。公開APIの時刻だけを表示します。 */
const tokyo = (options) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", ...options });
const isoDate = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

const state = {
  tab: "outbound",
  day: "土曜",
  stop: "すべて",
  search: "",
  entries: [],
  programs: [],
  updatedAt: "",
};

const $ = (selector) => document.querySelector(selector);

function todayDay() {
  const weekday = tokyo({ weekday: "short" }).format(new Date());
  if (weekday.includes("日")) return "日曜";
  if (weekday.includes("土")) return "土曜";
  return "";
}

function viewingToday() {
  return todayDay() === state.day;
}

function nowMinutes() {
  const [hour, minute] = tokyo({ hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).split(":");
  return Number(hour) * 60 + Number(minute);
}

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

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readQuery() {
  const params = new URLSearchParams(location.search);
  const day = params.get("day");
  state.day = day === "土曜" || day === "日曜" ? day : todayDay() || "土曜";
  const tab = params.get("tab");
  state.tab = ["outbound", "inbound", "event", "info"].includes(tab) ? tab : "outbound";
  state.stop = params.get("stop") || "すべて";
  state.search = params.get("q") || "";
}

function writeQuery() {
  const params = new URLSearchParams();
  params.set("day", state.day);
  if (state.tab !== "outbound") params.set("tab", state.tab);
  if (state.stop !== "すべて") params.set("stop", state.stop);
  if (state.search.trim()) params.set("q", state.search.trim());
  history.replaceState(null, "", `/?${params.toString()}`);
}

function matchesSearch(...values) {
  const query = state.search.trim();
  if (!query) return true;
  const target = values.join(" ");
  return query
    .split(/[\s　]+/)
    .filter(Boolean)
    .every((word) => target.includes(word));
}

function stopNames() {
  const names = [];
  state.entries.forEach((entry) => {
    (entry.stops || []).forEach((name) => {
      if (!names.includes(name)) names.push(name);
    });
  });
  return names;
}

/* 乗車できる便だけを、往路と復路に分けて並べます。 */
function tripsFor(tab) {
  const leg = tab === "inbound" ? "inbound" : "outbound";
  return state.entries
    .filter((entry) => (leg === "outbound" ? entry.outboundType : entry.inboundType) === "passenger")
    .filter((entry) => state.stop === "すべて" || (entry.stops || []).includes(state.stop))
    .filter((entry) => matchesSearch(
      (entry.stops || []).join("・"),
      clockText(entry.schoolDeparture),
      clockText(entry.schoolArrival),
      clockText(entry.stationDeparture),
      clockText(entry.stationArrival),
    ))
    .map((entry) => {
      const stops = (entry.stops || []).join("・") || "学校";
      if (leg === "outbound") {
        return {
          time: entry.schoolDeparture,
          timeLabel: "学校発",
          isDeparture: true,
          title: `${stops} ゆき`,
          detail: clockMinutes(entry.stationArrival) === null ? "" : `${stops}着 ${clockText(entry.stationArrival)}`,
          status: entry.status,
          delayMinutes: entry.delayMinutes,
        };
      }
      const departure = clockMinutes(entry.stationDeparture) === null ? "" : entry.stationDeparture;
      return {
        time: departure || entry.schoolArrival,
        timeLabel: departure ? `${stops}発` : "学校着",
        isDeparture: Boolean(departure),
        title: `${stops} から`,
        detail: departure ? `学校着 ${clockText(entry.schoolArrival)}` : "",
        status: entry.status,
        delayMinutes: entry.delayMinutes,
      };
    })
    .sort((a, b) => (clockMinutes(a.time) ?? 9999) - (clockMinutes(b.time) ?? 9999));
}

// 行き 駅から学校へ着く便のうち、開始時刻までに到着するもの
function arrivalBuses(start) {
  const limit = clockMinutes(start);
  if (limit === null) return [];
  return state.entries
    .filter((entry) => entry.inboundType === "passenger" && entry.status !== "cancelled")
    .filter((entry) => state.stop === "すべて" || (entry.stops || []).includes(state.stop))
    .map((entry) => ({
      stops: (entry.stops || []).join("・"),
      stationDeparture: entry.stationDeparture,
      schoolArrival: entry.schoolArrival,
      minutes: clockMinutes(entry.schoolArrival),
    }))
    .filter((bus) => bus.minutes !== null && bus.minutes <= limit)
    .sort((a, b) => b.minutes - a.minutes)
    .map((bus) => ({ ...bus, margin: limit - bus.minutes }));
}

// 5分以上の余裕がある便を優先し、無ければ直前の便を案内します。
function recommendedArrivals(start) {
  const all = arrivalBuses(start);
  const comfortable = all.filter((bus) => bus.margin >= 5);
  return comfortable.length ? comfortable.slice(0, 2) : all.slice(0, 1);
}

// 帰り 終了後に学校から駅へ向かう便
function departureBuses(end, start) {
  const limit = clockMinutes(end) ?? clockMinutes(start);
  if (limit === null) return [];
  return state.entries
    .filter((entry) => entry.outboundType === "passenger" && entry.status !== "cancelled")
    .filter((entry) => state.stop === "すべて" || (entry.stops || []).includes(state.stop))
    .map((entry) => ({
      stops: (entry.stops || []).join("・"),
      schoolDeparture: entry.schoolDeparture,
      minutes: clockMinutes(entry.schoolDeparture),
    }))
    .filter((bus) => bus.minutes !== null && bus.minutes >= limit)
    .sort((a, b) => a.minutes - b.minutes)
    .map((bus) => ({ ...bus, wait: bus.minutes - limit }));
}

function recommendedDeparture(end, start) {
  const all = departureBuses(end, start);
  return all.find((bus) => bus.wait >= 5) || all[0] || null;
}

function busHintRow(label, text, strongText) {
  const row = document.createElement("div");
  row.append(element("small", null, label));
  const line = document.createElement("span");
  if (strongText) {
    const value = document.createElement("b");
    value.textContent = strongText;
    line.append(value, document.createTextNode(` ${text}`));
  } else {
    line.textContent = text;
    line.className = "none";
  }
  row.append(line);
  return row;
}

function renderEvents() {
  if (state.tab !== "event") return;
  const list = $("#eventList");
  list.replaceChildren();
  const programs = state.programs.filter((program) => matchesSearch(program.title, program.stage, program.details || "", clockText(program.start)));
  $("#eventCount").textContent = `${state.day}　${programs.length}件`;
  $("#eventEmpty").hidden = programs.length > 0;
  $("#eventEmpty").textContent = state.search.trim() ? "該当するイベントはありません" : "ステージプログラムは準備中です";

  programs.forEach((program) => {
    const row = element("li", "row program");
    const time = element("div", "time");
    time.append(element("strong", null, clockText(program.start)));
    time.append(element("small", null, program.end ? `〜${clockText(program.end)}` : "開始"));
    row.append(time);

    const body = element("div", "body");
    body.append(element("strong", null, program.title));
    body.append(element("span", null, program.stage));
    if (program.details) body.append(element("p", null, program.details));

    const hint = element("div", "bus-hint");
    const going = recommendedArrivals(program.start);
    if (going.length) {
      going.forEach((bus, index) => {
        const label = index === 0 ? "行き" : "1本前";
        const margin = bus.margin === 0 ? "開始と同時刻 ぎりぎり" : bus.margin < 5 ? `開始${bus.margin}分前 ぎりぎり` : `開始${bus.margin}分前`;
        hint.append(busHintRow(label, `学校着　${bus.stops} から　${margin}`, clockText(bus.schoolArrival)));
      });
    } else {
      hint.append(busHintRow("行き", "開始までに学校へ着くバスはありません", ""));
    }
    const back = recommendedDeparture(program.end, program.start);
    if (back) {
      const wait = back.wait === 0 ? "終了と同時刻" : `終了${back.wait}分後`;
      hint.append(busHintRow("帰り", `学校発　${back.stops} ゆき　${wait}`, clockText(back.schoolDeparture)));
    } else {
      hint.append(busHintRow("帰り", "終了後に学校を出るバスはありません", ""));
    }
    body.append(hint);
    row.append(body);
    list.append(row);
  });
}

function renderDaySwitch() {
  document.querySelectorAll("#daySwitch button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.day === state.day));
  });
}

function renderStopSwitch() {
  const container = $("#stopSwitch");
  const names = ["すべて", ...stopNames()];
  if (!names.includes(state.stop)) state.stop = "すべて";
  container.replaceChildren();
  names.forEach((name) => {
    const button = element("button", null, name);
    button.type = "button";
    button.dataset.stop = name;
    button.setAttribute("aria-pressed", String(state.stop === name));
    container.append(button);
  });
  container.hidden = state.tab === "info";
}

function renderTabs() {
  document.querySelectorAll("#tabbar button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.tab === state.tab));
  });
  $("#listSection").hidden = state.tab !== "outbound" && state.tab !== "inbound";
  $("#eventSection").hidden = state.tab !== "event";
  $("#infoSection").hidden = state.tab !== "info";
  $("#daySwitch").hidden = state.tab === "info";
}

function renderList() {
  if (state.tab !== "outbound" && state.tab !== "inbound") return;
  const trips = tripsFor(state.tab);
  const list = $("#list");
  list.replaceChildren();
  $("#listHeading").textContent = state.tab === "inbound" ? "復路 学校ゆき" : "往路 学校発";
  $("#listCount").textContent = `${state.day}ダイヤ　${trips.length}便`;
  $("#listEmpty").hidden = trips.length > 0;
  $("#listEmpty").textContent = state.search.trim() ? "該当する便はありません" : "この時間帯の便はありません";

  const limit = viewingToday() ? nowMinutes() : null;
  let nextMarked = false;
  trips.forEach((trip) => {
    const row = element("li", "row");
    const minutes = clockMinutes(trip.time);
    const cancelled = trip.status === "cancelled";
    if (cancelled) row.classList.add("cancelled");
    if (limit !== null && minutes !== null && minutes < limit && !cancelled) row.classList.add("past");

    const time = element("div", "time");
    time.append(element("strong", null, clockText(trip.time)));
    time.append(element("small", null, trip.timeLabel));
    row.append(time);

    const body = element("div", "body");
    body.append(element("strong", null, trip.title));
    if (trip.detail) body.append(element("span", null, trip.detail));
    row.append(body);

    if (cancelled) {
      row.append(element("div", "mark stop", "運休"));
    } else if (trip.delayMinutes) {
      row.append(element("div", "mark warn", `約${trip.delayMinutes}分遅れ`));
    } else if (limit !== null && minutes !== null && minutes >= limit && !nextMarked) {
      nextMarked = true;
      row.classList.add("next");
      const remaining = minutes - limit;
      if (trip.isDeparture) row.append(element("div", "mark go", remaining <= 1 ? "まもなく" : `あと${remaining}分`));
      else row.append(element("div", "mark go", "次の到着"));
    }
    list.append(row);
  });
}

function renderInfo() {
  const title = $("#statusTitle");
  const text = $("#statusText");
  const list = $("#statusList");
  const card = $("#statusCard");
  list.replaceChildren();
  list.hidden = true;
  card.className = "card";

  const today = todayDay();
  if (!today) {
    title.textContent = "本日は運行日ではありません";
    text.textContent = "土曜ダイヤと日曜ダイヤの時刻をご確認ください。";
    return;
  }
  if (!viewingToday()) {
    title.textContent = `本日は${today}ダイヤです`;
    text.textContent = `運休と遅れは${today}ダイヤに表示します。`;
    return;
  }
  const cancelled = state.entries.filter((entry) => entry.status === "cancelled");
  const delayed = state.entries.filter((entry) => entry.delayMinutes);
  if (cancelled.length) {
    card.className = "card stop";
    title.textContent = `本日は${cancelled.length}便が運休です`;
    text.textContent = "運休の便は時刻の一覧にも表示しています。";
    cancelled.slice(0, 8).forEach((entry) => {
      list.append(element("li", null, `${clockText(entry.schoolDeparture)} 学校発　${(entry.stops || []).join("・")}`));
    });
    list.hidden = false;
    return;
  }
  if (delayed.length) {
    const worst = delayed.reduce((max, entry) => Math.max(max, entry.delayMinutes || 0), 0);
    card.className = "card warn";
    title.textContent = `遅れが出ています　最大約${worst}分`;
    text.textContent = "道路状況により到着が遅れる場合があります。";
    return;
  }
  card.className = "card go";
  title.textContent = "平常どおり運行しています";
  text.textContent = "運休と遅れの記録はありません。";
}

function render() {
  if ($("#searchInput").value !== state.search) $("#searchInput").value = state.search;
  $("#todayLabel").textContent = tokyo({ month: "long", day: "numeric", weekday: "short" }).format(new Date());
  renderTabs();
  renderDaySwitch();
  renderStopSwitch();
  renderList();
  renderEvents();
  renderInfo();
  $("#updatedLabel").textContent = state.updatedAt
    ? `最終確認 ${tokyo({ month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(state.updatedAt))}`
    : "";
}

async function load() {
  const params = new URLSearchParams({ day: state.day });
  if (viewingToday()) params.set("date", isoDate());
  try {
    const [response, programResponse] = await Promise.all([
      fetch(`/api/public/schedule?${params.toString()}`, { headers: { Accept: "application/json" } }),
      fetch(`/api/public/programs?day=${encodeURIComponent(state.day)}`, { headers: { Accept: "application/json" } }),
    ]);
    if (!response.ok) throw new Error("時刻を読み込めませんでした");
    const data = await response.json();
    state.entries = Array.isArray(data.entries) ? data.entries : [];
    state.updatedAt = data.updatedAt || "";
    const programData = programResponse.ok ? await programResponse.json() : {};
    state.programs = Array.isArray(programData.programs) ? programData.programs : [];
  } catch (error) {
    state.entries = [];
    state.programs = [];
    state.updatedAt = "";
    $("#listEmpty").textContent = `${error.message}。通信状況を確認して画面を再読込してください。`;
  }
  render();
}

document.addEventListener("click", (event) => {
  const dayButton = event.target.closest("#daySwitch button");
  if (dayButton) {
    if (dayButton.dataset.day === state.day) return;
    state.day = dayButton.dataset.day;
    writeQuery();
    load();
    return;
  }
  const stopButton = event.target.closest("#stopSwitch button");
  if (stopButton) {
    state.stop = stopButton.dataset.stop;
    writeQuery();
    render();
    return;
  }
  const tabButton = event.target.closest("#tabbar button");
  if (tabButton) {
    state.tab = tabButton.dataset.tab;
    writeQuery();
    render();
    if (state.tab === "outbound" || state.tab === "inbound") $("#listSection").focus({ preventScroll: true });
  }
});

$("#searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  writeQuery();
  render();
});

setInterval(() => {
  if (!document.hidden && viewingToday()) load();
}, 60000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && viewingToday()) load();
});

readQuery();
writeQuery();
render();
load();
