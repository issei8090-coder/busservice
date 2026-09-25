/* ステージプログラム管理。登録した進行は一般用の「イベント」に反映されます。 */
const state = {
  user: null,
  programs: [],
  schedules: { 土曜: [], 日曜: [] },
  day: "土曜",
  search: "",
  selected: null,
  busy: false,
};

const $ = (selector) => document.querySelector(selector);

function toast(message, tone = "info") {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;
  node.textContent = message;
  $("#toastRegion").append(node);
  setTimeout(() => node.remove(), 5000);
}

function clockMinutes(value) {
  if (!value) return null;
  const parts = String(value).split(":");
  if (parts.length !== 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function clockText(value) {
  const minutes = clockMinutes(value);
  if (minutes === null) return "—";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeInputValue(value) {
  const minutes = clockMinutes(value);
  return minutes === null ? "" : clockText(value);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    if (response.status === 401) showLogin("ログインの有効時間が切れました。もう一度ログインしてください。");
    const error = new Error(body.error || "処理に失敗しました");
    error.status = response.status;
    throw error;
  }
  return body;
}

function setBusy(busy) {
  state.busy = busy;
  $("#saveButton").disabled = busy;
  $("#copyDayButton").disabled = busy;
  $("#deleteButton").disabled = busy;
}

function showLogin(message) {
  state.user = null;
  $("#workspace").hidden = true;
  $("#loginGate").hidden = false;
  const error = $("#loginError");
  if (message) {
    error.textContent = message;
    error.hidden = false;
  } else {
    error.hidden = true;
  }
  $("#loginStaffId").focus();
}

/* ---------- バスとの突き合わせ ---------- */

// 行き 駅から学校へ着く便のうち、開始時刻までに到着するもの
function arrivalBuses(day, start) {
  const limit = clockMinutes(start);
  if (limit === null) return [];
  return (state.schedules[day] || [])
    .filter((entry) => entry.inboundType === "passenger" && entry.status !== "cancelled")
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

// 一般用と同じ選び方 5分以上の余裕がある便を優先します。
function recommendedArrivals(day, start) {
  const all = arrivalBuses(day, start);
  const comfortable = all.filter((bus) => bus.margin >= 5);
  return comfortable.length ? comfortable.slice(0, 2) : all.slice(0, 1);
}

// 帰り 終了後に学校から駅へ向かう便
function departureBuses(day, end, start) {
  const limit = clockMinutes(end) ?? clockMinutes(start);
  if (limit === null) return [];
  return (state.schedules[day] || [])
    .filter((entry) => entry.outboundType === "passenger" && entry.status !== "cancelled")
    .map((entry) => ({
      stops: (entry.stops || []).join("・"),
      schoolDeparture: entry.schoolDeparture,
      minutes: clockMinutes(entry.schoolDeparture),
    }))
    .filter((bus) => bus.minutes !== null && bus.minutes >= limit)
    .sort((a, b) => a.minutes - b.minutes)
    .map((bus) => ({ ...bus, wait: bus.minutes - limit }));
}

function recommendedDeparture(day, end, start) {
  const all = departureBuses(day, end, start);
  return all.find((bus) => bus.wait >= 5) || all[0] || null;
}

/* ---------- 表示 ---------- */

function renderMetrics() {
  const saturday = state.programs.filter((item) => item.day === "土曜").length;
  const sunday = state.programs.filter((item) => item.day === "日曜").length;
  const noBus = state.programs.filter((item) => !arrivalBuses(item.day, item.start).length).length;
  $("#metricTotal").textContent = state.programs.length;
  $("#metricSaturday").textContent = saturday;
  $("#metricSunday").textContent = sunday;
  $("#metricNoBus").textContent = noBus;
  $("#metricBusCard").dataset.tone = noBus ? "warn" : "";
}

function renderDaySwitch() {
  document.querySelectorAll("#listDaySwitch button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.day === state.day));
  });
}

function listItems() {
  const search = state.search.trim();
  return state.programs
    .filter((item) => item.day === state.day)
    .filter((item) => !search || `${item.stage}${item.title}${item.details}${item.start}`.includes(search))
    .sort((a, b) => (clockMinutes(a.start) ?? 0) - (clockMinutes(b.start) ?? 0));
}

function renderList() {
  const container = $("#programList");
  const items = listItems();
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "この曜日の進行はまだありません";
    container.append(empty);
    return;
  }
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.id = item.id;
    if (state.selected === item.id) button.setAttribute("aria-current", "true");
    const title = document.createElement("strong");
    title.textContent = `${clockText(item.start)}${item.end ? ` - ${clockText(item.end)}` : ""}`;
    const name = document.createElement("span");
    name.textContent = item.title;
    const note = document.createElement("small");
    const buses = recommendedArrivals(item.day, item.start);
    note.textContent = `${item.stage}　${buses.length ? `間に合うバス ${clockText(buses[0].schoolArrival)}着` : "間に合うバスなし"}`;
    button.append(title, name, note);
    container.append(button);
  });
}

function renderPreview() {
  const day = $("#fieldDay").value;
  const start = $("#fieldStart").value;
  const end = $("#fieldEnd").value;
  const container = $("#previewBuses");
  container.replaceChildren();
  const going = recommendedArrivals(day, start);
  const back = recommendedDeparture(day, end, start);
  const backList = back ? [back] : [];
  if (!going.length && !backList.length) {
    $("#previewNote").textContent = clockMinutes(start) === null ? "開始時刻を入力すると、間に合うバスを表示します。" : "この時間に間に合うバスがありません。ダイヤ管理で便を確認してください。";
    return;
  }
  going.slice(0, 2).forEach((bus, index) => {
    const block = document.createElement("div");
    const label = document.createElement("small");
    label.textContent = index === 0 ? "行き 最終" : "行き 1本前";
    const value = document.createElement("strong");
    value.textContent = `${clockText(bus.schoolArrival)}着`;
    block.append(label, value);
    container.append(block);
  });
  backList.forEach((bus) => {
    const block = document.createElement("div");
    const label = document.createElement("small");
    label.textContent = "帰り 最初";
    const value = document.createElement("strong");
    value.textContent = `${clockText(bus.schoolDeparture)}発`;
    block.append(label, value);
    container.append(block);
  });
  const notes = [];
  if (going.length) notes.push(`行きは ${going[0].stops} からの便が開始${going[0].margin}分前に学校着です。`);
  else notes.push("開始時刻までに学校へ着くバスがありません。");
  if (back) notes.push(`帰りは終了${back.wait}分後に ${back.stops} ゆきが出ます。`);
  else notes.push("終了後に学校を出るバスがありません。");
  $("#previewNote").textContent = notes.join(" ");
}

function render() {
  renderDaySwitch();
  renderMetrics();
  renderList();
  renderPreview();
}

/* ---------- 編集 ---------- */

function selectProgram(item) {
  state.selected = item ? item.id : null;
  const value = item || { id: "", day: state.day, stage: "", title: "", start: "", end: "", details: "" };
  $("#fieldId").value = value.id;
  $("#fieldDay").value = value.day;
  $("#fieldStage").value = value.stage;
  $("#fieldTitle").value = value.title;
  $("#fieldStart").value = timeInputValue(value.start);
  $("#fieldEnd").value = timeInputValue(value.end);
  $("#fieldDetails").value = value.details || "";
  $("#deleteButton").hidden = !item;
  $("#formSubtitle").textContent = item ? `${item.day} ${item.stage} ${item.title} を編集しています` : "新しい進行を追加します";
  $("#formError").hidden = true;
  renderList();
  renderPreview();
}

function formPayload() {
  return {
    id: $("#fieldId").value,
    day: $("#fieldDay").value,
    stage: $("#fieldStage").value.trim(),
    title: $("#fieldTitle").value.trim(),
    start: $("#fieldStart").value,
    end: $("#fieldEnd").value,
    details: $("#fieldDetails").value.trim(),
  };
}

function validatePayload(payload) {
  const errors = [];
  if (!payload.stage) errors.push("会場を入力してください。");
  if (!payload.title) errors.push("内容を入力してください。");
  const start = clockMinutes(payload.start);
  const end = clockMinutes(payload.end);
  if (start === null) errors.push("開始時刻を入力してください。");
  if (end !== null && start !== null && end <= start) errors.push("終了は開始より後にしてください。");
  return errors;
}

function showFormError(messages) {
  const box = $("#formError");
  if (!messages.length) {
    box.hidden = true;
    return;
  }
  box.replaceChildren();
  const list = document.createElement("ul");
  list.style.margin = "0";
  list.style.paddingLeft = "20px";
  messages.forEach((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    list.append(item);
  });
  box.append(list);
  box.hidden = false;
  box.focus();
}

async function saveProgram(event) {
  event.preventDefault();
  if (state.busy) return;
  const payload = formPayload();
  const errors = validatePayload(payload);
  if (errors.length) {
    showFormError(errors);
    return;
  }
  setBusy(true);
  try {
    const saved = await api("/api/programs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.programs = state.programs.filter((item) => item.id !== saved.id);
    state.programs.push(saved);
    state.day = saved.day;
    render();
    selectProgram(saved);
    toast(`${saved.title} を保存しました`, "ok");
  } catch (error) {
    showFormError([error.message]);
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function copyToOtherDay() {
  if (state.busy) return;
  const payload = formPayload();
  const errors = validatePayload(payload);
  if (errors.length) {
    showFormError(errors);
    return;
  }
  const targetDay = payload.day === "土曜" ? "日曜" : "土曜";
  if (!confirm(`${targetDay}へ「${payload.title}」を複製します。よろしいですか。`)) return;
  setBusy(true);
  try {
    const saved = await api("/api/programs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, id: "", day: targetDay }),
    });
    state.programs.push(saved);
    render();
    toast(`${targetDay}へ複製しました`, "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function deleteProgram() {
  if (state.busy || !state.selected) return;
  const item = state.programs.find((entry) => entry.id === state.selected);
  if (!item) return;
  if (!confirm(`${item.day} ${item.stage}「${item.title}」を削除します。よろしいですか。`)) return;
  setBusy(true);
  try {
    await api(`/api/programs/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    state.programs = state.programs.filter((entry) => entry.id !== item.id);
    state.selected = null;
    render();
    selectProgram(null);
    toast("進行を削除しました", "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

/* ---------- 読み込みとログイン ---------- */

async function loadAll() {
  const [programs, saturday, sunday] = await Promise.all([
    api("/api/programs"),
    api("/api/public/schedule?day=土曜"),
    api("/api/public/schedule?day=日曜"),
  ]);
  state.programs = Array.isArray(programs.programs) ? programs.programs : [];
  state.schedules = { 土曜: saturday.entries || [], 日曜: sunday.entries || [] };
  render();
  selectProgram(listItems()[0] || null);
}

async function login(event) {
  event.preventDefault();
  const button = $("#loginSubmit");
  button.disabled = true;
  button.textContent = "確認中";
  try {
    const result = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: $("#loginStaffId").value.trim(), pin: $("#loginPin").value }),
    });
    $("#loginPin").value = "";
    await startSession(result.user);
  } catch (error) {
    const box = $("#loginError");
    box.textContent = error.message;
    box.hidden = false;
    box.focus();
  } finally {
    button.disabled = false;
    button.textContent = "ログイン";
  }
}

async function startSession(user) {
  if (user.role !== "admin") {
    showLogin("プログラム管理は管理者権限が必要です。");
    try { await api("/api/logout", { method: "POST" }); } catch {}
    return;
  }
  state.user = user;
  $("#loginGate").hidden = true;
  $("#workspace").hidden = false;
  $("#currentUser").textContent = `${user.name}　管理者`;
  await loadAll();
}

async function initialize() {
  try {
    const session = await api("/api/session");
    await startSession(session.user);
  } catch (error) {
    if (error.status === 401) showLogin();
    else showLogin(error.message);
  }
}

$("#loginForm").addEventListener("submit", login);
$("#programForm").addEventListener("submit", saveProgram);
$("#programForm").addEventListener("input", renderPreview);
$("#programForm").addEventListener("change", renderPreview);
$("#copyDayButton").addEventListener("click", copyToOtherDay);
$("#deleteButton").addEventListener("click", deleteProgram);
$("#newProgramButton").addEventListener("click", () => selectProgram(null));
$("#listSearch").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderList();
});
$("#logoutButton").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  showLogin("終了しました。");
});

document.addEventListener("click", (event) => {
  const dayButton = event.target.closest("#listDaySwitch button");
  if (dayButton) {
    state.day = dayButton.dataset.day;
    state.selected = null;
    render();
    selectProgram(listItems()[0] || null);
    return;
  }
  const listButton = event.target.closest("#programList button[data-id]");
  if (listButton) {
    const item = state.programs.find((entry) => entry.id === listButton.dataset.id);
    if (item) selectProgram(item);
  }
});

initialize();
