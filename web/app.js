const state = {
  date: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()),
  day: "土曜",
  runs: [],
  events: [],
  status: "all",
  query: "",
  editing: null,
  confirming: null,
  busy: false,
  countTimers: new Map(),
  driveOpen: false,
  driveTimer: null,
  wakeLock: null,
  wakeWanted: false,
  lastFocused: null,
  serverReachable: null,
  driveRunId: null,
  driveOperationNo: null,
  driveSettings: readStoredJSON("busDriveSettings", { vehicleNo: "", driverName: "", capacity: 55, audioEnabled: true, gpsEnabled: false }),
  offlineQueue: readStoredJSON("busOfflineQueue", []),
  syncingOffline: false,
  notifiedDepartures: new Set(readStoredJSON("busDepartureNotified", [])),
  gpsWatchId: null,
  gpsPosition: null,
  gpsError: "GPS停止中",
  lastGpsSentAt: 0,
  lastGpsCoords: null,
  lastSyncAttempt: 0,
};

const statusInfo = {
  waiting: ["待機", ""],
  boarding: ["乗車受付", "boarding"],
  departed: ["運行中", "departed"],
  arrived: ["到着済", "arrived"],
  cancelled: ["運休", "cancelled"],
};

const actionInfo = {
  waiting: ["乗車受付", "boarding", ""],
  boarding: ["出発", "depart", "depart"],
  departed: ["到着", "arrive", "arrive"],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function readStoredJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch { return fallback; }
}

function storeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function requestID() {
  return crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function icon(name) {
  const paths = {
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4"/>',
    arrow: '<path d="m9 18 6-6-6-6"/>',
    bus: '<path d="M6 16h12M5 5h14v13H5zM8 20v-2m8 2v-2"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.bus}</svg>`;
}

function loaderMarkup(label = "読み込んでいます", compact = false) {
  return `<div class="loader-wrap ${compact ? "compact" : ""}" role="status"><svg class="pl" viewBox="0 0 240 240" aria-hidden="true"><circle class="pl__ring pl__ring--a" cx="120" cy="120" r="105" fill="none" stroke-width="20" stroke-dasharray="0 660" stroke-dashoffset="-330"/><circle class="pl__ring pl__ring--b" cx="120" cy="120" r="35" fill="none" stroke-width="20" stroke-dasharray="0 220" stroke-dashoffset="-110"/><circle class="pl__ring pl__ring--c" cx="85" cy="120" r="70" fill="none" stroke-width="20" stroke-dasharray="0 440"/><circle class="pl__ring pl__ring--d" cx="155" cy="120" r="70" fill="none" stroke-width="20" stroke-dasharray="0 440"/></svg><strong>${escapeHTML(label)}</strong></div>`;
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  $("#toastRegion").append(item);
  setTimeout(() => item.remove(), 3800);
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
    state.serverReachable = true;
    if (state.offlineQueue.length && !state.syncingOffline) setTimeout(syncOfflineQueue, 0);
  } catch (error) {
    state.serverReachable = false;
    error.networkFailure = true;
    updateConnectionStatus();
    throw error;
  }
  updateConnectionStatus();
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || "処理に失敗しました");
    error.status = response.status;
    throw error;
  }
  return body;
}

function enqueueMutation(url, method, body, label) {
  const item = { id: body.requestId || requestID(), url, method, body, label, queuedAt: new Date().toISOString() };
  item.body.requestId = item.id;
  const replaceLatest = label === "乗車人数" || label === "GPS位置" || label === "運用設定";
  const existingIndex = replaceLatest ? state.offlineQueue.findIndex((queued) => queued.method === method && queued.url === url && queued.label === label) : -1;
  if (existingIndex >= 0) state.offlineQueue.splice(existingIndex, 1, item);
  else state.offlineQueue.push(item);
  storeJSON("busOfflineQueue", state.offlineQueue);
  updateConnectionStatus();
  return item;
}

async function mutate(url, method, body, label) {
  try {
    const data = await api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { data, queued: false };
  } catch (error) {
    if (!error.networkFailure && navigator.onLine) throw error;
    enqueueMutation(url, method, body, label);
    return { data: null, queued: true };
  }
}

async function syncOfflineQueue() {
  if (state.syncingOffline || !navigator.onLine || !state.offlineQueue.length) return;
  state.syncingOffline = true;
  let rejected = 0;
  try {
    while (state.offlineQueue.length && navigator.onLine) {
      const item = state.offlineQueue[0];
      try {
        await api(item.url, { method: item.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.body) });
        state.offlineQueue.shift();
        storeJSON("busOfflineQueue", state.offlineQueue);
      } catch (error) {
        if (error.networkFailure || !navigator.onLine || (error.status || 500) >= 500) break;
        state.offlineQueue.shift();
        rejected += 1;
        storeJSON("busOfflineQueue", state.offlineQueue);
      }
    }
    if (!state.offlineQueue.length) {
      await loadDashboard(true);
      if (!rejected) toast("保留していた操作を同期しました");
    }
    if (rejected) toast(`${rejected}件の保留操作を確認できませんでした`, "error");
  } finally {
    state.syncingOffline = false;
    updateConnectionStatus();
  }
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle("busy", value);
  document.body.setAttribute("aria-busy", String(value));
  $("#busyOverlay").hidden = !value;
  $("#busyOverlay").innerHTML = value ? loaderMarkup("保存しています") : "";
}

async function loadDashboard(silent = false) {
  if (!silent) $("#runsContent").innerHTML = `<div class="loading">${loaderMarkup("運行便を準備しています")}</div>`;
  const cacheKey = `busDashboard:${state.date}:${state.day}`;
  try {
    const data = await api(`/api/dashboard?date=${encodeURIComponent(state.date)}&day=${encodeURIComponent(state.day)}`);
    state.runs = data.runs || [];
    state.events = data.events || [];
    $("#timetableCount").textContent = `${data.timetableCount || 0}便`;
    storeJSON(cacheKey, { runs: state.runs, events: state.events, timetableCount: data.timetableCount || 0 });
    renderAll();
  } catch (error) {
    const cached = readStoredJSON(cacheKey, null);
    if (error.networkFailure && cached?.runs) {
      state.runs = cached.runs;
      state.events = cached.events || [];
      $("#timetableCount").textContent = `${cached.timetableCount || 0}便`;
      renderAll();
      toast("通信がないため保存済み情報を表示しています", "error");
      return;
    }
    $("#runsContent").innerHTML = `<div class="empty"><div><strong>運行便を読み込めませんでした</strong><p>${escapeHTML(error.message)}</p></div></div>`;
    toast(error.message, "error");
  }
}

function metrics() {
  return {
    waiting: state.runs.filter((run) => run.status === "waiting" || run.status === "boarding").length,
    active: state.runs.filter((run) => run.status === "departed").length,
    arrived: state.runs.filter((run) => run.status === "arrived").length,
    delayed: state.runs.filter((run) => (run.departureDelayMinutes || 0) >= 5 || (run.arrivalDelayMinutes || 0) >= 5).length,
    passengers: state.runs.reduce((sum, run) => sum + Number(run.passengerCount || 0), 0),
  };
}

function actualTime(value) {
  if (!value) return "未記録";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未記録" : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(date);
}

function delayText(value) {
  if (value === null || value === undefined) return "";
  return value <= 0 ? "定刻" : `${value}分遅れ`;
}

function visibleRuns() {
  const query = state.query.trim().toLowerCase();
  return state.runs.filter((run) => {
    if (state.status !== "all" && run.status !== state.status) return false;
    const target = `${run.operationNo} ${run.route} ${run.vehicleNo} ${run.driverName}`.toLowerCase();
    return !query || target.includes(query);
  });
}

function priorityRun() {
  return state.runs.find((run) => run.status === "departed")
    || state.runs.find((run) => run.status === "boarding")
    || state.runs.find((run) => run.status === "waiting")
    || null;
}

function plannedDate(time) {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = String(Number(match[1])).padStart(2, "0");
  return new Date(`${state.date}T${hour}:${match[2]}:00+09:00`);
}

function durationText(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Math.abs(milliseconds) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function countdownInfo(run, now = new Date()) {
  const isActive = run?.status === "departed";
  const targetLabel = isActive ? "予定到着" : "出発";
  const targetTime = isActive ? run?.plannedArrival : run?.plannedDeparture;
  const target = plannedDate(targetTime);
  if (!target || !run) return { label: `${targetLabel}まで`, value: "--:--", detail: "予定時刻なし", late: false };
  const difference = target.getTime() - now.getTime();
  return {
    label: difference >= 0 ? `${targetLabel}まで` : `${targetLabel}予定から`,
    value: durationText(difference),
    detail: `${targetLabel} ${targetTime}`,
    late: difference < 0,
  };
}

function nextRunAfter(run) {
  const index = state.runs.findIndex((item) => item.id === run?.id);
  return state.runs.slice(Math.max(0, index + 1)).find((item) => item.operationNo === run?.operationNo && !["arrived", "cancelled"].includes(item.status)) || null;
}

function driveRun() {
  const selected = state.runs.find((item) => item.id === state.driveRunId);
  if (selected && !["arrived", "cancelled"].includes(selected.status)) return selected;
  const nextInOperation = state.runs.find((item) => item.operationNo === state.driveOperationNo && !["arrived", "cancelled"].includes(item.status));
  return nextInOperation || priorityRun();
}

function routeStops(run) {
  const stops = String(run?.route || "").split("→").map((stop) => stop.trim()).filter(Boolean);
  return stops.length ? stops : ["経路未設定"];
}

function capacityInfo(run) {
  const capacity = Number(run?.capacity || state.driveSettings.capacity || 55);
  const passengers = Number(run?.passengerCount || 0);
  if (passengers > capacity) return { capacity, className: "over", text: `定員を${passengers - capacity}名超過しています` };
  if (passengers === capacity) return { capacity, className: "full", text: "定員に達しています" };
  return { capacity, className: "", text: `残り${Math.max(0, capacity - passengers)}名` };
}

function gpsDisplay(run) {
  const position = state.gpsPosition;
  const latitude = position?.latitude ?? run?.latitude;
  const longitude = position?.longitude ?? run?.longitude;
  const accuracy = position?.accuracy ?? run?.locationAccuracy;
  if (!latitude && !longitude) return { status: state.gpsError, coordinates: "位置情報なし", detail: "GPSを有効にすると現在地を保存します" };
  const capturedAt = position?.capturedAt || run?.locationUpdatedAt;
  return {
    status: state.gpsError || "GPS取得中",
    coordinates: `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`,
    detail: `精度 約${Math.round(Number(accuracy || 0))}m${capturedAt ? `　${actualTime(capturedAt)}更新` : ""}`,
  };
}

function routeProgressMarkup(run) {
  const stops = routeStops(run);
  const index = Math.max(0, Math.min(stops.length - 1, Number(run.progressIndex || 0)));
  const gps = gpsDisplay(run);
  return `<section class="drive-route-progress" aria-labelledby="driveProgressHeading">
    <div class="drive-progress-heading"><div><span>経路進捗</span><strong id="driveProgressHeading">現在地 ${escapeHTML(stops[index])}</strong></div><div class="drive-gps-state" role="status" aria-live="polite" aria-atomic="true"><span id="driveGpsStatus">${escapeHTML(gps.status)}</span><strong id="driveGpsCoordinates">${escapeHTML(gps.coordinates)}</strong><small id="driveGpsDetail">${escapeHTML(gps.detail)}</small></div></div>
    <ol class="drive-stop-list">${stops.map((stop, stopIndex) => `<li class="${stopIndex < index ? "done" : stopIndex === index ? "current" : ""}"><i></i><span>${escapeHTML(stop)}</span></li>`).join("")}</ol>
    <div class="drive-progress-actions"><button type="button" data-progress-delta="-1" data-id="${escapeHTML(run.id)}" ${index === 0 ? "disabled" : ""}>前の地点</button><button type="button" data-gps-retry>GPS再取得</button><button type="button" data-progress-delta="1" data-id="${escapeHTML(run.id)}" ${index >= stops.length - 1 ? "disabled" : ""}>次の地点</button></div>
  </section>`;
}

function renderDriveView() {
  if (!state.driveOpen) return;
  const run = driveRun();
  if (run) {
    state.driveRunId = run.id;
    state.driveOperationNo = run.operationNo;
  }
  $("#driveServiceLabel").textContent = `${state.date}　${state.day}運行${run ? `　運用 ${run.operationNo}` : ""}`;
  if (!run) {
    $("#driveContent").innerHTML = `<div class="drive-empty">${icon("bus")}<strong>本日の運行は完了しています</strong><span>当日運行へ戻り、履歴を確認できます。</span></div>`;
    updateDriveTick();
    return;
  }
  const [statusLabel, statusClass] = statusInfo[run.status] || statusInfo.waiting;
  const next = actionInfo[run.status];
  const following = nextRunAfter(run);
  const countdown = countdownInfo(run);
  const capacity = capacityInfo(run);
  const actionLabel = run.status === "waiting" ? "乗車受付を開始" : run.status === "boarding" ? "出発を記録" : "到着を記録";
  $("#driveContent").innerHTML = `
    <section class="drive-primary ${statusClass || run.status}">
      <div class="drive-run-topline"><span class="drive-status ${statusClass}">${statusLabel}</span><span>運用 ${run.operationNo}　便 ${run.columnNo}</span></div>
      <div class="drive-route"><strong>${escapeHTML(run.route)}</strong><span>${escapeHTML(run.vehicleNo || "車両未定")}　${escapeHTML(run.driverName || "担当未定")}</span></div>
      <div class="drive-countdown ${countdown.late ? "late" : ""}"><span id="driveCountdownLabel">${countdown.label}</span><strong id="driveCountdown" role="timer">${countdown.value}</strong><small id="driveCountdownDetail">${countdown.detail}</small></div>
      ${run.note ? `<div class="drive-note"><strong>注意事項</strong><span>${escapeHTML(run.note)}</span></div>` : ""}
    </section>
    <section class="drive-passengers ${capacity.className}" aria-labelledby="drivePassengerHeading">
      <div class="drive-section-heading"><span>乗車人数　定員 ${capacity.capacity}名</span><strong id="drivePassengerHeading">${escapeHTML(capacity.text)}</strong></div>
      <label class="drive-passenger-value"><span class="sr-only">現在の乗車人数</span><input type="number" min="0" max="999" value="${Number(run.passengerCount || 0)}" data-count-input="${escapeHTML(run.id)}"><small>名</small></label>
      <div class="drive-count-actions">
        <button type="button" data-count-delta="-1" data-id="${escapeHTML(run.id)}" aria-label="乗車人数を1名減らす">−1名</button>
        <button type="button" data-count-delta="1" data-id="${escapeHTML(run.id)}" aria-label="乗車人数を1名増やす">＋1名</button>
        <button type="button" class="drive-plus-ten" data-count-delta="10" data-id="${escapeHTML(run.id)}" aria-label="乗車人数を10名増やす">＋10名</button>
      </div>
    </section>
    <section class="drive-action-panel">
      ${next ? `<button type="button" class="drive-main-action ${next[2]}" data-action="${next[1]}" data-id="${escapeHTML(run.id)}"><span>${actionLabel}</span>${icon("arrow")}</button>` : '<div class="drive-action-complete">この便の操作は完了しています</div>'}
      <p>時刻記録を伴う操作は、対象便を確認してから確定します。</p>
    </section>
    <aside class="drive-next-run">
      <span>同じ運用の次便</span>
      ${following ? `<strong>${escapeHTML(following.plannedDeparture || "未定")}　運用 ${following.operationNo}</strong><p>${escapeHTML(following.route)}</p>` : "<strong>本日の最終便</strong><p>後続便はありません</p>"}
    </aside>
    ${routeProgressMarkup(run)}`;
  updateDriveTick();
}

function updateDriveTick() {
  if (!state.driveOpen) return;
  const now = new Date();
  $("#driveClock").textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
  $("#driveDate").textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).format(now);
  const run = driveRun();
  if (!run || !$("#driveCountdown")) return;
  const countdown = countdownInfo(run, now);
  $("#driveCountdownLabel").textContent = countdown.label;
  $("#driveCountdown").textContent = countdown.value;
  $("#driveCountdownDetail").textContent = countdown.detail;
  $("#driveCountdown").parentElement.classList.toggle("late", countdown.late);
  maybeNotifyDeparture(run, now);
  if (state.offlineQueue.length && now.getTime() - state.lastSyncAttempt >= 15000) {
    state.lastSyncAttempt = now.getTime();
    syncOfflineQueue();
  }
}

function maybeNotifyDeparture(run, now) {
  if (!state.driveSettings.audioEnabled || !["waiting", "boarding"].includes(run.status) || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  const departure = plannedDate(run.plannedDeparture);
  if (!departure) return;
  const seconds = Math.floor((departure.getTime() - now.getTime()) / 1000);
  let minute = null;
  if (seconds > 60 && seconds <= 180) minute = 3;
  if (seconds > 0 && seconds <= 60) minute = 1;
  if (!minute) return;
  const key = `${run.id}:${minute}`;
  if (state.notifiedDepartures.has(key)) return;
  if (minute === 1) state.notifiedDepartures.add(`${run.id}:3`);
  state.notifiedDepartures.add(key);
  storeJSON("busDepartureNotified", [...state.notifiedDepartures]);
  speakJapanese(`運用${run.operationNo}、出発まで${minute}分以内です。乗車人数と安全確認を行ってください。`);
}

function speakJapanese(text, force = false) {
  if (!state.driveSettings.audioEnabled && !force) return false;
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    if (force) toast("この端末では音声通知を利用できません", "error");
    return false;
  }
  const message = new SpeechSynthesisUtterance(text);
  message.lang = "ja-JP";
  message.rate = 0.95;
  window.speechSynthesis.speak(message);
  return true;
}

function updateConnectionStatus() {
  const online = navigator.onLine && state.serverReachable !== false;
  const queueCount = state.offlineQueue.length;
  const baseLabel = !navigator.onLine ? "通信なし" : state.serverReachable === false ? "処理側未接続" : state.serverReachable === true ? "接続済" : "通信確認中";
  const label = queueCount ? `${baseLabel}　保留${queueCount}件` : baseLabel;
  $("#driveConnection").classList.toggle("offline", !online);
  $("#driveConnection").classList.toggle("pending", queueCount > 0);
  $("#driveConnection").querySelector("span").textContent = label;
}

function updateWakeButton() {
  const active = Boolean(state.wakeLock);
  $("#keepAwakeButton").classList.toggle("active", active);
  $("#keepAwakeButton").setAttribute("aria-pressed", String(active));
  $("#keepAwakeButton").querySelector("span").textContent = active ? "画面消灯を防止中" : "画面消灯を防ぐ";
}

async function setWakeLock(enabled) {
  state.wakeWanted = enabled;
  if (!enabled) {
    if (state.wakeLock) await state.wakeLock.release();
    state.wakeLock = null;
    updateWakeButton();
    return;
  }
  if (!("wakeLock" in navigator)) {
    state.wakeWanted = false;
    toast("この端末では画面消灯防止を利用できません", "error");
    updateWakeButton();
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; updateWakeButton(); });
  } catch (error) {
    state.wakeWanted = false;
    toast("画面消灯防止を開始できませんでした", "error");
  }
  updateWakeButton();
}

async function openDriveView(runId = null) {
  state.lastFocused = document.activeElement;
  const selected = state.runs.find((item) => item.id === runId) || priorityRun();
  state.driveRunId = selected?.id || null;
  state.driveOperationNo = selected?.operationNo || null;
  state.driveOpen = true;
  $(".app-shell").inert = true;
  $("#driveView").hidden = false;
  document.body.classList.add("drive-active");
  renderDriveView();
  updateConnectionStatus();
  clearInterval(state.driveTimer);
  state.driveTimer = setInterval(updateDriveTick, 1000);
  $("#exitDriveButton").focus();
  try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); } catch {}
  await setWakeLock(true);
  if (state.driveSettings.gpsEnabled) startGPS();
}

async function closeDriveView() {
  state.driveOpen = false;
  clearInterval(state.driveTimer);
  state.driveTimer = null;
  $("#driveView").hidden = true;
  $(".app-shell").inert = false;
  document.body.classList.remove("drive-active");
  state.driveRunId = null;
  state.driveOperationNo = null;
  stopGPS();
  await setWakeLock(false);
  try { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); } catch {}
  state.lastFocused?.focus?.();
}

function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const toRadians = (value) => value * Math.PI / 180;
  const earthRadius = 6371000;
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function updateGpsDisplay() {
  const run = driveRun();
  if (!run || !$("#driveGpsStatus")) return;
  const gps = gpsDisplay(run);
  $("#driveGpsStatus").textContent = gps.status;
  $("#driveGpsCoordinates").textContent = gps.coordinates;
  $("#driveGpsDetail").textContent = gps.detail;
}

async function sendGpsPosition(position) {
  const run = driveRun();
  if (!run) return;
  const body = {
    latitude: position.latitude,
    longitude: position.longitude,
    locationAccuracy: position.accuracy,
    occurredAt: position.capturedAt,
    requestId: requestID(),
  };
  try {
    const result = await mutate(`/api/runs/${encodeURIComponent(run.id)}`, "PATCH", body, "GPS位置");
    if (!result.queued) Object.assign(run, result.data);
  } catch (error) {
    state.gpsError = "位置送信失敗";
    updateGpsDisplay();
  }
}

function startGPS() {
  if (state.gpsWatchId !== null) return;
  if (!navigator.geolocation) {
    state.gpsError = "GPS未対応";
    updateGpsDisplay();
    return;
  }
  state.gpsError = "GPS取得中";
  updateGpsDisplay();
  state.gpsWatchId = navigator.geolocation.watchPosition((result) => {
    const next = {
      latitude: result.coords.latitude,
      longitude: result.coords.longitude,
      accuracy: result.coords.accuracy,
      capturedAt: new Date(result.timestamp).toISOString(),
    };
    state.gpsPosition = next;
    state.gpsError = "GPS取得済";
    updateGpsDisplay();
    const now = Date.now();
    if (now - state.lastGpsSentAt >= 20000 || distanceMeters(state.lastGpsCoords, next) >= 25) {
      state.lastGpsSentAt = now;
      state.lastGpsCoords = next;
      sendGpsPosition(next);
    }
  }, (error) => {
    state.gpsError = error.code === 1 ? "位置利用が未許可" : error.code === 2 ? "位置を取得できません" : "位置取得が時間切れ";
    updateGpsDisplay();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

function stopGPS() {
  if (state.gpsWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.gpsWatchId);
  state.gpsWatchId = null;
  state.gpsError = "GPS停止中";
  updateGpsDisplay();
}

async function updateRouteProgress(id, delta) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
  const stops = routeStops(run);
  const nextIndex = Math.max(0, Math.min(stops.length - 1, Number(run.progressIndex || 0) + Number(delta)));
  run.progressIndex = nextIndex;
  renderAll();
  try {
    const result = await mutate(`/api/runs/${encodeURIComponent(id)}`, "PATCH", { progressIndex: nextIndex, occurredAt: new Date().toISOString(), requestId: requestID() }, "経路進捗");
    if (!result.queued) replaceRun(result.data);
    else toast("経路進捗を一時保存しました");
  } catch (error) { toast(error.message, "error"); }
}

function openDriveSettings() {
  const run = driveRun();
  if (!run) return;
  $("#driveSettingsRun").textContent = `運用 ${run.operationNo}　${run.route}`;
  $("#driveVehicleNo").value = run.vehicleNo || state.driveSettings.vehicleNo || "";
  $("#driveDriverName").value = run.driverName || state.driveSettings.driverName || "";
  $("#driveCapacity").value = run.capacity || state.driveSettings.capacity || 55;
  $("#driveAudioEnabled").checked = state.driveSettings.audioEnabled !== false;
  $("#driveGpsEnabled").checked = Boolean(state.driveSettings.gpsEnabled);
  $("#driveSettingsDialog").showModal();
}

async function saveDriveSettings(event) {
  event.preventDefault();
  const run = driveRun();
  if (!run || state.busy) return;
  const settings = {
    vehicleNo: $("#driveVehicleNo").value.trim(),
    driverName: $("#driveDriverName").value.trim(),
    capacity: Math.max(1, Math.min(999, Number($("#driveCapacity").value) || 55)),
    audioEnabled: $("#driveAudioEnabled").checked,
    gpsEnabled: $("#driveGpsEnabled").checked,
  };
  state.driveSettings = settings;
  storeJSON("busDriveSettings", settings);
  setBusy(true);
  try {
    const url = `/api/operations/${run.operationNo}/assignment?date=${encodeURIComponent(state.date)}&day=${encodeURIComponent(state.day)}`;
    const result = await mutate(url, "PATCH", { ...settings, requestId: requestID() }, "運用設定");
    if (result.queued) {
      state.runs.forEach((item) => {
        if (item.operationNo === run.operationNo && !["arrived", "cancelled"].includes(item.status)) Object.assign(item, settings);
      });
    } else {
      const replacements = new Map((result.data.runs || []).map((item) => [item.id, item]));
      state.runs = state.runs.map((item) => replacements.get(item.id) || item);
    }
    $("#driveSettingsDialog").close();
    if (settings.gpsEnabled) startGPS(); else stopGPS();
    renderAll();
    toast(result.queued ? "運用設定を一時保存しました" : "同じ運用へ設定を固定しました");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function renderPriority() {
  const run = priorityRun();
  if (!run) {
    $("#priorityStrip").innerHTML = '<div class="priority-complete"><strong>本日の運行は完了しています</strong><span>到着済みの便と操作履歴を確認できます。</span></div>';
    return;
  }
  const mode = run.status === "departed" ? "運行中" : run.status === "boarding" ? "乗車受付中" : "次の便";
  const action = actionInfo[run.status];
  $("#priorityStrip").className = `priority-strip ${run.status}`;
  $("#priorityStrip").innerHTML = `<div class="priority-label"><span>${mode}</span><strong>${escapeHTML(run.plannedDeparture || "時刻未定")}</strong></div><div class="priority-route"><strong>運用 ${run.operationNo}　${escapeHTML(run.route)}</strong><span>${escapeHTML(run.vehicleNo || "車両未定")}　${escapeHTML(run.driverName || "担当未定")}　乗車 ${run.passengerCount || 0}名</span></div>${action ? `<button class="priority-action ${action[2]}" data-action="${action[1]}" data-id="${escapeHTML(run.id)}">${action[0]}${icon("arrow")}</button>` : ""}`;
}

function passengerControl(run, compact = false) {
  return `<div class="passenger-stepper ${compact ? "compact" : ""}" aria-label="乗車人数">
    <button type="button" data-count-delta="-1" data-id="${escapeHTML(run.id)}" aria-label="乗車人数を1名減らす">−1</button>
    <label><span class="sr-only">乗車人数</span><input type="number" min="0" max="999" value="${Number(run.passengerCount || 0)}" data-count-input="${escapeHTML(run.id)}"><small>名</small></label>
    <button type="button" data-count-delta="1" data-id="${escapeHTML(run.id)}" aria-label="乗車人数を1名増やす">＋1</button>
    <button type="button" class="quick-ten" data-count-delta="10" data-id="${escapeHTML(run.id)}" aria-label="乗車人数を10名増やす">＋10</button>
  </div>`;
}

function runEmphasis(run, delay) {
  if (run.status === "cancelled") return "is-cancelled";
  if (Number(run.passengerCount || 0) > Number(run.capacity || 55)) return "is-overcapacity";
  if (Number(run.passengerCount || 0) === Number(run.capacity || 55)) return "is-full";
  if ((delay ?? 0) >= 5) return "is-delayed";
  if (run.note) return "has-note";
  if (run.status === "departed") return "in-service";
  return "";
}

function renderRuns() {
  const runs = visibleRuns();
  if (!runs.length) {
    const reason = state.runs.length ? "絞り込み条件に合う便がありません" : "ダイヤ取込からExcelを登録してください";
    $("#runsContent").innerHTML = `<div class="empty"><div>${icon("bus")}<strong>${reason}</strong></div></div>`;
    return;
  }
  const rows = runs.map((run) => {
    const [statusLabel, statusClass] = statusInfo[run.status] || statusInfo.waiting;
    const next = actionInfo[run.status];
    const delay = run.arrivalDelayMinutes ?? run.departureDelayMinutes;
    const capacity = capacityInfo(run);
    const nextButton = next ? `<button class="next-button ${next[2]}" data-action="${next[1]}" data-id="${escapeHTML(run.id)}">${next[0]}${icon("arrow")}</button>` : "";
    const driveButton = !["arrived", "cancelled"].includes(run.status) ? `<button class="drive-row-button" data-drive-id="${escapeHTML(run.id)}" aria-label="この便を集中表示">集中</button>` : "";
    return `<tr class="${runEmphasis(run, delay)}">
      <td><div class="planned-time">${escapeHTML(run.plannedDeparture || "未定")}</div><div class="subtext">到着 ${escapeHTML(run.plannedArrival || "未定")}</div></td>
      <td class="route-cell"><strong>運用 ${run.operationNo}<span class="subtext">　便 ${run.columnNo}</span></strong><p>${escapeHTML(run.route)}</p>${run.note ? `<p class="note-text">注意 ${escapeHTML(run.note)}</p>` : ""}</td>
      <td><strong>${escapeHTML(run.vehicleNo || "車両未定")}</strong><div class="subtext">${escapeHTML(run.driverName || "担当未定")}</div></td>
      <td>${passengerControl(run, true)}<div class="capacity-mini ${capacity.className}">${capacity.capacity}名定員　${escapeHTML(capacity.text)}</div></td>
      <td><div class="actual-line"><span>出発</span><strong>${actualTime(run.actualDeparture)}</strong></div><div class="actual-line"><span>到着</span><strong>${actualTime(run.actualArrival)}</strong></div>${delay !== null && delay !== undefined ? `<div class="delay ${delay >= 5 ? "late" : ""}">${delayText(delay)}</div>` : ""}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td><div class="row-actions">${driveButton}<button class="edit-button" data-edit="${escapeHTML(run.id)}" aria-label="便情報を編集">${icon("edit")}</button>${nextButton}</div></td>
    </tr>`;
  }).join("");
  const cards = runs.map((run) => {
    const [statusLabel, statusClass] = statusInfo[run.status] || statusInfo.waiting;
    const next = actionInfo[run.status];
    const delay = run.arrivalDelayMinutes ?? run.departureDelayMinutes;
    const capacity = capacityInfo(run);
    const driveButton = !["arrived", "cancelled"].includes(run.status) ? `<button class="drive-row-button" data-drive-id="${escapeHTML(run.id)}" aria-label="この便を集中表示">集中</button>` : "";
    return `<article class="run-card ${runEmphasis(run, delay)}">
      <div class="run-card-head"><div><span class="run-label">運用 ${run.operationNo}　便 ${run.columnNo}</span><strong class="mobile-time">${escapeHTML(run.plannedDeparture || "未定")}</strong><span class="subtext">到着 ${escapeHTML(run.plannedArrival || "未定")}</span></div><span class="badge ${statusClass}">${statusLabel}</span></div>
      <div class="mobile-route"><strong>${escapeHTML(run.route)}</strong><span>${escapeHTML(run.vehicleNo || "車両未定")}　${escapeHTML(run.driverName || "担当未定")}</span></div>
      ${run.note ? `<div class="mobile-alert">注意　${escapeHTML(run.note)}</div>` : ""}
      ${delay !== null && delay !== undefined ? `<div class="mobile-delay ${delay >= 5 ? "late" : ""}">${delayText(delay)}</div>` : ""}
      <div class="mobile-facts"><span>出発 <strong>${actualTime(run.actualDeparture)}</strong></span><span>到着 <strong>${actualTime(run.actualArrival)}</strong></span></div>
      <div class="mobile-controls">${passengerControl(run)}<div class="mobile-side-actions">${driveButton}<button class="edit-button" data-edit="${escapeHTML(run.id)}" aria-label="便情報を編集">${icon("edit")}</button></div></div>
      <div class="capacity-mini ${capacity.className}">${capacity.capacity}名定員　${escapeHTML(capacity.text)}</div>
      ${next ? `<button class="next-button mobile-next ${next[2]}" data-action="${next[1]}" data-id="${escapeHTML(run.id)}">${next[0]}${icon("arrow")}</button>` : ""}
    </article>`;
  }).join("");
  $("#runsContent").innerHTML = `<div class="desktop-runs"><table class="runs-table"><thead><tr><th>予定</th><th>運用・経路</th><th>車両・担当</th><th>人数</th><th>実績</th><th>状態</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobile-runs">${cards}</div>`;
}

function renderHistory() {
  if (!state.events.length) {
    $("#historyContent").innerHTML = '<div class="empty">まだ操作履歴がありません</div>';
    return;
  }
  $("#historyContent").innerHTML = state.events.map((event) => {
    const when = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(event.createdAt));
    return `<div class="history-item"><time>${when}</time><strong>${escapeHTML(event.summary)}</strong><span class="history-type">${escapeHTML(event.type)}</span></div>`;
  }).join("");
}

function renderAll() {
  const result = metrics();
  $("#metricWaiting").textContent = result.waiting;
  $("#metricActive").textContent = result.active;
  $("#metricArrived").textContent = result.arrived;
  $("#metricDelayed").textContent = result.delayed;
  $("#metricPassengers").textContent = result.passengers;
  $("#allCount").textContent = state.runs.length;
  renderPriority();
  renderRuns();
  renderHistory();
  renderDriveView();
  storeJSON(`busDashboard:${state.date}:${state.day}`, { runs: state.runs, events: state.events, timetableCount: Number.parseInt($("#timetableCount").textContent, 10) || 0 });
}

function replaceRun(next) {
  state.runs = state.runs.map((run) => run.id === next.id ? next : run);
  renderAll();
}

function optimisticAction(run, action, occurredAt) {
  const next = { ...run, updatedAt: occurredAt };
  if (action === "boarding") next.status = "boarding";
  if (action === "depart") { next.status = "departed"; next.actualDeparture = occurredAt; }
  if (action === "arrive") { next.status = "arrived"; next.actualArrival = occurredAt; }
  if (action === "cancel") next.status = "cancelled";
  if (action === "reset") {
    next.status = "waiting";
    next.actualDeparture = "";
    next.actualArrival = "";
    next.departureDelayMinutes = null;
    next.arrivalDelayMinutes = null;
  }
  return next;
}

async function runAction(id, action) {
  if (state.busy) return;
  setBusy(true);
  try {
    const current = state.runs.find((run) => run.id === id);
    const occurredAt = new Date().toISOString();
    const result = await mutate(`/api/runs/${encodeURIComponent(id)}/action`, "POST", { action, occurredAt, requestId: requestID() }, "運行操作");
    replaceRun(result.queued ? optimisticAction(current, action, occurredAt) : result.data);
    if (!result.queued) await loadDashboard(true);
    const messages = { boarding: "乗車受付を開始しました", depart: "出発時刻を記録しました", arrive: "到着時刻を記録しました", cancel: "運休を記録しました", reset: "待機へ戻しました" };
    toast(result.queued ? "通信復帰後に同期します" : messages[action] || "更新しました");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function requestAction(id, action) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
  if (action === "boarding") { runAction(id, action); return; }
  const labels = { depart: ["出発を記録しますか？", "出発"], arrive: ["到着を記録しますか？", "到着"], cancel: ["この便を運休にしますか？", "運休"] };
  const [title, button] = labels[action] || ["操作を確定しますか？", "確定"];
  state.confirming = { id, action };
  $("#confirmTitle").textContent = title;
  $("#confirmDescription").textContent = action === "cancel" ? "運休として記録し、通常の運行操作から外します。" : "実績時刻と遅延時間を自動で保存します。";
  $("#confirmRun").innerHTML = `<strong>${escapeHTML(run.plannedDeparture || "未定")}　運用 ${run.operationNo}</strong><span>${escapeHTML(run.route)}</span>`;
  $("#confirmActionButton").textContent = `${button}を確定`;
  $("#confirmActionButton").className = `button ${action === "cancel" ? "danger" : "primary"}`;
  $("#confirmDialog").showModal();
}

function queuePassenger(id, value) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
  const previousValue = Number(run.passengerCount || 0);
  const nextValue = Math.max(0, Math.min(999, Number(value) || 0));
  run.passengerCount = nextValue;
  const capacity = Number(run.capacity || state.driveSettings.capacity || 55);
  if (previousValue < capacity && nextValue === capacity) {
    toast(`運用${run.operationNo}は定員${capacity}名に達しました`, "error");
    speakJapanese(`運用${run.operationNo}、定員に達しました。`);
  }
  if (previousValue <= capacity && nextValue > capacity) {
    toast(`定員を${nextValue - capacity}名超過しています`, "error");
    speakJapanese(`運用${run.operationNo}、定員を超過しています。乗車人数を確認してください。`);
  }
  renderAll();
  clearTimeout(state.countTimers.get(id));
  state.countTimers.set(id, setTimeout(async () => {
    try {
      const result = await mutate(`/api/runs/${encodeURIComponent(id)}`, "PATCH", { passengerCount: nextValue, occurredAt: new Date().toISOString(), requestId: requestID() }, "乗車人数");
      if (!result.queued) replaceRun(result.data);
      toast(result.queued ? `乗車人数${nextValue}名を一時保存しました` : `乗車人数を${nextValue}名で保存しました`);
    } catch (error) { toast(error.message, "error"); await loadDashboard(true); }
    finally { state.countTimers.delete(id); }
  }, 550));
}

function openDetails(id) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
  state.editing = { ...run };
  $("#dialogRoute").textContent = `運用 ${run.operationNo}　${run.route}`;
  $("#passengerCount").value = run.passengerCount || 0;
  $("#vehicleNo").value = run.vehicleNo || "";
  $("#driverName").value = run.driverName || "";
  $("#note").value = run.note || "";
  $("#cancelRunButton").hidden = run.status === "cancelled";
  $("#resetRunButton").hidden = run.status === "waiting";
  $("#detailsDialog").showModal();
}

async function saveDetails(event) {
  event.preventDefault();
  if (!state.editing || state.busy) return;
  setBusy(true);
  try {
    const payload = {
      passengerCount: Number($("#passengerCount").value || 0),
      vehicleNo: $("#vehicleNo").value,
      driverName: $("#driverName").value,
      note: $("#note").value,
      requestId: requestID(),
      occurredAt: new Date().toISOString(),
    };
    const result = await mutate(`/api/runs/${encodeURIComponent(state.editing.id)}`, "PATCH", payload, "便情報");
    if (!result.queued) replaceRun(result.data);
    else replaceRun({ ...state.editing, ...payload });
    $("#detailsDialog").close();
    if (!result.queued) await loadDashboard(true);
    toast(result.queued ? "便情報を一時保存しました" : "便情報を保存しました");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function switchView(view) {
  $$(".nav-button").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".view").forEach((section) => section.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
  const titles = { operations: ["当日運行", "人数と出発、到着を即時記録"], timetable: ["ダイヤ取込", "現在のExcelを運行便へ変換"], history: ["操作履歴", "出発、到着、変更内容を確認"] };
  $("#pageTitle").textContent = titles[view][0];
  $("#pageSubtitle").textContent = titles[view][1];
  $("#sidebar").classList.remove("open");
}

function updateDayToggle() {
  const sunday = state.day === "日曜";
  $("#dayToggle").checked = sunday;
  $("#dayToggle").setAttribute("aria-label", `${state.day}を選択中。曜日を切り替える`);
  $("#saturdayLabel").classList.toggle("active", !sunday);
  $("#sundayLabel").classList.toggle("active", sunday);
}

async function importExcel() {
  const file = $("#excelFile").files[0];
  if (!file || state.busy) return;
  setBusy(true);
  const button = $("#importButton");
  const original = button.innerHTML;
  button.innerHTML = loaderMarkup("検証中", true);
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/timetable/import", { method: "POST", body: form });
    toast(`${result.count}便のダイヤを取り込みました`);
    switchView("operations");
    await loadDashboard();
  } catch (error) { toast(error.message, "error"); }
  finally { button.innerHTML = original; setBusy(false); }
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) switchView(viewButton.dataset.view);
  const filterButton = event.target.closest("[data-status]");
  if (filterButton) {
    state.status = filterButton.dataset.status;
    $$("[data-status]").forEach((button) => {
      const active = button === filterButton;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderRuns();
  }
  const editButton = event.target.closest("[data-edit]");
  if (editButton) openDetails(editButton.dataset.edit);
  const driveButton = event.target.closest("[data-drive-id]");
  if (driveButton) openDriveView(driveButton.dataset.driveId);
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) requestAction(actionButton.dataset.id, actionButton.dataset.action);
  const countButton = event.target.closest("[data-count-delta]");
  if (countButton) {
    const run = state.runs.find((item) => item.id === countButton.dataset.id);
    if (run) {
      const delta = countButton.dataset.countDelta;
      const inDriveView = Boolean(countButton.closest("#driveView"));
      queuePassenger(run.id, Number(run.passengerCount || 0) + Number(delta));
      const scope = inDriveView ? $("#driveView") : document;
      [...scope.querySelectorAll("[data-count-delta]")].find((button) => button.dataset.id === run.id && button.dataset.countDelta === delta)?.focus({ preventScroll: true });
    }
  }
  const progressButton = event.target.closest("[data-progress-delta]");
  if (progressButton) updateRouteProgress(progressButton.dataset.id, progressButton.dataset.progressDelta);
  const gpsRetryButton = event.target.closest("[data-gps-retry]");
  if (gpsRetryButton) {
    if (!state.driveSettings.gpsEnabled) {
      toast("運用設定でGPSを有効にしてください", "error");
    } else {
      stopGPS();
      startGPS();
      toast("GPSを再取得しています");
    }
  }
});

document.addEventListener("change", (event) => {
  const input = event.target.closest("[data-count-input]");
  if (input) queuePassenger(input.dataset.countInput, input.value);
});

$("#serviceDate").value = state.date;
$("#serviceDate").addEventListener("change", (event) => { state.date = event.target.value; loadDashboard(); });
$("#searchInput").addEventListener("input", (event) => { state.query = event.target.value; renderRuns(); });
$("#reloadButton").addEventListener("click", () => loadDashboard());
$("#openDriveButton").addEventListener("click", () => openDriveView());
$("#exitDriveButton").addEventListener("click", closeDriveView);
$("#keepAwakeButton").addEventListener("click", () => setWakeLock(!state.wakeWanted));
$("#driveSettingsButton").addEventListener("click", openDriveSettings);
$("#driveSettingsForm").addEventListener("submit", saveDriveSettings);
$("#closeDriveSettings").addEventListener("click", () => $("#driveSettingsDialog").close());
$("#cancelDriveSettings").addEventListener("click", () => $("#driveSettingsDialog").close());
$("#testDriveAudio").addEventListener("click", () => speakJapanese("音声通知の確認です。出発前に乗車人数と安全確認を行ってください。", true));
$("#detailsForm").addEventListener("submit", saveDetails);
$("#cancelRunButton").addEventListener("click", () => { if (state.editing) { $("#detailsDialog").close(); requestAction(state.editing.id, "cancel"); } });
$("#resetRunButton").addEventListener("click", () => { if (state.editing) { $("#detailsDialog").close(); runAction(state.editing.id, "reset"); } });
$("#excelFile").addEventListener("change", (event) => {
  const file = event.target.files[0];
  $("#fileName").textContent = file ? file.name : "Excelを選択";
  $("#importButton").disabled = !file;
});
$("#importButton").addEventListener("click", importExcel);
$("#openSidebar").addEventListener("click", () => $("#sidebar").classList.add("open"));
$("#closeSidebar").addEventListener("click", () => $("#sidebar").classList.remove("open"));
$("#dayToggle").addEventListener("change", (event) => {
  state.day = event.target.checked ? "日曜" : "土曜";
  const control = event.target.nextElementSibling;
  control.classList.add("neo-activated");
  setTimeout(() => control.classList.remove("neo-activated"), 620);
  updateDayToggle();
  loadDashboard();
});
$("#confirmActionButton").addEventListener("click", async () => {
  if (!state.confirming) return;
  const pending = state.confirming;
  state.confirming = null;
  $("#confirmDialog").close();
  await runAction(pending.id, pending.action);
});
window.addEventListener("online", () => { state.serverReachable = null; updateConnectionStatus(); syncOfflineQueue(); });
window.addEventListener("offline", updateConnectionStatus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.driveOpen && state.wakeWanted && !state.wakeLock) setWakeLock(true);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.driveOpen && !$("#confirmDialog").open && !$("#detailsDialog").open && !$("#driveSettingsDialog").open) closeDriveView();
});

updateDayToggle();
loadDashboard().then(syncOfflineQueue);
