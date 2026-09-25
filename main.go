package main

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	"net"
	"net/http"
	"net/url"
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
	Day               string `json:"day"`
	OperationNo       int    `json:"operationNo"`
	ColumnNo          int    `json:"columnNo"`
	PlannedDeparture  string `json:"plannedDeparture"`
	PlannedArrival    string `json:"plannedArrival"`
	Route             string `json:"route"`
	OutboundType      string `json:"outboundType"`
	InboundType       string `json:"inboundType"`
	OutboundDeparture string `json:"outboundDeparture"`
	OutboundArrival   string `json:"outboundArrival"`
	InboundDeparture  string `json:"inboundDeparture"`
	InboundArrival    string `json:"inboundArrival"`
	Details           string `json:"details"`
}

type Run struct {
	ID                      string  `json:"id"`
	ServiceDate             string  `json:"serviceDate"`
	Day                     string  `json:"day"`
	OperationNo             int     `json:"operationNo"`
	ColumnNo                int     `json:"columnNo"`
	PlannedDeparture        string  `json:"plannedDeparture"`
	PlannedArrival          string  `json:"plannedArrival"`
	Route                   string  `json:"route"`
	Status                  string  `json:"status"`
	PassengerCount          int     `json:"passengerCount"`
	VehicleNo               string  `json:"vehicleNo"`
	DriverName              string  `json:"driverName"`
	ActualDeparture         string  `json:"actualDeparture"`
	ActualArrival           string  `json:"actualArrival"`
	DepartureDelayMinutes   *int    `json:"departureDelayMinutes"`
	ArrivalDelayMinutes     *int    `json:"arrivalDelayMinutes"`
	Note                    string  `json:"note"`
	Capacity                int     `json:"capacity"`
	ProgressIndex           int     `json:"progressIndex"`
	OutboundProgressIndex   int     `json:"outboundProgressIndex"`
	InboundProgressIndex    int     `json:"inboundProgressIndex"`
	Latitude                float64 `json:"latitude"`
	Longitude               float64 `json:"longitude"`
	LocationAccuracy        float64 `json:"locationAccuracy"`
	LocationUpdatedAt       string  `json:"locationUpdatedAt"`
	OutboundRouteProfileID  string  `json:"outboundRouteProfileId"`
	InboundRouteProfileID   string  `json:"inboundRouteProfileId"`
	OutboundType            string  `json:"outboundType"`
	InboundType             string  `json:"inboundType"`
	OutboundStatus          string  `json:"outboundStatus"`
	InboundStatus           string  `json:"inboundStatus"`
	OutboundPassengerCount  int     `json:"outboundPassengerCount"`
	InboundPassengerCount   int     `json:"inboundPassengerCount"`
	OutboundDeparture       string  `json:"outboundDeparture"`
	OutboundArrival         string  `json:"outboundArrival"`
	InboundDeparture        string  `json:"inboundDeparture"`
	InboundArrival          string  `json:"inboundArrival"`
	OutboundActualDeparture string  `json:"outboundActualDeparture"`
	OutboundActualArrival   string  `json:"outboundActualArrival"`
	InboundActualDeparture  string  `json:"inboundActualDeparture"`
	InboundActualArrival    string  `json:"inboundActualArrival"`
	ServiceDetails          string  `json:"serviceDetails"`
	LocationZone            string  `json:"locationZone"`
	Revision                int64   `json:"revision"`
	UpdatedAt               string  `json:"updatedAt"`
}

type AppSettings struct {
	SchoolLatitude  float64 `json:"schoolLatitude"`
	SchoolLongitude float64 `json:"schoolLongitude"`
	SchoolRadius    float64 `json:"schoolRadius"`
	// 一般用画面で日付として見せる開催日です。土曜ダイヤと日曜ダイヤに対応します。
	EventName     string `json:"eventName"`
	EventSaturday string `json:"eventSaturday"`
	EventSunday   string `json:"eventSunday"`
}

type GeoPoint struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type RouteProfile struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Line            string     `json:"line"`
	Direction       string     `json:"direction"`
	TimeFrom        string     `json:"timeFrom"`
	TimeTo          string     `json:"timeTo"`
	VehicleNo       string     `json:"vehicleNo"`
	Color           string     `json:"color"`
	Waypoints       []GeoPoint `json:"waypoints"`
	Geometry        []GeoPoint `json:"geometry"`
	DistanceMeters  float64    `json:"distanceMeters"`
	DurationSeconds float64    `json:"durationSeconds"`
	UpdatedAt       string     `json:"updatedAt"`
}

type Event struct {
	ID        string `json:"id"`
	RunID     string `json:"runId"`
	Type      string `json:"type"`
	Summary   string `json:"summary"`
	CreatedAt string `json:"createdAt"`
}

// Program は文化祭などのステージ進行です。一般用でバスとの乗り継ぎ案内に使います。
type Program struct {
	ID      string `json:"id"`
	Day     string `json:"day"`
	Stage   string `json:"stage"`
	Title   string `json:"title"`
	Start   string `json:"start"`
	End     string `json:"end"`
	Details string `json:"details"`
}

type State struct {
	Version           int                      `json:"version"`
	Timetable         []Template               `json:"timetable"`
	Programs          []Program                `json:"programs"`
	Runs              map[string]*Run          `json:"runs"`
	Events            []Event                  `json:"events"`
	ProcessedRequests map[string]string        `json:"processedRequests,omitempty"`
	RouteProfiles     map[string]*RouteProfile `json:"routeProfiles"`
	Settings          AppSettings              `json:"settings"`
	Stops             []Stop                   `json:"stops"`
	Legs              []Leg                    `json:"legs"`
	Notices           []Notice                 `json:"notices"`
	CrowdHints        []CrowdHint              `json:"crowdHints"`
	SearchSignals     []SearchSignal           `json:"searchSignals"`
	LineStatuses      []LineStatus             `json:"lineStatuses"`
	LineAttribution   []string                 `json:"lineAttribution"`
}

type Store struct {
	mu       sync.RWMutex
	filePath string
	state    State
}

func NewStore(filePath string) (*Store, error) {
	s := &Store{filePath: filePath, state: State{Version: 5, Runs: map[string]*Run{}, ProcessedRequests: map[string]string{}, RouteProfiles: map[string]*RouteProfile{}, Settings: AppSettings{SchoolRadius: 35}}}
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
	if s.state.RouteProfiles == nil {
		s.state.RouteProfiles = map[string]*RouteProfile{}
	}
	if s.state.Settings.SchoolRadius <= 0 {
		s.state.Settings.SchoolRadius = 35
	}
	for index := range s.state.Timetable {
		normalizeTemplate(&s.state.Timetable[index])
	}
	for _, run := range s.state.Runs {
		normalizeRun(run)
	}
	if s.state.Version < 5 {
		s.state.Version = 5
	}
	return s, nil
}

func validServiceType(value string) bool {
	return value == "passenger" || value == "deadhead" || value == "group" || value == "none"
}

func normalizeTemplate(t *Template) {
	if !validServiceType(t.OutboundType) {
		t.OutboundType = "passenger"
	}
	if !validServiceType(t.InboundType) {
		t.InboundType = "passenger"
	}
	if t.OutboundDeparture == "" {
		t.OutboundDeparture = t.PlannedDeparture
	}
	if t.InboundArrival == "" {
		t.InboundArrival = t.PlannedArrival
	}
}

func normalizeRun(run *Run) {
	if run.Revision < 1 {
		run.Revision = 1
	}
	if !validServiceType(run.OutboundType) {
		run.OutboundType = "passenger"
	}
	if !validServiceType(run.InboundType) {
		run.InboundType = "passenger"
	}
	if run.OutboundDeparture == "" {
		run.OutboundDeparture = run.PlannedDeparture
	}
	if run.InboundArrival == "" {
		run.InboundArrival = run.PlannedArrival
	}
	if run.OutboundStatus == "" || run.InboundStatus == "" {
		switch run.Status {
		case "arrived":
			run.OutboundStatus, run.InboundStatus = "arrived", "arrived"
		case "cancelled":
			run.OutboundStatus, run.InboundStatus = "cancelled", "cancelled"
		case "boarding", "departed":
			run.OutboundStatus, run.InboundStatus = run.Status, "waiting"
		default:
			run.OutboundStatus, run.InboundStatus = "waiting", "waiting"
		}
	}
	if run.OutboundType == "none" && run.OutboundStatus == "waiting" {
		run.OutboundStatus = "arrived"
	}
	if run.InboundType == "none" && run.InboundStatus == "waiting" {
		run.InboundStatus = "arrived"
	}
	syncRunStatus(run)
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
	for index := range templates {
		normalizeTemplate(&templates[index])
	}
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
			OutboundType: t.OutboundType, InboundType: t.InboundType,
			OutboundStatus: "waiting", InboundStatus: "waiting",
			OutboundDeparture: t.OutboundDeparture, OutboundArrival: t.OutboundArrival,
			InboundDeparture: t.InboundDeparture, InboundArrival: t.InboundArrival,
			ServiceDetails: t.Details,
			Capacity:       55,
			UpdatedAt:      time.Now().In(jst).Format(time.RFC3339),
		}
		normalizeRun(s.state.Runs[id])
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
			if a == "" {
				return false
			}
			if b == "" {
				return true
			}
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
	PassengerCount         *int     `json:"passengerCount"`
	OutboundPassengerCount *int     `json:"outboundPassengerCount"`
	InboundPassengerCount  *int     `json:"inboundPassengerCount"`
	VehicleNo              *string  `json:"vehicleNo"`
	DriverName             *string  `json:"driverName"`
	Note                   *string  `json:"note"`
	Capacity               *int     `json:"capacity"`
	ProgressIndex          *int     `json:"progressIndex"`
	Latitude               *float64 `json:"latitude"`
	Longitude              *float64 `json:"longitude"`
	LocationAccuracy       *float64 `json:"locationAccuracy"`
	OutboundRouteProfileID *string  `json:"outboundRouteProfileId"`
	InboundRouteProfileID  *string  `json:"inboundRouteProfileId"`
	Leg                    string   `json:"leg"`
	LocationZone           *string  `json:"locationZone"`
	OccurredAt             string   `json:"occurredAt"`
	RequestID              string   `json:"requestId"`
	ExpectedRevision       *int64   `json:"expectedRevision"`
}

type ConflictError struct{ Current Run }

func (e *ConflictError) Error() string { return "別端末で更新されています" }

func checkRevision(run *Run, expected *int64) error {
	if expected != nil && *expected != run.Revision {
		return &ConflictError{Current: *run}
	}
	return nil
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
	if err := checkRevision(run, input.ExpectedRevision); err != nil {
		return nil, err
	}
	humanChange := false
	if input.PassengerCount != nil {
		value := *input.PassengerCount
		if value < 0 {
			value = 0
		}
		if value > 999 {
			value = 999
		}
		run.PassengerCount = value
		if input.Leg == "inbound" {
			run.InboundPassengerCount = value
		} else if input.Leg == "outbound" {
			run.OutboundPassengerCount = value
		}
		humanChange = true
	}
	if input.OutboundPassengerCount != nil {
		value := *input.OutboundPassengerCount
		if value < 0 {
			value = 0
		}
		if value > 999 {
			value = 999
		}
		run.OutboundPassengerCount = value
		humanChange = true
	}
	if input.InboundPassengerCount != nil {
		value := *input.InboundPassengerCount
		if value < 0 {
			value = 0
		}
		if value > 999 {
			value = 999
		}
		run.InboundPassengerCount = value
		humanChange = true
	}
	if input.VehicleNo != nil {
		run.VehicleNo = clean(*input.VehicleNo, 30)
		humanChange = true
	}
	if input.DriverName != nil {
		run.DriverName = clean(*input.DriverName, 60)
		humanChange = true
	}
	if input.Note != nil {
		run.Note = clean(*input.Note, 500)
		humanChange = true
	}
	if input.Capacity != nil {
		value := *input.Capacity
		if value < 1 {
			value = 1
		}
		if value > 999 {
			value = 999
		}
		run.Capacity = value
		humanChange = true
	}
	if input.ProgressIndex != nil {
		value := *input.ProgressIndex
		if value < 0 {
			value = 0
		}
		if value > 20 {
			value = 20
		}
		run.ProgressIndex = value
		if input.Leg == "inbound" {
			run.InboundProgressIndex = value
		} else if input.Leg == "outbound" {
			run.OutboundProgressIndex = value
		}
		humanChange = true
	}
	if input.OutboundRouteProfileID != nil {
		value := clean(*input.OutboundRouteProfileID, 100)
		if value != "" {
			profile, exists := s.state.RouteProfiles[value]
			if !exists || profile.Direction != "outbound" {
				return nil, errors.New("往路経路が見つかりません")
			}
		}
		run.OutboundRouteProfileID = value
		humanChange = true
	}
	if input.InboundRouteProfileID != nil {
		value := clean(*input.InboundRouteProfileID, 100)
		if value != "" {
			profile, exists := s.state.RouteProfiles[value]
			if !exists || profile.Direction != "inbound" {
				return nil, errors.New("復路経路が見つかりません")
			}
		}
		run.InboundRouteProfileID = value
		humanChange = true
	}
	if input.Latitude != nil || input.Longitude != nil {
		if input.Latitude == nil || input.Longitude == nil || *input.Latitude < -90 || *input.Latitude > 90 || *input.Longitude < -180 || *input.Longitude > 180 {
			return nil, errors.New("位置情報が正しくありません")
		}
		run.Latitude, run.Longitude = *input.Latitude, *input.Longitude
		if input.LocationAccuracy != nil && *input.LocationAccuracy >= 0 {
			run.LocationAccuracy = *input.LocationAccuracy
		}
		capturedAt := time.Now().In(jst)
		if parsed, err := time.Parse(time.RFC3339, input.OccurredAt); err == nil {
			capturedAt = parsed.In(jst)
		}
		run.LocationUpdatedAt = capturedAt.Format(time.RFC3339)
		if input.LocationZone != nil {
			run.LocationZone = clean(*input.LocationZone, 30)
		}
	}
	if humanChange {
		run.Revision++
	}
	run.UpdatedAt = time.Now().In(jst).Format(time.RFC3339)
	if humanChange {
		s.addEventLocked(id, "updated", fmt.Sprintf("人数 %d名、定員 %d名、車両 %s、担当 %s", run.PassengerCount, run.Capacity, fallback(run.VehicleNo, "未定"), fallback(run.DriverName, "未定")))
	}
	s.markRequestLocked(input.RequestID, id)
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	copy := *run
	return &copy, nil
}

func (s *Store) markRequestLocked(requestID, runID string) {
	requestID = clean(requestID, 100)
	if requestID == "" {
		return
	}
	if len(s.state.ProcessedRequests) >= 10000 {
		s.state.ProcessedRequests = map[string]string{}
	}
	s.state.ProcessedRequests[requestID] = runID
}

type AssignmentInput struct {
	VehicleNo         string           `json:"vehicleNo"`
	DriverName        string           `json:"driverName"`
	Capacity          int              `json:"capacity"`
	RequestID         string           `json:"requestId"`
	ExpectedRevisions map[string]int64 `json:"expectedRevisions"`
}

func (s *Store) assignOperation(date, day string, operation int, input AssignmentInput) ([]Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if input.RequestID != "" && s.state.ProcessedRequests[input.RequestID] != "" {
		existing := make([]Run, 0)
		for _, run := range s.state.Runs {
			if run.ServiceDate == date && run.Day == day && run.OperationNo == operation {
				existing = append(existing, *run)
			}
		}
		return existing, nil
	}
	if input.Capacity < 1 {
		input.Capacity = 55
	}
	if input.Capacity > 999 {
		input.Capacity = 999
	}
	for _, run := range s.state.Runs {
		if run.ServiceDate != date || run.Day != day || run.OperationNo != operation || run.Status == "arrived" || run.Status == "cancelled" {
			continue
		}
		if expected, exists := input.ExpectedRevisions[run.ID]; exists && expected != run.Revision {
			return nil, &ConflictError{Current: *run}
		}
	}
	updated := make([]Run, 0)
	for _, run := range s.state.Runs {
		if run.ServiceDate != date || run.Day != day || run.OperationNo != operation || run.Status == "arrived" || run.Status == "cancelled" {
			continue
		}
		run.VehicleNo = clean(input.VehicleNo, 30)
		run.DriverName = clean(input.DriverName, 60)
		run.Capacity = input.Capacity
		run.Revision++
		run.UpdatedAt = time.Now().In(jst).Format(time.RFC3339)
		updated = append(updated, *run)
	}
	if len(updated) == 0 {
		return nil, os.ErrNotExist
	}
	s.addEventLocked("", "assignment", fmt.Sprintf("運用 %dを車両 %s、担当 %s、定員 %d名で固定", operation, fallback(clean(input.VehicleNo, 30), "未定"), fallback(clean(input.DriverName, 60), "未定"), input.Capacity))
	s.markRequestLocked(input.RequestID, updated[0].ID)
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	return updated, nil
}

func fallback(value, other string) string {
	if value == "" {
		return other
	}
	return value
}

func delayMinutes(serviceDate, planned string, actual time.Time) *int {
	if planned == "" {
		return nil
	}
	scheduled, err := time.ParseInLocation("2006-01-02 15:04", serviceDate+" "+planned, jst)
	if err != nil {
		return nil
	}
	delay := int(actual.Sub(scheduled).Minutes())
	return &delay
}

func syncRunStatus(run *Run) {
	statuses := []string{run.OutboundStatus, run.InboundStatus}
	for _, status := range statuses {
		if status == "departed" {
			run.Status = "departed"
			return
		}
	}
	for _, status := range statuses {
		if status == "boarding" {
			run.Status = "boarding"
			return
		}
	}
	terminal := 0
	cancelled := 0
	for _, status := range statuses {
		if status == "arrived" || status == "cancelled" {
			terminal++
		}
		if status == "cancelled" {
			cancelled++
		}
	}
	if terminal == 2 {
		if cancelled == 2 {
			run.Status = "cancelled"
		} else {
			run.Status = "arrived"
		}
		return
	}
	run.Status = "waiting"
}

func (s *Store) action(id, action, leg, occurredAt, requestID string, expectedRevision *int64) (*Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.state.Runs[id]
	if !ok {
		return nil, os.ErrNotExist
	}
	if requestID != "" && s.state.ProcessedRequests[requestID] != "" {
		copy := *run
		return &copy, nil
	}
	if err := checkRevision(run, expectedRevision); err != nil {
		return nil, err
	}
	now := time.Now().In(jst)
	actionTime := now
	if parsed, err := time.Parse(time.RFC3339, occurredAt); err == nil {
		actionTime = parsed.In(jst)
	}
	if leg != "" && leg != "outbound" && leg != "inbound" {
		return nil, errors.New("往路または復路を指定してください")
	}
	summary := ""
	direction := "便"
	serviceType := "passenger"
	status := &run.Status
	actualDeparture := &run.ActualDeparture
	actualArrival := &run.ActualArrival
	plannedDeparture := run.PlannedDeparture
	plannedArrival := run.PlannedArrival
	if leg == "outbound" {
		direction, serviceType, status = "往路", run.OutboundType, &run.OutboundStatus
		actualDeparture, actualArrival = &run.OutboundActualDeparture, &run.OutboundActualArrival
		plannedDeparture, plannedArrival = run.OutboundDeparture, run.OutboundArrival
	}
	if leg == "inbound" {
		direction, serviceType, status = "復路", run.InboundType, &run.InboundStatus
		actualDeparture, actualArrival = &run.InboundActualDeparture, &run.InboundActualArrival
		plannedDeparture, plannedArrival = run.InboundDeparture, run.InboundArrival
	}
	if leg != "" && serviceType == "none" {
		return nil, errors.New(direction + "は運行なしです")
	}
	currentStatus := *status
	switch action {
	case "boarding":
		if serviceType == "deadhead" {
			return nil, errors.New("回送区間では受付を開始できません")
		}
		if currentStatus != "waiting" {
			return nil, errors.New(direction + "は待機中の場合だけ受付を開始できます")
		}
		*status, summary = "boarding", direction+"の乗車受付を開始"
	case "depart":
		if serviceType == "deadhead" && currentStatus != "waiting" {
			return nil, errors.New(direction + "の回送は待機中の場合だけ出発できます")
		}
		if serviceType != "deadhead" && currentStatus != "boarding" {
			return nil, errors.New(direction + "は受付開始後に出発してください")
		}
		*status, *actualDeparture = "departed", actionTime.Format(time.RFC3339)
		if leg != "inbound" {
			run.DepartureDelayMinutes = delayMinutes(run.ServiceDate, plannedDeparture, actionTime)
		}
		summary = direction + "の出発を記録"
	case "arrive":
		if currentStatus != "departed" {
			return nil, errors.New(direction + "は出発記録後に到着できます")
		}
		*status, *actualArrival = "arrived", actionTime.Format(time.RFC3339)
		if leg != "outbound" {
			run.ArrivalDelayMinutes = delayMinutes(run.ServiceDate, plannedArrival, actionTime)
		}
		summary = direction + "の到着を記録"
	case "cancel":
		if leg != "" && currentStatus != "waiting" && currentStatus != "boarding" {
			return nil, errors.New(direction + "は出発前のみ運休にできます")
		}
		if leg == "" {
			run.Status, run.OutboundStatus, run.InboundStatus = "cancelled", "cancelled", "cancelled"
		} else {
			*status = "cancelled"
		}
		summary = direction + "の運休を記録"
	case "reset":
		if leg == "" {
			run.OutboundStatus, run.InboundStatus = "waiting", "waiting"
			run.OutboundActualDeparture, run.OutboundActualArrival, run.InboundActualDeparture, run.InboundActualArrival = "", "", "", ""
		} else {
			*status, *actualDeparture, *actualArrival = "waiting", "", ""
		}
		run.Status, run.ActualDeparture, run.ActualArrival = "waiting", "", ""
		run.DepartureDelayMinutes, run.ArrivalDelayMinutes = nil, nil
		summary = direction + "を待機へ戻す"
	default:
		return nil, errors.New("不正な操作です")
	}
	if leg != "" {
		syncRunStatus(run)
	}
	if leg == "outbound" {
		run.PassengerCount = run.OutboundPassengerCount
	}
	if leg == "inbound" {
		run.PassengerCount = run.InboundPassengerCount
	}
	if action == "depart" && leg != "inbound" && run.ActualDeparture == "" {
		run.ActualDeparture = actionTime.Format(time.RFC3339)
	}
	if action == "arrive" && run.Status == "arrived" {
		run.ActualArrival = actionTime.Format(time.RFC3339)
	}
	run.Revision++
	run.UpdatedAt = now.Format(time.RFC3339)
	s.addEventLockedAt(id, action, summary, actionTime)
	s.markRequestLocked(requestID, id)
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	copy := *run
	return &copy, nil
}

func (s *Store) info() (int, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.state.Timetable), len(s.state.Runs)
}

func (s *Store) timetable() []Template {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := append([]Template(nil), s.state.Timetable...)
	sort.Slice(items, func(i, j int) bool {
		if items[i].Day != items[j].Day {
			return items[i].Day < items[j].Day
		}
		if items[i].OperationNo != items[j].OperationNo {
			return items[i].OperationNo < items[j].OperationNo
		}
		return items[i].ColumnNo < items[j].ColumnNo
	})
	return items
}

func (s *Store) saveTemplate(input Template) (*Template, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.Day = clean(input.Day, 10)
	input.Route = clean(input.Route, 200)
	input.Details = clean(input.Details, 500)
	if input.Day != "土曜" && input.Day != "日曜" {
		return nil, errors.New("曜日が正しくありません")
	}
	if input.OperationNo < 1 || input.OperationNo > 9 || input.ColumnNo < 1 || input.ColumnNo > 99 {
		return nil, errors.New("運用番号または便番号が正しくありません")
	}
	if input.Route == "" {
		return nil, errors.New("経路を入力してください")
	}
	normalizeTemplate(&input)
	for _, value := range []string{input.PlannedDeparture, input.PlannedArrival, input.OutboundDeparture, input.OutboundArrival, input.InboundDeparture, input.InboundArrival} {
		if !validClock(value) {
			return nil, errors.New("時刻は24時間表記で入力してください")
		}
	}
	if !validServiceType(input.OutboundType) || !validServiceType(input.InboundType) {
		return nil, errors.New("便種別が正しくありません")
	}
	if input.PlannedDeparture == "" || input.PlannedArrival == "" {
		return nil, errors.New("一周の出発と帰着を入力してください")
	}
	if start, ok := clockMinutes(input.PlannedDeparture); ok {
		if end, valid := clockMinutes(input.PlannedArrival); valid && end <= start {
			return nil, errors.New("一周の帰着は出発より後にしてください")
		}
	}
	if input.OutboundType != "none" && input.OutboundDeparture == "" {
		return nil, errors.New("往路の出発時刻を入力してください")
	}
	if input.InboundType != "none" && input.InboundArrival == "" {
		return nil, errors.New("復路の到着時刻を入力してください")
	}
	if input.OutboundArrival != "" {
		start, _ := clockMinutes(input.OutboundDeparture)
		end, _ := clockMinutes(input.OutboundArrival)
		if end <= start {
			return nil, errors.New("往路到着は往路出発より後にしてください")
		}
	}
	if input.InboundDeparture != "" && input.InboundArrival != "" {
		start, _ := clockMinutes(input.InboundDeparture)
		end, _ := clockMinutes(input.InboundArrival)
		if end <= start {
			return nil, errors.New("復路到着は復路出発より後にしてください")
		}
	}
	if input.OutboundArrival != "" && input.InboundDeparture != "" {
		outboundEnd, _ := clockMinutes(input.OutboundArrival)
		inboundStart, _ := clockMinutes(input.InboundDeparture)
		if inboundStart < outboundEnd {
			return nil, errors.New("復路出発は往路到着以降にしてください")
		}
	}
	inputStart, _ := clockMinutes(input.PlannedDeparture)
	inputEnd, _ := clockMinutes(input.PlannedArrival)
	for _, existing := range s.state.Timetable {
		if existing.Day != input.Day || existing.OperationNo != input.OperationNo || existing.ColumnNo == input.ColumnNo {
			continue
		}
		if existing.PlannedDeparture == input.PlannedDeparture {
			return nil, errors.New("同じ運用に同一出発時刻の便があります")
		}
		existingStart, startOK := clockMinutes(existing.PlannedDeparture)
		existingEnd, endOK := clockMinutes(existing.PlannedArrival)
		if startOK && endOK && inputStart < existingEnd && inputEnd > existingStart {
			return nil, errors.New("同じ運用の別便と時間が重複しています")
		}
	}
	found := false
	for index := range s.state.Timetable {
		item := &s.state.Timetable[index]
		if item.Day == input.Day && item.OperationNo == input.OperationNo && item.ColumnNo == input.ColumnNo {
			*item = input
			found = true
			break
		}
	}
	if !found {
		s.state.Timetable = append(s.state.Timetable, input)
	}
	for _, run := range s.state.Runs {
		if run.Day != input.Day || run.OperationNo != input.OperationNo || run.ColumnNo != input.ColumnNo || run.Status != "waiting" {
			continue
		}
		run.PlannedDeparture, run.PlannedArrival, run.Route = input.PlannedDeparture, input.PlannedArrival, input.Route
		run.OutboundType, run.InboundType = input.OutboundType, input.InboundType
		run.OutboundDeparture, run.OutboundArrival = input.OutboundDeparture, input.OutboundArrival
		run.InboundDeparture, run.InboundArrival, run.ServiceDetails = input.InboundDeparture, input.InboundArrival, input.Details
		normalizeRun(run)
	}
	s.addEventLocked("", "timetable-edit", fmt.Sprintf("%s 運用%d 便%dの元ダイヤを保存", input.Day, input.OperationNo, input.ColumnNo))
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	copy := input
	return &copy, nil
}

func (s *Store) settings() AppSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state.Settings
}

func (s *Store) saveSettings(input AppSettings) (AppSettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if input.SchoolLatitude < -90 || input.SchoolLatitude > 90 || input.SchoolLongitude < -180 || input.SchoolLongitude > 180 {
		return AppSettings{}, errors.New("学校地点が正しくありません")
	}
	if input.SchoolRadius < 5 {
		input.SchoolRadius = 5
	}
	if input.SchoolRadius > 200 {
		input.SchoolRadius = 200
	}
	input.EventName = clean(input.EventName, 40)
	input.EventSaturday = clean(input.EventSaturday, 10)
	input.EventSunday = clean(input.EventSunday, 10)
	for _, date := range []string{input.EventSaturday, input.EventSunday} {
		if date == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return AppSettings{}, errors.New("開催日はYYYY-MM-DDで入力してください")
		}
	}
	s.state.Settings = input
	s.addEventLocked("", "school-point", "学校地点⓪を更新")
	return input, s.saveLocked()
}

type sheetRef struct {
	Name string `xml:"name,attr"`
	RID  string `xml:"id,attr"`
}

type workbookXML struct {
	Sheets []sheetRef `xml:"sheets>sheet"`
}
type relationship struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
}
type relationshipsXML struct {
	Items []relationship `xml:"Relationship"`
}
type cellXML struct {
	Ref    string `xml:"r,attr"`
	Type   string `xml:"t,attr"`
	Value  string `xml:"v"`
	Inline struct {
		Text string `xml:"t"`
	} `xml:"is"`
}
type rowXML struct {
	Number int       `xml:"r,attr"`
	Cells  []cellXML `xml:"c"`
}
type worksheetXML struct {
	Rows []rowXML `xml:"sheetData>row"`
}

func zipRead(z *zip.ReadCloser, name string) ([]byte, error) {
	name = strings.TrimPrefix(path.Clean(name), "/")
	for _, f := range z.File {
		if f.Name != name {
			continue
		}
		r, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer r.Close()
		return io.ReadAll(r)
	}
	return nil, fmt.Errorf("%s がありません", name)
}

func columnIndex(ref string) int {
	index := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' {
			break
		}
		index = index*26 + int(r-'A'+1)
	}
	return index - 1
}

func parseWorkbook(filePath string) ([]Template, error) {
	z, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, err
	}
	defer z.Close()
	workbookData, err := zipRead(z, "xl/workbook.xml")
	if err != nil {
		return nil, err
	}
	relData, err := zipRead(z, "xl/_rels/workbook.xml.rels")
	if err != nil {
		return nil, err
	}
	var wb workbookXML
	var rels relationshipsXML
	if err := xml.Unmarshal(workbookData, &wb); err != nil {
		return nil, err
	}
	if err := xml.Unmarshal(relData, &rels); err != nil {
		return nil, err
	}
	relMap := map[string]string{}
	for _, rel := range rels.Items {
		relMap[rel.ID] = rel.Target
	}
	templates := make([]Template, 0)
	for _, sheet := range wb.Sheets {
		parts := strings.Split(sheet.Name, "_")
		if len(parts) != 2 || !strings.HasPrefix(parts[0], "運用") || (parts[1] != "土曜" && parts[1] != "日曜") {
			continue
		}
		operation, err := strconv.Atoi(strings.TrimPrefix(parts[0], "運用"))
		if err != nil || operation < 1 || operation > 9 {
			continue
		}
		target := relMap[sheet.RID]
		if target == "" {
			continue
		}
		if !strings.HasPrefix(target, "xl/") {
			target = path.Join("xl", target)
		}
		sheetData, err := zipRead(z, target)
		if err != nil {
			return nil, err
		}
		var ws worksheetXML
		if err := xml.Unmarshal(sheetData, &ws); err != nil {
			return nil, err
		}
		rows := make([][]string, 20)
		for i := range rows {
			rows[i] = make([]string, 1)
		}
		for _, row := range ws.Rows {
			if row.Number < 1 || row.Number > 20 {
				continue
			}
			for _, cell := range row.Cells {
				col := columnIndex(cell.Ref)
				if col < 0 {
					continue
				}
				for len(rows[row.Number-1]) <= col {
					rows[row.Number-1] = append(rows[row.Number-1], "")
				}
				value := cell.Value
				if cell.Type == "inlineStr" {
					value = cell.Inline.Text
				}
				rows[row.Number-1][col] = strings.TrimSpace(value)
			}
		}
		width := 1
		for _, row := range rows {
			if len(row) > width {
				width = len(row)
			}
		}
		for col := 1; col < width; col++ {
			active := false
			for row := 1; row < len(rows); row++ {
				if valueAt(rows, row, col) != "" {
					active = true
					break
				}
			}
			if !active {
				continue
			}
			templates = append(templates, Template{
				Day: parts[1], OperationNo: operation, ColumnNo: col,
				PlannedDeparture: firstValue(rows, col, 5, 3, 1),
				PlannedArrival:   firstValue(rows, col, 15, 18),
				Route:            routeFor(rows, col),
			})
		}
	}
	if len(templates) == 0 {
		return nil, errors.New("運用1から9の土曜または日曜の表が見つかりません")
	}
	sort.Slice(templates, func(i, j int) bool {
		if templates[i].Day != templates[j].Day {
			return templates[i].Day < templates[j].Day
		}
		if templates[i].OperationNo != templates[j].OperationNo {
			return templates[i].OperationNo < templates[j].OperationNo
		}
		return templates[i].ColumnNo < templates[j].ColumnNo
	})
	return templates, nil
}

func valueAt(rows [][]string, row, col int) string {
	if row < 0 || row >= len(rows) || col < 0 || col >= len(rows[row]) {
		return ""
	}
	return strings.TrimSpace(rows[row][col])
}

func firstValue(rows [][]string, col int, candidates ...int) string {
	for _, row := range candidates {
		if value := valueAt(rows, row, col); value != "" {
			return value
		}
	}
	return ""
}

func routeFor(rows [][]string, col int) string {
	stops := []struct {
		Row  int
		Name string
	}{{5, "学校"}, {6, "ふじみ野"}, {8, "南古谷"}, {10, "本川越"}, {12, "南古谷"}, {15, "学校"}}
	names := make([]string, 0)
	for _, stop := range stops {
		if valueAt(rows, stop.Row, col) != "" {
			names = append(names, stop.Name)
		}
	}
	if len(names) == 0 {
		return "経路未設定"
	}
	return strings.Join(names, " → ")
}

type RouteProfileInput struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Line            string     `json:"line"`
	Direction       string     `json:"direction"`
	TimeFrom        string     `json:"timeFrom"`
	TimeTo          string     `json:"timeTo"`
	VehicleNo       string     `json:"vehicleNo"`
	Color           string     `json:"color"`
	Waypoints       []GeoPoint `json:"waypoints"`
	Geometry        []GeoPoint `json:"geometry"`
	DistanceMeters  float64    `json:"distanceMeters"`
	DurationSeconds float64    `json:"durationSeconds"`
}

func validClock(value string) bool {
	if value == "" {
		return true
	}
	_, ok := clockMinutes(value)
	return ok
}

func clockMinutes(value string) (int, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return 0, false
	}
	hour, errHour := strconv.Atoi(parts[0])
	minute, errMinute := strconv.Atoi(parts[1])
	if errHour != nil || errMinute != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 0, false
	}
	return hour*60 + minute, true
}

func validPoint(point GeoPoint) bool {
	return point.Latitude >= -90 && point.Latitude <= 90 && point.Longitude >= -180 && point.Longitude <= 180
}

func (s *Store) listRouteProfiles() []RouteProfile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profiles := make([]RouteProfile, 0, len(s.state.RouteProfiles))
	for _, profile := range s.state.RouteProfiles {
		profiles = append(profiles, *profile)
	}
	sort.Slice(profiles, func(i, j int) bool {
		if profiles[i].Line != profiles[j].Line {
			return profiles[i].Line < profiles[j].Line
		}
		if profiles[i].Direction != profiles[j].Direction {
			return profiles[i].Direction < profiles[j].Direction
		}
		return profiles[i].Name < profiles[j].Name
	})
	return profiles
}

func (s *Store) saveRouteProfile(input RouteProfileInput) (*RouteProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.Name = clean(input.Name, 80)
	input.Line = clean(input.Line, 20)
	input.Direction = clean(input.Direction, 20)
	input.VehicleNo = clean(input.VehicleNo, 30)
	input.Color = clean(input.Color, 20)
	if input.Name == "" {
		return nil, errors.New("経路名を入力してください")
	}
	if input.Line != "ふじみ野" && input.Line != "南古谷" && input.Line != "本川越" {
		return nil, errors.New("路線が正しくありません")
	}
	if input.Direction != "outbound" && input.Direction != "inbound" {
		return nil, errors.New("方向が正しくありません")
	}
	if !validClock(input.TimeFrom) || !validClock(input.TimeTo) {
		return nil, errors.New("時間帯が正しくありません")
	}
	if len(input.Waypoints) < 2 || len(input.Waypoints) > 25 {
		return nil, errors.New("経由地点は2点から25点で指定してください")
	}
	if len(input.Geometry) < 2 || len(input.Geometry) > 20000 {
		return nil, errors.New("道路経路が正しくありません")
	}
	if input.Color != "" {
		if len(input.Color) != 7 || input.Color[0] != '#' {
			return nil, errors.New("経路色が正しくありません")
		}
		if _, err := hex.DecodeString(input.Color[1:]); err != nil {
			return nil, errors.New("経路色が正しくありません")
		}
	}
	for _, point := range append(append([]GeoPoint{}, input.Waypoints...), input.Geometry...) {
		if !validPoint(point) {
			return nil, errors.New("地点情報が正しくありません")
		}
	}
	if s.state.Settings.SchoolLatitude != 0 || s.state.Settings.SchoolLongitude != 0 {
		school := GeoPoint{Latitude: s.state.Settings.SchoolLatitude, Longitude: s.state.Settings.SchoolLongitude}
		if input.Direction == "outbound" {
			input.Waypoints[0] = school
			if len(input.Geometry) > 0 {
				input.Geometry[0] = school
			}
		} else {
			input.Waypoints[len(input.Waypoints)-1] = school
			if len(input.Geometry) > 0 {
				input.Geometry[len(input.Geometry)-1] = school
			}
		}
	}
	id := clean(input.ID, 100)
	if id == "" {
		id = randomID()
	}
	if input.Color == "" {
		input.Color = "#1e60aa"
	}
	profile := &RouteProfile{ID: id, Name: input.Name, Line: input.Line, Direction: input.Direction, TimeFrom: input.TimeFrom, TimeTo: input.TimeTo, VehicleNo: input.VehicleNo, Color: input.Color, Waypoints: input.Waypoints, Geometry: input.Geometry, DistanceMeters: input.DistanceMeters, DurationSeconds: input.DurationSeconds, UpdatedAt: time.Now().In(jst).Format(time.RFC3339)}
	s.state.RouteProfiles[id] = profile
	s.addEventLocked("", "route-profile", fmt.Sprintf("経路 %sを保存", profile.Name))
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	copy := *profile
	return &copy, nil
}

func (s *Store) deleteRouteProfile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	profile, exists := s.state.RouteProfiles[id]
	if !exists {
		return os.ErrNotExist
	}
	delete(s.state.RouteProfiles, id)
	for _, run := range s.state.Runs {
		if run.OutboundRouteProfileID == id {
			run.OutboundRouteProfileID = ""
		}
		if run.InboundRouteProfileID == id {
			run.InboundRouteProfileID = ""
		}
	}
	s.addEventLocked("", "route-profile", fmt.Sprintf("経路 %sを削除", profile.Name))
	return s.saveLocked()
}

func routeDirection(route string) string {
	parts := strings.Split(route, "→")
	if len(parts) == 0 {
		return ""
	}
	if strings.TrimSpace(parts[0]) == "学校" {
		return "outbound"
	}
	if strings.TrimSpace(parts[len(parts)-1]) == "学校" {
		return "inbound"
	}
	return ""
}

func clockInRange(value, from, to string) bool {
	if from == "" && to == "" {
		return true
	}
	current, ok := clockMinutes(value)
	if !ok {
		return false
	}
	if from != "" {
		if start, valid := clockMinutes(from); !valid || current < start {
			return false
		}
	}
	if to != "" {
		if end, valid := clockMinutes(to); !valid || current > end {
			return false
		}
	}
	return true
}

func (s *Store) autoAssignRouteProfiles(date, day string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	assigned := 0
	for _, run := range s.state.Runs {
		if run.ServiceDate != date || run.Day != day || run.Status == "arrived" || run.Status == "cancelled" {
			continue
		}
		bestOutbound, bestOutboundScore := "", -1
		bestInbound, bestInboundScore := "", -1
		for _, profile := range s.state.RouteProfiles {
			if !strings.Contains(run.Route, profile.Line) {
				continue
			}
			if profile.VehicleNo != "" && profile.VehicleNo != run.VehicleNo {
				continue
			}
			if !clockInRange(run.PlannedDeparture, profile.TimeFrom, profile.TimeTo) {
				continue
			}
			score := 1
			if profile.TimeFrom != "" || profile.TimeTo != "" {
				score += 2
			}
			if profile.VehicleNo != "" {
				score += 4
			}
			if profile.Direction == "outbound" && score > bestOutboundScore {
				bestOutbound, bestOutboundScore = profile.ID, score
			}
			if profile.Direction == "inbound" && score > bestInboundScore {
				bestInbound, bestInboundScore = profile.ID, score
			}
		}
		if bestOutbound != "" && run.OutboundRouteProfileID != bestOutbound {
			run.OutboundRouteProfileID = bestOutbound
			assigned++
		}
		if bestInbound != "" && run.InboundRouteProfileID != bestInbound {
			run.InboundRouteProfileID = bestInbound
			assigned++
		}
	}
	if assigned > 0 {
		s.addEventLocked("", "route-assignment", fmt.Sprintf("条件により%d区間へ経路を割当", assigned))
		if err := s.saveLocked(); err != nil {
			return 0, err
		}
	}
	return assigned, nil
}

type AuthUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type configuredUser struct {
	AuthUser
	PIN string `json:"pin"`
}

type authSession struct {
	User      AuthUser
	ExpiresAt time.Time
}

type loginAttempt struct {
	Failures    int
	LockedUntil time.Time
}

type Auth struct {
	mu       sync.Mutex
	users    map[string]configuredUser
	sessions map[string]authSession
	attempts map[string]loginAttempt
}

func NewAuth() *Auth {
	auth := &Auth{users: map[string]configuredUser{}, sessions: map[string]authSession{}, attempts: map[string]loginAttempt{}}
	var users []configuredUser
	if raw := strings.TrimSpace(os.Getenv("APP_USERS")); raw != "" {
		if err := json.Unmarshal([]byte(raw), &users); err != nil {
			log.Printf("APP_USERSを読めません: %v", err)
		}
	}
	for _, user := range users {
		user.ID, user.Name, user.Role = clean(user.ID, 40), clean(user.Name, 60), clean(user.Role, 20)
		if user.ID == "" || len(user.PIN) < 4 || (user.Role != "admin" && user.Role != "driver" && user.Role != "viewer") {
			continue
		}
		auth.users[user.ID] = user
	}
	if len(auth.users) == 0 {
		log.Print("警告: APP_USERSが未設定のためログインできません")
	}
	return auth
}

func clientAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func (a *Auth) login(id, pin, address string) (AuthUser, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	attemptKey := address + "|" + id
	attempt := a.attempts[attemptKey]
	if now.Before(attempt.LockedUntil) {
		return AuthUser{}, "", errors.New("ログイン試行が多いため5分後に再試行してください")
	}
	configured, exists := a.users[id]
	valid := exists && subtle.ConstantTimeCompare([]byte(configured.PIN), []byte(pin)) == 1
	if !valid {
		attempt.Failures++
		if attempt.Failures >= 5 {
			attempt.Failures = 0
			attempt.LockedUntil = now.Add(5 * time.Minute)
		}
		a.attempts[attemptKey] = attempt
		return AuthUser{}, "", errors.New("職員番号または暗証番号が違います")
	}
	delete(a.attempts, attemptKey)
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return AuthUser{}, "", errors.New("ログインを開始できません")
	}
	token := hex.EncodeToString(tokenBytes)
	a.sessions[token] = authSession{User: configured.AuthUser, ExpiresAt: now.Add(12 * time.Hour)}
	return configured.AuthUser, token, nil
}

func (a *Auth) user(r *http.Request) (AuthUser, bool) {
	cookie, err := r.Cookie("bus_session")
	if err != nil {
		return AuthUser{}, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session, exists := a.sessions[cookie.Value]
	if !exists || time.Now().After(session.ExpiresAt) {
		delete(a.sessions, cookie.Value)
		return AuthUser{}, false
	}
	return session.User, true
}

func (a *Auth) logout(r *http.Request) {
	if cookie, err := r.Cookie("bus_session"); err == nil {
		a.mu.Lock()
		delete(a.sessions, cookie.Value)
		a.mu.Unlock()
	}
}

type userContextKey struct{}

func currentUser(r *http.Request) AuthUser {
	user, _ := r.Context().Value(userContextKey{}).(AuthUser)
	return user
}

type App struct {
	store        *Store
	auth         *Auth
	routingBase  string
	httpClient   *http.Client
	trainInfoURL string
}

func (a *App) require(roles ...string) func(http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, role := range roles {
		allowed[role] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := a.auth.user(r)
			if !ok {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "ログインが必要です"})
				return
			}
			if !allowed[user.Role] {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "この操作を行う権限がありません"})
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userContextKey{}, user)))
		})
	}
}

func (a *App) session(w http.ResponseWriter, r *http.Request) {
	user, ok := a.auth.user(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "ログインが必要です"})
		return
	}
	writeJSON(w, 200, map[string]any{"user": user})
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID  string `json:"id"`
		PIN string `json:"pin"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	user, token, err := a.auth.login(clean(input.ID, 40), input.PIN, clientAddress(r))
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "bus_session", Value: token, Path: "/", HttpOnly: true, Secure: requestIsSecure(r), SameSite: http.SameSiteStrictMode, MaxAge: 12 * 60 * 60})
	writeJSON(w, 200, map[string]any{"user": user})
}

// requestIsSecure はRenderなどTLSを前段で終端する構成でもHTTPS接続を判定します。
func requestIsSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	return strings.EqualFold(proto, "https")
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	a.auth.logout(r)
	http.SetCookie(w, &http.Cookie{Name: "bus_session", Value: "", Path: "/", HttpOnly: true, Secure: requestIsSecure(r), SameSite: http.SameSiteStrictMode, MaxAge: -1})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeStoreError(w http.ResponseWriter, err error) bool {
	var conflict *ConflictError
	if errors.As(err, &conflict) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": conflict.Error(), "current": conflict.Current})
		return true
	}
	return false
}

func (a *App) dashboard(w http.ResponseWriter, r *http.Request) {
	date, day := r.URL.Query().Get("date"), r.URL.Query().Get("day")
	if _, err := time.Parse("2006-01-02", date); err != nil || (day != "土曜" && day != "日曜") {
		writeJSON(w, 400, map[string]string{"error": "運行日または曜日が正しくありません"})
		return
	}
	runs, events, err := a.store.dashboard(date, day)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "運行情報を保存できません"})
		return
	}
	timetableCount, runCount := a.store.info()
	writeJSON(w, 200, map[string]any{"runs": runs, "events": events, "routeProfiles": a.store.listRouteProfiles(), "timetable": a.store.timetable(), "settings": a.store.settings(), "timetableCount": timetableCount, "runCount": runCount})
}

func (a *App) timetable(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"timetable": a.store.timetable()})
		return
	}
	if r.Method == http.MethodPut {
		var input Template
		if !decodeJSON(w, r, &input) {
			return
		}
		saved, err := a.store.saveTemplate(input)
		if writeStoreError(w, err) {
			return
		}
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	http.NotFound(w, r)
}

func (a *App) settings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, a.store.settings())
		return
	}
	if r.Method == http.MethodPatch {
		var input AppSettings
		if !decodeJSON(w, r, &input) {
			return
		}
		saved, err := a.store.saveSettings(input)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	http.NotFound(w, r)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		writeJSON(w, 400, map[string]string{"error": "入力内容が正しくありません"})
		return false
	}
	return true
}

func (a *App) routeProfiles(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"routeProfiles": a.store.listRouteProfiles()})
		return
	}
	if r.Method == http.MethodPost {
		var input RouteProfileInput
		if !decodeJSON(w, r, &input) {
			return
		}
		profile, err := a.store.saveRouteProfile(input)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, profile)
		return
	}
	http.NotFound(w, r)
}

func (a *App) routeProfileByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.NotFound(w, r)
		return
	}
	if err := a.store.deleteRouteProfile(r.PathValue("id")); errors.Is(err, os.ErrNotExist) {
		writeJSON(w, 404, map[string]string{"error": "経路が見つかりません"})
		return
	} else if err != nil {
		writeJSON(w, 500, map[string]string{"error": "経路を削除できません"})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) autoAssignRoutes(w http.ResponseWriter, r *http.Request) {
	date, day := r.URL.Query().Get("date"), r.URL.Query().Get("day")
	if _, err := time.Parse("2006-01-02", date); err != nil || (day != "土曜" && day != "日曜") {
		writeJSON(w, 400, map[string]string{"error": "運行日または曜日が正しくありません"})
		return
	}
	count, err := a.store.autoAssignRouteProfiles(date, day)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "経路を割り当てできません"})
		return
	}
	writeJSON(w, 200, map[string]int{"assigned": count})
}

func (a *App) resolveRoute(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Points []GeoPoint `json:"points"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.Points) < 2 || len(input.Points) > 25 {
		writeJSON(w, 400, map[string]string{"error": "地点は2点から25点で指定してください"})
		return
	}
	coordinates := make([]string, 0, len(input.Points))
	for _, point := range input.Points {
		if !validPoint(point) {
			writeJSON(w, 400, map[string]string{"error": "地点情報が正しくありません"})
			return
		}
		coordinates = append(coordinates, strconv.FormatFloat(point.Longitude, 'f', 6, 64)+","+strconv.FormatFloat(point.Latitude, 'f', 6, 64))
	}
	base, err := url.Parse(strings.TrimRight(a.routingBase, "/") + "/route/v1/driving/" + strings.Join(coordinates, ";"))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "経路処理の設定が正しくありません"})
		return
	}
	query := base.Query()
	query.Set("overview", "full")
	query.Set("geometries", "geojson")
	query.Set("steps", "false")
	base.RawQuery = query.Encode()
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, base.String(), nil)
	req.Header.Set("User-Agent", "SchoolBusOperations/1.0")
	response, err := a.httpClient.Do(req)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "道路経路を取得できません"})
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		writeJSON(w, 502, map[string]string{"error": "道路経路処理が応答しません"})
		return
	}
	var result struct {
		Code   string `json:"code"`
		Routes []struct {
			Distance float64 `json:"distance"`
			Duration float64 `json:"duration"`
			Geometry struct {
				Coordinates [][]float64 `json:"coordinates"`
			} `json:"geometry"`
		} `json:"routes"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 10<<20)).Decode(&result); err != nil || result.Code != "Ok" || len(result.Routes) == 0 {
		writeJSON(w, 502, map[string]string{"error": "道路経路を作成できません"})
		return
	}
	geometry := make([]GeoPoint, 0, len(result.Routes[0].Geometry.Coordinates))
	for _, coordinate := range result.Routes[0].Geometry.Coordinates {
		if len(coordinate) >= 2 {
			geometry = append(geometry, GeoPoint{Latitude: coordinate[1], Longitude: coordinate[0]})
		}
	}
	writeJSON(w, 200, map[string]any{"geometry": geometry, "distanceMeters": result.Routes[0].Distance, "durationSeconds": result.Routes[0].Duration})
}

func (a *App) runRoute(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodPatch {
		var input DetailsInput
		if !decodeJSON(w, r, &input) {
			return
		}
		run, err := a.store.updateDetails(id, input)
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, 404, map[string]string{"error": "便が見つかりません"})
			return
		}
		if writeStoreError(w, err) {
			return
		}
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, run)
		return
	}
	if r.Method == http.MethodPost {
		var input struct {
			Action           string `json:"action"`
			Leg              string `json:"leg"`
			OccurredAt       string `json:"occurredAt"`
			RequestID        string `json:"requestId"`
			ExpectedRevision *int64 `json:"expectedRevision"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		user := currentUser(r)
		if (input.Action == "cancel" || input.Action == "reset") && user.Role != "admin" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "運休と待機への戻しは管理者だけが行えます"})
			return
		}
		run, err := a.store.action(id, input.Action, input.Leg, input.OccurredAt, input.RequestID, input.ExpectedRevision)
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, 404, map[string]string{"error": "便が見つかりません"})
			return
		}
		if writeStoreError(w, err) {
			return
		}
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, run)
		return
	}
	http.NotFound(w, r)
}

func (a *App) operationAssignment(w http.ResponseWriter, r *http.Request) {
	operation, err := strconv.Atoi(r.PathValue("operation"))
	date, day := r.URL.Query().Get("date"), r.URL.Query().Get("day")
	if err != nil || operation < 1 || operation > 99 {
		writeJSON(w, 400, map[string]string{"error": "運用番号が正しくありません"})
		return
	}
	if _, err := time.Parse("2006-01-02", date); err != nil || (day != "土曜" && day != "日曜") {
		writeJSON(w, 400, map[string]string{"error": "運行日または曜日が正しくありません"})
		return
	}
	var input AssignmentInput
	if !decodeJSON(w, r, &input) {
		return
	}
	runs, err := a.store.assignOperation(date, day, operation, input)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, 404, map[string]string{"error": "対象の運行便が見つかりません"})
		return
	}
	if writeStoreError(w, err) {
		return
	}
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "固定設定を保存できません"})
		return
	}
	writeJSON(w, 200, map[string]any{"runs": runs})
}

func saveUpload(file multipart.File) (string, error) {
	tmp, err := os.CreateTemp("", "bus-timetable-*.xlsx")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	if _, err := io.Copy(tmp, io.LimitReader(file, 20<<20)); err != nil {
		tmp.Close()
		os.Remove(name)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}

func (a *App) importTimetable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		writeJSON(w, 400, map[string]string{"error": "Excelを受信できません"})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "Excelを選択してください"})
		return
	}
	defer file.Close()
	if !strings.HasSuffix(strings.ToLower(header.Filename), ".xlsx") {
		writeJSON(w, 400, map[string]string{"error": "xlsx形式を選択してください"})
		return
	}
	tmp, err := saveUpload(file)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "一時保存に失敗しました"})
		return
	}
	defer os.Remove(tmp)
	templates, err := parseWorkbook(tmp)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if err := a.store.replaceTimetable(templates); err != nil {
		writeJSON(w, 500, map[string]string{"error": "ダイヤを保存できません"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(templates)})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(self), fullscreen=(self)")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'")
		next.ServeHTTP(w, r)
	})
}

func main() {
	dataPath := flag.String("data", envOr("DATA_FILE", "data/store.json"), "保存ファイル")
	importPath := flag.String("import", "", "Excelを取り込んで終了")
	flag.Parse()
	ensureDataFile(*dataPath, envOr("SEED_FILE", "data/store.json"))
	store, err := NewStore(*dataPath)
	if err != nil {
		log.Fatal(err)
	}
	if *importPath != "" {
		templates, err := parseWorkbook(*importPath)
		if err != nil {
			log.Fatal(err)
		}
		if err := store.replaceTimetable(templates); err != nil {
			log.Fatal(err)
		}
		log.Printf("%d便を取り込みました", len(templates))
		return
	}
	app := &App{
		store:       store,
		auth:        NewAuth(),
		routingBase: envOr("ROUTING_API", "https://router.project-osrm.org"),
		httpClient:  &http.Client{Timeout: 15 * time.Second},
		// 運行情報はHUBBのtraininfo-api（JR東日本公式・公共交通オープンデータセンター・私鉄各社公式を統合、匿名GET）から取ります。
		trainInfoURL: envOr("TRAININFO_API", "https://script.google.com/macros/s/AKfycbxu0W_WXSw7KJNHTFM4lsLONRTRgcIsLXV_JmxNI7R5DbospsSO4OFVfga9FJNZYOfL/exec"),
	}
	store.seedGuideDefaults()
	app.startLineStatusRefresh()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", app.login)
	mux.HandleFunc("POST /api/logout", app.logout)
	mux.Handle("GET /api/session", app.require("admin", "driver", "viewer")(http.HandlerFunc(app.session)))
	mux.Handle("GET /api/dashboard", app.require("admin", "driver", "viewer")(http.HandlerFunc(app.dashboard)))
	mux.Handle("PATCH /api/runs/{id}", app.require("admin", "driver")(http.HandlerFunc(app.runRoute)))
	mux.Handle("POST /api/runs/{id}/action", app.require("admin", "driver")(http.HandlerFunc(app.runRoute)))
	mux.Handle("PATCH /api/operations/{operation}/assignment", app.require("admin", "driver")(http.HandlerFunc(app.operationAssignment)))
	mux.Handle("GET /api/route-profiles", app.require("admin", "driver", "viewer")(http.HandlerFunc(app.routeProfiles)))
	mux.Handle("POST /api/route-profiles", app.require("admin")(http.HandlerFunc(app.routeProfiles)))
	mux.Handle("DELETE /api/route-profiles/{id}", app.require("admin")(http.HandlerFunc(app.routeProfileByID)))
	mux.Handle("POST /api/route-profiles/auto-assign", app.require("admin")(http.HandlerFunc(app.autoAssignRoutes)))
	mux.Handle("POST /api/routes/resolve", app.require("admin")(http.HandlerFunc(app.resolveRoute)))
	mux.Handle("POST /api/timetable/import", app.require("admin")(http.HandlerFunc(app.importTimetable)))
	mux.Handle("GET /api/timetable", app.require("admin")(http.HandlerFunc(app.timetable)))
	mux.Handle("PUT /api/timetable", app.require("admin")(http.HandlerFunc(app.timetable)))
	mux.Handle("DELETE /api/timetable/{day}/{operation}/{column}", app.require("admin")(http.HandlerFunc(app.timetableEntry)))
	mux.HandleFunc("GET /api/public/guide", app.publicGuide)
	mux.HandleFunc("POST /api/public/signal", app.publicSignal)
	mux.HandleFunc("GET /api/public/schedule", app.publicSchedule)
	mux.HandleFunc("GET /api/public/programs", app.publicPrograms)
	mux.Handle("GET /api/programs", app.require("admin", "driver", "viewer")(http.HandlerFunc(app.programs)))
	mux.Handle("PUT /api/programs", app.require("admin")(http.HandlerFunc(app.programs)))
	mux.Handle("DELETE /api/programs/{id}", app.require("admin")(http.HandlerFunc(app.programByID)))
	// 案内設定は当日その場で直せるよう、ログインなしで開けます。
	// GUIDE_LOCK=1 を設定すると管理者のログインが必要になります。
	guard := func(handler http.HandlerFunc) http.Handler {
		if envOr("GUIDE_LOCK", "") == "1" {
			return app.require("admin")(http.HandlerFunc(handler))
		}
		return http.HandlerFunc(handler)
	}
	mux.Handle("GET /api/stops", guard(app.stops))
	mux.Handle("PUT /api/stops", guard(app.stops))
	mux.Handle("DELETE /api/stops/{id}", guard(app.stopByID))
	mux.Handle("GET /api/legs", guard(app.legs))
	mux.Handle("PUT /api/legs", guard(app.legs))
	mux.Handle("GET /api/notices", guard(app.notices))
	mux.Handle("PUT /api/notices", guard(app.notices))
	mux.Handle("DELETE /api/notices/{id}", guard(app.noticeByID))
	mux.Handle("GET /api/crowd-hints", guard(app.crowdHints))
	mux.Handle("PUT /api/crowd-hints", guard(app.crowdHints))
	mux.Handle("DELETE /api/crowd-hints/{id}", guard(app.crowdHintByID))
	mux.Handle("GET /api/line-statuses", guard(app.lineStatuses))
	mux.Handle("PUT /api/line-statuses", guard(app.lineStatuses))
	mux.Handle("GET /api/guide/event", guard(app.guideEvent))
	mux.Handle("PATCH /api/guide/event", guard(app.guideEvent))
	mux.Handle("GET /api/settings", app.require("admin", "driver", "viewer")(http.HandlerFunc(app.settings)))
	mux.Handle("PATCH /api/settings", app.require("admin")(http.HandlerFunc(app.settings)))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200); _, _ = w.Write([]byte("ok")) })
	staticFiles, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("GET /{$}", pageHandler(staticFiles, "public.html"))
	mux.Handle("GET /staff", pageHandler(staticFiles, "staff.html"))
	mux.Handle("GET /staff/{$}", pageHandler(staticFiles, "staff.html"))
	mux.Handle("GET /diagram", pageHandler(staticFiles, "diagram.html"))
	mux.Handle("GET /guide", pageHandler(staticFiles, "guide.html"))
	mux.Handle("GET /guide/{$}", pageHandler(staticFiles, "guide.html"))
	mux.Handle("GET /program", pageHandler(staticFiles, "program.html"))
	mux.Handle("GET /program/{$}", pageHandler(staticFiles, "program.html"))
	mux.Handle("GET /diagram/{$}", pageHandler(staticFiles, "diagram.html"))
	mux.HandleFunc("GET /index.html", redirectTo("/"))
	mux.HandleFunc("GET /public.html", redirectTo("/"))
	mux.HandleFunc("GET /staff.html", redirectTo("/staff"))
	mux.HandleFunc("GET /diagram.html", redirectTo("/diagram"))
	mux.HandleFunc("GET /program.html", redirectTo("/program"))
	mux.Handle("/", staticHandler(staticFiles))
	port := envOr("PORT", "8080")
	server := &http.Server{Addr: ":" + port, Handler: securityHeaders(mux), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("一般用 http://localhost:%s/ 、ダイヤ管理 /diagram 、職員用 /staff で開始", port)
	log.Fatal(server.ListenAndServe())
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func routeStops(route string) []string {
	stops := make([]string, 0, 4)
	for _, part := range strings.Split(route, "→") {
		name := strings.TrimSpace(part)
		if name == "" || name == "学校" {
			continue
		}
		known := false
		for _, existing := range stops {
			if existing == name {
				known = true
				break
			}
		}
		if !known {
			stops = append(stops, name)
		}
	}
	return stops
}

type PublicEntry struct {
	OperationNo      int      `json:"operationNo"`
	ColumnNo         int      `json:"columnNo"`
	Route            string   `json:"route"`
	Stops            []string `json:"stops"`
	SchoolDeparture  string   `json:"schoolDeparture"`
	StationArrival   string   `json:"stationArrival"`
	StationDeparture string   `json:"stationDeparture"`
	SchoolArrival    string   `json:"schoolArrival"`
	OutboundType     string   `json:"outboundType"`
	InboundType      string   `json:"inboundType"`
	Details          string   `json:"details"`
	Status           string   `json:"status"`
	DelayMinutes     *int     `json:"delayMinutes"`
}

// publicSchedule は一般公開用の時刻だけを読み取り専用で返します。
// 乗車人数、担当者、車両番号、GPS位置は公開しません。
func (s *Store) publicSchedule(date, day string) []PublicEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries := make([]PublicEntry, 0, len(s.state.Timetable))
	for _, t := range s.state.Timetable {
		if t.Day != day {
			continue
		}
		entry := PublicEntry{
			OperationNo:      t.OperationNo,
			ColumnNo:         t.ColumnNo,
			Route:            t.Route,
			Stops:            routeStops(t.Route),
			SchoolDeparture:  fallback(t.OutboundDeparture, t.PlannedDeparture),
			StationArrival:   t.OutboundArrival,
			StationDeparture: t.InboundDeparture,
			SchoolArrival:    fallback(t.InboundArrival, t.PlannedArrival),
			OutboundType:     t.OutboundType,
			InboundType:      t.InboundType,
			Details:          t.Details,
		}
		if date != "" {
			if run, ok := s.state.Runs[runID(date, day, t.OperationNo, t.ColumnNo)]; ok {
				entry.Status = run.Status
				delay := run.DepartureDelayMinutes
				if delay == nil {
					delay = run.ArrivalDelayMinutes
				}
				if delay != nil && *delay > 0 {
					value := *delay
					entry.DelayMinutes = &value
				}
			}
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		a, aOK := clockMinutes(entries[i].SchoolDeparture)
		b, bOK := clockMinutes(entries[j].SchoolDeparture)
		if aOK != bOK {
			return aOK
		}
		if aOK && bOK && a != b {
			return a < b
		}
		if entries[i].OperationNo != entries[j].OperationNo {
			return entries[i].OperationNo < entries[j].OperationNo
		}
		return entries[i].ColumnNo < entries[j].ColumnNo
	})
	return entries
}

func (s *Store) deleteTemplate(day string, operation, column int) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	index := -1
	for position, item := range s.state.Timetable {
		if item.Day == day && item.OperationNo == operation && item.ColumnNo == column {
			index = position
			break
		}
	}
	if index < 0 {
		return 0, errors.New("削除する便が見つかりません")
	}
	s.state.Timetable = append(s.state.Timetable[:index], s.state.Timetable[index+1:]...)
	removed := 0
	for id, run := range s.state.Runs {
		if run.Day != day || run.OperationNo != operation || run.ColumnNo != column {
			continue
		}
		if run.Status != "waiting" || run.PassengerCount > 0 || run.OutboundPassengerCount > 0 || run.InboundPassengerCount > 0 {
			continue
		}
		if run.ActualDeparture != "" || run.ActualArrival != "" || run.Note != "" {
			continue
		}
		delete(s.state.Runs, id)
		removed++
	}
	s.addEventLocked("", "timetable-delete", fmt.Sprintf("%s 運用%d 便%dの元ダイヤを削除。未記録の運行%d件も削除", day, operation, column, removed))
	if err := s.saveLocked(); err != nil {
		return 0, err
	}
	return removed, nil
}

func (a *App) publicSchedule(w http.ResponseWriter, r *http.Request) {
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	day := strings.TrimSpace(r.URL.Query().Get("day"))
	if date != "" {
		parsed, err := time.ParseInLocation("2006-01-02", date, jst)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": "日付が正しくありません"})
			return
		}
		if day == "" {
			switch parsed.Weekday() {
			case time.Sunday:
				day = "日曜"
			default:
				day = "土曜"
			}
		}
	}
	if day != "土曜" && day != "日曜" {
		writeJSON(w, 400, map[string]string{"error": "曜日が正しくありません"})
		return
	}
	entries := a.store.publicSchedule(date, day)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{
		"date":      date,
		"day":       day,
		"entries":   entries,
		"count":     len(entries),
		"updatedAt": time.Now().In(jst).Format(time.RFC3339),
	})
}

func (a *App) timetableEntry(w http.ResponseWriter, r *http.Request) {
	day := r.PathValue("day")
	operation, errOperation := strconv.Atoi(r.PathValue("operation"))
	column, errColumn := strconv.Atoi(r.PathValue("column"))
	if (day != "土曜" && day != "日曜") || errOperation != nil || errColumn != nil {
		writeJSON(w, 400, map[string]string{"error": "削除対象が正しくありません"})
		return
	}
	removed, err := a.store.deleteTemplate(day, operation, column)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "removedRuns": removed})
}

func pageHandler(files fs.FS, name string) http.HandlerFunc {
	body, err := fs.ReadFile(files, name)
	if err != nil {
		log.Fatalf("%sを読めません: %v", name, err)
	}
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	}
}

func redirectTo(target string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	}
}

// ensureDataFile は保存先が空の環境へ初回だけ同梱ダイヤを複製します。
func ensureDataFile(dataPath, seedPath string) {
	if seedPath == "" || seedPath == dataPath {
		return
	}
	if _, err := os.Stat(dataPath); err == nil {
		return
	}
	body, err := os.ReadFile(seedPath)
	if err != nil {
		return
	}
	if err := os.MkdirAll(path.Dir(dataPath), 0o755); err != nil {
		log.Printf("保存先を作成できません: %v", err)
		return
	}
	if err := os.WriteFile(dataPath, body, 0o644); err != nil {
		log.Printf("初期ダイヤを配置できません: %v", err)
		return
	}
	log.Printf("初期ダイヤを %s へ配置しました", dataPath)
}

// staticHandler は内容に基づくETagを付け、更新した画面が確実に読み込まれるようにします。
func staticHandler(files fs.FS) http.Handler {
	tags := map[string]string{}
	_ = fs.WalkDir(files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		body, readErr := fs.ReadFile(files, name)
		if readErr != nil {
			return nil
		}
		sum := sha256.Sum256(body)
		tags["/"+name] = "\"" + hex.EncodeToString(sum[:8]) + "\""
		return nil
	})
	fileServer := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tag, ok := tags[r.URL.Path]; ok {
			w.Header().Set("ETag", tag)
			w.Header().Set("Cache-Control", "no-cache")
			if r.Header.Get("If-None-Match") == tag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		fileServer.ServeHTTP(w, r)
	})
}

func sortPrograms(items []Program) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Day != items[j].Day {
			return items[i].Day > items[j].Day
		}
		a, aOK := clockMinutes(items[i].Start)
		b, bOK := clockMinutes(items[j].Start)
		if aOK && bOK && a != b {
			return a < b
		}
		if items[i].Stage != items[j].Stage {
			return items[i].Stage < items[j].Stage
		}
		return items[i].Title < items[j].Title
	})
}

func (s *Store) listPrograms(day string) []Program {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]Program, 0, len(s.state.Programs))
	for _, item := range s.state.Programs {
		if day != "" && item.Day != day {
			continue
		}
		items = append(items, item)
	}
	sortPrograms(items)
	return items
}

func (s *Store) saveProgram(input Program) (*Program, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.Day = clean(input.Day, 10)
	input.Stage = clean(input.Stage, 40)
	input.Title = clean(input.Title, 80)
	input.Start = clean(input.Start, 5)
	input.End = clean(input.End, 5)
	input.Details = clean(input.Details, 1000)
	if input.Day != "土曜" && input.Day != "日曜" {
		return nil, errors.New("曜日が正しくありません")
	}
	if input.Stage == "" {
		return nil, errors.New("会場を入力してください")
	}
	if input.Title == "" {
		return nil, errors.New("内容を入力してください")
	}
	start, ok := clockMinutes(input.Start)
	if !ok {
		return nil, errors.New("開始時刻を24時間表記で入力してください")
	}
	if !validClock(input.End) {
		return nil, errors.New("終了時刻を24時間表記で入力してください")
	}
	if end, valid := clockMinutes(input.End); valid && end <= start {
		return nil, errors.New("終了は開始より後にしてください")
	}
	if input.ID == "" {
		input.ID = randomID()
		s.state.Programs = append(s.state.Programs, input)
	} else {
		found := false
		for index := range s.state.Programs {
			if s.state.Programs[index].ID == input.ID {
				s.state.Programs[index] = input
				found = true
				break
			}
		}
		if !found {
			s.state.Programs = append(s.state.Programs, input)
		}
	}
	s.addEventLocked("", "program-edit", fmt.Sprintf("%s %s %sの進行を保存", input.Day, input.Stage, input.Title))
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	saved := input
	return &saved, nil
}

func (s *Store) deleteProgram(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, item := range s.state.Programs {
		if item.ID != id {
			continue
		}
		s.state.Programs = append(s.state.Programs[:index], s.state.Programs[index+1:]...)
		s.addEventLocked("", "program-delete", fmt.Sprintf("%s %s %sの進行を削除", item.Day, item.Stage, item.Title))
		return s.saveLocked()
	}
	return errors.New("削除する進行が見つかりません")
}

func (a *App) programs(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"programs": a.store.listPrograms(strings.TrimSpace(r.URL.Query().Get("day")))})
		return
	}
	if r.Method == http.MethodPut {
		var input Program
		if !decodeJSON(w, r, &input) {
			return
		}
		saved, err := a.store.saveProgram(input)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	http.NotFound(w, r)
}

func (a *App) programByID(w http.ResponseWriter, r *http.Request) {
	if err := a.store.deleteProgram(r.PathValue("id")); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) publicPrograms(w http.ResponseWriter, r *http.Request) {
	day := strings.TrimSpace(r.URL.Query().Get("day"))
	if day != "土曜" && day != "日曜" {
		writeJSON(w, 400, map[string]string{"error": "曜日が正しくありません"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"day": day, "programs": a.store.listPrograms(day)})
}
