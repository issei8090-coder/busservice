(() => {
  const TILE_SIZE = 256;
  const DEFAULT_CENTER = { latitude: 35.889, longitude: 139.51 };
  const byId = (id) => document.getElementById(id);
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  // 未設定の座標は (0,0) で保存されます。実在の地点として扱うと、日本の車両と
  // ギニア湾の(0,0)を両方収めようとして、地図の中心が海の真ん中へ飛びます。
  function located(point) {
    if (!point) return false;
    const { latitude, longitude } = point;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    return Math.abs(latitude) > 0.0001 || Math.abs(longitude) > 0.0001;
  }
  function worldSize(zoom) { return TILE_SIZE * (2 ** zoom); }
  function project(point, zoom) {
    const size = worldSize(zoom);
    const latitude = clamp(point.latitude, -85.05112878, 85.05112878);
    const sin = Math.sin(latitude * Math.PI / 180);
    return { x: (point.longitude + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
  }
  function unproject(pixel, zoom) {
    const size = worldSize(zoom);
    const longitude = pixel.x / size * 360 - 180;
    const n = Math.PI - 2 * Math.PI * pixel.y / size;
    return { latitude: 180 / Math.PI * Math.atan(Math.sinh(n)), longitude };
  }

  class OSMMap {
    constructor(element, onAddPoint = null) {
      this.element = element;
      this.onAddPoint = onAddPoint;
      this.center = { ...DEFAULT_CENTER };
      this.zoom = 13;
      this.waypoints = [];
      this.waypointLabels = [];
      this.geometry = [];
      this.routes = [];
      this.color = "#1e60aa";
      this.position = null;
      this.positions = [];
      this.school = null;
      this.drag = null;
      this.tiles = document.createElement("div");
      this.tiles.className = "osm-tile-layer";
      this.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.overlay.classList.add("osm-overlay");
      element.replaceChildren(this.tiles, this.overlay);
      element.addEventListener("pointerdown", (event) => this.pointerDown(event));
      element.addEventListener("pointermove", (event) => this.pointerMove(event));
      element.addEventListener("pointerup", (event) => this.pointerUp(event));
      element.addEventListener("pointercancel", () => { this.drag = null; });
      element.addEventListener("wheel", (event) => { event.preventDefault(); this.setZoom(this.zoom + (event.deltaY < 0 ? 1 : -1)); }, { passive: false });
      element.addEventListener("keydown", (event) => this.keyDown(event));
      this.observer = new ResizeObserver(() => this.render());
      this.observer.observe(element);
      this.render();
    }
    setData({ waypoints = [], waypointLabels = [], geometry = [], routes = [], color = "#1e60aa", position = null, positions = [], school = null }) {
      this.waypoints = waypoints;
      this.waypointLabels = waypointLabels;
      this.geometry = geometry;
      this.routes = routes;
      this.color = color;
      this.position = position;
      this.positions = positions;
      this.school = school;
      this.render();
    }
    destroy() { this.observer?.disconnect(); }
    setZoom(value) { this.zoom = clamp(Math.round(value), 8, 18); this.render(); }
    keyDown(event) {
      if (event.key === "Enter" && this.onAddPoint) { event.preventDefault(); this.onAddPoint({ ...this.center }); return; }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); this.setZoom(this.zoom + 1); return; }
      if (event.key === "-") { event.preventDefault(); this.setZoom(this.zoom - 1); return; }
      const moves = { ArrowLeft: [-64, 0], ArrowRight: [64, 0], ArrowUp: [0, -64], ArrowDown: [0, 64] };
      if (!moves[event.key]) return;
      event.preventDefault();
      const center = project(this.center, this.zoom);
      this.center = unproject({ x: center.x + moves[event.key][0], y: center.y + moves[event.key][1] }, this.zoom);
      this.render();
    }
    pointerDown(event) {
      if (event.button !== 0) return;
      this.element.setPointerCapture(event.pointerId);
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, center: project(this.center, this.zoom) };
    }
    pointerMove(event) {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      this.center = unproject({ x: this.drag.center.x - dx, y: this.drag.center.y - dy }, this.zoom);
      this.render();
    }
    pointerUp(event) {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const moved = this.drag.moved;
      this.drag = null;
      if (!moved && this.onAddPoint) {
        const rect = this.element.getBoundingClientRect();
        const center = project(this.center, this.zoom);
        const point = unproject({ x: center.x + event.clientX - rect.left - rect.width / 2, y: center.y + event.clientY - rect.top - rect.height / 2 }, this.zoom);
        this.onAddPoint(point);
      }
    }
    fit(points) {
      points = (points || []).filter(located);
      if (!points.length) { this.center = { ...DEFAULT_CENTER }; this.zoom = 13; this.render(); return; }
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      points.forEach((point) => { minLat = Math.min(minLat, point.latitude); maxLat = Math.max(maxLat, point.latitude); minLon = Math.min(minLon, point.longitude); maxLon = Math.max(maxLon, point.longitude); });
      this.center = { latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2 };
      const rect = this.element.getBoundingClientRect();
      this.zoom = 8;
      for (let zoom = 17; zoom >= 8; zoom -= 1) {
        const a = project({ latitude: minLat, longitude: minLon }, zoom);
        const b = project({ latitude: maxLat, longitude: maxLon }, zoom);
        if (Math.abs(b.x - a.x) <= Math.max(120, rect.width - 80) && Math.abs(b.y - a.y) <= Math.max(120, rect.height - 80)) { this.zoom = zoom; break; }
      }
      this.render();
    }
    render() {
      const rect = this.element.getBoundingClientRect();
      const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
      const center = project(this.center, this.zoom);
      const left = center.x - width / 2, top = center.y - height / 2;
      const tileCount = 2 ** this.zoom;
      const fragment = document.createDocumentFragment();
      const startX = Math.floor(left / TILE_SIZE), endX = Math.floor((left + width) / TILE_SIZE);
      const startY = Math.max(0, Math.floor(top / TILE_SIZE)), endY = Math.min(tileCount - 1, Math.floor((top + height) / TILE_SIZE));
      for (let y = startY; y <= endY; y += 1) {
        for (let x = startX; x <= endX; x += 1) {
          const wrappedX = ((x % tileCount) + tileCount) % tileCount;
          const image = document.createElement("img");
          image.alt = "";
          image.draggable = false;
          image.src = `https://tile.openstreetmap.org/${this.zoom}/${wrappedX}/${y}.png`;
          image.style.left = `${x * TILE_SIZE - left}px`;
          image.style.top = `${y * TILE_SIZE - top}px`;
          fragment.append(image);
        }
      }
      this.tiles.replaceChildren(fragment);
      this.overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.overlay.replaceChildren();
      const toScreen = (point) => { const pixel = project(point, this.zoom); return { x: pixel.x - left, y: pixel.y - top }; };
      const lines = this.routes.length ? this.routes : [{ geometry: this.geometry.length ? this.geometry : this.waypoints, color: this.color }];
      lines.forEach((line) => {
        const linePoints = (line.geometry || []).map(toScreen);
        if (linePoints.length < 2) return;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", linePoints.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "));
        path.setAttribute("class", "osm-route-line");
        path.setAttribute("stroke", line.color || this.color);
        this.overlay.append(path);
      });
      this.waypoints.forEach((point, index) => {
        const screen = toScreen(point);
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.setAttribute("class", "osm-waypoint");
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", screen.x); circle.setAttribute("cy", screen.y); circle.setAttribute("r", 12);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", screen.x); text.setAttribute("y", screen.y + 4); text.textContent = this.waypointLabels[index] || String(index + 1);
        group.append(circle, text); this.overlay.append(group);
      });
      if (this.position) {
        const screen = toScreen(this.position);
        const metersPerPixel = 156543.03392 * Math.cos(Number(this.position.latitude) * Math.PI / 180) / (2 ** this.zoom);
        const accuracyRadius = clamp(Number(this.position.accuracy || 0) / Math.max(.01, metersPerPixel), 0, 160);
        if (accuracyRadius > 2) {
          const accuracy = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          accuracy.setAttribute("cx", screen.x); accuracy.setAttribute("cy", screen.y); accuracy.setAttribute("r", accuracyRadius); accuracy.setAttribute("class", "osm-accuracy-circle");
          this.overlay.append(accuracy);
        }
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        marker.setAttribute("cx", screen.x); marker.setAttribute("cy", screen.y); marker.setAttribute("r", 9); marker.setAttribute("class", "osm-current-position");
        this.overlay.append(marker);
      }
      if (this.school) {
        const screen = toScreen(this.school);
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.setAttribute("class", "osm-school-marker");
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", screen.x); circle.setAttribute("cy", screen.y); circle.setAttribute("r", 15);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", screen.x); text.setAttribute("y", screen.y - 22); text.textContent = "⓪ 学校";
        group.append(circle, text); this.overlay.append(group);
      }
      const positionGroups = new Map();
      this.positions.forEach((position) => {
        const key = `${Number(position.latitude).toFixed(5)}|${Number(position.longitude).toFixed(5)}`;
        if (!positionGroups.has(key)) positionGroups.set(key, []);
        positionGroups.get(key).push(position);
      });
      positionGroups.forEach((items) => {
        const screen = toScreen(items[0]);
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const freshness = items.some((item) => item.freshness === "stale") ? "stale" : items.some((item) => item.freshness === "delayed") ? "delayed" : "fresh";
        group.setAttribute("class", `osm-fleet-marker ${items.length > 1 ? "cluster" : ""} ${freshness}`);
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", screen.x); circle.setAttribute("cy", screen.y); circle.setAttribute("r", items.length > 1 ? 17 : 13);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", screen.x); text.setAttribute("y", screen.y + 4); text.textContent = items.length > 1 ? `${items.length}台` : String(items[0].label || "車").replace("運用", "");
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = items.map((item) => item.label || "車両").join("、");
        group.append(title, circle, text); this.overlay.append(group);
      });
    }
  }

  const manager = {
    profiles: [], runs: [], date: "", day: "", settings: {}, currentId: "", waypoints: [], geometry: [], distance: 0, duration: 0, map: null, dirty: false,
    init() {
      if (!byId("routeMap")) return;
      this.map = new OSMMap(byId("routeMap"), (point) => { this.waypoints.push(point); this.geometry = []; this.distance = 0; this.duration = 0; this.setDirty(); this.draw(); });
      byId("newRouteProfile").addEventListener("click", () => this.reset());
      byId("routeZoomIn").addEventListener("click", () => this.map.setZoom(this.map.zoom + 1));
      byId("routeZoomOut").addEventListener("click", () => this.map.setZoom(this.map.zoom - 1));
      byId("routeFit").addEventListener("click", () => this.map.fit(this.geometry.length ? this.geometry : this.waypoints));
      byId("routeUndoPoint").addEventListener("click", () => { this.waypoints.pop(); this.geometry = []; this.setDirty(); this.draw(); });
      byId("routeClearPoints").addEventListener("click", () => { this.waypoints = []; this.geometry = []; this.distance = 0; this.duration = 0; this.setDirty(); this.draw(); });
      byId("routeResolve").addEventListener("click", () => this.resolve());
      byId("routeProfileForm").addEventListener("submit", (event) => this.save(event));
      byId("deleteRouteProfile").addEventListener("click", () => this.remove());
      byId("cancelRouteEdit").addEventListener("click", () => this.currentId ? this.edit(this.currentId) : this.reset());
      byId("autoAssignRoutes").addEventListener("click", () => this.autoAssign());
      byId("routeProfileList").addEventListener("click", (event) => { const button = event.target.closest("[data-route-profile]"); if (button) this.edit(button.dataset.routeProfile); });
      byId("routeProfileForm").addEventListener("input", (event) => { if (event.target.id === "routeColor" || event.target.id === "routeDirection") this.draw(); this.setDirty(); });
      this.update(window.busApp?.snapshot?.() || {});
      this.reset();
    },
    update(data = {}) { this.profiles = data.profiles || this.profiles; this.runs = data.runs || this.runs; this.date = data.date || this.date; this.day = data.day || this.day; this.settings = data.settings || this.settings; this.renderList(); },
    activate() { setTimeout(() => { this.map?.render(); if (!this.currentId && this.profiles.length) this.edit(this.profiles[0].id); }, 0); },
    setDirty(value = true) { this.dirty = value; byId("routeSaveState").textContent = value ? "未保存" : "保存済"; byId("routeSaveState").classList.toggle("saved", !value); },
    reset() {
      this.currentId = ""; this.waypoints = []; this.geometry = []; this.distance = 0; this.duration = 0;
      byId("routeProfileForm").reset(); byId("routeColor").value = "#1e60aa"; byId("routeProfileId").value = ""; byId("routeEditorTitle").textContent = "新しい経路"; byId("deleteRouteProfile").hidden = true;
      this.setDirty(false); this.map.fit([]); this.draw(); this.renderList();
    },
    edit(id) {
      const profile = this.profiles.find((item) => item.id === id); if (!profile) return;
      this.currentId = id; this.waypoints = structuredClone(profile.waypoints || []); this.geometry = structuredClone(profile.geometry || []); this.distance = profile.distanceMeters || 0; this.duration = profile.durationSeconds || 0;
      byId("routeProfileId").value = profile.id; byId("routeName").value = profile.name; byId("routeLine").value = profile.line; byId("routeDirection").value = profile.direction; byId("routeTimeFrom").value = profile.timeFrom || ""; byId("routeTimeTo").value = profile.timeTo || ""; byId("routeVehicleNo").value = profile.vehicleNo || ""; byId("routeColor").value = profile.color || "#1e60aa";
      byId("routeEditorTitle").textContent = profile.name; byId("deleteRouteProfile").hidden = false; this.setDirty(false); this.draw(); this.map.fit(this.geometry.length ? this.geometry : this.waypoints); this.renderList();
    },
    draw() {
      const direction = byId("routeDirection")?.value || "outbound";
      const labels = this.waypoints.map((_, index) => direction === "outbound" && index === 0 || direction === "inbound" && index === this.waypoints.length - 1 ? "⓪" : String(index + 1));
      this.map?.setData({ waypoints: this.waypoints, waypointLabels: labels, geometry: this.geometry, color: byId("routeColor")?.value || "#1e60aa" });
      byId("routePointCount").textContent = `地点 ${this.waypoints.length}件`;
      byId("routeDistance").textContent = this.distance ? `距離 ${Math.round(this.distance / 100) / 10}km` : "距離 未計算";
      byId("routeDuration").textContent = this.duration ? `所要 約${Math.round(this.duration / 60)}分` : "所要 未計算";
      byId("routeResolve").disabled = this.waypoints.length < 2;
      byId("routeUndoPoint").disabled = !this.waypoints.length;
      byId("routeClearPoints").disabled = !this.waypoints.length;
    },
    renderList() {
      if (!byId("routeProfileList")) return;
      byId("routeProfileCount").textContent = `${this.profiles.length}件`;
      byId("routeProfileList").innerHTML = this.profiles.length ? this.profiles.map((profile) => `<button type="button" class="route-profile-item ${profile.id === this.currentId ? "active" : ""}" data-route-profile="${esc(profile.id)}"><i style="background:${esc(profile.color || "#1e60aa")}"></i><span><strong>${esc(profile.name)}</strong><small>${esc(profile.line)}線　${profile.direction === "outbound" ? "往路" : "復路"}${profile.timeFrom || profile.timeTo ? `　${esc(profile.timeFrom || "開始")}から${esc(profile.timeTo || "終了")}` : ""}${profile.vehicleNo ? `　${esc(profile.vehicleNo)}` : ""}</small></span><b>${Math.round(Number(profile.distanceMeters || 0) / 100) / 10}km</b></button>`).join("") : `<div class="route-list-empty"><strong>経路は未登録です</strong><span>新しい経路を作成してください。</span></div>`;
    },
    async resolve() {
      if (this.waypoints.length < 2) return;
      const button = byId("routeResolve"), original = button.textContent; button.disabled = true; button.textContent = "道路を計算中";
      try {
        const result = await window.busApp.api("/api/routes/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: this.waypoints }) });
        this.geometry = result.geometry || []; this.distance = result.distanceMeters || 0; this.duration = result.durationSeconds || 0; this.setDirty(); this.draw(); this.map.fit(this.geometry);
        window.busApp.toast("道路に沿った経路を作成しました");
      } catch (error) { window.busApp.toast(error.message, "error"); }
      finally { button.textContent = original; this.draw(); }
    },
    payload() { return { id: this.currentId, name: byId("routeName").value.trim(), line: byId("routeLine").value, direction: byId("routeDirection").value, timeFrom: byId("routeTimeFrom").value, timeTo: byId("routeTimeTo").value, vehicleNo: byId("routeVehicleNo").value.trim(), color: byId("routeColor").value, waypoints: this.waypoints, geometry: this.geometry, distanceMeters: this.distance, durationSeconds: this.duration }; },
    async save(event) {
      event.preventDefault();
      if (this.waypoints.length < 2) { window.busApp.toast("地図へ出発地点と到着地点を追加してください", "error"); return; }
      if (this.geometry.length < 2) { window.busApp.toast("道路に沿って作成を押してください", "error"); return; }
      window.busApp.setBusy(true);
      try {
        const saved = await window.busApp.api("/api/route-profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.payload()) });
        const next = this.profiles.filter((profile) => profile.id !== saved.id); next.push(saved); this.profiles = next; window.busApp.setProfiles(next); this.edit(saved.id); window.busApp.toast("経路を保存しました");
      } catch (error) { window.busApp.toast(error.message, "error"); }
      finally { window.busApp.setBusy(false); }
    },
    async remove() {
      const profile = this.profiles.find((item) => item.id === this.currentId); if (!profile || !window.confirm(`${profile.name}を削除しますか？\n便への割当も解除されます。`)) return;
      window.busApp.setBusy(true);
      try { await window.busApp.api(`/api/route-profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" }); this.profiles = this.profiles.filter((item) => item.id !== profile.id); window.busApp.setProfiles(this.profiles); this.reset(); await window.busApp.reload(); window.busApp.toast("経路を削除しました"); }
      catch (error) { window.busApp.toast(error.message, "error"); }
      finally { window.busApp.setBusy(false); }
    },
    async autoAssign() {
      if (!this.profiles.length) { window.busApp.toast("先に経路を登録してください", "error"); return; }
      window.busApp.setBusy(true);
      try { const result = await window.busApp.api(`/api/route-profiles/auto-assign?date=${encodeURIComponent(this.date)}&day=${encodeURIComponent(this.day)}`, { method: "POST" }); await window.busApp.reload(); window.busApp.toast(`${result.assigned}区間へ経路を割り当てました`); }
      catch (error) { window.busApp.toast(error.message, "error"); }
      finally { window.busApp.setBusy(false); }
    },
  };

  let driveMap = null;
  let driveRoutes = [];
  let fleetMap = null;
  let fleetFitted = false;
  window.BusRoutes = {
    update: (data) => manager.update(data),
    activate: () => manager.activate(),
    renderDriveMap(element, profiles, position) { if (!element) return; driveMap?.destroy(); const list = Array.isArray(profiles) ? profiles : [profiles]; driveRoutes = list.map((profile) => ({ geometry: profile.geometry || [], color: profile.color || "#36f9c7" })); const points = driveRoutes.flatMap((route) => route.geometry); driveMap = new OSMMap(element); driveMap.setData({ routes: driveRoutes, position }); driveMap.fit([...points, ...(position ? [position] : [])]); },
    updateDrivePosition(position) { if (driveMap) driveMap.setData({ routes: driveRoutes, position }); },
    closeDriveMap() { driveMap?.destroy(); driveMap = null; driveRoutes = []; },
    renderFleetMap(element, profiles, positions, school) {
      if (!element) return;
      if (!fleetMap || fleetMap.element !== element) { fleetMap?.destroy(); fleetMap = new OSMMap(element); fleetFitted = false; }
      const routes = (profiles || []).map((profile) => ({ geometry: profile.geometry || [], color: profile.color || "#1e60aa" }));
      fleetMap.setData({ routes, positions: positions || [], school });
      const points = routes.flatMap((route) => route.geometry).concat(positions || []).concat(school ? [school] : []).filter(located);
      if (points.length && !fleetFitted) { fleetMap.fit(points); fleetFitted = true; }
    },
  };
  document.addEventListener("DOMContentLoaded", () => manager.init());
})();
