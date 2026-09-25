/* 案内設定。ここで登録した内容が一般用の画面に出ます。 */
const validTabs = ["stops", "legs", "notices", "crowd", "lines"];

const state = {
  tab: validTabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : "stops",
  stops: [],
  legs: [],
  notices: [],
  crowdHints: [],
  signals: [],
  lines: [],
  settings: {},
  autoReady: false,
  timetable: { 土曜: [], 日曜: [] },
};

const $ = (selector) => document.querySelector(selector);
const todayISO = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

function toast(message, tone = "info") {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;
  node.textContent = message;
  $("#toastRegion").append(node);
  setTimeout(() => node.remove(), 5000);
}

function showError(id, message) {
  const box = $(id);
  if (!message) {
    box.hidden = true;
    return;
  }
  box.textContent = message;
  box.hidden = false;
  box.focus();
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
  if (minutes === null) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || "処理に失敗しました");
    error.status = response.status;
    throw error;
  }
  return body;
}

function put(url, payload) {
  return api(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

/* ---------- 乗り場 ---------- */

// 地図アプリのリンク。iPhoneとiPadはAppleマップ、それ以外はGoogleマップを開きます。
function mapLink(stop) {
  if (!stop.latitude && !stop.longitude) return "";
  const label = encodeURIComponent(`${stop.name}　${stop.place || "バス乗り場"}`);
  const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple
    ? `https://maps.apple.com/?ll=${stop.latitude},${stop.longitude}&q=${label}`
    : `https://www.google.com/maps/search/?api=1&query=${stop.latitude},${stop.longitude}`;
}

function stopCard(stop) {
  const card = document.createElement("article");
  card.className = "stop-card";
  card.dataset.id = stop.id || "";

  const head = document.createElement("div");
  head.className = "stop-card-head";
  const title = document.createElement("strong");
  title.textContent = stop.name || "新しい乗り場";
  const line = document.createElement("small");
  line.textContent = stop.line || "";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(title, line, spacer);
  card.append(head);

  const body = document.createElement("div");
  body.className = "stop-card-body";
  const grid = document.createElement("div");
  grid.className = "stop-grid";
  const fields = [
    ["name", "駅名（経路の表記と同じ）", "text", stop.name || "", "ふじみ野"],
    ["line", "路線", "text", stop.line || "", "東武東上線"],
    ["place", "乗り場の名前", "text", stop.place || "", "東口ロータリー"],
    ["walkMinutes", "改札から徒歩（分）", "number", stop.walkMinutes || 0, "2"],
    ["latitude", "緯度", "number", stop.latitude || "", "35.8790"],
    ["longitude", "経度", "number", stop.longitude || "", "139.5210"],
  ];
  fields.forEach(([key, label, type, value, placeholder]) => {
    const wrap = document.createElement("label");
    const span = document.createElement("span");
    span.className = "field-label";
    span.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.dataset.field = key;
    input.value = value;
    input.placeholder = placeholder;
    if (type === "number") input.step = key === "walkMinutes" ? "1" : "any";
    wrap.append(span, input);
    grid.append(wrap);
  });
  const landmark = document.createElement("label");
  landmark.className = "full";
  const landmarkLabel = document.createElement("span");
  landmarkLabel.className = "field-label";
  landmarkLabel.textContent = "目印（来場者に表示されます）";
  const landmarkInput = document.createElement("input");
  landmarkInput.type = "text";
  landmarkInput.dataset.field = "landmark";
  landmarkInput.value = stop.landmark || "";
  landmarkInput.placeholder = "改札を出て左、交番の向かいです";
  landmark.append(landmarkLabel, landmarkInput);
  grid.append(landmark);
  body.append(grid);

  const actions = document.createElement("div");
  actions.className = "stop-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "button primary";
  save.dataset.action = "save-stop";
  save.textContent = "この乗り場を保存";
  const hint = document.createElement("span");
  hint.className = "map-hint";
  const link = mapLink(stop);
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.textContent = "地図で位置を確認";
    hint.append(anchor);
  } else {
    hint.textContent = "緯度経度を入れると地図ボタンが出ます";
  }
  const spacer2 = document.createElement("span");
  spacer2.className = "spacer";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button danger";
  remove.dataset.action = "delete-stop";
  remove.textContent = "削除";
  actions.append(save, hint, spacer2);
  if (stop.id) actions.append(remove);
  body.append(actions);
  card.append(body);
  return card;
}

function renderStops() {
  const list = $("#stopCards");
  list.replaceChildren();
  if (!state.stops.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "乗り場がまだありません。追加してください。";
    list.append(empty);
  }
  state.stops.forEach((stop) => list.append(stopCard(stop)));
}

function collectStop(card) {
  const stop = { id: card.dataset.id || "" };
  card.querySelectorAll("input[data-field]").forEach((input) => {
    const key = input.dataset.field;
    if (input.type === "number") stop[key] = input.value === "" ? 0 : Number(input.value);
    else stop[key] = input.value.trim();
  });
  const existing = state.stops.find((item) => item.id === stop.id);
  stop.order = existing ? existing.order : state.stops.length + 1;
  return stop;
}

/* ---------- 区間の所要時間 ---------- */

function legRow(leg) {
  const row = document.createElement("div");
  row.className = "leg-row";
  const from = document.createElement("input");
  from.className = "leg-from";
  from.type = "text";
  from.dataset.field = "from";
  from.value = leg.from || "";
  from.placeholder = "学校";
  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "↔";
  const to = document.createElement("input");
  to.className = "leg-to";
  to.type = "text";
  to.dataset.field = "to";
  to.value = leg.to || "";
  to.placeholder = "ふじみ野";
  const minutes = document.createElement("input");
  minutes.className = "leg-minutes";
  minutes.type = "number";
  minutes.min = "1";
  minutes.max = "180";
  minutes.dataset.field = "minutes";
  minutes.value = leg.minutes || "";
  minutes.placeholder = "15";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove-leg";
  remove.textContent = "削除";
  row.append(from, arrow, to, minutes, remove);
  return row;
}

function renderLegs() {
  const rows = $("#legRows");
  rows.replaceChildren();
  state.legs.forEach((leg) => rows.append(legRow(leg)));
  if (!state.legs.length) rows.append(legRow({}));
  renderLegCheck();
}

function collectLegs() {
  return Array.from($("#legRows").children).map((row) => ({
    from: row.querySelector('[data-field="from"]').value.trim(),
    to: row.querySelector('[data-field="to"]').value.trim(),
    minutes: Number(row.querySelector('[data-field="minutes"]').value || 0),
  })).filter((leg) => leg.from && leg.to);
}

function legMinutes(legs, from, to) {
  const found = legs.find((leg) => (leg.from === from && leg.to === to) || (leg.from === to && leg.to === from));
  return found ? found.minutes : null;
}

// 登録した所要時間が、実際のダイヤの運行時間に収まるかを確かめます。
function renderLegCheck() {
  const box = $("#legCheck");
  box.replaceChildren();
  const legs = collectLegs();
  const problems = [];
  ["土曜", "日曜"].forEach((day) => {
    (state.timetable[day] || []).forEach((entry) => {
      const nodes = String(entry.route).split("→").map((part) => part.trim()).filter(Boolean);
      let travel = 0;
      for (let index = 0; index + 1 < nodes.length; index += 1) {
        const minutes = legMinutes(legs, nodes[index], nodes[index + 1]);
        if (minutes === null) {
          problems.push({ tone: "stop", text: `${day} ${entry.route}　区間「${nodes[index]}〜${nodes[index + 1]}」が未登録です` });
          travel = null;
          break;
        }
        travel += minutes;
      }
      if (travel === null) return;
      const departure = clockMinutes(entry.schoolDeparture);
      const arrival = clockMinutes(entry.schoolArrival);
      if (departure === null || arrival === null) return;
      const span = arrival - departure;
      if (travel > span) {
        problems.push({ tone: "stop", text: `${day} ${entry.schoolDeparture}発 ${entry.route}　走行${travel}分が運行${span}分を超えています` });
      }
    });
  });
  if (!problems.length) {
    const item = document.createElement("li");
    item.dataset.tone = "go";
    item.textContent = "全便で計算が成立します。";
    box.append(item);
    return;
  }
  problems.slice(0, 12).forEach((problem) => {
    const item = document.createElement("li");
    item.dataset.tone = problem.tone;
    item.textContent = problem.text;
    box.append(item);
  });
  if (problems.length > 12) {
    const item = document.createElement("li");
    item.textContent = `ほか${problems.length - 12}件`;
    box.append(item);
  }
}

/* ---------- お知らせ ---------- */

function renderNotices() {
  const list = $("#noticeList");
  list.replaceChildren();
  if (!state.notices.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "お知らせはまだありません。";
    list.append(empty);
    return;
  }
  state.notices.forEach((notice) => {
    const item = document.createElement("div");
    item.className = "notice-item";
    item.dataset.level = notice.level;
    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("strong");
    title.textContent = `${notice.day}　${notice.title}`;
    body.append(title);
    if (notice.body) {
      const text = document.createElement("p");
      text.textContent = notice.body;
      body.append(text);
    }
    const tools = document.createElement("div");
    tools.className = "tools";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.action = "edit-notice";
    edit.dataset.id = notice.id;
    edit.textContent = "編集";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.action = "delete-notice";
    remove.dataset.id = notice.id;
    remove.textContent = "削除";
    tools.append(edit, remove);
    item.append(body, tools);
    list.append(item);
  });
}

function fillNoticeForm(notice) {
  $("#noticeId").value = notice?.id || "";
  $("#noticeDay").value = notice?.day || "すべて";
  $("#noticeLevel").value = notice?.level || "info";
  $("#noticeTitle").value = notice?.title || "";
  $("#noticeBody").value = notice?.body || "";
  showError("#noticeError", "");
}

/* ---------- 混雑予測 ---------- */

const crowdLabels = { calm: "ゆったり", crowded: "混み合う見込み", packed: "大変混み合う見込み" };
const directionLabels = { both: "行き帰り", inbound: "学校へ行く便", outbound: "学校から帰る便" };

function renderCrowd() {
  const stopSelect = $("#crowdStop");
  const current = stopSelect.value;
  stopSelect.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "すべての駅";
  stopSelect.append(all);
  state.stops.forEach((stop) => {
    const option = document.createElement("option");
    option.value = stop.name;
    option.textContent = stop.name;
    stopSelect.append(option);
  });
  stopSelect.value = current;

  const list = $("#crowdList");
  list.replaceChildren();
  if (!state.crowdHints.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "手動の混雑予測はまだありません。設定がない時間帯は自動で推定します。";
    list.append(empty);
  }
  state.crowdHints.forEach((hint) => {
    const item = document.createElement("div");
    item.className = "notice-item";
    item.dataset.level = hint.level === "packed" ? "alert" : hint.level === "crowded" ? "warn" : "calm";
    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("strong");
    title.textContent = `${hint.day} ${clockText(hint.start)}〜${clockText(hint.end)}　${crowdLabels[hint.level] || hint.level}`;
    const detail = document.createElement("p");
    detail.textContent = `${directionLabels[hint.direction] || ""}　${hint.stop || "すべての駅"}${hint.note ? `　${hint.note}` : ""}`;
    body.append(title, detail);
    const tools = document.createElement("div");
    tools.className = "tools";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.action = "edit-crowd";
    edit.dataset.id = hint.id;
    edit.textContent = "編集";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.action = "delete-crowd";
    remove.dataset.id = hint.id;
    remove.textContent = "削除";
    tools.append(edit, remove);
    item.append(body, tools);
    list.append(item);
  });

  const signals = $("#signalList");
  signals.replaceChildren();
  if (!state.signals.length) {
    const item = document.createElement("li");
    item.dataset.tone = "go";
    item.textContent = "本日の検索はまだありません。";
    signals.append(item);
    return;
  }
  const sorted = [...state.signals].sort((a, b) => b.count - a.count).slice(0, 12);
  sorted.forEach((signal) => {
    const item = document.createElement("li");
    item.dataset.tone = signal.count >= 5 ? "stop" : "go";
    item.textContent = `${clockText(signal.slot)}　${directionLabels[signal.direction] || signal.direction}　${signal.stop || "駅の指定なし"}　${signal.count}件`;
    signals.append(item);
  });
}

function fillCrowdForm(hint) {
  $("#crowdId").value = hint?.id || "";
  $("#crowdDay").value = hint?.day || "土曜";
  $("#crowdDirection").value = hint?.direction || "both";
  $("#crowdStop").value = hint?.stop || "";
  $("#crowdLevel").value = hint?.level || "crowded";
  $("#crowdStart").value = clockText(hint?.start) || "";
  $("#crowdEnd").value = clockText(hint?.end) || "";
  $("#crowdNote").value = hint?.note || "";
  showError("#crowdError", "");
}

/* ---------- 沿線情報 ---------- */

const defaultLines = [
  { railway: "tobu.tojo", name: "東武東上線" },
  { railway: "jreast.kawagoeline", name: "JR川越線" },
  { railway: "seibu.shinjuku", name: "西武新宿線" },
];

function renderLines() {
  $("#autoState").textContent = state.autoReady
    ? "JR東日本公式、公共交通オープンデータセンター、私鉄各社公式をまとめた運行情報を5分ごとに自動取得しています。手入力すると、次の自動取得まで手入力の内容が表示されます。"
    : "自動取得の取得先が未設定です。ここで手入力した内容が一般用に表示されます。";
  const rows = $("#lineRows");
  rows.replaceChildren();
  const source = state.lines.length ? state.lines : defaultLines.map((line) => ({ ...line, status: "normal", text: "" }));
  source.forEach((line) => {
    const row = document.createElement("div");
    row.className = "line-row";
    row.dataset.railway = line.railway || "";
    const name = document.createElement("strong");
    name.textContent = line.name;
    const status = document.createElement("select");
    status.dataset.field = "status";
    [["normal", "平常運転"], ["trouble", "遅れ・見合わせ"], ["info", "お知らせ"], ["unknown", "情報なし"]].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      status.append(option);
    });
    status.value = line.status || "normal";
    const text = document.createElement("input");
    text.type = "text";
    text.dataset.field = "text";
    text.maxLength = 200;
    text.value = line.text || "";
    text.placeholder = "人身事故の影響で遅れが出ています";
    row.append(name, status, text);
    row.dataset.name = line.name;
    rows.append(row);
  });
}

function collectLines() {
  return Array.from($("#lineRows").children).map((row) => ({
    railway: row.dataset.railway || "",
    name: row.dataset.name || "",
    status: row.querySelector('[data-field="status"]').value,
    text: row.querySelector('[data-field="text"]').value.trim(),
  }));
}

/* ---------- 表示の切り替え ---------- */

function renderTabs() {
  document.querySelectorAll("#guideTabs button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.tab === state.tab));
  });
  $("#panelStops").hidden = state.tab !== "stops";
  $("#panelLegs").hidden = state.tab !== "legs";
  $("#panelNotices").hidden = state.tab !== "notices";
  $("#panelCrowd").hidden = state.tab !== "crowd";
  $("#panelLines").hidden = state.tab !== "lines";
}

function render() {
  renderTabs();
  renderStops();
  renderLegs();
  renderNotices();
  renderCrowd();
  renderLines();
  renderEvent();
}

function renderEvent() {
  $("#eventName").value = state.settings.eventName || "";
  $("#eventSaturday").value = state.settings.eventSaturday || "";
  $("#eventSunday").value = state.settings.eventSunday || "";
}

/* ---------- 読み込み ---------- */

async function loadAll() {
  const [stops, legs, notices, crowd, lines, settings, saturday, sunday] = await Promise.all([
    api("/api/stops"),
    api("/api/legs"),
    api("/api/notices"),
    api(`/api/crowd-hints?date=${todayISO()}`),
    api("/api/line-statuses"),
    api("/api/guide/event"),
    api("/api/public/schedule?day=" + encodeURIComponent("土曜")),
    api("/api/public/schedule?day=" + encodeURIComponent("日曜")),
  ]);
  state.stops = stops.stops || [];
  state.legs = legs.legs || [];
  state.notices = notices.notices || [];
  state.crowdHints = crowd.crowdHints || [];
  state.signals = crowd.signals || [];
  state.lines = lines.lines || [];
  state.autoReady = Boolean(lines.autoReady);
  state.settings = settings || {};
  state.timetable["土曜"] = saturday.entries || [];
  state.timetable["日曜"] = sunday.entries || [];
  render();
}

/* ---------- 操作 ---------- */

$("#noticeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await put("/api/notices", {
      id: $("#noticeId").value,
      day: $("#noticeDay").value,
      level: $("#noticeLevel").value,
      title: $("#noticeTitle").value.trim(),
      body: $("#noticeBody").value.trim(),
    });
    const notices = await api("/api/notices");
    state.notices = notices.notices || [];
    fillNoticeForm(null);
    renderNotices();
    toast("お知らせを保存しました");
  } catch (error) {
    showError("#noticeError", error.message);
  }
});

$("#noticeResetButton").addEventListener("click", () => fillNoticeForm(null));

$("#crowdForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await put("/api/crowd-hints", {
      id: $("#crowdId").value,
      day: $("#crowdDay").value,
      direction: $("#crowdDirection").value,
      stop: $("#crowdStop").value,
      level: $("#crowdLevel").value,
      start: $("#crowdStart").value,
      end: $("#crowdEnd").value,
      note: $("#crowdNote").value.trim(),
    });
    const crowd = await api(`/api/crowd-hints?date=${todayISO()}`);
    state.crowdHints = crowd.crowdHints || [];
    state.signals = crowd.signals || [];
    fillCrowdForm(null);
    renderCrowd();
    toast("混雑予測を保存しました");
  } catch (error) {
    showError("#crowdError", error.message);
  }
});

$("#crowdResetButton").addEventListener("click", () => fillCrowdForm(null));

$("#addStopButton").addEventListener("click", () => {
  state.stops = [...state.stops, { id: "", name: "", line: "", place: "", landmark: "", walkMinutes: 0, latitude: 0, longitude: 0, order: state.stops.length + 1 }];
  renderStops();
});

$("#addLegButton").addEventListener("click", () => {
  $("#legRows").append(legRow({}));
});

$("#saveLegsButton").addEventListener("click", async () => {
  try {
    const result = await put("/api/legs", { legs: collectLegs() });
    state.legs = result.legs || [];
    showError("#legError", "");
    renderLegs();
    toast("所要時間を保存しました");
  } catch (error) {
    showError("#legError", error.message);
  }
});

$("#saveEventButton").addEventListener("click", async () => {
  try {
    const saved = await api("/api/guide/event", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName: $("#eventName").value.trim(),
        eventSaturday: $("#eventSaturday").value,
        eventSunday: $("#eventSunday").value,
      }),
    });
    state.settings = saved || {};
    showError("#eventError", "");
    toast("開催日を保存しました");
  } catch (error) {
    showError("#eventError", error.message);
  }
});

$("#saveLinesButton").addEventListener("click", async () => {
  try {
    const result = await put("/api/line-statuses", { lines: collectLines() });
    state.lines = result.lines || [];
    showError("#lineError", "");
    renderLines();
    toast("沿線情報を保存しました");
  } catch (error) {
    showError("#lineError", error.message);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest("#legRows")) renderLegCheck();
});

document.addEventListener("click", async (event) => {
  const tabButton = event.target.closest("#guideTabs button");
  if (tabButton) {
    state.tab = tabButton.dataset.tab;
    history.replaceState(null, "", `#${state.tab}`);
    renderTabs();
    return;
  }
  const removeLeg = event.target.closest('[data-action="remove-leg"]');
  if (removeLeg) {
    removeLeg.closest(".leg-row").remove();
    renderLegCheck();
    return;
  }
  const saveStop = event.target.closest('[data-action="save-stop"]');
  if (saveStop) {
    const card = saveStop.closest(".stop-card");
    try {
      await put("/api/stops", collectStop(card));
      const stops = await api("/api/stops");
      state.stops = stops.stops || [];
      renderStops();
      renderCrowd();
      toast("乗り場を保存しました");
    } catch (error) {
      toast(error.message, "stop");
    }
    return;
  }
  const deleteStop = event.target.closest('[data-action="delete-stop"]');
  if (deleteStop) {
    const card = deleteStop.closest(".stop-card");
    if (!card.dataset.id) {
      card.remove();
      return;
    }
    if (!confirm("この乗り場を削除します。よろしいですか。")) return;
    try {
      await api(`/api/stops/${encodeURIComponent(card.dataset.id)}`, { method: "DELETE" });
      state.stops = state.stops.filter((stop) => stop.id !== card.dataset.id);
      renderStops();
      renderCrowd();
      toast("乗り場を削除しました");
    } catch (error) {
      toast(error.message, "stop");
    }
    return;
  }
  const editNotice = event.target.closest('[data-action="edit-notice"]');
  if (editNotice) {
    fillNoticeForm(state.notices.find((item) => item.id === editNotice.dataset.id));
    return;
  }
  const deleteNotice = event.target.closest('[data-action="delete-notice"]');
  if (deleteNotice) {
    if (!confirm("このお知らせを削除します。よろしいですか。")) return;
    try {
      await api(`/api/notices/${encodeURIComponent(deleteNotice.dataset.id)}`, { method: "DELETE" });
      state.notices = state.notices.filter((item) => item.id !== deleteNotice.dataset.id);
      renderNotices();
      toast("お知らせを削除しました");
    } catch (error) {
      toast(error.message, "stop");
    }
    return;
  }
  const editCrowd = event.target.closest('[data-action="edit-crowd"]');
  if (editCrowd) {
    fillCrowdForm(state.crowdHints.find((item) => item.id === editCrowd.dataset.id));
    return;
  }
  const deleteCrowd = event.target.closest('[data-action="delete-crowd"]');
  if (deleteCrowd) {
    if (!confirm("この混雑予測を削除します。よろしいですか。")) return;
    try {
      await api(`/api/crowd-hints/${encodeURIComponent(deleteCrowd.dataset.id)}`, { method: "DELETE" });
      state.crowdHints = state.crowdHints.filter((item) => item.id !== deleteCrowd.dataset.id);
      renderCrowd();
      toast("混雑予測を削除しました");
    } catch (error) {
      toast(error.message, "stop");
    }
  }
});

loadAll().catch((error) => toast(error.message, "stop"));
