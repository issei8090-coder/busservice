package main

// 一般用の案内に必要な情報をまとめます。
// 乗り場、区間の所要時間、お知らせ、混雑予測、沿線の運行情報を扱います。

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// 学校を表す経路上の名前です。
const schoolNode = "学校"

// 停車時間が計算できない片道便で使う、駅での停車時間の目安です。
const defaultDwellMinutes = 5

// Stop は駅の乗り場です。管理画面から登録します。
type Stop struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`        // 経路に出てくる駅名。例 ふじみ野
	Line        string  `json:"line"`        // 東武東上線
	Place       string  `json:"place"`       // 東口ロータリー
	Landmark    string  `json:"landmark"`    // 改札を出て左、交番の向かい
	WalkMinutes int     `json:"walkMinutes"` // 改札から乗り場までの徒歩
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	Order       int     `json:"order"`
}

// Leg は区間の所要時間です。向きは問いません。
type Leg struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Minutes int    `json:"minutes"`
}

// Notice は一般用画面の上部に出すお知らせです。
type Notice struct {
	ID        string `json:"id"`
	Day       string `json:"day"`   // 土曜 日曜 すべて
	Level     string `json:"level"` // info warn alert
	Title     string `json:"title"`
	Body      string `json:"body"`
	UpdatedAt string `json:"updatedAt"`
}

// CrowdHint は管理画面から設定する混雑予測です。検索からの推定より優先します。
type CrowdHint struct {
	ID        string `json:"id"`
	Day       string `json:"day"`
	Direction string `json:"direction"` // outbound inbound both
	Stop      string `json:"stop"`      // 空ならすべての駅
	Start     string `json:"start"`
	End       string `json:"end"`
	Level     string `json:"level"` // calm crowded packed
	Note      string `json:"note"`
}

// SearchSignal は利用者が調べた希望時刻の匿名集計です。個人を識別する情報は持ちません。
type SearchSignal struct {
	Date      string `json:"date"`
	Direction string `json:"direction"`
	Stop      string `json:"stop"`
	Slot      string `json:"slot"` // 15分単位に丸めた希望時刻
	Count     int    `json:"count"`
}

// LineStatus は沿線の運行情報です。自動取得できないときは手入力を使います。
type LineStatus struct {
	Railway   string `json:"railway"`
	Name      string `json:"name"`
	Status    string `json:"status"` // normal trouble unknown
	Text      string `json:"text"`
	Source    string `json:"source"` // traininfo manual
	UpdatedAt string `json:"updatedAt"`
}

// StopPoint は1つの便が駅に立ち寄る1回分の時刻です。
type StopPoint struct {
	Stop       string `json:"stop"`
	Arrival    string `json:"arrival"`   // 学校から来た人が降りる時刻
	Departure  string `json:"departure"` // 学校へ向かう人が乗る時刻
	CanAlight  bool   `json:"canAlight"` // 学校から乗ってここで降りられる
	CanBoard   bool   `json:"canBoard"`  // ここから乗って学校へ行ける
	Estimated  bool   `json:"estimated"` // 区間所要からの計算値
	OrderIndex int    `json:"orderIndex"`
}

// ---------- 区間の所要時間 ----------

// legMinutes は2駅の間の所要時間を返します。向きは問いません。
func legMinutes(legs []Leg, from, to string) (int, bool) {
	for _, leg := range legs {
		if (leg.From == from && leg.To == to) || (leg.From == to && leg.To == from) {
			return leg.Minutes, true
		}
	}
	return 0, false
}

func routeNodes(route string) []string {
	nodes := make([]string, 0, 5)
	for _, part := range strings.Split(route, "→") {
		name := strings.TrimSpace(part)
		if name != "" {
			nodes = append(nodes, name)
		}
	}
	return nodes
}

func clockFromMinutes(total int) string {
	for total < 0 {
		total += 24 * 60
	}
	return fmt.Sprintf("%02d:%02d", (total/60)%24, total%60)
}

// stopTimes は学校発と学校着から、途中の駅の発着時刻を計算します。
// 走行時間は区間表から足し上げ、余った時間を停車時間として駅に配分します。
func stopTimes(route, schoolDeparture, schoolArrival string, legs []Leg, outboundPassenger, inboundPassenger bool) []StopPoint {
	nodes := routeNodes(route)
	if len(nodes) < 2 {
		return nil
	}
	travel := make([]int, 0, len(nodes)-1)
	for index := 0; index+1 < len(nodes); index++ {
		minutes, ok := legMinutes(legs, nodes[index], nodes[index+1])
		if !ok {
			return nil // 区間が未登録のときは推測しません
		}
		travel = append(travel, minutes)
	}
	total := 0
	for _, minutes := range travel {
		total += minutes
	}

	departure, hasDeparture := clockMinutes(schoolDeparture)
	arrival, hasArrival := clockMinutes(schoolArrival)
	stopCount := 0
	for index, name := range nodes {
		if name != schoolNode && index != 0 && index != len(nodes)-1 {
			stopCount++
		} else if name != schoolNode {
			stopCount++
		}
	}
	// 始点と終点が学校でない片道便も停車地に数えるため、学校以外の数をそのまま使います。
	stopCount = 0
	for _, name := range nodes {
		if name != schoolNode {
			stopCount++
		}
	}

	dwell := make([]int, len(nodes))
	if hasDeparture && hasArrival && nodes[0] == schoolNode && nodes[len(nodes)-1] == schoolNode {
		slack := arrival - departure - total
		if slack < 0 {
			slack = 0
		}
		if stopCount > 0 {
			each := slack / stopCount
			extra := slack % stopCount
			for index, name := range nodes {
				if name == schoolNode {
					continue
				}
				dwell[index] = each
				if extra > 0 {
					dwell[index]++
					extra--
				}
			}
		}
	} else {
		for index, name := range nodes {
			if name == schoolNode || index == 0 || index == len(nodes)-1 {
				continue
			}
			dwell[index] = defaultDwellMinutes
		}
	}

	// 起点の時刻を決めます。学校発があれば前から、無ければ学校着から逆算します。
	start := 0
	switch {
	case nodes[0] == schoolNode && hasDeparture:
		start = departure
	case hasArrival:
		back := 0
		for index := len(nodes) - 1; index > 0; index-- {
			back += travel[index-1] + dwell[index]
		}
		start = arrival - back
	case hasDeparture:
		start = departure
	default:
		return nil
	}

	points := make([]StopPoint, 0, len(nodes))
	clock := start
	for index, name := range nodes {
		if index > 0 {
			clock += travel[index-1]
		}
		arriveAt := clock
		clock += dwell[index]
		departAt := clock
		if name == schoolNode {
			continue
		}
		alight := false
		for before := 0; before < index; before++ {
			if nodes[before] == schoolNode {
				alight = true
				break
			}
		}
		board := false
		for after := index + 1; after < len(nodes); after++ {
			if nodes[after] == schoolNode {
				board = true
				break
			}
		}
		point := StopPoint{
			Stop:       name,
			Arrival:    clockFromMinutes(arriveAt),
			Departure:  clockFromMinutes(departAt),
			CanAlight:  alight && outboundPassenger,
			CanBoard:   board && inboundPassenger,
			Estimated:  true,
			OrderIndex: index,
		}
		points = append(points, point)
	}
	return points
}

// ---------- 乗り場 ----------

func (s *Store) listStops() []Stop {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := append([]Stop(nil), s.state.Stops...)
	sort.SliceStable(items, func(a, b int) bool {
		if items[a].Order != items[b].Order {
			return items[a].Order < items[b].Order
		}
		return items[a].Name < items[b].Name
	})
	return items
}

func (s *Store) saveStop(input Stop) (*Stop, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.Name = clean(input.Name, 20)
	input.Line = clean(input.Line, 40)
	input.Place = clean(input.Place, 40)
	input.Landmark = clean(input.Landmark, 200)
	if input.Name == "" {
		return nil, errors.New("駅名を入力してください")
	}
	if input.WalkMinutes < 0 || input.WalkMinutes > 60 {
		return nil, errors.New("徒歩の分数は0から60で入力してください")
	}
	if input.Latitude != 0 || input.Longitude != 0 {
		if input.Latitude < 20 || input.Latitude > 46 || input.Longitude < 122 || input.Longitude > 154 {
			return nil, errors.New("緯度経度が日本の範囲から外れています")
		}
	}
	if input.ID == "" {
		input.ID = randomID()
		s.state.Stops = append(s.state.Stops, input)
	} else {
		found := false
		for index := range s.state.Stops {
			if s.state.Stops[index].ID == input.ID {
				s.state.Stops[index] = input
				found = true
				break
			}
		}
		if !found {
			s.state.Stops = append(s.state.Stops, input)
		}
	}
	s.addEventLocked("", "stop-edit", fmt.Sprintf("%sの乗り場を保存", input.Name))
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	saved := input
	return &saved, nil
}

func (s *Store) deleteStop(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, item := range s.state.Stops {
		if item.ID != id {
			continue
		}
		s.state.Stops = append(s.state.Stops[:index], s.state.Stops[index+1:]...)
		s.addEventLocked("", "stop-delete", fmt.Sprintf("%sの乗り場を削除", item.Name))
		return s.saveLocked()
	}
	return errors.New("削除する乗り場が見つかりません")
}

// ---------- 区間の所要時間 ----------

func (s *Store) listLegs() []Leg {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Leg(nil), s.state.Legs...)
}

func (s *Store) saveLegs(input []Leg) ([]Leg, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cleaned := make([]Leg, 0, len(input))
	for _, leg := range input {
		leg.From = clean(leg.From, 20)
		leg.To = clean(leg.To, 20)
		if leg.From == "" || leg.To == "" {
			continue
		}
		if leg.From == leg.To {
			return nil, errors.New("同じ地点どうしの区間は登録できません")
		}
		if leg.Minutes < 1 || leg.Minutes > 180 {
			return nil, fmt.Errorf("%s〜%sの所要時間は1から180分で入力してください", leg.From, leg.To)
		}
		duplicate := false
		for _, existing := range cleaned {
			if (existing.From == leg.From && existing.To == leg.To) || (existing.From == leg.To && existing.To == leg.From) {
				duplicate = true
				break
			}
		}
		if duplicate {
			return nil, fmt.Errorf("%s〜%sの区間が重複しています", leg.From, leg.To)
		}
		cleaned = append(cleaned, leg)
	}
	s.state.Legs = cleaned
	s.addEventLocked("", "leg-edit", fmt.Sprintf("区間の所要時間を%d件保存", len(cleaned)))
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	return append([]Leg(nil), cleaned...), nil
}

// ---------- お知らせ ----------

func (s *Store) listNotices(day string) []Notice {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]Notice, 0, len(s.state.Notices))
	for _, item := range s.state.Notices {
		if day != "" && item.Day != "すべて" && item.Day != day {
			continue
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(a, b int) bool { return items[a].UpdatedAt > items[b].UpdatedAt })
	return items
}

func (s *Store) saveNotice(input Notice) (*Notice, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.Day = clean(input.Day, 10)
	input.Level = clean(input.Level, 10)
	input.Title = clean(input.Title, 60)
	input.Body = clean(input.Body, 600)
	if input.Day != "土曜" && input.Day != "日曜" && input.Day != "すべて" {
		return nil, errors.New("曜日を選んでください")
	}
	if input.Level != "info" && input.Level != "warn" && input.Level != "alert" {
		input.Level = "info"
	}
	if input.Title == "" {
		return nil, errors.New("見出しを入力してください")
	}
	input.UpdatedAt = time.Now().In(jst).Format(time.RFC3339)
	if input.ID == "" {
		input.ID = randomID()
		s.state.Notices = append(s.state.Notices, input)
	} else {
		found := false
		for index := range s.state.Notices {
			if s.state.Notices[index].ID == input.ID {
				s.state.Notices[index] = input
				found = true
				break
			}
		}
		if !found {
			s.state.Notices = append(s.state.Notices, input)
		}
	}
	s.addEventLocked("", "notice-edit", fmt.Sprintf("お知らせ「%s」を保存", input.Title))
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	saved := input
	return &saved, nil
}

func (s *Store) deleteNotice(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, item := range s.state.Notices {
		if item.ID != id {
			continue
		}
		s.state.Notices = append(s.state.Notices[:index], s.state.Notices[index+1:]...)
		s.addEventLocked("", "notice-delete", fmt.Sprintf("お知らせ「%s」を削除", item.Title))
		return s.saveLocked()
	}
	return errors.New("削除するお知らせが見つかりません")
}

// ---------- 混雑予測 ----------

func (s *Store) listCrowdHints(day string) []CrowdHint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]CrowdHint, 0, len(s.state.CrowdHints))
	for _, item := range s.state.CrowdHints {
		if day != "" && item.Day != day {
			continue
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(a, b int) bool { return items[a].Start < items[b].Start })
	return items
}

func (s *Store) saveCrowdHint(input CrowdHint) (*CrowdHint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.Day = clean(input.Day, 10)
	input.Direction = clean(input.Direction, 10)
	input.Stop = clean(input.Stop, 20)
	input.Start = clean(input.Start, 5)
	input.End = clean(input.End, 5)
	input.Level = clean(input.Level, 10)
	input.Note = clean(input.Note, 120)
	if input.Day != "土曜" && input.Day != "日曜" {
		return nil, errors.New("曜日を選んでください")
	}
	if input.Direction != "outbound" && input.Direction != "inbound" && input.Direction != "both" {
		input.Direction = "both"
	}
	if input.Level != "calm" && input.Level != "crowded" && input.Level != "packed" {
		return nil, errors.New("混雑の程度を選んでください")
	}
	start, ok := clockMinutes(input.Start)
	if !ok {
		return nil, errors.New("開始時刻を24時間表記で入力してください")
	}
	end, ok := clockMinutes(input.End)
	if !ok {
		return nil, errors.New("終了時刻を24時間表記で入力してください")
	}
	if end <= start {
		return nil, errors.New("終了は開始より後にしてください")
	}
	if input.ID == "" {
		input.ID = randomID()
		s.state.CrowdHints = append(s.state.CrowdHints, input)
	} else {
		found := false
		for index := range s.state.CrowdHints {
			if s.state.CrowdHints[index].ID == input.ID {
				s.state.CrowdHints[index] = input
				found = true
				break
			}
		}
		if !found {
			s.state.CrowdHints = append(s.state.CrowdHints, input)
		}
	}
	s.addEventLocked("", "crowd-edit", fmt.Sprintf("%s %s〜%sの混雑予測を保存", input.Day, input.Start, input.End))
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	saved := input
	return &saved, nil
}

func (s *Store) deleteCrowdHint(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, item := range s.state.CrowdHints {
		if item.ID != id {
			continue
		}
		s.state.CrowdHints = append(s.state.CrowdHints[:index], s.state.CrowdHints[index+1:]...)
		s.addEventLocked("", "crowd-delete", "混雑予測を削除")
		return s.saveLocked()
	}
	return errors.New("削除する混雑予測が見つかりません")
}

// ---------- 検索の匿名集計 ----------

// recordSearch は利用者が選んだ希望時刻を15分単位で数えます。個人を識別する情報は保存しません。
func (s *Store) recordSearch(date, direction, stop, clock string) {
	minutes, ok := clockMinutes(clock)
	if !ok {
		return
	}
	slot := clockFromMinutes(minutes - minutes%15)
	s.mu.Lock()
	defer s.mu.Unlock()
	for index := range s.state.SearchSignals {
		signal := &s.state.SearchSignals[index]
		if signal.Date == date && signal.Direction == direction && signal.Stop == stop && signal.Slot == slot {
			signal.Count++
			_ = s.saveLocked()
			return
		}
	}
	s.state.SearchSignals = append(s.state.SearchSignals, SearchSignal{Date: date, Direction: direction, Stop: stop, Slot: slot, Count: 1})
	_ = s.saveLocked()
}

func (s *Store) listSearchSignals(date string) []SearchSignal {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]SearchSignal, 0, len(s.state.SearchSignals))
	for _, item := range s.state.SearchSignals {
		if date != "" && item.Date != date {
			continue
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(a, b int) bool { return items[a].Slot < items[b].Slot })
	return items
}

// ---------- 沿線の運行情報 ----------

// saveAttribution は運行情報の出典表示を保存します。画面への表示が利用条件です。
func (s *Store) saveAttribution(items []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cleaned := make([]string, 0, len(items))
	for _, item := range items {
		item = clean(item, 200)
		if item != "" {
			cleaned = append(cleaned, item)
		}
	}
	s.state.LineAttribution = cleaned
	_ = s.saveLocked()
}

func (s *Store) listAttribution() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.state.LineAttribution...)
}

func (s *Store) listLineStatuses() []LineStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]LineStatus(nil), s.state.LineStatuses...)
}

func (s *Store) saveLineStatuses(input []LineStatus, source string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cleaned := make([]LineStatus, 0, len(input))
	now := time.Now().In(jst).Format(time.RFC3339)
	for _, item := range input {
		item.Name = clean(item.Name, 40)
		item.Text = clean(item.Text, 200)
		item.Railway = clean(item.Railway, 80)
		if item.Name == "" {
			continue
		}
		if item.Status != "normal" && item.Status != "trouble" && item.Status != "info" {
			item.Status = "unknown"
		}
		item.Source = source
		item.UpdatedAt = now
		cleaned = append(cleaned, item)
	}
	s.state.LineStatuses = cleaned
	return s.saveLocked()
}

// guideRailways は画面に出す路線です。traininfo-apiの路線IDと、来場者向けの表示名を対応させます。
var guideRailways = []struct {
	ID   string
	Name string
}{
	{"tobu.tojo", "東武東上線"},
	{"jreast.kawagoeline", "JR川越線"},
	{"seibu.shinjuku", "西武新宿線"},
}

// trainInfoSnapshot は traininfo-api が返す運行情報です。
// JR東日本公式、公共交通オープンデータセンター、関東私鉄各社公式をまとめた匿名GETのAPIです。
type trainInfoSnapshot struct {
	UpdatedAt   string          `json:"updatedAt"`
	Attribution []string        `json:"attribution"`
	Lines       []trainInfoLine `json:"lines"`
}

type trainInfoLine struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Status     string `json:"status"` // normal delay suspend info unknown
	StatusText string `json:"statusText"`
	Detail     *struct {
		JA string `json:"ja"`
	} `json:"detail"`
}

// 状態の表記です。遅延と運転見合わせは目立たせ、直通運転中止などはお知らせとして出します。
func guideLineStatus(status string) (string, string) {
	switch status {
	case "normal":
		return "normal", "平常運転"
	case "delay":
		return "trouble", "遅延"
	case "suspend":
		return "trouble", "運転見合わせ"
	case "info":
		return "info", "お知らせ"
	}
	return "unknown", "情報なし"
}

// fetchLineStatuses は沿線の運行情報を取得します。
func (a *App) fetchLineStatuses() ([]LineStatus, []string, error) {
	if a.trainInfoURL == "" {
		return nil, nil, errors.New("運行情報の取得先が設定されていません")
	}
	endpoint := a.trainInfoURL
	if strings.Contains(endpoint, "?") {
		endpoint += "&path=status"
	} else {
		endpoint += "?path=status"
	}
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, nil, err
	}
	response, err := a.httpClient.Do(request)
	if err != nil {
		return nil, nil, err
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	_ = response.Body.Close()
	if err != nil {
		return nil, nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("運行情報を取得できません(%d)", response.StatusCode)
	}
	var snapshot trainInfoSnapshot
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return nil, nil, fmt.Errorf("運行情報を読めません: %w", err)
	}
	byID := make(map[string]trainInfoLine, len(snapshot.Lines))
	for _, line := range snapshot.Lines {
		byID[line.ID] = line
	}
	statuses := make([]LineStatus, 0, len(guideRailways))
	for _, target := range guideRailways {
		status := LineStatus{Railway: target.ID, Name: target.Name, Status: "unknown", Text: ""}
		if line, ok := byID[target.ID]; ok {
			state, _ := guideLineStatus(line.Status)
			status.Status = state
			// 本文は詳細のみを入れます。「遅延」などの見出しは画面側で状態から出します。
			if line.Detail != nil && strings.TrimSpace(line.Detail.JA) != "" {
				status.Text = strings.TrimSpace(line.Detail.JA)
			} else if state != "normal" && strings.TrimSpace(line.StatusText) != "" {
				status.Text = strings.TrimSpace(line.StatusText)
			}
		}
		statuses = append(statuses, status)
	}
	return statuses, snapshot.Attribution, nil
}

// refreshLineStatuses は運行情報を取り直して保存します。失敗しても手入力の内容は残します。
func (a *App) refreshLineStatuses() {
	statuses, attribution, err := a.fetchLineStatuses()
	if err != nil {
		return
	}
	_ = a.store.saveLineStatuses(statuses, "traininfo")
	a.store.saveAttribution(attribution)
}

// ---------- 初期値 ----------

// seedGuideDefaults は乗り場と区間が未登録のときだけ、既定値を入れます。
func (s *Store) seedGuideDefaults() {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	if len(s.state.Legs) == 0 {
		s.state.Legs = []Leg{
			{From: schoolNode, To: "ふじみ野", Minutes: 15},
			{From: schoolNode, To: "南古谷", Minutes: 10},
			{From: schoolNode, To: "本川越", Minutes: 25},
			{From: "南古谷", To: "本川越", Minutes: 20},
		}
		changed = true
	}
	if len(s.state.Stops) == 0 {
		s.state.Stops = []Stop{
			{ID: randomID(), Name: "ふじみ野", Line: "東武東上線", Order: 1},
			{ID: randomID(), Name: "南古谷", Line: "JR川越線", Order: 2},
			{ID: randomID(), Name: "本川越", Line: "西武新宿線", Order: 3},
		}
		changed = true
	}
	if changed {
		_ = s.saveLocked()
	}
}

// ---------- 一般用のまとめ取得 ----------

// PublicTrip は一般用に出す1便です。駅ごとの発着時刻を持ちます。
type PublicTrip struct {
	OperationNo       int         `json:"operationNo"`
	ColumnNo          int         `json:"columnNo"`
	Route             string      `json:"route"`
	SchoolDeparture   string      `json:"schoolDeparture"`
	SchoolArrival     string      `json:"schoolArrival"`
	OutboundPassenger bool        `json:"outboundPassenger"`
	InboundPassenger  bool        `json:"inboundPassenger"`
	Status            string      `json:"status"`
	DelayMinutes      *int        `json:"delayMinutes"`
	Details           string      `json:"details"`
	Points            []StopPoint `json:"points"`
}

// CrowdWindow は混雑予測の1区切りです。優先度の高いものを採用します。
type CrowdWindow struct {
	Direction string `json:"direction"`
	Stop      string `json:"stop"`
	Start     string `json:"start"`
	End       string `json:"end"`
	Level     string `json:"level"`
	Note      string `json:"note"`
	Source    string `json:"source"`
	Priority  int    `json:"priority"`
}

func (s *Store) publicTrips(date, day string) []PublicTrip {
	entries := s.publicSchedule(date, day)
	legs := s.listLegs()
	trips := make([]PublicTrip, 0, len(entries))
	for _, entry := range entries {
		outbound := entry.OutboundType == "passenger"
		inbound := entry.InboundType == "passenger"
		trip := PublicTrip{
			OperationNo:       entry.OperationNo,
			ColumnNo:          entry.ColumnNo,
			Route:             entry.Route,
			SchoolDeparture:   entry.SchoolDeparture,
			SchoolArrival:     entry.SchoolArrival,
			OutboundPassenger: outbound,
			InboundPassenger:  inbound,
			Status:            entry.Status,
			DelayMinutes:      entry.DelayMinutes,
			Details:           entry.Details,
			Points:            stopTimes(entry.Route, entry.SchoolDeparture, entry.SchoolArrival, legs, outbound, inbound),
		}
		trips = append(trips, trip)
	}
	return trips
}

// crowdWindows は混雑予測を組み立てます。
// 管理画面の設定を最優先し、次に当日の検索、最後に前日の乗車実績を使います。
func (s *Store) crowdWindows(date, day string) []CrowdWindow {
	windows := make([]CrowdWindow, 0, 8)
	for _, hint := range s.listCrowdHints(day) {
		windows = append(windows, CrowdWindow{
			Direction: hint.Direction, Stop: hint.Stop, Start: hint.Start, End: hint.End,
			Level: hint.Level, Note: hint.Note, Source: "manual", Priority: 3,
		})
	}
	windows = append(windows, s.searchCrowdWindows(date)...)
	windows = append(windows, s.historyCrowdWindows(date, day)...)
	return windows
}

// searchCrowdWindows は当日の検索の集中から混雑を推定します。
func (s *Store) searchCrowdWindows(date string) []CrowdWindow {
	signals := s.listSearchSignals(date)
	if len(signals) < 4 {
		return nil
	}
	counts := make([]int, 0, len(signals))
	for _, signal := range signals {
		counts = append(counts, signal.Count)
	}
	sort.Ints(counts)
	median := counts[len(counts)/2]
	if median < 1 {
		median = 1
	}
	windows := make([]CrowdWindow, 0, 4)
	for _, signal := range signals {
		if signal.Count < 5 {
			continue
		}
		level := ""
		switch {
		case signal.Count >= median*5/2:
			level = "packed"
		case signal.Count >= median*3/2:
			level = "crowded"
		}
		if level == "" {
			continue
		}
		start, ok := clockMinutes(signal.Slot)
		if !ok {
			continue
		}
		windows = append(windows, CrowdWindow{
			Direction: signal.Direction, Stop: signal.Stop,
			Start: signal.Slot, End: clockFromMinutes(start + 15),
			Level: level, Note: "この時間を調べている方が多いです", Source: "search", Priority: 2,
		})
	}
	return windows
}

// historyCrowdWindows は直近の運行日の乗車実績から混雑を推定します。
func (s *Store) historyCrowdWindows(date, day string) []CrowdWindow {
	s.mu.RLock()
	defer s.mu.RUnlock()
	latest := ""
	for _, run := range s.state.Runs {
		if run.ServiceDate == "" || run.ServiceDate >= date {
			continue
		}
		if run.OutboundPassengerCount == 0 && run.InboundPassengerCount == 0 && run.PassengerCount == 0 {
			continue
		}
		if run.ServiceDate > latest {
			latest = run.ServiceDate
		}
	}
	if latest == "" {
		return nil
	}
	windows := make([]CrowdWindow, 0, 8)
	add := func(clock string, count, capacity int, direction string) {
		if clock == "" || capacity <= 0 || count <= 0 {
			return
		}
		start, ok := clockMinutes(clock)
		if !ok {
			return
		}
		ratio := float64(count) / float64(capacity)
		level := ""
		switch {
		case ratio >= 0.9:
			level = "packed"
		case ratio >= 0.7:
			level = "crowded"
		}
		if level == "" {
			return
		}
		windows = append(windows, CrowdWindow{
			Direction: direction, Start: clockFromMinutes(start - 10), End: clockFromMinutes(start + 10),
			Level: level, Note: "前回の同じ時間帯は混み合いました", Source: "history", Priority: 1,
		})
	}
	for _, run := range s.state.Runs {
		if run.ServiceDate != latest {
			continue
		}
		capacity := run.Capacity
		if capacity <= 0 {
			capacity = 55
		}
		outbound := run.OutboundPassengerCount
		inbound := run.InboundPassengerCount
		if outbound == 0 && inbound == 0 {
			outbound = run.PassengerCount
		}
		add(fallback(run.OutboundDeparture, run.PlannedDeparture), outbound, capacity, "outbound")
		add(fallback(run.InboundArrival, run.PlannedArrival), inbound, capacity, "inbound")
	}
	return windows
}

// publicEventSettings は一般用に出してよい設定だけを返します。学校の座標は含めません。
func (s *Store) publicEventSettings() map[string]string {
	settings := s.settings()
	return map[string]string{
		"eventName":     settings.EventName,
		"eventSaturday": settings.EventSaturday,
		"eventSunday":   settings.EventSunday,
	}
}

// publicGuide は一般用画面が必要とする情報を1度にまとめて返します。
func (a *App) publicGuide(w http.ResponseWriter, r *http.Request) {
	day := strings.TrimSpace(r.URL.Query().Get("day"))
	if day != "土曜" && day != "日曜" {
		day = "土曜"
	}
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	if _, err := time.Parse("2006-01-02", date); err != nil {
		date = ""
	}
	writeJSON(w, 200, map[string]any{
		"day":         day,
		"date":        date,
		"trips":       a.store.publicTrips(date, day),
		"stops":       a.store.listStops(),
		"legs":        a.store.listLegs(),
		"notices":     a.store.listNotices(day),
		"programs":    a.store.listPrograms(day),
		"crowd":       a.store.crowdWindows(date, day),
		"lines":       a.store.listLineStatuses(),
		"attribution": a.store.listAttribution(),
		"settings":    a.store.publicEventSettings(),
		"updatedAt":   time.Now().In(jst).Format(time.RFC3339),
	})
}

// publicSignal は利用者が選んだ希望時刻を匿名で数えます。
func (a *App) publicSignal(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Date      string `json:"date"`
		Direction string `json:"direction"`
		Stop      string `json:"stop"`
		Time      string `json:"time"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	direction := clean(input.Direction, 10)
	if direction != "outbound" && direction != "inbound" {
		writeJSON(w, 400, map[string]string{"error": "方向が正しくありません"})
		return
	}
	date := clean(input.Date, 10)
	if _, err := time.Parse("2006-01-02", date); err != nil {
		date = time.Now().In(jst).Format("2006-01-02")
	}
	a.store.recordSearch(date, direction, clean(input.Stop, 20), clean(input.Time, 5))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---------- 管理用のAPI ----------

func (a *App) stops(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"stops": a.store.listStops()})
		return
	}
	if r.Method == http.MethodPut {
		var input Stop
		if !decodeJSON(w, r, &input) {
			return
		}
		saved, err := a.store.saveStop(input)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	http.NotFound(w, r)
}

func (a *App) stopByID(w http.ResponseWriter, r *http.Request) {
	if err := a.store.deleteStop(r.PathValue("id")); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) legs(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"legs": a.store.listLegs()})
		return
	}
	if r.Method == http.MethodPut {
		var input struct {
			Legs []Leg `json:"legs"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		saved, err := a.store.saveLegs(input.Legs)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"legs": saved})
		return
	}
	http.NotFound(w, r)
}

func (a *App) notices(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{"notices": a.store.listNotices(strings.TrimSpace(r.URL.Query().Get("day")))})
		return
	}
	if r.Method == http.MethodPut {
		var input Notice
		if !decodeJSON(w, r, &input) {
			return
		}
		saved, err := a.store.saveNotice(input)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	http.NotFound(w, r)
}

func (a *App) noticeByID(w http.ResponseWriter, r *http.Request) {
	if err := a.store.deleteNotice(r.PathValue("id")); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) crowdHints(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{
			"crowdHints": a.store.listCrowdHints(strings.TrimSpace(r.URL.Query().Get("day"))),
			"signals":    a.store.listSearchSignals(strings.TrimSpace(r.URL.Query().Get("date"))),
		})
		return
	}
	if r.Method == http.MethodPut {
		var input CrowdHint
		if !decodeJSON(w, r, &input) {
			return
		}
		saved, err := a.store.saveCrowdHint(input)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, saved)
		return
	}
	http.NotFound(w, r)
}

func (a *App) crowdHintByID(w http.ResponseWriter, r *http.Request) {
	if err := a.store.deleteCrowdHint(r.PathValue("id")); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// lineStatuses は沿線の運行情報です。自動取得が使えないときは手入力を保存します。
func (a *App) lineStatuses(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]any{
			"lines":       a.store.listLineStatuses(),
			"attribution": a.store.listAttribution(),
			"autoReady":   a.trainInfoURL != "",
		})
		return
	}
	if r.Method == http.MethodPut {
		var input struct {
			Lines []LineStatus `json:"lines"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := a.store.saveLineStatuses(input.Lines, "manual"); err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"lines": a.store.listLineStatuses()})
		return
	}
	http.NotFound(w, r)
}

// startLineStatusRefresh は沿線の運行情報を定期的に取り直します。
func (a *App) startLineStatusRefresh() {
	if a.trainInfoURL == "" {
		return
	}
	go func() {
		a.refreshLineStatuses()
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			a.refreshLineStatuses()
		}
	}()
}

// guideEvent は開催日の設定です。学校の座標などには触れません。
func (a *App) guideEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		settings := a.store.settings()
		writeJSON(w, 200, map[string]string{
			"eventName":     settings.EventName,
			"eventSaturday": settings.EventSaturday,
			"eventSunday":   settings.EventSunday,
		})
		return
	}
	if r.Method == http.MethodPatch {
		var input struct {
			EventName     string `json:"eventName"`
			EventSaturday string `json:"eventSaturday"`
			EventSunday   string `json:"eventSunday"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		settings := a.store.settings()
		settings.EventName = input.EventName
		settings.EventSaturday = input.EventSaturday
		settings.EventSunday = input.EventSunday
		saved, err := a.store.saveSettings(settings)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{
			"eventName":     saved.EventName,
			"eventSaturday": saved.EventSaturday,
			"eventSunday":   saved.EventSunday,
		})
		return
	}
	http.NotFound(w, r)
}
