package main

import (
	"archive/zip"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var webFiles embed.FS

var jst = time.FixedZone("JST", 9*60*60)

type Template struct {
	Day              string `json:"day"`
	OperationNo      int    `json:"operationNo"`
	ColumnNo         int    `json:"columnNo"`
	PlannedDeparture string `json:"plannedDeparture"`
	PlannedArrival   string `json:"plannedArrival"`
	Route            string `json:"route"`
}

type Run struct {
	ID                    string `json:"id"`
	ServiceDate           string `json:"serviceDate"`
	Day                   string `json:"day"`
	OperationNo           int    `json:"operationNo"`
	ColumnNo              int    `json:"columnNo"`
	PlannedDeparture      string `json:"plannedDeparture"`
	PlannedArrival        string `json:"plannedArrival"`
	Route                 string `json:"route"`
	Status                string `json:"status"`
	PassengerCount        int    `json:"passengerCount"`
	VehicleNo             string `json:"vehicleNo"`
	DriverName            string `json:"driverName"`
	ActualDeparture       string `json:"actualDeparture"`
	ActualArrival         string `json:"actualArrival"`
	DepartureDelayMinutes *int   `json:"departureDelayMinutes"`
	ArrivalDelayMinutes   *int   `json:"arrivalDelayMinutes"`
	Note                  string `json:"note"`
	Capacity              int     `json:"capacity"`
	ProgressIndex         int     `json:"progressIndex"`
	Latitude              float64 `json:"latitude"`
	Longitude             float64 `json:"longitude"`
	LocationAccuracy      float64 `json:"locationAccuracy"`
	LocationUpdatedAt     string  `json:"locationUpdatedAt"`
	UpdatedAt             string `json:"updatedAt"`
}

type Event struct {
	ID        string `json:"id"`
	RunID     string `json:"runId"`
	Type      string `json:"type"`
	Summary   string `json:"summary"`
	CreatedAt string `json:"createdAt"`
}

type State struct {
	Version           int               `json:"version"`
	Timetable         []Template        `json:"timetable"`
	Runs              map[string]*Run   `json:"runs"`
	Events            []Event           `json:"events"`
	ProcessedRequests map[string]string `json:"processedRequests,omitempty"`
}

type Store struct {
	mu       sync.RWMutex
	filePath string
	state    State
}

func NewStore(filePath string) (*Store, error) {
	s := &Store{filePath: filePath, state: State{Version: 2, Runs: map[string]*Run{}, ProcessedRequests: map[string]string{}}}
	data, err := os.ReadFile(filePath)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.state); err != nil {
		return nil, fmt.Errorf("保存ファイルを読めません: %w", err)
	}
	if s.state.Runs == nil {
		s.state.Runs = map[string]*Run{}
	}
	if s.state.ProcessedRequests == nil {
		s.state.ProcessedRequests = map[string]string{}
	}
	if s.state.Version < 2 { s.state.Version = 2 }
	return s, nil
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(path.Dir(s.filePath), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.filePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, s.filePath)
}

func (s *Store) replaceTimetable(templates []Template) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Timetable = templates
	s.addEventLocked("", "import", fmt.Sprintf("ダイヤを%d便取り込み", len(templates)))
	return s.saveLocked()
}

func runID(date, day string, operation, column int) string {
	return fmt.Sprintf("%s|%s|%d|%d", date, day, operation, column)
}

func randomID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b)
}

func (s *Store) addEventLocked(runID, eventType, summary string) {
	s.addEventLockedAt(runID, eventType, summary, time.Now().In(jst))
}

func (s *Store) addEventLockedAt(runID, eventType, summary string, occurredAt time.Time) {
	s.state.Events = append(s.state.Events, Event{
		ID: randomID(), RunID: runID, Type: eventType, Summary: summary,
		CreatedAt: occurredAt.In(jst).Format(time.RFC3339),
	})
	if len(s.state.Events) > 2000 {
		s.state.Events = s.state.Events[len(s.state.Events)-2000:]
	}
}

func (s *Store) dashboard(date, day string) ([]Run, []Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, t := range s.state.Timetable {
		if t.Day != day {
			continue
		}
		id := runID(date, day, t.OperationNo, t.ColumnNo)
		if _, exists := s.state.Runs[id]; exists {
			if s.state.Runs[id].Capacity <= 0 {
				s.state.Runs[id].Capacity = 55
				changed = true
			}
			continue
		}
		s.state.Runs[id] = &Run{
			ID: id, ServiceDate: date, Day: day, OperationNo: t.OperationNo,
			ColumnNo: t.ColumnNo, PlannedDeparture: t.PlannedDeparture,
			PlannedArrival: t.PlannedArrival, Route: t.Route, Status: "waiting",
			Capacity: 55,
			UpdatedAt: time.Now().In(jst).Format(time.RFC3339),
		}
		changed = true
	}
	if changed {
		if err := s.saveLocked(); err != nil {
			return nil, nil, err
		}
	}
	runs := make([]Run, 0)
	for _, run := range s.state.Runs {
		if run.ServiceDate == date && run.Day == day {
			runs = append(runs, *run)
		}
	}
	sort.Slice(runs, func(i, j int) bool {
		a, b := runs[i].PlannedDeparture, runs[j].PlannedDeparture
		if a != b {
			if a == "" { return false }
			if b == "" { return true }
			return a < b
		}
		if runs[i].OperationNo != runs[j].OperationNo {
			return runs[i].OperationNo < runs[j].OperationNo
		}
		return runs[i].ColumnNo < runs[j].ColumnNo
	})
	events := append([]Event(nil), s.state.Events...)
	if len(events) > 100 {
		events = events[len(events)-100:]
	}
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	return runs, events, nil
}

type DetailsInput struct {
	PassengerCount    *int     `json:"passengerCount"`
	VehicleNo         *string  `json:"vehicleNo"`
	DriverName        *string  `json:"driverName"`
	Note              *string  `json:"note"`
	Capacity          *int     `json:"capacity"`
	ProgressIndex     *int     `json:"progressIndex"`
	Latitude          *float64 `json:"latitude"`
	Longitude         *float64 `json:"longitude"`
	LocationAccuracy  *float64 `json:"locationAccuracy"`
	OccurredAt        string   `json:"occurredAt"`
	RequestID         string   `json:"requestId"`
}

func clean(input string, limit int) string {
	input = strings.TrimSpace(input)
	runes := []rune(input)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return input
}

func (s *Store) updateDetails(id string, input DetailsInput) (*Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.state.Runs[id]
	if !ok {
		return nil, os.ErrNotExist
	}
	if input.RequestID != "" && s.state.ProcessedRequests[input.RequestID] != "" {
		copy := *run
		return &copy, nil
	}
	humanChange := false
	if input.PassengerCount != nil {
		value := *input.PassengerCount
		if value < 0 { value = 0 }
		if value > 999 { value = 999 }
		run.PassengerCount = value
		humanChange = true
	}
	if input.VehicleNo != nil { run.VehicleNo = clean(*input.VehicleNo, 30); humanChange = true }
	if input.DriverName != nil { run.DriverName = clean(*input.DriverName, 60); humanChange = true }
	if input.Note != nil { run.Note = clean(*input.Note, 500); humanChange = true }
	if input.Capacity != nil {
		value := *input.Capacity
		if value < 1 { value = 1 }
		if value > 999 { value = 999 }
		run.Capacity = value
		humanChange = true
	}
	if input.ProgressIndex != nil {
		value := *input.ProgressIndex
		if value < 0 { value = 0 }
		if value > 20 { value = 20 }
		run.ProgressIndex = value
		humanChange = true
	}
	if input.Latitude != nil || input.Longitude != nil {
		if input.Latitude == nil || input.Longitude == nil || *input.Latitude < -90 || *input.Latitude > 90 || *input.Longitude < -180 || *input.Longitude > 180 {
			return nil, errors.New("位置情報が正しくありません")
		}
		run.Latitude, run.Longitude = *input.Latitude, *input.Longitude
		if input.LocationAccuracy != nil && *input.LocationAccuracy >= 0 { run.LocationAccuracy = *input.LocationAccuracy }
		capturedAt := time.Now().In(jst)
		if parsed, err := time.Parse(time.RFC3339, input.OccurredAt); err == nil { capturedAt = parsed.In(jst) }
		run.LocationUpdatedAt = capturedAt.Format(time.RFC3339)
	}
	run.UpdatedAt = time.Now().In(jst).Format(time.RFC3339)
	if humanChange { s.addEventLocked(id, "updated", fmt.Sprintf("人数 %d名、定員 %d名、車両 %s、担当 %s", run.PassengerCount, run.Capacity, fallback(run.VehicleNo, "未定"), fallback(run.DriverName, "未定"))) }
	s.markRequestLocked(input.RequestID, id)
	if err := s.saveLocked(); err != nil { return nil, err }
	copy := *run
	return &copy, nil
}

func (s *Store) markRequestLocked(requestID, runID string) {
	requestID = clean(requestID, 100)
	if requestID == "" { return }
	if len(s.state.ProcessedRequests) >= 10000 { s.state.ProcessedRequests = map[string]string{} }
	s.state.ProcessedRequests[requestID] = runID
}

type AssignmentInput struct {
	VehicleNo  string `json:"vehicleNo"`
	DriverName string `json:"driverName"`
	Capacity   int    `json:"capacity"`
	RequestID  string `json:"requestId"`
}

func (s *Store) assignOperation(date, day string, operation int, input AssignmentInput) ([]Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if input.RequestID != "" && s.state.ProcessedRequests[input.RequestID] != "" {
		existing := make([]Run, 0)
		for _, run := range s.state.Runs {
			if run.ServiceDate == date && run.Day == day && run.OperationNo == operation { existing = append(existing, *run) }
		}
		return existing, nil
	}
	if input.Capacity < 1 { input.Capacity = 55 }
	if input.Capacity > 999 { input.Capacity = 999 }
	updated := make([]Run, 0)
	for _, run := range s.state.Runs {
		if run.ServiceDate != date || run.Day != day || run.OperationNo != operation || run.Status == "arrived" || run.Status == "cancelled" { continue }
		run.VehicleNo = clean(input.VehicleNo, 30)
		run.DriverName = clean(input.DriverName, 60)
		run.Capacity = input.Capacity
		run.UpdatedAt = time.Now().In(jst).Format(time.RFC3339)
		updated = append(updated, *run)
	}
	if len(updated) == 0 { return nil, os.ErrNotExist }
	s.addEventLocked("", "assignment", fmt.Sprintf("運用 %dを車両 %s、担当 %s、定員 %d名で固定", operation, fallback(clean(input.VehicleNo, 30), "未定"), fallback(clean(input.DriverName, 60), "未定"), input.Capacity))
	s.markRequestLocked(input.RequestID, updated[0].ID)
	if err := s.saveLocked(); err != nil { return nil, err }
	return updated, nil
}

func fallback(value, other string) string {
	if value == "" { return other }
	return value
}

func delayMinutes(serviceDate, planned string, actual time.Time) *int {
	if planned == "" { return nil }
	scheduled, err := time.ParseInLocation("2006-01-02 15:04", serviceDate+" "+planned, jst)
	if err != nil { return nil }
	delay := int(actual.Sub(scheduled).Minutes())
	return &delay
}

func (s *Store) action(id, action, occurredAt, requestID string) (*Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.state.Runs[id]
	if !ok { return nil, os.ErrNotExist }
	if requestID != "" && s.state.ProcessedRequests[requestID] != "" {
		copy := *run
		return &copy, nil
	}
	now := time.Now().In(jst)
	actionTime := now
	if parsed, err := time.Parse(time.RFC3339, occurredAt); err == nil { actionTime = parsed.In(jst) }
	summary := ""
	switch action {
	case "boarding":
		run.Status, summary = "boarding", "乗車受付を開始"
	case "depart":
		run.Status, run.ActualDeparture = "departed", actionTime.Format(time.RFC3339)
		run.DepartureDelayMinutes = delayMinutes(run.ServiceDate, run.PlannedDeparture, actionTime)
		summary = "出発を記録"
	case "arrive":
		run.Status, run.ActualArrival = "arrived", actionTime.Format(time.RFC3339)
		run.ArrivalDelayMinutes = delayMinutes(run.ServiceDate, run.PlannedArrival, actionTime)
		summary = "到着を記録"
	case "cancel":
		run.Status, summary = "cancelled", "運休を記録"
	case "reset":
		run.Status, run.ActualDeparture, run.ActualArrival = "waiting", "", ""
		run.DepartureDelayMinutes, run.ArrivalDelayMinutes = nil, nil
		summary = "待機へ戻す"
	default:
		return nil, errors.New("不正な操作です")
	}
	run.UpdatedAt = now.Format(time.RFC3339)
	s.addEventLockedAt(id, action, summary, actionTime)
	s.markRequestLocked(requestID, id)
	if err := s.saveLocked(); err != nil { return nil, err }
	copy := *run
	return &copy, nil
}

func (s *Store) info() (int, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.state.Timetable), len(s.state.Runs)
}

type sheetRef struct {
	Name string `xml:"name,attr"`
	RID  string `xml:"id,attr"`
}

type workbookXML struct { Sheets []sheetRef `xml:"sheets>sheet"` }
type relationship struct { ID string `xml:"Id,attr"`; Target string `xml:"Target,attr"` }
type relationshipsXML struct { Items []relationship `xml:"Relationship"` }
type cellXML struct { Ref string `xml:"r,attr"`; Type string `xml:"t,attr"`; Value string `xml:"v"`; Inline struct { Text string `xml:"t"` } `xml:"is"` }
type rowXML struct { Number int `xml:"r,attr"`; Cells []cellXML `xml:"c"` }
type worksheetXML struct { Rows []rowXML `xml:"sheetData>row"` }

func zipRead(z *zip.ReadCloser, name string) ([]byte, error) {
	name = strings.TrimPrefix(path.Clean(name), "/")
	for _, f := range z.File {
		if f.Name != name { continue }
		r, err := f.Open()
		if err != nil { return nil, err }
		defer r.Close()
		return io.ReadAll(r)
	}
	return nil, fmt.Errorf("%s がありません", name)
}

func columnIndex(ref string) int {
	index := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' { break }
		index = index*26 + int(r-'A'+1)
	}
	return index - 1
}

func parseWorkbook(filePath string) ([]Template, error) {
	z, err := zip.OpenReader(filePath)
	if err != nil { return nil, err }
	defer z.Close()
	workbookData, err := zipRead(z, "xl/workbook.xml")
	if err != nil { return nil, err }
	relData, err := zipRead(z, "xl/_rels/workbook.xml.rels")
	if err != nil { return nil, err }
	var wb workbookXML
	var rels relationshipsXML
	if err := xml.Unmarshal(workbookData, &wb); err != nil { return nil, err }
	if err := xml.Unmarshal(relData, &rels); err != nil { return nil, err }
	relMap := map[string]string{}
	for _, rel := range rels.Items { relMap[rel.ID] = rel.Target }
	templates := make([]Template, 0)
	for _, sheet := range wb.Sheets {
		parts := strings.Split(sheet.Name, "_")
		if len(parts) != 2 || !strings.HasPrefix(parts[0], "運用") || (parts[1] != "土曜" && parts[1] != "日曜") { continue }
		operation, err := strconv.Atoi(strings.TrimPrefix(parts[0], "運用"))
		if err != nil || operation < 1 || operation > 9 { continue }
		target := relMap[sheet.RID]
		if target == "" { continue }
		if !strings.HasPrefix(target, "xl/") { target = path.Join("xl", target) }
		sheetData, err := zipRead(z, target)
		if err != nil { return nil, err }
		var ws worksheetXML
		if err := xml.Unmarshal(sheetData, &ws); err != nil { return nil, err }
		rows := make([][]string, 20)
		for i := range rows { rows[i] = make([]string, 1) }
		for _, row := range ws.Rows {
			if row.Number < 1 || row.Number > 20 { continue }
			for _, cell := range row.Cells {
				col := columnIndex(cell.Ref)
				if col < 0 { continue }
				for len(rows[row.Number-1]) <= col { rows[row.Number-1] = append(rows[row.Number-1], "") }
				value := cell.Value
				if cell.Type == "inlineStr" { value = cell.Inline.Text }
				rows[row.Number-1][col] = strings.TrimSpace(value)
			}
		}
		width := 1
		for _, row := range rows { if len(row) > width { width = len(row) } }
		for col := 1; col < width; col++ {
			active := false
			for row := 1; row < len(rows); row++ { if valueAt(rows, row, col) != "" { active = true; break } }
			if !active { continue }
			templates = append(templates, Template{
				Day: parts[1], OperationNo: operation, ColumnNo: col,
				PlannedDeparture: firstValue(rows, col, 5, 3, 1),
				PlannedArrival: firstValue(rows, col, 15, 18),
				Route: routeFor(rows, col),
			})
		}
	}
	if len(templates) == 0 { return nil, errors.New("運用1から9の土曜または日曜の表が見つかりません") }
	sort.Slice(templates, func(i, j int) bool {
		if templates[i].Day != templates[j].Day { return templates[i].Day < templates[j].Day }
		if templates[i].OperationNo != templates[j].OperationNo { return templates[i].OperationNo < templates[j].OperationNo }
		return templates[i].ColumnNo < templates[j].ColumnNo
	})
	return templates, nil
}

func valueAt(rows [][]string, row, col int) string {
	if row < 0 || row >= len(rows) || col < 0 || col >= len(rows[row]) { return "" }
	return strings.TrimSpace(rows[row][col])
}

func firstValue(rows [][]string, col int, candidates ...int) string {
	for _, row := range candidates { if value := valueAt(rows, row, col); value != "" { return value } }
	return ""
}

func routeFor(rows [][]string, col int) string {
	stops := []struct { Row int; Name string }{{5,"学校"},{6,"ふじみ野"},{8,"南古谷"},{10,"本川越"},{12,"南古谷"},{15,"学校"}}
	names := make([]string, 0)
	for _, stop := range stops { if valueAt(rows, stop.Row, col) != "" { names = append(names, stop.Name) } }
	if len(names) == 0 { return "経路未設定" }
	return strings.Join(names, " → ")
}

type App struct { store *Store }

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (a *App) dashboard(w http.ResponseWriter, r *http.Request) {
	date, day := r.URL.Query().Get("date"), r.URL.Query().Get("day")
	if _, err := time.Parse("2006-01-02", date); err != nil || (day != "土曜" && day != "日曜") {
		writeJSON(w, 400, map[string]string{"error":"運行日または曜日が正しくありません"}); return
	}
	runs, events, err := a.store.dashboard(date, day)
	if err != nil { writeJSON(w, 500, map[string]string{"error":"運行情報を保存できません"}); return }
	timetableCount, runCount := a.store.info()
	writeJSON(w, 200, map[string]any{"runs":runs, "events":events, "timetableCount":timetableCount, "runCount":runCount})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		writeJSON(w, 400, map[string]string{"error":"入力内容が正しくありません"}); return false
	}
	return true
}

func (a *App) runRoute(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" { http.NotFound(w, r); return }
	if r.Method == http.MethodPatch {
		var input DetailsInput
		if !decodeJSON(w, r, &input) { return }
		run, err := a.store.updateDetails(id, input)
		if errors.Is(err, os.ErrNotExist) { writeJSON(w, 404, map[string]string{"error":"便が見つかりません"}); return }
		if err != nil { writeJSON(w, 400, map[string]string{"error":err.Error()}); return }
		writeJSON(w, 200, run); return
	}
	if r.Method == http.MethodPost {
		var input struct {
			Action     string `json:"action"`
			OccurredAt string `json:"occurredAt"`
			RequestID  string `json:"requestId"`
		}
		if !decodeJSON(w, r, &input) { return }
		run, err := a.store.action(id, input.Action, input.OccurredAt, input.RequestID)
		if errors.Is(err, os.ErrNotExist) { writeJSON(w, 404, map[string]string{"error":"便が見つかりません"}); return }
		if err != nil { writeJSON(w, 400, map[string]string{"error":err.Error()}); return }
		writeJSON(w, 200, run); return
	}
	http.NotFound(w, r)
}

func (a *App) operationAssignment(w http.ResponseWriter, r *http.Request) {
	operation, err := strconv.Atoi(r.PathValue("operation"))
	date, day := r.URL.Query().Get("date"), r.URL.Query().Get("day")
	if err != nil || operation < 1 || operation > 99 {
		writeJSON(w, 400, map[string]string{"error":"運用番号が正しくありません"}); return
	}
	if _, err := time.Parse("2006-01-02", date); err != nil || (day != "土曜" && day != "日曜") {
		writeJSON(w, 400, map[string]string{"error":"運行日または曜日が正しくありません"}); return
	}
	var input AssignmentInput
	if !decodeJSON(w, r, &input) { return }
	runs, err := a.store.assignOperation(date, day, operation, input)
	if errors.Is(err, os.ErrNotExist) { writeJSON(w, 404, map[string]string{"error":"対象の運行便が見つかりません"}); return }
	if err != nil { writeJSON(w, 500, map[string]string{"error":"固定設定を保存できません"}); return }
	writeJSON(w, 200, map[string]any{"runs":runs})
}

func saveUpload(file multipart.File) (string, error) {
	tmp, err := os.CreateTemp("", "bus-timetable-*.xlsx")
	if err != nil { return "", err }
	name := tmp.Name()
	if _, err := io.Copy(tmp, io.LimitReader(file, 20<<20)); err != nil { tmp.Close(); os.Remove(name); return "", err }
	if err := tmp.Close(); err != nil { os.Remove(name); return "", err }
	return name, nil
}

func (a *App) importTimetable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.NotFound(w, r); return }
	if err := r.ParseMultipartForm(20 << 20); err != nil { writeJSON(w, 400, map[string]string{"error":"Excelを受信できません"}); return }
	file, header, err := r.FormFile("file")
	if err != nil { writeJSON(w, 400, map[string]string{"error":"Excelを選択してください"}); return }
	defer file.Close()
	if !strings.HasSuffix(strings.ToLower(header.Filename), ".xlsx") { writeJSON(w, 400, map[string]string{"error":"xlsx形式を選択してください"}); return }
	tmp, err := saveUpload(file)
	if err != nil { writeJSON(w, 500, map[string]string{"error":"一時保存に失敗しました"}); return }
	defer os.Remove(tmp)
	templates, err := parseWorkbook(tmp)
	if err != nil { writeJSON(w, 400, map[string]string{"error":err.Error()}); return }
	if err := a.store.replaceTimetable(templates); err != nil { writeJSON(w, 500, map[string]string{"error":"ダイヤを保存できません"}); return }
	writeJSON(w, 200, map[string]any{"ok":true, "count":len(templates)})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(self), fullscreen=(self)")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'")
		next.ServeHTTP(w, r)
	})
}

func main() {
	dataPath := flag.String("data", envOr("DATA_FILE", "data/store.json"), "保存ファイル")
	importPath := flag.String("import", "", "Excelを取り込んで終了")
	flag.Parse()
	store, err := NewStore(*dataPath)
	if err != nil { log.Fatal(err) }
	if *importPath != "" {
		templates, err := parseWorkbook(*importPath)
		if err != nil { log.Fatal(err) }
		if err := store.replaceTimetable(templates); err != nil { log.Fatal(err) }
		log.Printf("%d便を取り込みました", len(templates)); return
	}
	app := &App{store: store}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/dashboard", app.dashboard)
	mux.HandleFunc("PATCH /api/runs/{id}", app.runRoute)
	mux.HandleFunc("POST /api/runs/{id}/action", app.runRoute)
	mux.HandleFunc("PATCH /api/operations/{operation}/assignment", app.operationAssignment)
	mux.HandleFunc("POST /api/timetable/import", app.importTimetable)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200); _, _ = w.Write([]byte("ok")) })
	staticFiles, err := fs.Sub(webFiles, "web")
	if err != nil { log.Fatal(err) }
	mux.Handle("/", http.FileServer(http.FS(staticFiles)))
	port := envOr("PORT", "8080")
	server := &http.Server{Addr: ":"+port, Handler: securityHeaders(mux), ReadHeaderTimeout: 5*time.Second, ReadTimeout: 30*time.Second, WriteTimeout: 30*time.Second, IdleTimeout: 60*time.Second}
	log.Printf("学校バス運行管理を http://localhost:%s で開始", port)
	log.Fatal(server.ListenAndServe())
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" { return value }
	return fallback
}
