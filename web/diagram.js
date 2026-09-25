/* ダイヤ管理。元ダイヤの追加、変更、削除、Excel取込をまとめて行います。 */
const state = {
  user: null,
  timetable: [],
  day: "土曜",
  operation: "すべて",
  search: "",
  selected: null,
  busy: false,
};

const $ = (selector) => document.querySelector(selector);
const templateKey = (item) => `${item.day}|${item.operationNo}|${item.columnNo}`;

const serviceTypeName = { passenger: "通常便", deadhead: "回送", group: "団体専用", none: "運行なし" };

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
  if (minutes === null) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
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
  $("#importButton").disabled = busy || !$("#excelFile").files.length;
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

function showWorkspace() {
  $("#loginGate").hidden = true;
  $("#workspace").hidden = false;
  $("#currentUser").textContent = `${state.user.name}　${state.user.role === "admin" ? "管理者" : state.user.role}`;
}

/* ---------- 検証 ---------- */

function formPayload() {
  return {
    day: $("#fieldDay").value,
    operationNo: Number($("#fieldOperation").value),
    columnNo: Number($("#fieldColumn").value),
    plannedDeparture: $("#fieldPlannedDeparture").value,
    plannedArrival: $("#fieldPlannedArrival").value,
    route: $("#fieldRoute").value.trim(),
    outboundType: $("#fieldOutboundType").value,
    inboundType: $("#fieldInboundType").value,
    outboundDeparture: $("#fieldOutboundDeparture").value,
    outboundArrival: $("#fieldOutboundArrival").value,
    inboundDeparture: $("#fieldInboundDeparture").value,
    inboundArrival: $("#fieldInboundArrival").value,
    details: $("#fieldDetails").value.trim(),
  };
}

function validatePayload(payload) {
  const errors = [];
  if (payload.day !== "土曜" && payload.day !== "日曜") errors.push("曜日を選んでください。");
  if (!(payload.operationNo >= 1 && payload.operationNo <= 9)) errors.push("運用番号は1から9で入力してください。");
  if (!(payload.columnNo >= 1 && payload.columnNo <= 99)) errors.push("便番号は1から99で入力してください。");
  if (!payload.route) errors.push("全体経路を入力してください。");
  const planStart = clockMinutes(payload.plannedDeparture);
  const planEnd = clockMinutes(payload.plannedArrival);
  if (planStart === null) errors.push("一周の出発時刻を入力してください。");
  if (planEnd === null) errors.push("一周の帰着時刻を入力してください。");
  if (planStart !== null && planEnd !== null && planEnd <= planStart) errors.push("一周の帰着は出発より後にしてください。");
  if (payload.outboundType !== "none" && clockMinutes(payload.outboundDeparture) === null && planStart === null) {
    errors.push("往路の学校発時刻を入力してください。");
  }
  if (payload.inboundType !== "none" && clockMinutes(payload.inboundArrival) === null && planEnd === null) {
    errors.push("復路の学校着時刻を入力してください。");
  }
  const outStart = clockMinutes(payload.outboundDeparture) ?? planStart;
  const outEnd = clockMinutes(payload.outboundArrival);
  const inStart = clockMinutes(payload.inboundDeparture);
  const inEnd = clockMinutes(payload.inboundArrival) ?? planEnd;
  if (outEnd !== null && outStart !== null && outEnd <= outStart) errors.push("駅着は学校発より後にしてください。");
  if (inStart !== null && inEnd !== null && inEnd <= inStart) errors.push("学校着は駅発より後にしてください。");
  if (outEnd !== null && inStart !== null && inStart < outEnd) errors.push("駅発は駅着以降にしてください。");

  state.timetable.forEach((item) => {
    if (item.day !== payload.day || item.operationNo !== payload.operationNo || item.columnNo === payload.columnNo) return;
    if (item.plannedDeparture === payload.plannedDeparture || clockMinutes(item.plannedDeparture) === planStart) {
      errors.push(`運用${payload.operationNo}の${payload.columnNo}便と同じ出発時刻の便（${item.columnNo}便）があります。`);
      return;
    }
    const otherStart = clockMinutes(item.plannedDeparture);
    const otherEnd = clockMinutes(item.plannedArrival);
    if (otherStart !== null && otherEnd !== null && planStart !== null && planEnd !== null && planStart < otherEnd && planEnd > otherStart) {
      errors.push(`運用${payload.operationNo}の${item.columnNo}便（${clockText(item.plannedDeparture)}〜${clockText(item.plannedArrival)}）と時間が重複します。`);
    }
  });
  return errors;
}

function showFormError(messages) {
  const box = $("#formError");
  if (!messages.length) {
    box.hidden = true;
    box.textContent = "";
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

/* ---------- 表示 ---------- */

function renderMetrics() {
  const saturday = state.timetable.filter((item) => item.day === "土曜").length;
  const sunday = state.timetable.filter((item) => item.day === "日曜").length;
  const incomplete = state.timetable.filter((item) => incompleteStationTimes(item).length).length;
  $("#metricTotal").textContent = state.timetable.length;
  $("#metricSaturday").textContent = saturday;
  $("#metricSunday").textContent = sunday;
  $("#metricIncomplete").textContent = incomplete;
  $("#metricIncompleteCard").dataset.tone = incomplete ? "warn" : "";
}

function incompleteStationTimes(item) {
  const missing = [];
  if (item.outboundType !== "none" && clockMinutes(item.outboundArrival) === null) missing.push("駅着");
  if (item.inboundType !== "none" && clockMinutes(item.inboundDeparture) === null) missing.push("駅発");
  return missing;
}

function buildChecks() {
  const checks = [];
  const groups = new Map();
  state.timetable.forEach((item) => {
    const key = `${item.day}|${item.operationNo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  groups.forEach((items, key) => {
    const [day, operation] = key.split("|");
    const sorted = [...items].sort((a, b) => (clockMinutes(a.plannedDeparture) ?? 0) - (clockMinutes(b.plannedDeparture) ?? 0));
    const seen = new Map();
    sorted.forEach((item) => {
      const start = clockMinutes(item.plannedDeparture);
      const end = clockMinutes(item.plannedArrival);
      if (start !== null && seen.has(start)) {
        checks.push({ tone: "stop", text: `${day} 運用${operation}　${clockText(item.plannedDeparture)}発が${seen.get(start)}便と${item.columnNo}便で重複しています`, target: item });
      } else if (start !== null) {
        seen.set(start, item.columnNo);
      }
      if (start !== null && end !== null && end <= start) {
        checks.push({ tone: "stop", text: `${day} 運用${operation} ${item.columnNo}便　帰着${clockText(item.plannedArrival)}が出発${clockText(item.plannedDeparture)}より前です`, target: item });
      }
    });
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      const previousEnd = clockMinutes(previous.plannedArrival);
      const currentStart = clockMinutes(current.plannedDeparture);
      if (previousEnd !== null && currentStart !== null && currentStart < previousEnd) {
        checks.push({ tone: "stop", text: `${day} 運用${operation}　${previous.columnNo}便（帰着${clockText(previous.plannedArrival)}）と${current.columnNo}便（出発${clockText(current.plannedDeparture)}）の時間が重なっています`, target: current });
      }
    }
  });
  const incomplete = state.timetable.filter((item) => incompleteStationTimes(item).length);
  if (incomplete.length) {
    const byDay = ["土曜", "日曜"].map((day) => `${day}${incomplete.filter((item) => item.day === day).length}便`).join("　");
    checks.push({ tone: "warn", text: `駅着または駅発が未入力の便が${incomplete.length}便あります（${byDay}）。一般用では駅の時刻を表示できません`, target: incomplete[0] });
  }
  if (!checks.length) {
    checks.push({ tone: "go", text: `重複と時刻の前後関係に問題はありません。登録${state.timetable.length}便`, target: null });
  }
  return checks;
}

function renderChecks() {
  const list = $("#checkList");
  list.replaceChildren();
  buildChecks().slice(0, 12).forEach((check) => {
    const item = document.createElement("li");
    item.dataset.tone = check.tone;
    const text = document.createElement("span");
    text.textContent = check.text;
    item.append(text);
    if (check.target) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "この便を開く";
      button.dataset.jump = templateKey(check.target);
      item.append(button);
    }
    list.append(item);
  });
}

function renderOperationFilter() {
  const select = $("#listOperationFilter");
  const current = state.operation;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "すべて";
  all.textContent = "すべての運用";
  select.append(all);
  for (let operation = 1; operation <= 9; operation += 1) {
    const count = state.timetable.filter((item) => item.day === state.day && item.operationNo === operation).length;
    const option = document.createElement("option");
    option.value = String(operation);
    option.textContent = `運用${operation}　${count}便`;
    select.append(option);
  }
  select.value = current;
  if (select.value !== current) {
    state.operation = "すべて";
    select.value = "すべて";
  }
}

function listItems() {
  const search = state.search.trim();
  return state.timetable
    .filter((item) => item.day === state.day)
    .filter((item) => state.operation === "すべて" || item.operationNo === Number(state.operation))
    .filter((item) => !search || `${item.plannedDeparture}${item.plannedArrival}${item.route}${item.details}`.includes(search))
    .sort((a, b) => {
      if (a.operationNo !== b.operationNo) return a.operationNo - b.operationNo;
      return (clockMinutes(a.plannedDeparture) ?? 0) - (clockMinutes(b.plannedDeparture) ?? 0);
    });
}

function renderList() {
  const container = $("#runList");
  const items = listItems();
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "該当する便はありません";
    container.append(empty);
    return;
  }
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.key = templateKey(item);
    if (state.selected === templateKey(item)) button.setAttribute("aria-current", "true");
    const title = document.createElement("strong");
    title.textContent = `運用${item.operationNo} ${item.columnNo}便　${clockText(item.plannedDeparture)} → ${clockText(item.plannedArrival)}`;
    const route = document.createElement("span");
    route.textContent = item.route;
    const note = document.createElement("small");
    const missing = incompleteStationTimes(item);
    note.textContent = `往 ${serviceTypeName[item.outboundType] || "通常便"}　復 ${serviceTypeName[item.inboundType] || "通常便"}${missing.length ? `　${missing.join("と")}が未入力` : ""}`;
    button.append(title, route, note);
    container.append(button);
  });
}

function renderPreview() {
  const payload = formPayload();
  const schoolDeparture = payload.outboundType === "none" ? "" : payload.outboundDeparture || payload.plannedDeparture;
  const schoolArrival = payload.inboundType === "none" ? "" : payload.inboundArrival || payload.plannedArrival;
  const stationArrival = payload.outboundType === "none" ? "" : payload.outboundArrival;
  const stationDeparture = payload.inboundType === "none" ? "" : payload.inboundDeparture;
  const fields = [
    ["#previewSchoolDeparture", schoolDeparture],
    ["#previewStationArrival", stationArrival],
    ["#previewStationDeparture", stationDeparture],
    ["#previewSchoolArrival", schoolArrival],
  ];
  fields.forEach(([selector, value]) => {
    const node = $(selector);
    node.textContent = clockText(value);
    node.classList.toggle("unset", clockMinutes(value) === null);
  });
  const notes = [];
  if (payload.outboundType !== "passenger") notes.push(`往路は${serviceTypeName[payload.outboundType]}のため、一般用には表示しません。`);
  if (payload.inboundType !== "passenger") notes.push(`復路は${serviceTypeName[payload.inboundType]}のため、一般用には表示しません。`);
  if (clockMinutes(stationArrival) === null && payload.outboundType !== "none") notes.push("駅着が未入力のため、往路は学校発だけを表示します。");
  if (clockMinutes(stationDeparture) === null && payload.inboundType !== "none") notes.push("駅発が未入力のため、復路は学校着だけを表示します。");
  $("#previewNote").textContent = notes.join(" ");
}

function renderDaySwitch() {
  document.querySelectorAll("#listDaySwitch button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.day === state.day));
  });
}

function render() {
  renderDaySwitch();
  renderMetrics();
  renderChecks();
  renderOperationFilter();
  renderList();
  renderPreview();
}

/* ---------- 編集 ---------- */

function nextColumn(day, operation) {
  return state.timetable
    .filter((item) => item.day === day && item.operationNo === operation)
    .reduce((max, item) => Math.max(max, item.columnNo), 0) + 1;
}

function selectTemplate(item) {
  state.selected = item ? templateKey(item) : null;
  const operation = state.operation === "すべて" ? 1 : Number(state.operation);
  const value = item || {
    day: state.day,
    operationNo: operation,
    columnNo: nextColumn(state.day, operation),
    plannedDeparture: "",
    plannedArrival: "",
    route: "",
    outboundType: "passenger",
    inboundType: "passenger",
    outboundDeparture: "",
    outboundArrival: "",
    inboundDeparture: "",
    inboundArrival: "",
    details: "",
  };
  $("#fieldDay").value = value.day;
  $("#fieldOperation").value = value.operationNo;
  $("#fieldColumn").value = value.columnNo;
  $("#fieldPlannedDeparture").value = timeInputValue(value.plannedDeparture);
  $("#fieldPlannedArrival").value = timeInputValue(value.plannedArrival);
  $("#fieldRoute").value = value.route || "";
  $("#fieldOutboundType").value = value.outboundType || "passenger";
  $("#fieldInboundType").value = value.inboundType || "passenger";
  $("#fieldOutboundDeparture").value = timeInputValue(value.outboundDeparture);
  $("#fieldOutboundArrival").value = timeInputValue(value.outboundArrival);
  $("#fieldInboundDeparture").value = timeInputValue(value.inboundDeparture);
  $("#fieldInboundArrival").value = timeInputValue(value.inboundArrival);
  $("#fieldDetails").value = value.details || "";
  $("#deleteButton").hidden = !item;
  $("#formSubtitle").textContent = item
    ? `${item.day} 運用${item.operationNo} ${item.columnNo}便を編集しています`
    : "新しい便を追加します";
  showFormError([]);
  renderList();
  renderPreview();
}

async function loadTimetable(keepSelection = false) {
  const data = await api("/api/timetable");
  state.timetable = Array.isArray(data.timetable) ? data.timetable : [];
  const previous = state.selected;
  render();
  if (keepSelection && previous) {
    const item = state.timetable.find((entry) => templateKey(entry) === previous);
    if (item) {
      selectTemplate(item);
      return;
    }
  }
  if (!keepSelection) selectTemplate(state.timetable.find((item) => item.day === state.day) || null);
}

async function saveTemplate(event) {
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
    const saved = await api("/api/timetable", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.timetable = state.timetable.filter((item) => templateKey(item) !== templateKey(saved));
    state.timetable.push(saved);
    state.day = saved.day;
    state.selected = templateKey(saved);
    render();
    selectTemplate(saved);
    toast(`${saved.day} 運用${saved.operationNo} ${saved.columnNo}便を保存しました`, "ok");
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
  const existing = state.timetable.find((item) => item.day === targetDay && item.operationNo === payload.operationNo && item.columnNo === payload.columnNo);
  const message = existing
    ? `${targetDay} 運用${payload.operationNo} ${payload.columnNo}便（${clockText(existing.plannedDeparture)}発）を、この内容で上書きします。よろしいですか。`
    : `${targetDay} 運用${payload.operationNo} ${payload.columnNo}便として複製します。よろしいですか。`;
  if (!confirm(message)) return;
  setBusy(true);
  try {
    const saved = await api("/api/timetable", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, day: targetDay }),
    });
    state.timetable = state.timetable.filter((item) => templateKey(item) !== templateKey(saved));
    state.timetable.push(saved);
    render();
    toast(`${targetDay}へ複製しました`, "ok");
  } catch (error) {
    showFormError([error.message]);
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function deleteTemplate() {
  if (state.busy || !state.selected) return;
  const item = state.timetable.find((entry) => templateKey(entry) === state.selected);
  if (!item) return;
  if (!confirm(`${item.day} 運用${item.operationNo} ${item.columnNo}便（${clockText(item.plannedDeparture)}発 ${item.route}）を削除します。記録のない運行も同時に削除されます。よろしいですか。`)) return;
  setBusy(true);
  try {
    const result = await api(`/api/timetable/${encodeURIComponent(item.day)}/${item.operationNo}/${item.columnNo}`, { method: "DELETE" });
    state.timetable = state.timetable.filter((entry) => templateKey(entry) !== templateKey(item));
    state.selected = null;
    render();
    selectTemplate(state.timetable.find((entry) => entry.day === state.day) || null);
    toast(`便を削除しました。未記録の運行${result.removedRuns || 0}件も削除しました`, "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function importExcel() {
  const file = $("#excelFile").files[0];
  if (!file || state.busy) return;
  if (!confirm("元ダイヤ全体を取り込み内容へ置き換えます。よろしいですか。")) return;
  setBusy(true);
  const button = $("#importButton");
  const original = button.textContent;
  button.textContent = "取り込み中";
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/timetable/import", { method: "POST", body: form });
    $("#excelFile").value = "";
    state.selected = null;
    await loadTimetable();
    toast(`${result.count}便を取り込みました。駅着と駅発を確認してください`, "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.textContent = original;
    setBusy(false);
  }
}

/* ---------- ログイン ---------- */

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
    showLogin("ダイヤ管理は管理者権限が必要です。運行の記録は職員用画面から行ってください。");
    try { await api("/api/logout", { method: "POST" }); } catch {}
    return;
  }
  state.user = user;
  showWorkspace();
  await loadTimetable();
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

/* ---------- イベント ---------- */

$("#loginForm").addEventListener("submit", login);
$("#templateForm").addEventListener("submit", saveTemplate);
$("#copyDayButton").addEventListener("click", copyToOtherDay);
$("#deleteButton").addEventListener("click", deleteTemplate);
$("#newTemplateButton").addEventListener("click", () => selectTemplate(null));
$("#importButton").addEventListener("click", importExcel);
$("#excelFile").addEventListener("change", () => { $("#importButton").disabled = !$("#excelFile").files.length; });
$("#listOperationFilter").addEventListener("change", (event) => {
  state.operation = event.target.value;
  renderList();
});
$("#listSearch").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderList();
});
$("#logoutButton").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  showLogin("終了しました。");
});
$("#templateForm").addEventListener("input", renderPreview);
$("#templateForm").addEventListener("change", renderPreview);

document.addEventListener("click", (event) => {
  const dayButton = event.target.closest("#listDaySwitch button");
  if (dayButton) {
    state.day = dayButton.dataset.day;
    state.selected = null;
    render();
    selectTemplate(state.timetable.find((item) => item.day === state.day) || null);
    return;
  }
  const listButton = event.target.closest("#runList button[data-key]");
  if (listButton) {
    const item = state.timetable.find((entry) => templateKey(entry) === listButton.dataset.key);
    if (item) selectTemplate(item);
    return;
  }
  const jumpButton = event.target.closest("#checkList button[data-jump]");
  if (jumpButton) {
    const item = state.timetable.find((entry) => templateKey(entry) === jumpButton.dataset.jump);
    if (!item) return;
    state.day = item.day;
    state.operation = String(item.operationNo);
    render();
    selectTemplate(item);
    $("#formHeading").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

initialize();
