package main

// 運行の記録を手元へ取り出すための口です。
//
// Renderの無料インスタンスは保存先が揮発し、有料へ上げて永続ディスクを付けても、
// 無料へ戻すときにはディスクごと消すことになります。どちらの道でも、当日つけた
// 人数と出発到着はサーバーの外へ写しておかないと残りません。
//
// CSVは人が読む控え、JSONはそのまま保存先へ戻せる控えです。

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// exportRuns は指定した日の運行便をCSVで返します。日付を省くと記録のある日を全部返します。
func (a *App) exportRuns(w http.ResponseWriter, r *http.Request) {
	date := r.URL.Query().Get("date")
	if date != "" {
		if _, err := time.Parse("2006-01-02", date); err != nil {
			writeJSON(w, 400, map[string]string{"error": "運行日はYYYY-MM-DDで指定してください"})
			return
		}
	}
	rows := a.store.runRows(date)
	stamp := time.Now().In(jst).Format("20060102-1504")
	name := "運行記録-" + stamp + ".csv"
	if date != "" {
		name = "運行記録-" + date + ".csv"
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	// ファイル名に日本語を使うので、RFC 5987の書き方を添えます。
	w.Header().Set("Content-Disposition", "attachment; filename=\"runs-"+stamp+".csv\"; filename*=UTF-8''"+urlEscape(name))
	w.WriteHeader(200)
	// Excelが文字化けしないよう、先頭にBOMを置きます。
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	out := csv.NewWriter(w)
	defer out.Flush()
	_ = out.Write([]string{
		"運行日", "曜日", "運用", "便", "路線", "経路",
		"往路種別", "往路人数", "往路予定発", "往路実際発", "往路予定着", "往路実際着",
		"復路種別", "復路人数", "復路予定発", "復路実際発", "復路予定着", "復路実際着",
		"状態", "車両", "担当", "定員", "備考",
	})
	for _, row := range rows {
		_ = out.Write(row)
	}
}

// runRows は記録の写しを組み立てます。運行日、運用、便の順に並べます。
func (s *Store) runRows(date string) [][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	runs := make([]*Run, 0, len(s.state.Runs))
	for _, run := range s.state.Runs {
		if date != "" && run.ServiceDate != date {
			continue
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool {
		if runs[i].ServiceDate != runs[j].ServiceDate {
			return runs[i].ServiceDate < runs[j].ServiceDate
		}
		if runs[i].OperationNo != runs[j].OperationNo {
			return runs[i].OperationNo < runs[j].OperationNo
		}
		return runs[i].ColumnNo < runs[j].ColumnNo
	})
	rows := make([][]string, 0, len(runs))
	for _, run := range runs {
		rows = append(rows, []string{
			run.ServiceDate, run.Day, strconv.Itoa(run.OperationNo), strconv.Itoa(run.ColumnNo), run.Line, run.Route,
			serviceTypeLabel(run.OutboundType), strconv.Itoa(run.OutboundPassengerCount),
			run.OutboundDeparture, clockOf(run.OutboundActualDeparture),
			run.OutboundArrival, clockOf(run.OutboundActualArrival),
			serviceTypeLabel(run.InboundType), strconv.Itoa(run.InboundPassengerCount),
			run.InboundDeparture, clockOf(run.InboundActualDeparture),
			run.InboundArrival, clockOf(run.InboundActualArrival),
			runStatusLabel(run.Status), run.VehicleNo, run.DriverName, strconv.Itoa(run.Capacity), run.Note,
		})
	}
	return rows
}

func serviceTypeLabel(value string) string {
	switch value {
	case "passenger":
		return "通常便"
	case "deadhead":
		return "回送"
	case "group":
		return "団体専用"
	case "none":
		return "運行なし"
	}
	return value
}

func runStatusLabel(value string) string {
	switch value {
	case "waiting":
		return "待機"
	case "boarding":
		return "乗車受付"
	case "departed":
		return "運行中"
	case "arrived":
		return "到着"
	case "cancelled":
		return "運休"
	}
	return value
}

// clockOf は記録した時刻を東京の時刻に直します。記録は日時ごと持っています。
func clockOf(value string) string {
	if value == "" {
		return ""
	}
	moment, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return moment.In(jst).Format("15:04:05")
}

// exportStore は保存先の中身をそのまま返します。取り出した控えは、保存先へ
// 置き直せばその時点へ戻せます。
func (a *App) exportStore(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	body, err := json.MarshalIndent(a.store.state, "", "  ")
	a.store.mu.RUnlock()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "控えを組み立てられません"})
		return
	}
	stamp := time.Now().In(jst).Format("20060102-1504")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"store-%s.json\"", stamp))
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

// urlEscape はファイル名をRFC 5987の書き方へ直します。
func urlEscape(value string) string {
	const hex = "0123456789ABCDEF"
	out := make([]byte, 0, len(value)*3)
	for index := 0; index < len(value); index++ {
		char := value[index]
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '.' || char == '_' || char == '~' {
			out = append(out, char)
			continue
		}
		out = append(out, '%', hex[char>>4], hex[char&0x0F])
	}
	return string(out)
}

// restore は控えの内容でまるごと置き換えます。控えを取った時点へ戻す操作です。
func (s *Store) restore(incoming State) error {
	normalizeState(&incoming)
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := len(s.state.Runs)
	s.state = incoming
	s.addEventLocked("", "store-import", fmt.Sprintf("控えを読み込み。運行の記録 %d件 → %d件", previous, len(s.state.Runs)))
	return s.saveLocked()
}

// importStore は取り出した控えを保存先へ戻します。
//
// 無料インスタンスでは保存先がコンテナごと作り直され、当日つけた人数も
// 出発到着も消えます。シェルが無いのでファイルを置き直すこともできません。
// 消えたあとに戻れる道は、この口だけです。
//
// 中身はそっくり入れ替えます。いま入っている内容は残りません。
func (a *App) importStore(w http.ResponseWriter, r *http.Request) {
	// 控えは運行の記録と操作の記録を抱えるので、ほかの入力より大きくなります。
	// decodeJSON の1MBでは、いちばん戻したい「記録が溜まったあと」で弾かれます。
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	var incoming State
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeJSON(w, 400, map[string]string{"error": "控えを読めません。取り出したJSONをそのまま送ってください"})
		return
	}
	// 空や別物を送られて中身を失わないよう、ダイヤが入っていることだけ確かめます。
	if len(incoming.Timetable) == 0 {
		writeJSON(w, 400, map[string]string{"error": "元ダイヤの入っていない控えは読み込めません"})
		return
	}
	if err := a.store.restore(incoming); err != nil {
		writeJSON(w, 500, map[string]string{"error": "控えを保存先へ書けません"})
		return
	}
	writeJSON(w, 200, map[string]any{
		"timetable": len(incoming.Timetable),
		"programs":  len(incoming.Programs),
		"runs":      len(incoming.Runs),
	})
}
