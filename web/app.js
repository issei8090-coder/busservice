const initialServiceDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const initialWeekday = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(new Date());

const state = {
	user: null,
  date: initialServiceDate,
  day: initialWeekday.includes("日") ? "日曜" : "土曜",
  runs: [],
  events: [],
  routeProfiles: [],
  timetable: [],
  settings: { schoolLatitude: 0, schoolLongitude: 0, schoolRadius: 35 },
  status: "all",
  query: "",
  editing: null,
  editingTemplateKey: null,
	templateWarningSignature: "",
  confirming: null,
  busy: false,
  countTimers: new Map(),
  driveOpen: false,
  driveTimer: null,
  fleetTimer: null,
  wakeLock: null,
  wakeWanted: false,
  lastFocused: null,
  serverReachable: null,
  driveRunId: null,
  driveOperationNo: null,
  driveLeg: "outbound",
  driveChooserOpen: false,
  driveSelections: readStoredJSON("busDriveSelections", {}),
  driveSettings: readStoredJSON("busDriveSettings", { vehicleNo: "", driverName: "", capacity: 55, audioEnabled: true, gpsEnabled: false }),
  offlineQueue: readStoredJSON("busOfflineQueue", []),
	offlineConflicts: readStoredJSON("busOfflineConflicts", []),
  syncingOffline: false,
  notifiedDepartures: new Set(readStoredJSON("busDepartureNotified", [])),
  gpsWatchId: null,
  gpsPosition: null,
  gpsError: "GPS停止中",
  lastGpsSentAt: 0,
  lastGpsCoords: null,
	lastRawGps: null,
	gpsSpeed: 0,
  lastSyncAttempt: 0,
	passengerUndo: null,
};

const statusInfo = {
  waiting: ["待機", ""],
  boarding: ["乗車受付", "boarding"],
  departed: ["運行中", "departed"],
  arrived: ["到着済", "arrived"],
  cancelled: ["運休", "cancelled"],
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

function toast(message, type = "success", action = null) {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
	const label = document.createElement("span");
	label.textContent = message;
	item.append(label);
	if (action) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = action.label;
		button.addEventListener("click", () => { action.run(); item.remove(); });
		item.append(button);
	}
  $("#toastRegion").append(item);
	setTimeout(() => item.remove(), action ? 5200 : 3800);
}

function showLogin(message = "") {
	if (state.driveOpen) {
		state.driveOpen = false;
		clearInterval(state.driveTimer);
		state.driveTimer = null;
		$("#driveView").hidden = true;
		document.body.classList.remove("drive-active");
		stopGPS();
		window.BusRoutes?.closeDriveMap?.();
	}
	state.user = null;
	document.body.dataset.role = "";
	$("#loginGate").hidden = false;
	$("#launchGate").hidden = true;
	$(".app-shell").inert = true;
	const error = $("#loginError");
	error.hidden = !message;
	error.textContent = message;
	if (message) error.focus(); else $("#loginStaffId").focus();
}

function applyUser(user) {
	state.user = user;
	document.body.dataset.role = user.role;
	const roleLabel = ({ admin:"管理者", driver:"運転担当", viewer:"閲覧担当" })[user.role] || user.role;
	const userLabel = user.name || user.id;
	$("#currentUserLabel").textContent = userLabel === roleLabel ? userLabel : `${userLabel}　${roleLabel}`;
	$$('[data-role-required="admin"]').forEach((element) => { element.hidden = user.role !== "admin"; });
	const visibleNav = $$(".nav-button").filter((element) => !element.hidden).length;
	$("#sidebar nav").style.setProperty("--nav-count", visibleNav);
	$("#launchOperationGrid").hidden = user.role === "viewer";
	$("#launchAdmin").textContent = user.role === "viewer" ? "運行状況を開く" : "管理画面を開く";
	$("#openDriveButton").hidden = user.role === "viewer";
	$("#loginGate").hidden = true;
	$("#launchGate").hidden = false;
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
    state.serverReachable = true;
    if (state.user && state.offlineQueue.length && !state.syncingOffline) setTimeout(syncOfflineQueue, 0);
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
		error.body = body;
		if (response.status === 401 && url !== "/api/login") showLogin("ログインの有効時間が切れました。再度ログインしてください。");
    throw error;
  }
  return body;
}

function enqueueMutation(url, method, body, label) {
  const item = { id: body.requestId || requestID(), ownerId: state.user?.id || "", url, method, body, label, queuedAt: new Date().toISOString() };
  item.body.requestId = item.id;
  const replaceLatest = label === "乗車人数" || label === "GPS位置" || label === "運用設定";
  const existingIndex = replaceLatest ? state.offlineQueue.findIndex((queued) => queued.method === method && queued.url === url && queued.label === label) : -1;
	if (existingIndex >= 0) {
		const previous = state.offlineQueue[existingIndex];
		if (previous.body.expectedRevision !== undefined) item.body.expectedRevision = previous.body.expectedRevision;
		if (previous.body.expectedRevisions) item.body.expectedRevisions = previous.body.expectedRevisions;
		state.offlineQueue.splice(existingIndex, 1, item);
	}
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
    const queuedItem = enqueueMutation(url, method, body, label);
    return { data: null, queued: true, queuedItem };
  }
}

async function syncOfflineQueue() {
  if (state.syncingOffline || !navigator.onLine || !state.offlineQueue.length) return;
  state.syncingOffline = true;
  let rejected = 0;
  try {
    while (state.offlineQueue.length && navigator.onLine) {
      const item = state.offlineQueue[0];
	  if (item.ownerId && item.ownerId !== state.user?.id) break;
      try {
        await api(item.url, { method: item.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.body) });
        state.offlineQueue.shift();
        storeJSON("busOfflineQueue", state.offlineQueue);
      } catch (error) {
        if (error.networkFailure || !navigator.onLine || (error.status || 500) >= 500) break;
        state.offlineQueue.shift();
		state.offlineConflicts.push({ ...item, reason:error.message, current:error.body?.current || null, failedAt:new Date().toISOString() });
		storeJSON("busOfflineConflicts", state.offlineConflicts);
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
	renderSyncCenter();
  }
}

function renderSyncCenter() {
	if (!$("#syncItems")) return;
	const pending = state.offlineQueue.length;
	const conflicts = state.offlineConflicts.length;
	$("#syncStatusCount").textContent = pending + conflicts;
	$("#syncStatusButton").classList.toggle("has-items", pending + conflicts > 0);
	$("#syncSummary").innerHTML = `<strong>${pending}件が未送信</strong><span>${conflicts}件が要確認</span>`;
	const pendingMarkup = state.offlineQueue.map((item) => `<article><strong>${escapeHTML(item.label)}</strong><span>${item.ownerId && item.ownerId !== state.user?.id ? "別の職員が保存した操作です" : `${actualTime(item.queuedAt)}から未送信`}</span></article>`).join("");
	const conflictMarkup = state.offlineConflicts.map((item, index) => `<article class="conflict"><strong>${escapeHTML(item.label)}　確認が必要</strong><span>${escapeHTML(item.reason || "別端末で更新されています")}</span><div><button type="button" data-conflict-retry="${index}">現在の内容で再試行</button><button type="button" data-conflict-discard="${index}">破棄</button></div></article>`).join("");
	$("#syncItems").innerHTML = pendingMarkup + conflictMarkup || `<div class="empty">未送信の操作はありません</div>`;
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
    state.routeProfiles = data.routeProfiles || [];
    state.timetable = data.timetable || [];
    state.settings = data.settings || state.settings;
    $("#timetableCount").textContent = `${data.timetableCount || 0}便`;
    storeJSON(cacheKey, { runs: state.runs, events: state.events, routeProfiles: state.routeProfiles, timetable: state.timetable, settings: state.settings, timetableCount: data.timetableCount || 0 });
    renderAll();
  } catch (error) {
    const cached = readStoredJSON(cacheKey, null);
    if (error.networkFailure && cached?.runs) {
      state.runs = cached.runs;
      state.events = cached.events || [];
      state.routeProfiles = cached.routeProfiles || [];
      state.timetable = cached.timetable || [];
      state.settings = cached.settings || state.settings;
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
    passengers: state.runs.reduce((sum, run) => sum + Number(run.outboundPassengerCount || 0) + Number(run.inboundPassengerCount || 0), 0),
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
  }).sort(compareRunsByTime);
}

function priorityRun() {
  const byStatus = (status) => state.runs.filter((run) => run.status === status).sort(compareRunsByTime);
  const active = byStatus("departed")[0] || byStatus("boarding")[0];
  if (active) return active;
  const waiting = byStatus("waiting");
  if (!waiting.length) return null;
  if (state.date !== initialServiceDate) return waiting[0];
  const japanTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const nowMinutes = timeToMinutes(japanTime);
  return waiting.reduce((closest, run) => {
    const distance = Math.abs(timeToMinutes(run.plannedDeparture) - nowMinutes);
    const closestDistance = Math.abs(timeToMinutes(closest.plannedDeparture) - nowMinutes);
    return distance < closestDistance ? run : closest;
  }, waiting[0]);
}

function timeToMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.MAX_SAFE_INTEGER;
}

function compareRunsByTime(left, right) {
  return timeToMinutes(left.plannedDeparture) - timeToMinutes(right.plannedDeparture)
    || Number(left.operationNo || 0) - Number(right.operationNo || 0)
    || Number(left.columnNo || 0) - Number(right.columnNo || 0);
}

function priorityTiming(run) {
  if (state.date !== initialServiceDate || !run?.plannedDeparture || run.status === "departed") return "";
  const target = plannedDate(run.plannedDeparture);
  if (!target) return "";
  const minutes = Math.round((target.getTime() - Date.now()) / 60000);
  if (Math.abs(minutes) < 1) return "出発時刻です";
  return minutes > 0 ? `出発まで ${minutes}分` : `予定から ${Math.abs(minutes)}分経過`;
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

function legCountdownInfo(run, leg = state.driveLeg, now = new Date()) {
  const data = legData(run, leg);
  const isActive = data.status === "departed";
  const targetLabel = isActive ? "予定到着" : "出発";
  const targetTime = isActive ? data.arrival : data.departure;
  const target = plannedDate(targetTime);
  if (!target) return { label: `${data.label} ${targetLabel}まで`, value: "--:--", detail: "中間時刻を元ダイヤ編集で設定", late: false };
  const difference = target.getTime() - now.getTime();
  return { label: `${data.label} ${difference >= 0 ? `${targetLabel}まで` : `${targetLabel}予定から`}`, value: durationText(difference), detail: `${targetLabel} ${targetTime}`, late: difference < 0 };
}

function nextRunAfter(run) {
  const index = state.runs.findIndex((item) => item.id === run?.id);
  return state.runs.slice(Math.max(0, index + 1)).find((item) => item.operationNo === run?.operationNo && !["arrived", "cancelled"].includes(item.status)) || null;
}

function driveSelectionKey() {
  return `${state.date}|${state.day}`;
}

function driveOperationRuns(operationNo = state.driveOperationNo) {
  return state.runs.filter((run) => run.operationNo === Number(operationNo));
}

function driveOperations() {
  const operations = [...new Set(state.runs.map((run) => run.operationNo))].sort((a, b) => a - b);
  return operations.map((operationNo) => {
    const runs = driveOperationRuns(operationNo);
    const active = runs.filter((run) => !["arrived", "cancelled"].includes(run.status));
    const assigned = runs.find((run) => run.vehicleNo || run.driverName) || runs[0];
    return { operationNo, runs, active, assigned, first: runs[0], last: runs[runs.length - 1] };
  });
}

function initialRunForOperation(operationNo) {
  const runs = driveOperationRuns(operationNo);
  return runs.find((run) => run.status === "departed") || runs.find((run) => run.status === "boarding") || runs.find((run) => run.status === "waiting") || runs[0] || null;
}

function driveRun() {
  const selected = state.runs.find((item) => item.id === state.driveRunId);
  if (selected && selected.operationNo === state.driveOperationNo) return selected;
  if (state.driveOperationNo) return initialRunForOperation(state.driveOperationNo);
  return null;
}

const serviceTypeInfo = {
  passenger: ["通常便", "service-passenger"],
  deadhead: ["回送", "service-deadhead"],
  group: ["団体専用", "service-group"],
  none: ["運行なし", "service-none"],
};

function legData(run, leg = state.driveLeg) {
  const inbound = leg === "inbound";
  const type = inbound ? run.inboundType : run.outboundType;
  const status = inbound ? run.inboundStatus : run.outboundStatus;
  return {
    leg: inbound ? "inbound" : "outbound",
    label: inbound ? "復路" : "往路",
    type: serviceTypeInfo[type] ? type : "passenger",
    status: status || "waiting",
    passengers: Number(inbound ? run.inboundPassengerCount : run.outboundPassengerCount) || 0,
    departure: inbound ? run.inboundDeparture : run.outboundDeparture,
    arrival: inbound ? run.inboundArrival : run.outboundArrival,
    actualDeparture: inbound ? run.inboundActualDeparture : run.outboundActualDeparture,
    actualArrival: inbound ? run.inboundActualArrival : run.outboundActualArrival,
  };
}

function initialLegForRun(run) {
  const outbound = legData(run, "outbound");
  const inbound = legData(run, "inbound");
  if (!["arrived", "cancelled"].includes(outbound.status) && outbound.type !== "none") return "outbound";
  if (!["arrived", "cancelled"].includes(inbound.status) && inbound.type !== "none") return "inbound";
  return outbound.type !== "none" ? "outbound" : "inbound";
}

function legActionInfo(run, leg = state.driveLeg) {
  const data = legData(run, leg);
  if (data.type === "none" || ["arrived", "cancelled"].includes(data.status)) return null;
  if (data.status === "departed") return { action: "arrive", label: data.label + "の到着を記録", className: "arrive" };
  if (data.status === "boarding") return { action: "depart", label: data.label + "の出発を記録", className: "depart" };
  if (data.type === "deadhead") return { action: "depart", label: data.label + "回送を出発", className: "depart" };
  return { action: "boarding", label: data.label + "の受付を開始", className: "" };
}

function nextLegAction(run) {
  const legs = ["outbound", "inbound"];
  for (const status of ["departed", "boarding", "waiting"]) {
    for (const leg of legs) {
      const data = legData(run, leg);
      if (data.status !== status) continue;
      const action = legActionInfo(run, leg);
      if (action) return { ...action, leg };
    }
  }
  return null;
}

function routeStops(run) {
  const stops = String(run?.route || "").split("→").map((stop) => stop.trim()).filter(Boolean);
  return stops.length ? stops : ["経路未設定"];
}

function routeStopsForLeg(run, leg = state.driveLeg) {
  const stops = routeStops(run);
  if (stops.length < 2) return stops;
  if (leg === "outbound") return stops.slice(0, Math.max(2, stops.length - 1));
  return stops.slice(Math.max(0, stops.length - 2));
}

function legRouteText(run, leg = state.driveLeg) {
  return routeStopsForLeg(run, leg).join(" → ");
}

function routeProfileFor(run, direction = "outbound") {
  const id = direction === "inbound" ? run?.inboundRouteProfileId : run?.outboundRouteProfileId;
  return state.routeProfiles.find((profile) => profile.id === id) || null;
}

function capacityInfo(run, leg = null) {
  const capacity = Number(run?.capacity || state.driveSettings.capacity || 55);
  const passengers = leg ? legData(run, leg).passengers : Math.max(Number(run?.passengerCount || 0), Number(run?.outboundPassengerCount || 0), Number(run?.inboundPassengerCount || 0));
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
	const ageSeconds = capturedAt ? Math.max(0, Math.floor((Date.now() - new Date(capturedAt).getTime()) / 1000)) : Infinity;
	const freshness = ageSeconds > 60 ? "位置が古い" : ageSeconds > 30 ? "更新遅延" : "更新中";
  const quality = Number(accuracy) <= 5 ? "高精度" : Number(accuracy) <= 20 ? "通常精度" : "低精度";
  return {
		status: ageSeconds > 60 ? "位置が古い" : position?.zone === "school" || run?.locationZone === "school" ? "学校⓪へ位置補正" : state.gpsError || "GPS取得中",
    coordinates: `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`,
		detail: `端末測位 約${Math.round(Number(accuracy || 0))}m　${quality}　${freshness}${capturedAt ? `　${actualTime(capturedAt)}更新` : ""}`,
  };
}

function routeProgressMarkup(run) {
  const leg = legData(run);
  const stops = routeStopsForLeg(run, leg.leg);
  const progressValue = leg.leg === "inbound" ? run.inboundProgressIndex : run.outboundProgressIndex;
  const index = Math.max(0, Math.min(stops.length - 1, Number(progressValue || 0)));
  const gps = gpsDisplay(run);
  const profile = routeProfileFor(run, leg.leg);
  const routeMap = profile ? `<div class="drive-route-map-heading"><strong>${escapeHTML(profile.name)}</strong><span>${leg.label}のみ表示</span></div><div class="drive-route-map-shell"><div id="driveRouteMap" class="drive-route-map" aria-label="${leg.label}の経路と現在地"></div><a class="osm-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a></div>` : `<div class="drive-route-unassigned">${leg.label}の走行経路が未割当です。便情報または経路管理から選択してください。</div>`;
  return `<section class="drive-route-progress" aria-labelledby="driveProgressHeading">
    <div class="drive-progress-heading"><div><span>経路進捗</span><strong id="driveProgressHeading">現在地 ${escapeHTML(stops[index])}</strong></div><div class="drive-gps-state" role="status" aria-live="polite" aria-atomic="true"><span id="driveGpsStatus">${escapeHTML(gps.status)}</span><strong id="driveGpsCoordinates">${escapeHTML(gps.coordinates)}</strong><small id="driveGpsDetail">${escapeHTML(gps.detail)}</small></div></div>
    <ol class="drive-stop-list">${stops.map((stop, stopIndex) => `<li class="${stopIndex < index ? "done" : stopIndex === index ? "current" : ""}"><i></i><span>${escapeHTML(stop)}</span></li>`).join("")}</ol>
    <div class="drive-progress-actions"><button type="button" data-progress-delta="-1" data-id="${escapeHTML(run.id)}" data-leg="${leg.leg}" ${index === 0 ? "disabled" : ""}>前の地点</button><button type="button" data-gps-retry>GPS再取得</button><button type="button" data-progress-delta="1" data-id="${escapeHTML(run.id)}" data-leg="${leg.leg}" ${index >= stops.length - 1 ? "disabled" : ""}>次の地点</button></div>
    ${routeMap}
  </section>`;
}

function renderDriveChooser() {
  const operations = driveOperations();
  const previous = Number(state.driveSelections[driveSelectionKey()] || 0);
  $("#driveServiceLabel").textContent = `${state.date}　${state.day}運行`;
  $("#driveSettingsButton").disabled = true;
  $("#driveContent").innerHTML = `<section class="drive-operation-chooser" aria-labelledby="driveChooserHeading">
    <div class="drive-chooser-copy"><span>運転表示を始める</span><h3 id="driveChooserHeading">今日の担当運用を選択</h3><p>選択した運用の全便を左右に動かして確認できます。</p></div>
    <div class="drive-operation-grid">${operations.map((item) => {
      const current = item.runs.find((run) => run.status === "departed" || run.status === "boarding");
      const status = current ? (current.status === "departed" ? "運行中" : "乗車受付中") : item.active.length ? `残り${item.active.length}便` : "完了";
      return `<button type="button" class="drive-operation-card ${item.operationNo === previous ? "previous" : ""} ${current ? "current" : ""}" data-select-operation="${item.operationNo}">
        <span class="drive-operation-card-top"><b>運用 ${item.operationNo}</b><em>${status}</em></span>
        <strong>${escapeHTML(item.first?.plannedDeparture || "未定")} から ${escapeHTML(item.last?.plannedArrival || item.last?.plannedDeparture || "未定")}</strong>
        <small>${item.runs.length}便　${escapeHTML(item.assigned?.vehicleNo || "車両未定")}　${escapeHTML(item.assigned?.driverName || "担当未定")}</small>
        ${item.operationNo === previous ? `<i>前回選択</i>` : ""}
      </button>`;
    }).join("")}</div>
  </section>`;
  updateDriveTick();
}

function driveRunDeckMarkup(selected) {
  const runs = driveOperationRuns();
  const index = Math.max(0, runs.findIndex((run) => run.id === selected.id));
  return `<section class="drive-run-deck-section" aria-labelledby="driveDeckHeading">
    <div class="drive-deck-heading"><div><span>これからの運用</span><strong id="driveDeckHeading">運用 ${state.driveOperationNo}　全${runs.length}便</strong></div><span class="drive-deck-position" role="status" aria-atomic="true">${index + 1}便目を表示中</span></div>
    <div class="drive-run-deck" id="driveRunDeck" tabindex="0" aria-label="運用便一覧。左右に動かして確認">
      ${runs.map((run, runIndex) => {
        const [label, statusClass] = statusInfo[run.status] || statusInfo.waiting;
        const capacity = capacityInfo(run);
        return `<button type="button" class="drive-run-card ${run.id === selected.id ? "active" : ""} ${runIndex < index ? "past" : ""}" data-drive-run="${escapeHTML(run.id)}" aria-pressed="${run.id === selected.id}">
          <span><b>${runIndex + 1}</b><em class="${statusClass}">${label}</em></span>
          <strong>${escapeHTML(run.plannedDeparture || "未定")}</strong>
          <small>${escapeHTML(run.route)}</small>
          <i>往 ${Number(run.outboundPassengerCount || 0)}名　復 ${Number(run.inboundPassengerCount || 0)}名 ／ 定員 ${capacity.capacity}名</i>
        </button>`;
      }).join("")}
    </div>
    <div class="drive-deck-controls"><button type="button" data-drive-move="-1" ${index === 0 ? "disabled" : ""}>前の便</button><span>カードを左右に動かすか、前後ボタンで確認</span><button type="button" data-drive-move="1" ${index >= runs.length - 1 ? "disabled" : ""}>次の便</button></div>
  </section>`;
}

function renderDriveView() {
  if (!state.driveOpen) return;
  if (state.driveChooserOpen || !state.driveOperationNo) { renderDriveChooser(); return; }
  $("#driveSettingsButton").disabled = false;
  const run = driveRun();
  if (run) {
    state.driveRunId = run.id;
    state.driveOperationNo = run.operationNo;
    if (!state.driveLeg || legData(run, state.driveLeg).type === "none") state.driveLeg = initialLegForRun(run);
  }
  $("#driveServiceLabel").textContent = `${state.date}　${state.day}運行${run ? `　運用 ${run.operationNo}` : ""}`;
  if (!run) {
    $("#driveContent").innerHTML = `<div class="drive-empty">${icon("bus")}<strong>本日の運行は完了しています</strong><span>当日運行へ戻り、履歴を確認できます。</span></div>`;
    updateDriveTick();
    return;
  }
  const leg = legData(run);
  const [statusLabel, statusClass] = statusInfo[leg.status] || statusInfo.waiting;
  const next = legActionInfo(run);
  const following = nextRunAfter(run);
  const countdown = legCountdownInfo(run);
  const capacity = capacityInfo(run, leg.leg);
  const typeInfo = serviceTypeInfo[leg.type];
  $("#driveContent").innerHTML = `${driveRunDeckMarkup(run)}
    <section class="drive-leg-switch" aria-label="往路と復路を切り替える">
      ${["outbound", "inbound"].map((value) => { const item = legData(run, value); const info = serviceTypeInfo[item.type]; return `<button type="button" data-drive-leg="${value}" class="${leg.leg === value ? "active" : ""}" aria-pressed="${leg.leg === value}" ${item.type === "none" ? "disabled" : ""}><span>${item.label}</span><strong>${info[0]}</strong><small>${(statusInfo[item.status] || statusInfo.waiting)[0]}</small></button>`; }).join("")}
    </section>
    <section class="drive-primary ${statusClass || run.status}">
      <div class="drive-run-topline"><span class="drive-status ${statusClass}">${leg.label}　${statusLabel}</span><span class="service-type ${typeInfo[1]}">${typeInfo[0]}</span><span>運用 ${run.operationNo}　便 ${run.columnNo}</span></div>
      <div class="drive-route"><strong>${escapeHTML(legRouteText(run, leg.leg))}</strong><span>${escapeHTML(run.vehicleNo || "車両未定")}　${escapeHTML(run.driverName || "担当未定")}</span></div>
      <div class="drive-countdown ${countdown.late ? "late" : ""}"><span id="driveCountdownLabel">${countdown.label}</span><strong id="driveCountdown" role="timer">${countdown.value}</strong><small id="driveCountdownDetail">${countdown.detail}</small></div>
      ${run.serviceDetails ? `<div class="drive-note"><strong>便種別の詳細</strong><span>${escapeHTML(run.serviceDetails)}</span></div>` : ""}
      ${run.note ? `<div class="drive-note"><strong>注意事項</strong><span>${escapeHTML(run.note)}</span></div>` : ""}
    </section>
    <section class="drive-passengers ${capacity.className}" aria-labelledby="drivePassengerHeading">
      <div class="drive-section-heading"><span>乗車人数　定員 ${capacity.capacity}名</span><strong id="drivePassengerHeading">${escapeHTML(capacity.text)}</strong></div>
      <label class="drive-passenger-value"><span class="sr-only">${leg.label}の乗車人数</span><input type="number" min="0" max="999" value="${leg.passengers}" data-count-input="${escapeHTML(run.id)}" data-leg="${leg.leg}"><small>名</small></label>
      <div class="drive-count-actions">
        <button type="button" data-count-delta="-1" data-id="${escapeHTML(run.id)}" data-leg="${leg.leg}" aria-label="${leg.label}の乗車人数を1名減らす">−1名</button>
        <button type="button" data-count-delta="1" data-id="${escapeHTML(run.id)}" data-leg="${leg.leg}" aria-label="${leg.label}の乗車人数を1名増やす">＋1名</button>
        <button type="button" class="drive-plus-ten" data-count-delta="10" data-id="${escapeHTML(run.id)}" data-leg="${leg.leg}" aria-label="${leg.label}の乗車人数を10名増やす">＋10名</button>
      </div>
    </section>
    <section class="drive-action-panel">
      ${next ? `<button type="button" class="drive-main-action ${next.className}" data-action="${next.action}" data-id="${escapeHTML(run.id)}" data-leg="${leg.leg}"><span>${next.label}</span>${icon("arrow")}</button>` : `<div class="drive-action-complete">${leg.label}の操作は完了しています</div>`}
      <p>時刻記録を伴う操作は、対象便を確認してから確定します。</p>
    </section>
    <details class="drive-more">
      <summary>経路、GPS、次便を確認</summary>
      <aside class="drive-next-run">
        <span>同じ運用の次便</span>
        ${following ? `<strong>${escapeHTML(following.plannedDeparture || "未定")}　運用 ${following.operationNo}</strong><p>${escapeHTML(following.route)}</p>` : "<strong>本日の最終便</strong><p>後続便はありません</p>"}
      </aside>
      ${routeProgressMarkup(run)}
    </details>`;
  requestAnimationFrame(() => {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    $("#driveRunDeck")?.querySelector(".drive-run-card.active")?.scrollIntoView({ behavior, block: "nearest", inline: "center" });
    bindDriveSwipe();
  });
  const profiles = [routeProfileFor(run, state.driveLeg)].filter(Boolean);
  if (profiles.length && window.BusRoutes?.renderDriveMap) requestAnimationFrame(() => window.BusRoutes.renderDriveMap($("#driveRouteMap"), profiles, state.gpsPosition || (run.latitude || run.longitude ? { latitude: run.latitude, longitude: run.longitude } : null)));
  updateDriveTick();
}

function updateDriveTick() {
  if (!state.driveOpen) return;
  const now = new Date();
  $("#driveClock").textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
  $("#driveDate").textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).format(now);
  const run = driveRun();
  if (!run || !$("#driveCountdown")) return;
  const countdown = legCountdownInfo(run, state.driveLeg, now);
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
  const leg = legData(run);
  if (!state.driveSettings.audioEnabled || !["waiting", "boarding"].includes(leg.status) || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  const departure = plannedDate(leg.departure);
  if (!departure) return;
  const seconds = Math.floor((departure.getTime() - now.getTime()) / 1000);
  let minute = null;
  if (seconds > 60 && seconds <= 180) minute = 3;
  if (seconds > 0 && seconds <= 60) minute = 1;
  if (!minute) return;
  const key = `${run.id}:${leg.leg}:${minute}`;
  if (state.notifiedDepartures.has(key)) return;
  if (minute === 1) state.notifiedDepartures.add(`${run.id}:${leg.leg}:3`);
  state.notifiedDepartures.add(key);
  storeJSON("busDepartureNotified", [...state.notifiedDepartures]);
  speakJapanese(`運用${run.operationNo}、${leg.label}の出発まで${minute}分以内です。乗車人数と安全確認を行ってください。`);
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
  renderSyncCenter();
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

async function selectDriveOperation(operationNo, runId = null) {
  const operation = Number(operationNo);
  const selected = state.runs.find((run) => run.id === runId && run.operationNo === operation) || initialRunForOperation(operation);
  if (!selected) { toast("対象の運用便がありません", "error"); return; }
  state.driveOperationNo = operation;
  state.driveRunId = selected.id;
  state.driveLeg = initialLegForRun(selected);
  state.driveChooserOpen = false;
  state.driveSelections[driveSelectionKey()] = operation;
  storeJSON("busDriveSelections", state.driveSelections);
  renderDriveView();
  $("#driveRunDeck")?.focus({ preventScroll: true });
  await setWakeLock(true);
  if (state.driveSettings.gpsEnabled) startGPS();
}

function showDriveOperationChooser() {
  state.driveChooserOpen = true;
  stopGPS();
  renderDriveView();
  $("[data-select-operation]")?.focus({ preventScroll: true });
}

function selectDriveRun(runId) {
  const run = state.runs.find((item) => item.id === runId && item.operationNo === state.driveOperationNo);
  if (!run) return;
  state.driveRunId = run.id;
  state.driveLeg = initialLegForRun(run);
  renderDriveView();
}

function moveDriveRun(delta) {
  const runs = driveOperationRuns();
  const index = runs.findIndex((run) => run.id === state.driveRunId);
  const next = runs[Math.max(0, Math.min(runs.length - 1, index + Number(delta)))];
  if (next && next.id !== state.driveRunId) selectDriveRun(next.id);
}

function bindDriveSwipe() {
  const target = $(".drive-primary");
  const deck = $("#driveRunDeck");
  deck?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      moveDriveRun(event.key === "ArrowRight" ? 1 : -1);
    }
  });
  if (!target) return;
  let start = null;
  target.addEventListener("pointerdown", (event) => { if (event.target.closest("button,input,a")) return; start = { x: event.clientX, y: event.clientY, id: event.pointerId }; });
  target.addEventListener("pointerup", (event) => {
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.25) moveDriveRun(dx < 0 ? 1 : -1);
  });
  target.addEventListener("pointercancel", () => { start = null; });
}

async function openDriveView(runId = null) {
  if (state.user?.role === "viewer") { toast("閲覧担当は集中表示を操作できません", "error"); return; }
  state.lastFocused = document.activeElement;
  const selected = state.runs.find((item) => item.id === runId) || null;
  const previousOperation = Number(state.driveSelections[driveSelectionKey()] || 0);
  state.driveRunId = selected?.id || null;
  state.driveOperationNo = selected?.operationNo || (driveOperationRuns(previousOperation).length ? previousOperation : null);
  state.driveLeg = selected ? initialLegForRun(selected) : "outbound";
  state.driveChooserOpen = !selected;
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
  if (selected) {
    state.driveSelections[driveSelectionKey()] = selected.operationNo;
    storeJSON("busDriveSelections", state.driveSelections);
    await setWakeLock(true);
    if (state.driveSettings.gpsEnabled) startGPS();
  }
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
  state.driveChooserOpen = false;
  stopGPS();
  window.BusRoutes?.closeDriveMap?.();
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
  if (state.gpsPosition) window.BusRoutes?.updateDrivePosition?.(state.gpsPosition);
}

async function sendGpsPosition(position) {
  const run = driveRun();
  if (!run) return;
  const body = {
    latitude: position.latitude,
    longitude: position.longitude,
    locationAccuracy: position.accuracy,
    locationZone: position.zone || "road",
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
    const raw = {
      latitude: result.coords.latitude,
      longitude: result.coords.longitude,
      accuracy: result.coords.accuracy,
		speed: Math.max(0, Number(result.coords.speed || 0)),
      capturedAt: new Date(result.timestamp).toISOString(),
    };
		if (state.lastRawGps) {
			const seconds = Math.max(1, (new Date(raw.capturedAt) - new Date(state.lastRawGps.capturedAt)) / 1000);
			const jump = distanceMeters(state.lastRawGps, raw);
			if (seconds <= 15 && jump > Math.max(300, seconds * 45) && raw.accuracy > 20) {
				state.gpsError = "不自然な測位を除外";
				updateGpsDisplay();
				return;
			}
		}
		state.lastRawGps = raw;
		state.gpsSpeed = raw.speed;
    const school = state.settings.schoolLatitude || state.settings.schoolLongitude ? { latitude: state.settings.schoolLatitude, longitude: state.settings.schoolLongitude } : null;
    const schoolDistance = school ? distanceMeters(raw, school) : Infinity;
		const schoolThreshold = Math.max(Number(state.settings.schoolRadius || 35), Math.min(45, Number(raw.accuracy || 0) * 1.2));
		const next = school && raw.accuracy <= 20 && schoolDistance <= schoolThreshold ? { ...raw, ...school, zone: "school", rawLatitude:raw.latitude, rawLongitude:raw.longitude, rawDistance:schoolDistance } : { ...raw, zone: "road" };
    state.gpsPosition = next;
    state.gpsError = next.zone === "school" ? "学校⓪へ位置補正" : "GPS取得済";
    updateGpsDisplay();
    const now = Date.now();
    const sendInterval = next.zone === "school" ? 10000 : 20000;
    const moveThreshold = next.zone === "school" ? 1 : 25;
    if (now - state.lastGpsSentAt >= sendInterval || distanceMeters(state.lastGpsCoords, next) >= moveThreshold) {
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

async function updateRouteProgress(id, delta, leg = state.driveLeg) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
  const stops = routeStopsForLeg(run, leg);
  const current = leg === "inbound" ? run.inboundProgressIndex : run.outboundProgressIndex;
  const nextIndex = Math.max(0, Math.min(stops.length - 1, Number(current || 0) + Number(delta)));
  run.progressIndex = nextIndex;
  if (leg === "inbound") run.inboundProgressIndex = nextIndex; else run.outboundProgressIndex = nextIndex;
  renderAll();
  try {
    const result = await mutate(`/api/runs/${encodeURIComponent(id)}`, "PATCH", { progressIndex: nextIndex, leg, expectedRevision: run.revision, occurredAt: new Date().toISOString(), requestId: requestID() }, "経路進捗");
    if (!result.queued) replaceRun(result.data);
    else { run.revision = Number(result.queuedItem?.body?.expectedRevision ?? run.revision) + 1; toast("経路進捗を一時保存しました"); }
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
    const expectedRevisions = Object.fromEntries(state.runs.filter((item) => item.operationNo === run.operationNo && !["arrived", "cancelled"].includes(item.status)).map((item) => [item.id, item.revision]));
    const result = await mutate(url, "PATCH", { ...settings, expectedRevisions, requestId: requestID() }, "運用設定");
    if (result.queued) {
      state.runs.forEach((item) => {
        if (item.operationNo === run.operationNo && !["arrived", "cancelled"].includes(item.status)) {
          Object.assign(item, settings);
          item.revision = Number(expectedRevisions[item.id] || item.revision || 1) + 1;
        }
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
  const mode = run.status === "departed" ? "運行中" : run.status === "boarding" ? "乗車受付中" : "次の確認便";
  const action = nextLegAction(run);
  const timing = priorityTiming(run);
  $("#priorityStrip").className = `priority-strip ${run.status}`;
  $("#priorityStrip").innerHTML = `<div class="priority-label"><span>${mode}</span><strong>${escapeHTML(run.plannedDeparture || "時刻未定")}</strong>${timing ? `<small>${escapeHTML(timing)}</small>` : ""}</div><div class="priority-route"><strong>運用 ${run.operationNo}　${escapeHTML(run.route)}</strong><span>${escapeHTML(run.vehicleNo || "車両未定")}　${escapeHTML(run.driverName || "担当未定")}　往 ${run.outboundPassengerCount || 0}名　復 ${run.inboundPassengerCount || 0}名</span></div>${action ? `<button class="priority-action ${action.className}" data-action="${action.action}" data-leg="${action.leg}" data-id="${escapeHTML(run.id)}">${action.label}${icon("arrow")}</button>` : ""}`;
}

function passengerControl(run, compact = false, leg = "outbound") {
  const data = legData(run, leg);
  return `<div class="passenger-stepper ${compact ? "compact" : ""}" aria-label="${data.label}の乗車人数">
    <button type="button" data-count-delta="-1" data-id="${escapeHTML(run.id)}" data-leg="${leg}" aria-label="${data.label}の乗車人数を1名減らす">−1</button>
    <label><span class="sr-only">${data.label}の乗車人数</span><input type="number" min="0" max="999" value="${data.passengers}" data-count-input="${escapeHTML(run.id)}" data-leg="${leg}"><small>名</small></label>
    <button type="button" data-count-delta="1" data-id="${escapeHTML(run.id)}" data-leg="${leg}" aria-label="${data.label}の乗車人数を1名増やす">＋1</button>
    <button type="button" class="quick-ten" data-count-delta="10" data-id="${escapeHTML(run.id)}" data-leg="${leg}" aria-label="${data.label}の乗車人数を10名増やす">＋10</button>
  </div>`;
}

function passengerPair(run, compact = false) {
  return `<div class="leg-passenger-pair"><span>往路</span>${passengerControl(run, compact, "outbound")}<span>復路</span>${passengerControl(run, compact, "inbound")}</div>`;
}

function runEmphasis(run, delay) {
  if (run.status === "cancelled") return "is-cancelled";
  const highestCount = Math.max(Number(run.passengerCount || 0), Number(run.outboundPassengerCount || 0), Number(run.inboundPassengerCount || 0));
  if (highestCount > Number(run.capacity || 55)) return "is-overcapacity";
  if (highestCount === Number(run.capacity || 55)) return "is-full";
  if ((delay ?? 0) >= 5) return "is-delayed";
  if (run.note) return "has-note";
  if (run.status === "departed") return "in-service";
  return "";
}

function clearRunFilters() {
  state.status = "all";
  state.query = "";
  $("#searchInput").value = "";
  $$("[data-status]").forEach((button) => {
    const active = button.dataset.status === "all";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderRuns();
  $("#searchInput").focus();
}

function clearRunSearch() {
  state.query = "";
  $("#searchInput").value = "";
  renderRuns();
  $("#searchInput").focus();
}

function renderRuns() {
  const runs = visibleRuns();
  const statusCounts = state.runs.reduce((counts, run) => {
    counts[run.status] = (counts[run.status] || 0) + 1;
    return counts;
  }, {});
  ["waiting", "boarding", "departed", "arrived", "cancelled"].forEach((status) => {
    const element = $(`#${status}Count`);
    if (element) element.textContent = statusCounts[status] || 0;
  });
  const hasFilter = state.status !== "all" || Boolean(state.query.trim());
  $("#clearSearchButton").hidden = !state.query;
  $("#resultsSummary").innerHTML = `<strong>${runs.length}便を表示</strong><span> ／ 全${state.runs.length}便</span>${hasFilter ? '<button type="button" data-clear-filters>絞り込みを解除</button>' : '<span>　時刻順に確認できます</span>'}`;
  if (!runs.length) {
    const reason = state.runs.length ? "絞り込み条件に合う便がありません" : "ダイヤ取込からExcelを登録してください";
    const reset = state.runs.length ? '<button type="button" class="button secondary" data-clear-filters>絞り込みを解除</button>' : '';
    $("#runsContent").innerHTML = `<div class="empty"><div>${icon("bus")}<strong>${reason}</strong><p>${state.runs.length ? "検索語や状態を変更して、もう一度お試しください。" : "元ダイヤを登録すると、ここに本日の便が表示されます。"}</p>${reset}</div></div>`;
    return;
  }
  const rows = runs.map((run) => {
    const [statusLabel, statusClass] = statusInfo[run.status] || statusInfo.waiting;
    const next = nextLegAction(run);
    const delay = run.arrivalDelayMinutes ?? run.departureDelayMinutes;
    const capacity = capacityInfo(run);
    const nextButton = next ? `<button class="next-button ${next.className}" data-action="${next.action}" data-leg="${next.leg}" data-id="${escapeHTML(run.id)}">${next.label}${icon("arrow")}</button>` : "";
    const driveButton = !["arrived", "cancelled"].includes(run.status) ? `<button class="drive-row-button" data-drive-id="${escapeHTML(run.id)}" aria-label="この便を集中表示">集中</button>` : "";
    return `<tr class="${runEmphasis(run, delay)}">
      <td><div class="planned-time">${escapeHTML(run.plannedDeparture || "未定")}</div><div class="subtext">到着 ${escapeHTML(run.plannedArrival || "未定")}</div></td>
      <td class="route-cell"><strong>運用 ${run.operationNo}<span class="subtext">　便 ${run.columnNo}</span></strong><p>${escapeHTML(run.route)}</p><span class="route-assignment-chip ${routeProfileFor(run, "outbound") ? "" : "unassigned"}">往 ${escapeHTML(routeProfileFor(run, "outbound")?.name || "未割当")}</span><span class="route-assignment-chip ${routeProfileFor(run, "inbound") ? "" : "unassigned"}">復 ${escapeHTML(routeProfileFor(run, "inbound")?.name || "未割当")}</span>${run.note ? `<p class="note-text">注意 ${escapeHTML(run.note)}</p>` : ""}</td>
      <td><strong>${escapeHTML(run.vehicleNo || "車両未定")}</strong><div class="subtext">${escapeHTML(run.driverName || "担当未定")}</div></td>
      <td>${passengerPair(run, true)}<div class="capacity-mini ${capacity.className}">${capacity.capacity}名定員</div></td>
      <td><div class="actual-line"><span>出発</span><strong>${actualTime(run.actualDeparture)}</strong></div><div class="actual-line"><span>到着</span><strong>${actualTime(run.actualArrival)}</strong></div>${delay !== null && delay !== undefined ? `<div class="delay ${delay >= 5 ? "late" : ""}">${delayText(delay)}</div>` : ""}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td><div class="row-actions">${driveButton}<button class="edit-button" data-edit="${escapeHTML(run.id)}" aria-label="便情報を編集">${icon("edit")}</button>${nextButton}</div></td>
    </tr>`;
  }).join("");
  const cards = runs.map((run) => {
    const [statusLabel, statusClass] = statusInfo[run.status] || statusInfo.waiting;
    const next = nextLegAction(run);
    const delay = run.arrivalDelayMinutes ?? run.departureDelayMinutes;
    const capacity = capacityInfo(run);
    const driveButton = !["arrived", "cancelled"].includes(run.status) ? `<button class="drive-row-button" data-drive-id="${escapeHTML(run.id)}" aria-label="この便を集中表示">集中</button>` : "";
    return `<article class="run-card ${runEmphasis(run, delay)}">
      <div class="run-card-head"><div><span class="run-label">運用 ${run.operationNo}　便 ${run.columnNo}</span><strong class="mobile-time">${escapeHTML(run.plannedDeparture || "未定")}</strong><span class="subtext">到着 ${escapeHTML(run.plannedArrival || "未定")}</span></div><span class="badge ${statusClass}">${statusLabel}</span></div>
      <div class="mobile-route"><strong>${escapeHTML(run.route)}</strong><span>${escapeHTML(run.vehicleNo || "車両未定")}　${escapeHTML(run.driverName || "担当未定")}</span><span><span class="route-assignment-chip ${routeProfileFor(run, "outbound") ? "" : "unassigned"}">往 ${escapeHTML(routeProfileFor(run, "outbound")?.name || "未割当")}</span><span class="route-assignment-chip ${routeProfileFor(run, "inbound") ? "" : "unassigned"}">復 ${escapeHTML(routeProfileFor(run, "inbound")?.name || "未割当")}</span></span></div>
      ${run.note ? `<div class="mobile-alert">注意　${escapeHTML(run.note)}</div>` : ""}
      ${delay !== null && delay !== undefined ? `<div class="mobile-delay ${delay >= 5 ? "late" : ""}">${delayText(delay)}</div>` : ""}
      <div class="mobile-facts"><span>出発 <strong>${actualTime(run.actualDeparture)}</strong></span><span>到着 <strong>${actualTime(run.actualArrival)}</strong></span></div>
      <div class="mobile-controls">${passengerPair(run)}<div class="mobile-side-actions">${driveButton}<button class="edit-button" data-edit="${escapeHTML(run.id)}" aria-label="便情報を編集">${icon("edit")}</button></div></div>
      <div class="capacity-mini ${capacity.className}">${capacity.capacity}名定員　${escapeHTML(capacity.text)}</div>
      ${next ? `<button class="next-button mobile-next ${next.className}" data-action="${next.action}" data-leg="${next.leg}" data-id="${escapeHTML(run.id)}">${next.label}${icon("arrow")}</button>` : ""}
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

function renderLaunchOperations() {
  const container = $("#launchOperationGrid");
  if (!container) return;
  $("#launchDateLabel").textContent = `${state.date}　${state.day}運行。担当する運用番号を一度押すだけで開始できます。`;
  const previous = Number(state.driveSelections[driveSelectionKey()] || 0);
  container.innerHTML = Array.from({ length: 9 }, (_, index) => index + 1).map((operationNo) => {
    const runs = driveOperationRuns(operationNo);
    const active = runs.filter((run) => !["arrived", "cancelled"].includes(run.status)).length;
    const current = runs.find((run) => ["boarding", "departed"].includes(run.status));
    const label = current ? "運行中" : runs.length ? "残り" + active + "便" : "運行なし";
    return "<button type=\"button\" class=\"" + (operationNo === previous ? "previous" : "") + "\" data-launch-operation=\"" + operationNo + "\" " + (runs.length ? "" : "disabled") + " aria-label=\"運用" + operationNo + "を開く\"><strong>" + operationNo + "</strong><span>" + label + (operationNo === previous ? "　前回" : "") + "</span></button>";
  }).join("");
}

function templateKey(item) {
  return [item.day, item.operationNo, item.columnNo].join("|");
}

function timeInputValue(value) {
  const parts = String(value || "").split(":");
  return parts.length === 2 ? `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}` : "";
}

function clockValue(value) {
	const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
	return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function validateTemplatePayload(payload) {
	const errors = [], warnings = [];
	const cycleStart = clockValue(payload.plannedDeparture), cycleEnd = clockValue(payload.plannedArrival);
	const outboundStart = clockValue(payload.outboundDeparture), outboundEnd = clockValue(payload.outboundArrival);
	const inboundStart = clockValue(payload.inboundDeparture), inboundEnd = clockValue(payload.inboundArrival);
	if (cycleStart === null || cycleEnd === null) errors.push("一周の出発と帰着を入力してください");
	else if (cycleEnd <= cycleStart) errors.push("一周の帰着は出発より後にしてください");
	if (payload.outboundType !== "none" && outboundStart === null) errors.push("往路の出発時刻を入力してください");
	if (payload.inboundType !== "none" && inboundEnd === null) errors.push("復路の到着時刻を入力してください");
	if (outboundStart !== null && outboundEnd !== null && outboundEnd <= outboundStart) errors.push("往路到着は往路出発より後にしてください");
	if (inboundStart !== null && inboundEnd !== null && inboundEnd <= inboundStart) errors.push("復路到着は復路出発より後にしてください");
	if (outboundEnd !== null && inboundStart !== null && inboundStart < outboundEnd) errors.push("復路出発は往路到着以降にしてください");
	if (payload.outboundType !== "none" && outboundEnd === null) warnings.push("往路到着が未入力です");
	if (payload.inboundType !== "none" && inboundStart === null) warnings.push("復路出発が未入力です");
	if (payload.outboundType === "none" && (outboundStart !== null || outboundEnd !== null)) warnings.push("往路は運行なしですが時刻が入っています");
	if (payload.inboundType === "none" && (inboundStart !== null || inboundEnd !== null)) warnings.push("復路は運行なしですが時刻が入っています");
	const overlaps = state.timetable.filter((item) => item.day === payload.day && item.operationNo === payload.operationNo && item.columnNo !== payload.columnNo).filter((item) => {
		const start = clockValue(timeInputValue(item.plannedDeparture)), end = clockValue(timeInputValue(item.plannedArrival));
		return cycleStart !== null && cycleEnd !== null && start !== null && end !== null && cycleStart < end && cycleEnd > start;
	});
	if (overlaps.length) errors.push(`便${overlaps.map((item) => item.columnNo).join("、")}と時間が重複しています`);
	const hasRouteProfile = state.routeProfiles.some((profile) => payload.route.includes(profile.line));
	if (!hasRouteProfile) warnings.push("該当路線の登録経路がありません");
	return { errors, warnings };
}

function showTemplateValidation(report) {
	const element = $("#templateValidation");
	const items = [...report.errors.map((text) => `<li class="error">${escapeHTML(text)}</li>`), ...report.warnings.map((text) => `<li>${escapeHTML(text)}</li>`)].join("");
	element.hidden = !items;
	element.innerHTML = items ? `<strong>${report.errors.length ? "保存できない項目があります" : "確認が必要な項目があります"}</strong><ul>${items}</ul>${!report.errors.length ? "<small>内容が正しければ、もう一度保存を押してください。</small>" : ""}` : "";
	if (items) element.focus();
}

function renderTimetableEditor() {
  const day = $("#timetableDayFilter")?.value || state.day;
  const operation = Number($("#timetableOperationFilter")?.value || 1);
  const items = state.timetable.filter((item) => item.day === day && item.operationNo === operation);
  if (!$("#timetableList")) return;
  $("#timetableList").innerHTML = items.length ? items.map((item) => {
    const outward = serviceTypeInfo[item.outboundType] || serviceTypeInfo.passenger;
    const inward = serviceTypeInfo[item.inboundType] || serviceTypeInfo.passenger;
    return "<button type=\"button\" data-template-key=\"" + escapeHTML(templateKey(item)) + "\" class=\"" + (state.editingTemplateKey === templateKey(item) ? "active" : "") + "\"><strong>便 " + item.columnNo + "　" + escapeHTML(item.plannedDeparture || "未定") + "</strong><span>" + escapeHTML(item.route) + "</span><small>往 " + outward[0] + "　復 " + inward[0] + "</small></button>";
  }).join("") : "<div class=\"empty\">この運用の元ダイヤはありません</div>";
}

function editTemplate(item) {
  state.editingTemplateKey = item ? templateKey(item) : null;
  const day = $("#timetableDayFilter")?.value || state.day;
  const operation = Number($("#timetableOperationFilter")?.value || 1);
  const nextColumn = state.timetable.filter((entry) => entry.day === day && entry.operationNo === operation).reduce((max, entry) => Math.max(max, entry.columnNo), 0) + 1;
  const value = item || { day, operationNo: operation, columnNo: nextColumn, outboundType: "passenger", inboundType: "passenger" };
  $("#templateDay").value = value.day;
  $("#templateOperation").value = value.operationNo;
  $("#templateColumn").value = value.columnNo;
  $("#templateDeparture").value = timeInputValue(value.plannedDeparture);
  $("#templateArrival").value = timeInputValue(value.plannedArrival);
  $("#templateRoute").value = value.route || "";
  $("#templateOutboundType").value = value.outboundType || "passenger";
  $("#templateInboundType").value = value.inboundType || "passenger";
  $("#templateOutboundDeparture").value = timeInputValue(value.outboundDeparture || value.plannedDeparture);
  $("#templateOutboundArrival").value = timeInputValue(value.outboundArrival);
  $("#templateInboundDeparture").value = timeInputValue(value.inboundDeparture);
  $("#templateInboundArrival").value = timeInputValue(value.inboundArrival || value.plannedArrival);
  $("#templateDetails").value = value.details || "";
  renderTimetableEditor();
}

async function saveTemplate(event) {
  event.preventDefault();
  if (state.busy) return;
  const payload = {
    day: $("#templateDay").value, operationNo: Number($("#templateOperation").value), columnNo: Number($("#templateColumn").value),
    plannedDeparture: $("#templateDeparture").value, plannedArrival: $("#templateArrival").value, route: $("#templateRoute").value.trim(),
    outboundType: $("#templateOutboundType").value, inboundType: $("#templateInboundType").value,
    outboundDeparture: $("#templateOutboundDeparture").value, outboundArrival: $("#templateOutboundArrival").value,
    inboundDeparture: $("#templateInboundDeparture").value, inboundArrival: $("#templateInboundArrival").value,
    details: $("#templateDetails").value.trim(),
  };
	const report = validateTemplatePayload(payload);
	const signature = JSON.stringify(payload);
	if (report.errors.length || (report.warnings.length && state.templateWarningSignature !== signature)) {
		state.templateWarningSignature = report.errors.length ? "" : signature;
		showTemplateValidation(report);
		return;
	}
	showTemplateValidation({ errors:[], warnings:[] });
	state.templateWarningSignature = "";
  setBusy(true);
  try {
    const saved = await api("/api/timetable", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    state.timetable = state.timetable.filter((item) => templateKey(item) !== templateKey(saved));
    state.timetable.push(saved);
    editTemplate(saved);
    await loadDashboard(true);
    toast("元ダイヤを保存しました");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function fleetVehicles() {
  return driveOperations().map((operation) => {
    const positioned = operation.runs.filter((run) => run.locationUpdatedAt && (run.latitude || run.longitude)).sort((a, b) => new Date(b.locationUpdatedAt) - new Date(a.locationUpdatedAt))[0];
    const current = operation.runs.find((run) => ["boarding", "departed"].includes(run.status)) || initialRunForOperation(operation.operationNo);
    const ageSeconds = positioned ? Math.max(0, Math.floor((Date.now() - new Date(positioned.locationUpdatedAt).getTime()) / 1000)) : Infinity;
		const position = positioned ? { latitude: positioned.latitude, longitude: positioned.longitude, accuracy: positioned.locationAccuracy, label: "運用" + operation.operationNo, zone: positioned.locationZone, freshness:ageSeconds > 60 ? "stale" : ageSeconds > 30 ? "delayed" : "fresh" } : null;
		return { operationNo: operation.operationNo, run: current, position, updatedAt: positioned?.locationUpdatedAt, ageSeconds };
  });
}

function renderFleet() {
  if (!$("#fleetVehicleList")) return;
  const vehicles = fleetVehicles();
  $("#fleetVehicleList").innerHTML = vehicles.map((item) => {
    const freshness = item.ageSeconds > 60 ? "位置が古い" : item.ageSeconds > 30 ? "更新遅延" : "更新中";
		const location = item.position ? (item.position.zone === "school" ? "学校⓪" : "道路上") + "　精度約" + Math.round(item.position.accuracy || 0) + "m　" + freshness + "　" + actualTime(item.updatedAt) : "位置情報なし";
		return "<article class=\"" + (!item.position ? "no-position" : item.ageSeconds > 60 ? "stale-position" : item.ageSeconds > 30 ? "delayed-position" : "") + "\"><strong>運用 " + item.operationNo + "</strong><span>" + escapeHTML(item.run?.vehicleNo || "車両未定") + "　" + escapeHTML(item.run?.driverName || "担当未定") + "</span><small>" + location + "</small></article>";
  }).join("");
  $("#fleetMapStatus").textContent = vehicles.filter((item) => item.position).length + "台の最新位置を表示";
  if (!$("#schoolPointForm").contains(document.activeElement)) {
    $("#schoolLatitude").value = state.settings.schoolLatitude || "";
    $("#schoolLongitude").value = state.settings.schoolLongitude || "";
  $("#schoolRadius").value = state.settings.schoolRadius || 35;
  }
  const school = state.settings.schoolLatitude || state.settings.schoolLongitude ? { latitude: state.settings.schoolLatitude, longitude: state.settings.schoolLongitude, label: "⓪ 学校" } : null;
  if ($("#fleetView").classList.contains("active")) window.BusRoutes?.renderFleetMap?.($("#fleetMap"), state.routeProfiles, vehicles.map((item) => item.position).filter(Boolean), school);
}

async function saveSchoolPoint(event) {
  event.preventDefault();
  const payload = { schoolLatitude: Number($("#schoolLatitude").value), schoolLongitude: Number($("#schoolLongitude").value), schoolRadius: Number($("#schoolRadius").value || 35) };
  setBusy(true);
  try {
    state.settings = await api("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    renderFleet();
    toast("学校地点⓪を保存しました");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function captureSchoolPoint() {
  if (!navigator.geolocation) { toast("この端末では位置情報を利用できません", "error"); return; }
  $("#captureSchoolPoint").disabled = true;
  navigator.geolocation.getCurrentPosition((result) => {
    $("#schoolLatitude").value = result.coords.latitude.toFixed(7);
    $("#schoolLongitude").value = result.coords.longitude.toFixed(7);
    $("#captureSchoolPoint").disabled = false;
    toast("現在地を取得しました。端末精度は約" + Math.round(result.coords.accuracy) + "mです");
  }, () => { $("#captureSchoolPoint").disabled = false; toast("現在地を取得できませんでした", "error"); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
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
  renderLaunchOperations();
  renderTimetableEditor();
  renderFleet();
  renderDriveView();
  window.BusRoutes?.update?.({ date: state.date, day: state.day, runs: state.runs, profiles: state.routeProfiles, settings: state.settings });
  storeJSON(`busDashboard:${state.date}:${state.day}`, { runs: state.runs, events: state.events, routeProfiles: state.routeProfiles, timetable: state.timetable, settings: state.settings, timetableCount: Number.parseInt($("#timetableCount").textContent, 10) || 0 });
}

function replaceRun(next) {
  state.runs = state.runs.map((run) => run.id === next.id ? next : run);
  renderAll();
}

function optimisticAction(run, action, occurredAt, leg = "") {
  const next = { ...run, revision: Number(run.revision || 1) + 1, updatedAt: occurredAt };
  if (leg) {
    const prefix = leg === "inbound" ? "inbound" : "outbound";
    if (action === "boarding") next[`${prefix}Status`] = "boarding";
    if (action === "depart") { next[`${prefix}Status`] = "departed"; next[`${prefix}ActualDeparture`] = occurredAt; }
    if (action === "arrive") { next[`${prefix}Status`] = "arrived"; next[`${prefix}ActualArrival`] = occurredAt; }
    if (action === "cancel") next[`${prefix}Status`] = "cancelled";
    const legStatuses = [next.outboundStatus, next.inboundStatus];
    if (legStatuses.includes("departed")) next.status = "departed";
    else if (legStatuses.includes("boarding")) next.status = "boarding";
    else if (legStatuses.every((status) => ["arrived", "cancelled"].includes(status))) {
      next.status = legStatuses.every((status) => status === "cancelled") ? "cancelled" : "arrived";
    } else next.status = "waiting";
    if (leg === "outbound" && action === "depart") next.actualDeparture = occurredAt;
    if (leg === "inbound" && action === "arrive") next.actualArrival = occurredAt;
    return next;
  }
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

async function runAction(id, action, leg = "") {
  if (state.busy) return;
  setBusy(true);
  try {
    const current = state.runs.find((run) => run.id === id);
    const occurredAt = new Date().toISOString();
    const result = await mutate(`/api/runs/${encodeURIComponent(id)}/action`, "POST", { action, leg, expectedRevision: current?.revision, occurredAt, requestId: requestID() }, "運行操作");
    if (state.driveOpen && state.driveRunId === id && (action === "arrive" || action === "cancel")) {
      const current = state.runs.find((run) => run.id === id);
      if (leg === "outbound" && current && legData(current, "inbound").type !== "none") state.driveLeg = "inbound";
      else {
        const runs = driveOperationRuns();
        const currentIndex = runs.findIndex((run) => run.id === id);
        const next = runs.slice(currentIndex + 1).find((run) => !["arrived", "cancelled"].includes(run.status));
        if (next) { state.driveRunId = next.id; state.driveLeg = initialLegForRun(next); }
      }
    }
    replaceRun(result.queued ? optimisticAction(current, action, occurredAt, leg) : result.data);
    if (!result.queued) await loadDashboard(true);
    const messages = { boarding: "乗車受付を開始しました", depart: "出発時刻を記録しました", arrive: "到着時刻を記録しました", cancel: "運休を記録しました", reset: "待機へ戻しました" };
    toast(result.queued ? "通信復帰後に同期します" : messages[action] || "更新しました");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function requestAction(id, action, leg = "") {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
	if (state.gpsPosition && state.gpsSpeed > 2.8 && Number(state.gpsPosition.accuracy || 999) <= 30) {
		toast("走行中の可能性があります。停車後に操作してください", "error");
		speakJapanese("走行中の操作はできません。停車後に操作してください。", true);
		return;
	}
  if (action === "boarding") { runAction(id, action, leg); return; }
  const legLabel = leg === "inbound" ? "復路" : leg === "outbound" ? "往路" : "便";
  const labels = { depart: ["出発を記録しますか？", "出発"], arrive: ["到着を記録しますか？", "到着"], cancel: ["この便を運休にしますか？", "運休"] };
  const [title, button] = labels[action] || ["操作を確定しますか？", "確定"];
  state.confirming = { id, action, leg };
  $("#confirmTitle").textContent = `${legLabel}　${title}`;
  $("#confirmDescription").textContent = action === "cancel" ? "運休として記録し、通常の運行操作から外します。" : "実績時刻と遅延時間を自動で保存します。";
  const selectedLeg = leg ? legData(run, leg) : null;
  $("#confirmRun").innerHTML = `<strong>${escapeHTML(selectedLeg?.departure || run.plannedDeparture || "未定")}　運用 ${run.operationNo}</strong><span>${escapeHTML(leg ? legRouteText(run, leg) : run.route)}</span>`;
  $("#confirmActionButton").textContent = `${button}を確定`;
  $("#confirmActionButton").className = `button ${action === "cancel" ? "danger" : "primary"}`;
  $("#confirmDialog").showModal();
}

function queuePassenger(id, value, leg = "", offerUndo = false) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
  const previousValue = leg ? legData(run, leg).passengers : Number(run.passengerCount || 0);
  const nextValue = Math.max(0, Math.min(999, Number(value) || 0));
  run.passengerCount = nextValue;
  if (leg === "outbound") run.outboundPassengerCount = nextValue;
  if (leg === "inbound") run.inboundPassengerCount = nextValue;
	if (offerUndo && nextValue !== previousValue) {
		toast(`${nextValue - previousValue > 0 ? "+" : ""}${nextValue - previousValue}名を反映しました`, "success", { label:"取り消す", run:() => queuePassenger(id, previousValue, leg, false) });
	}
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
  const timerKey = `${id}:${leg || "cycle"}`;
  clearTimeout(state.countTimers.get(timerKey));
  state.countTimers.set(timerKey, setTimeout(async () => {
    try {
      const expectedRevision = run.revision;
      const result = await mutate(`/api/runs/${encodeURIComponent(id)}`, "PATCH", { passengerCount: nextValue, leg, expectedRevision, occurredAt: new Date().toISOString(), requestId: requestID() }, "乗車人数");
      if (!result.queued) replaceRun(result.data);
      else run.revision = Number(result.queuedItem?.body?.expectedRevision ?? expectedRevision) + 1;
      if (!offerUndo) toast(result.queued ? `乗車人数${nextValue}名を一時保存しました` : `乗車人数を${nextValue}名で保存しました`);
    } catch (error) { toast(error.message, "error"); await loadDashboard(true); }
    finally { state.countTimers.delete(timerKey); }
  }, 550));
}

function openDetails(id) {
  const run = state.runs.find((item) => item.id === id);
  if (!run) return;
  state.editing = { ...run };
  $("#dialogRoute").textContent = `運用 ${run.operationNo}　${run.route}`;
  $("#outboundPassengerCount").value = run.outboundPassengerCount || 0;
  $("#inboundPassengerCount").value = run.inboundPassengerCount || 0;
  $("#vehicleNo").value = run.vehicleNo || "";
  $("#driverName").value = run.driverName || "";
  $("#runOutboundRouteProfile").innerHTML = `<option value="">未割当</option>${state.routeProfiles.filter((profile) => profile.direction === "outbound").map((profile) => `<option value="${escapeHTML(profile.id)}">${escapeHTML(profile.name)}</option>`).join("")}`;
  $("#runInboundRouteProfile").innerHTML = `<option value="">未割当</option>${state.routeProfiles.filter((profile) => profile.direction === "inbound").map((profile) => `<option value="${escapeHTML(profile.id)}">${escapeHTML(profile.name)}</option>`).join("")}`;
  $("#runOutboundRouteProfile").value = run.outboundRouteProfileId || "";
  $("#runInboundRouteProfile").value = run.inboundRouteProfileId || "";
  $("#note").value = run.note || "";
  $("#cancelRunButton").hidden = state.user?.role !== "admin" || run.status === "cancelled";
  $("#resetRunButton").hidden = state.user?.role !== "admin" || run.status === "waiting";
  $("#detailsDialog").showModal();
}

async function saveDetails(event) {
  event.preventDefault();
  if (!state.editing || state.busy) return;
  setBusy(true);
  try {
    const payload = {
      outboundPassengerCount: Number($("#outboundPassengerCount").value || 0),
      inboundPassengerCount: Number($("#inboundPassengerCount").value || 0),
      vehicleNo: $("#vehicleNo").value,
      driverName: $("#driverName").value,
      outboundRouteProfileId: $("#runOutboundRouteProfile").value,
      inboundRouteProfileId: $("#runInboundRouteProfile").value,
      note: $("#note").value,
		expectedRevision: state.editing.revision,
      requestId: requestID(),
      occurredAt: new Date().toISOString(),
    };
    const result = await mutate(`/api/runs/${encodeURIComponent(state.editing.id)}`, "PATCH", payload, "便情報");
    if (!result.queued) replaceRun(result.data);
    else replaceRun({ ...state.editing, ...payload, revision: Number(state.editing.revision || 0) + 1 });
    $("#detailsDialog").close();
    if (!result.queued) await loadDashboard(true);
    toast(result.queued ? "便情報を一時保存しました" : "便情報を保存しました");
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
}

function switchView(view) {
	const destination = $(`#${view}View`);
	if (!destination || (["timetable", "routes"].includes(view) && state.user?.role !== "admin")) { toast("この画面を開く権限がありません", "error"); return; }
  clearInterval(state.fleetTimer);
  state.fleetTimer = null;
  $$(".nav-button").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".view").forEach((section) => section.classList.remove("active"));
  destination.classList.add("active");
  const titles = { operations: ["当日運行", "人数と出発、到着を即時記録"], timetable: ["元ダイヤ編集", "往路、復路、便種別を編集"], fleet: ["全車両位置", "最新GPSと学校地点⓪を確認"], routes: ["経路管理", "道路経路を条件別に登録して便へ割当"], history: ["操作履歴", "出発、到着、変更内容を確認"] };
  $("#pageTitle").textContent = titles[view][0];
  $("#pageSubtitle").textContent = titles[view][1];
  if (view === "routes") window.BusRoutes?.activate?.();
  if (view === "fleet") {
    requestAnimationFrame(renderFleet);
    state.fleetTimer = setInterval(() => { if (!document.hidden && !state.busy) loadDashboard(true); }, 15000);
  }
  if (view === "timetable" && !state.editingTemplateKey) editTemplate(state.timetable.find((item) => item.day === state.day && item.operationNo === 1) || null);
  $("#sidebar").classList.remove("open");
}

async function login(event) {
	event.preventDefault();
	const error = $("#loginError");
	error.hidden = true;
	const button = $("#loginForm button[type=submit]");
	button.disabled = true;
	button.textContent = "確認中";
	try {
		const result = await api("/api/login", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ id:$("#loginStaffId").value.trim(), pin:$("#loginPin").value }) });
		$("#loginPin").value = "";
		applyUser(result.user);
		await startAfterLogin();
	} catch (loginError) {
		error.textContent = loginError.message;
		error.hidden = false;
		error.focus();
	} finally {
		button.disabled = false;
		button.textContent = "ログイン";
	}
}

async function logout() {
	try { await api("/api/logout", { method:"POST" }); } catch {}
	if (state.driveOpen) await closeDriveView();
	showLogin();
}

async function startAfterLogin() {
	await loadDashboard();
	const previous = Number(state.driveSelections[driveSelectionKey()] || 0);
	const target = state.user?.role === "viewer" ? $("#launchAdmin") : $(`[data-launch-operation="${previous}"]:not(:disabled)`) || $("[data-launch-operation]:not(:disabled)") || $("#launchAdmin");
	target?.focus();
	renderSyncCenter();
	syncOfflineQueue();
}

async function initializeApp() {
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
	try {
		const session = await api("/api/session");
		applyUser(session.user);
		await startAfterLogin();
	} catch (error) {
		if (error.status !== 401) showLogin(error.message);
		else showLogin();
	}
}

function retryConflict(index) {
	const item = state.offlineConflicts[index];
	if (!item) return;
	item.id = requestID();
	item.body.requestId = item.id;
	item.queuedAt = new Date().toISOString();
	if (item.current?.revision && item.body.expectedRevision !== undefined) item.body.expectedRevision = item.current.revision;
	if (item.current?.revision && item.body.expectedRevisions) item.body.expectedRevisions[item.current.id] = item.current.revision;
	state.offlineQueue.push(item);
	state.offlineConflicts.splice(index, 1);
	storeJSON("busOfflineQueue", state.offlineQueue);
	storeJSON("busOfflineConflicts", state.offlineConflicts);
	renderSyncCenter();
	syncOfflineQueue();
}

function discardConflict(index) {
	state.offlineConflicts.splice(index, 1);
	storeJSON("busOfflineConflicts", state.offlineConflicts);
	renderSyncCenter();
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
	const clearFiltersButton = event.target.closest("[data-clear-filters]");
	if (clearFiltersButton) { clearRunFilters(); return; }
	const retryConflictButton = event.target.closest("[data-conflict-retry]");
	if (retryConflictButton) { retryConflict(Number(retryConflictButton.dataset.conflictRetry)); return; }
	const discardConflictButton = event.target.closest("[data-conflict-discard]");
	if (discardConflictButton) { discardConflict(Number(discardConflictButton.dataset.conflictDiscard)); return; }
  const launchOperation = event.target.closest("[data-launch-operation]");
  if (launchOperation) {
    const run = initialRunForOperation(Number(launchOperation.dataset.launchOperation));
    if (run) { $("#launchGate").hidden = true; $(".app-shell").inert = false; openDriveView(run.id); }
  }
  const templateButton = event.target.closest("[data-template-key]");
  if (templateButton) {
    const item = state.timetable.find((entry) => templateKey(entry) === templateButton.dataset.templateKey);
    if (item) editTemplate(item);
  }
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
  const operationButton = event.target.closest("[data-select-operation]");
  if (operationButton) selectDriveOperation(operationButton.dataset.selectOperation);
  const driveRunButton = event.target.closest("[data-drive-run]");
  if (driveRunButton) selectDriveRun(driveRunButton.dataset.driveRun);
  const driveMoveButton = event.target.closest("[data-drive-move]");
  if (driveMoveButton) moveDriveRun(driveMoveButton.dataset.driveMove);
  const driveLegButton = event.target.closest("[data-drive-leg]");
  if (driveLegButton) { state.driveLeg = driveLegButton.dataset.driveLeg; renderDriveView(); }
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) requestAction(actionButton.dataset.id, actionButton.dataset.action, actionButton.dataset.leg || "");
  const countButton = event.target.closest("[data-count-delta]");
  if (countButton) {
    const run = state.runs.find((item) => item.id === countButton.dataset.id);
    if (run) {
      const delta = countButton.dataset.countDelta;
      const inDriveView = Boolean(countButton.closest("#driveView"));
      const leg = countButton.dataset.leg || "";
      const currentCount = leg ? legData(run, leg).passengers : Number(run.passengerCount || 0);
      queuePassenger(run.id, currentCount + Number(delta), leg, Math.abs(Number(delta)) >= 10);
      const scope = inDriveView ? $("#driveView") : document;
      [...scope.querySelectorAll("[data-count-delta]")].find((button) => button.dataset.id === run.id && button.dataset.countDelta === delta)?.focus({ preventScroll: true });
    }
  }
  const progressButton = event.target.closest("[data-progress-delta]");
  if (progressButton) updateRouteProgress(progressButton.dataset.id, progressButton.dataset.progressDelta, progressButton.dataset.leg || state.driveLeg);
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
  if (input) queuePassenger(input.dataset.countInput, input.value, input.dataset.leg || "");
});

$("#serviceDate").value = state.date;
$("#timetableOperationFilter").innerHTML = Array.from({ length: 9 }, (_, index) => `<option value="${index + 1}">運用 ${index + 1}</option>`).join("");
$("#timetableDayFilter").value = state.day;
$("#launchAdmin").addEventListener("click", () => { $("#launchGate").hidden = true; $(".app-shell").inert = false; $("#openSidebar").focus(); });
$("#loginForm").addEventListener("submit", login);
$("#logoutButton").addEventListener("click", logout);
$("#syncStatusButton").addEventListener("click", () => { renderSyncCenter(); $("#syncDialog").showModal(); });
$("#retrySyncButton").addEventListener("click", syncOfflineQueue);
$("#timetableDayFilter").addEventListener("change", () => { state.editingTemplateKey = null; renderTimetableEditor(); editTemplate(null); });
$("#timetableOperationFilter").addEventListener("change", () => { state.editingTemplateKey = null; renderTimetableEditor(); editTemplate(null); });
$("#timetableForm").addEventListener("submit", saveTemplate);
$("#newTemplateButton").addEventListener("click", () => editTemplate(null));
$("#schoolPointForm").addEventListener("submit", saveSchoolPoint);
$("#captureSchoolPoint").addEventListener("click", captureSchoolPoint);
$("#serviceDate").addEventListener("change", (event) => { state.date = event.target.value; loadDashboard(); });
$("#searchInput").addEventListener("input", (event) => { state.query = event.target.value; renderRuns(); });
$("#clearSearchButton").addEventListener("click", clearRunSearch);
$("#reloadButton").addEventListener("click", () => loadDashboard());
$("#openDriveButton").addEventListener("click", () => openDriveView());
$("#exitDriveButton").addEventListener("click", closeDriveView);
$("#keepAwakeButton").addEventListener("click", () => setWakeLock(!state.wakeWanted));
$("#driveOperationButton").addEventListener("click", showDriveOperationChooser);
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
  $("#timetableDayFilter").value = state.day;
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
  await runAction(pending.id, pending.action, pending.leg || "");
});
window.addEventListener("online", () => { state.serverReachable = null; updateConnectionStatus(); syncOfflineQueue(); });
window.addEventListener("offline", updateConnectionStatus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.driveOpen && state.wakeWanted && !state.wakeLock) setWakeLock(true);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.driveOpen && !$("#confirmDialog").open && !$("#detailsDialog").open && !$("#driveSettingsDialog").open) closeDriveView();
});

window.busApp = {
  api,
  toast,
  setBusy,
  reload: () => loadDashboard(true),
  snapshot: () => ({ date: state.date, day: state.day, runs: state.runs, profiles: state.routeProfiles, settings: state.settings }),
  setProfiles: (profiles) => { state.routeProfiles = profiles || []; renderAll(); },
};

updateDayToggle();
initializeApp();
