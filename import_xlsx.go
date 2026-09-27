package main

// 2026年の時刻表（「土曜 1」から「日曜 9」の18枚）を読み取ります。
// 1列が1便で、行の位置は固定です。上から順に次の並びです。
//
//	2  車庫発      3  印（回送など）   4  学校着
//	5  発番        6  学校発
//	7  ふじみ野着   8  ふじみ野発
//	9  南古谷着（経由のみ）           10 南古谷発（経由のみ）
//	11 本川越着    12 本川越発
//	13 南古谷着    14 南古谷発
//	15 印（回送、団体専用）           16 学校着
//	17 学校発（入庫、または後夜祭）    19 車庫着
//
// 便種別は次のように決めます。
//   - 発番が「回送」なら往路は回送
//   - 15行目が「回送」なら復路は回送、「団体専用」なら復路は団体専用
//   - 学校発が無い便（車庫から駅へ迎えに行く便）は往路なし
//
// 経由のある一回りは、乗り降りする区間ごとに片道の便へ分けます。
// 乗車人数を駅ごとに数えるためです。例 学校 → 本川越 → 南古谷 → 学校 は
// 「学校 → 本川越」「本川越 →（南古谷経由）→ 学校」「南古谷 → 学校」の3便です。
// 経路の中の「（南古谷経由）」は通るだけの駅の印で、停まる駅として数えません。
//
// 車庫の区間は全て回送です。学校に寄らず駅へ迎えに行く一回りだけ、
// 車庫から最初の駅までを1便として登録します。車庫と学校は同じ場所で
// 所要0分なので、車庫と学校の行き来は便にせず、詳細情報へ時刻を残します。

import (
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
)

const (
	rowGarageDeparture  = 2
	rowGarageMark       = 3
	rowSchoolBefore     = 4
	rowBoardingNumber   = 5
	rowSchoolDeparture  = 6
	rowFujiminoArrival  = 7
	rowFujiminoDepart   = 8
	rowViaArrival       = 9
	rowViaDepart        = 10
	rowHonkawagoeArrive = 11
	rowHonkawagoeDepart = 12
	rowMinamikoyaArrive = 13
	rowMinamikoyaDepart = 14
	rowReturnMark       = 15
	rowSchoolArrival    = 16
	rowSchoolAfter      = 17
	rowGarageArrival    = 19
)

const afterPartyMark = "後夜祭"

// garageNode は車庫です。学校発が無い一回りは、車庫発の回送便として登録します。
const garageNode = "車庫"

// cellValue は1つの枠の中身です。時刻と、時刻以外の文字を分けて持ちます。
type cellValue struct {
	Clock string
	Note  string
}

func (c cellValue) empty() bool { return c.Clock == "" && c.Note == "" }

// stationStop は1便が停まる駅1つです。時刻が無く注記だけの枠もあります。
type stationStop struct {
	Name    string
	Arrival cellValue
	Depart  cellValue
}

func (s stationStop) empty() bool { return s.Arrival.empty() && s.Depart.empty() }
func (s stationStop) timed() bool { return s.Arrival.Clock != "" || s.Depart.Clock != "" }

// columnTrip はシートの1列、つまり車両の一回りです。
// 駅は行の位置で役目が決まります。7-8行と11-12行が目的の駅、
// 9-10行は往路の途中で降りる南古谷、13-14行は復路の途中で乗る南古谷です。
type columnTrip struct {
	Day             string
	Operation       int
	Vehicle         string
	GarageDepart    cellValue
	GarageArrival   cellValue
	SchoolBefore    cellValue
	SchoolDeparture cellValue
	SchoolArrival   cellValue
	SchoolAfter     cellValue
	BoardingNumber  string
	GarageMark      string
	ReturnMark      string
	Fujimino        stationStop // 7-8行
	OutboundVia     stationStop // 9-10行 往路の経由
	Honkawagoe      stationStop // 11-12行
	InboundVia      stationStop // 13-14行 復路の経由
}

// newSheetTitle は「土曜 1」のようなシート名を曜日と運用番号へ分けます。
func newSheetTitle(name string) (string, int, bool) {
	trimmed := strings.TrimSpace(name)
	day := ""
	switch {
	case strings.HasPrefix(trimmed, "土曜"):
		day = "土曜"
	case strings.HasPrefix(trimmed, "日曜"):
		day = "日曜"
	default:
		return "", 0, false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(trimmed, day))
	rest = strings.TrimSpace(strings.TrimPrefix(rest, "　"))
	operation, err := strconv.Atoi(rest)
	if err != nil || operation < 1 || operation > 9 {
		return "", 0, false
	}
	return day, operation, true
}

// excelCell は枠の中身を時刻と注記へ分けます。
// 時刻はExcelでは0から1の小数なので、分に直します。
// 「14:30(予備)」のように時刻と文字が混ざる枠もあります。
func excelCell(value string) cellValue {
	value = strings.TrimSpace(value)
	if value == "" {
		return cellValue{}
	}
	if number, err := strconv.ParseFloat(value, 64); err == nil {
		if number > 0 && number < 1 {
			minutes := int(number*24*60 + 0.5)
			return cellValue{Clock: fmt.Sprintf("%d:%02d", minutes/60, minutes%60)}
		}
		// 1や2は発番の数字です。時刻ではないので使いません。
		return cellValue{}
	}
	if clock, rest, ok := splitClockText(value); ok {
		return cellValue{Clock: clock, Note: rest}
	}
	return cellValue{Note: value}
}

// splitClockText は「14:30(予備)」を時刻と残りの文字へ分けます。
func splitClockText(value string) (string, string, bool) {
	for index := 0; index < len(value); index++ {
		if value[index] != ':' {
			continue
		}
		start := index
		for start > 0 && value[start-1] >= '0' && value[start-1] <= '9' {
			start--
		}
		end := index + 1
		for end < len(value) && value[end] >= '0' && value[end] <= '9' {
			end++
		}
		if start == index || end == index+1 {
			continue
		}
		clock := value[start:end]
		if !validClock(clock) {
			continue
		}
		rest := strings.TrimSpace(strings.Trim(strings.TrimSpace(value[:start]+" "+value[end:]), "（）()　 "))
		return clock, rest, true
	}
	return "", "", false
}

// readColumnTrip はシートの1列を読み取ります。中身が無い列は false を返します。
func readColumnTrip(rows [][]string, col int, day string, operation int, vehicle string) (columnTrip, bool) {
	at := func(row int) cellValue { return excelCell(valueAt(rows, row-1, col)) }
	note := func(row int) string { return excelCell(valueAt(rows, row-1, col)).Note }
	trip := columnTrip{
		Day: day, Operation: operation, Vehicle: vehicle,
		GarageDepart:    at(rowGarageDeparture),
		GarageArrival:   at(rowGarageArrival),
		SchoolBefore:    at(rowSchoolBefore),
		SchoolDeparture: at(rowSchoolDeparture),
		SchoolArrival:   at(rowSchoolArrival),
		SchoolAfter:     at(rowSchoolAfter),
		BoardingNumber:  note(rowBoardingNumber),
		GarageMark:      note(rowGarageMark),
		ReturnMark:      note(rowReturnMark),
		Fujimino:        stationStop{Name: "ふじみ野", Arrival: at(rowFujiminoArrival), Depart: at(rowFujiminoDepart)},
		OutboundVia:     stationStop{Name: "南古谷", Arrival: at(rowViaArrival), Depart: at(rowViaDepart)},
		Honkawagoe:      stationStop{Name: "本川越", Arrival: at(rowHonkawagoeArrive), Depart: at(rowHonkawagoeDepart)},
		InboundVia:      stationStop{Name: "南古谷", Arrival: at(rowMinamikoyaArrive), Depart: at(rowMinamikoyaDepart)},
	}
	if trip.destination().empty() && trip.SchoolDeparture.empty() && trip.SchoolArrival.empty() {
		return columnTrip{}, false
	}
	return trip, true
}

// destination は折り返しの駅です。ふじみ野と本川越が目的の駅で、
// どちらも無い便は南古谷が目的の駅になります。
func (t columnTrip) destination() stationStop {
	if !t.Fujimino.empty() {
		return t.Fujimino
	}
	if !t.Honkawagoe.empty() {
		return t.Honkawagoe
	}
	if !t.InboundVia.empty() {
		return t.InboundVia
	}
	return t.OutboundVia
}

// firstStation は最初に着く駅です。車庫発の回送便の行き先になります。
func (t columnTrip) firstStation() stationStop {
	for _, stop := range []stationStop{t.Fujimino, t.OutboundVia, t.Honkawagoe, t.InboundVia} {
		if stop.Arrival.Clock != "" {
			return stop
		}
	}
	return stationStop{}
}

// outboundType は往路の便種別です。発番が「回送」なら回送になります。
func (t columnTrip) outboundType() string {
	if strings.Contains(t.BoardingNumber, "回送") {
		return "deadhead"
	}
	return "passenger"
}

// inboundType は復路の便種別です。15行目の印で決めます。
// 15行目の回送は、学校から駅へ客を乗せて出たあと、空で学校へ戻る便を指します。
// 往路が回送の便と、学校発が無い便（車庫から駅へ迎えに行く便）の復路は客を乗せます。
func (t columnTrip) inboundType() string {
	if strings.Contains(t.ReturnMark, "団体専用") {
		return "group"
	}
	if strings.Contains(t.ReturnMark, "回送") && t.SchoolDeparture.Clock != "" && t.outboundType() == "passenger" {
		return "deadhead"
	}
	return "passenger"
}

// lineName は5路線のどれかを返します。判別できないときは空です。
func (t columnTrip) lineName() string {
	outVia := !t.OutboundVia.empty()
	inVia := !t.InboundVia.empty()
	switch {
	case !t.Fujimino.empty():
		return lineFujimino
	case !t.Honkawagoe.empty() && outVia:
		return lineHonkawagoeViaMK
	case !t.Honkawagoe.empty() && inVia:
		return lineHonkawagoeToMK
	case !t.Honkawagoe.empty():
		return lineHonkawagoe
	case inVia || outVia:
		return lineMinamikoya
	}
	return ""
}

// notes は詳細情報に残す文章を組み立てます。
// 車庫の出入り、経由駅の時刻、表の注記をここへまとめます。
func (t columnTrip) notes(extra ...string) string {
	parts := make([]string, 0, 8)
	if line := t.lineName(); line != "" {
		parts = append(parts, line)
	}
	if t.Vehicle != "" {
		parts = append(parts, t.Vehicle)
	}
	for _, text := range extra {
		if text != "" {
			parts = append(parts, text)
		}
	}
	if t.GarageDepart.Clock != "" {
		parts = append(parts, "出庫 "+t.GarageDepart.Clock+"（車庫から回送）")
	}
	if t.GarageArrival.Clock != "" {
		parts = append(parts, "入庫 "+t.GarageArrival.Clock+"（車庫へ回送）")
	}
	for _, note := range []string{t.GarageMark, t.BoardingNumber, t.ReturnMark} {
		if text := noteText(note); text != "" && text != note {
			parts = append(parts, text)
		}
	}
	for _, stop := range []stationStop{t.Fujimino, t.OutboundVia, t.Honkawagoe, t.InboundVia} {
		for _, note := range []string{stop.Arrival.Note, stop.Depart.Note} {
			if text := noteText(note); text != "" {
				parts = append(parts, stop.Name+"は"+text)
			}
		}
	}
	if text := noteText(t.SchoolAfter.Note); text != "" {
		parts = append(parts, text)
	}
	return strings.Join(parts, " / ")
}

// noteText は表の短い注記を、読んで分かる言葉にします。
func noteText(note string) string {
	switch note {
	case "どちらか":
		return "どちらか一方のみ運行"
	case "本川越優先":
		return "本川越優先"
	case "予備":
		return "予備"
	case "終":
		return "この駅で終了、学校へは戻りません"
	case afterPartyMark:
		return "後夜祭（花火）終了後、順次発車"
	case "回送", "団体専用", "|", "^", "<":
		return ""
	}
	return note
}

// templates は1列を、アプリの元ダイヤへ直します。
// 駅が1つの便は学校との往復1件です。経由のある便は乗り降りする駅ごとに
// 片道の便へ分けます。例 学校 → 本川越 → 南古谷 → 学校 は
// 「学校 → 本川越」「本川越 → 学校」「南古谷 → 学校」の3件になります。
// 乗車人数を駅ごとに数えるためです。
func (t columnTrip) templates(nextColumn func() int) []Template {
	destination := t.destination()
	if destination.empty() {
		return nil
	}
	outboundVia := !t.OutboundVia.empty() && t.OutboundVia != destination
	inboundVia := !t.InboundVia.empty() && t.InboundVia != destination
	list := make([]Template, 0, 5)
	add := func(item Template, ok bool) {
		if !ok {
			return
		}
		item.ColumnNo = nextColumn()
		list = append(list, item)
	}
	// 学校発が無い一回りは、車庫から駅へ向かう回送を1便として登録します。
	add(t.garageLegTemplate(t.firstStation()))
	if !outboundVia && !inboundVia {
		add(t.roundTemplate(destination), true)
		return list
	}
	if outboundVia {
		add(t.outboundLegTemplate(t.OutboundVia, destination))
	}
	add(t.outboundLegTemplate(destination, destination))
	add(t.inboundLegTemplate(destination, destination))
	if inboundVia {
		add(t.inboundLegTemplate(t.InboundVia, destination))
	}
	return list
}

// roundTemplate は学校と目的の駅を往復する便です。
// 学校発が無ければ駅から学校へ向かう迎えの便、学校着が無ければ片道の便になります。
func (t columnTrip) roundTemplate(stop stationStop) Template {
	hasOutbound := t.SchoolDeparture.Clock != ""
	hasInbound := t.SchoolArrival.Clock != ""
	names := make([]string, 0, 3)
	if hasOutbound {
		names = append(names, schoolNode)
	}
	names = append(names, stop.Name)
	if hasInbound {
		names = append(names, schoolNode)
	}
	item := Template{
		Day: t.Day, OperationNo: t.Operation,
		Line:         t.lineName(),
		Route:        strings.Join(names, " → "),
		OutboundType: "none",
		InboundType:  "none",
	}
	if hasOutbound {
		item.OutboundType = t.outboundType()
		item.OutboundDeparture = t.SchoolDeparture.Clock
		item.OutboundArrival = stop.Arrival.Clock
	}
	if hasInbound {
		item.InboundType = t.inboundType()
		item.InboundDeparture = stop.Depart.Clock
		item.InboundArrival = t.SchoolArrival.Clock
	}
	item.PlannedDeparture = firstClock(t.SchoolDeparture.Clock, stop.Depart.Clock, t.GarageDepart.Clock)
	item.PlannedArrival = firstClock(t.SchoolArrival.Clock, stop.Arrival.Clock)
	item.Details = t.notes()
	return item
}

// garageLegTemplate は車庫から駅へ向かう回送の便です。
// 学校発が無い一回り（駅へ迎えに行く便）だけ作ります。車庫の区間は全て回送です。
func (t columnTrip) garageLegTemplate(stop stationStop) (Template, bool) {
	if t.SchoolDeparture.Clock != "" || t.GarageDepart.Clock == "" || stop.Arrival.Clock == "" {
		return Template{}, false
	}
	item := Template{
		Day: t.Day, OperationNo: t.Operation,
		Line:              t.lineName(),
		Route:             garageNode + " → " + stop.Name,
		OutboundType:      "deadhead",
		InboundType:       "none",
		OutboundDeparture: t.GarageDepart.Clock,
		OutboundArrival:   stop.Arrival.Clock,
		PlannedDeparture:  t.GarageDepart.Clock,
		PlannedArrival:    stop.Arrival.Clock,
	}
	item.Details = t.notes("車庫から" + stop.Name + "へ回送")
	return item, true
}

// outboundLegTemplate は学校から駅へ向かう片道の便です。
// 経由の駅へ向かう分と、終点へ向かう分を、それぞれ1件にします。
func (t columnTrip) outboundLegTemplate(stop stationStop, destination stationStop) (Template, bool) {
	if t.SchoolDeparture.Clock == "" || stop.Arrival.Clock == "" {
		return Template{}, false
	}
	item := Template{
		Day: t.Day, OperationNo: t.Operation,
		Line:              t.lineName(),
		Route:             schoolNode + " → " + t.viaLabel(t.OutboundVia, destination, stop) + stop.Name,
		OutboundType:      t.outboundType(),
		InboundType:       "none",
		OutboundDeparture: t.SchoolDeparture.Clock,
		OutboundArrival:   stop.Arrival.Clock,
		PlannedDeparture:  t.SchoolDeparture.Clock,
		PlannedArrival:    stop.Arrival.Clock,
	}
	if stop == destination {
		item.Details = t.notes(t.viaNote(t.OutboundVia, destination))
	} else {
		item.Details = t.notes(destination.Name + "行きと同じ車両の" + stop.Name + "区間")
	}
	return item, true
}

// inboundLegTemplate は駅から学校へ向かう片道の便です。
// 終点から乗る分と、復路の途中から乗る分を、それぞれ1件にします。
func (t columnTrip) inboundLegTemplate(stop stationStop, destination stationStop) (Template, bool) {
	if stop.Depart.Clock == "" || t.SchoolArrival.Clock == "" {
		return Template{}, false
	}
	item := Template{
		Day: t.Day, OperationNo: t.Operation,
		Line:             t.lineName(),
		Route:            stop.Name + " → " + t.viaLabel(t.InboundVia, destination, stop) + schoolNode,
		OutboundType:     "none",
		InboundType:      t.inboundType(),
		InboundDeparture: stop.Depart.Clock,
		InboundArrival:   t.SchoolArrival.Clock,
		PlannedDeparture: stop.Depart.Clock,
		PlannedArrival:   t.SchoolArrival.Clock,
	}
	if stop == destination {
		item.Details = t.notes(t.viaNote(t.InboundVia, destination))
	} else {
		item.Details = t.notes(destination.Name + "発と同じ車両の" + stop.Name + "区間")
	}
	return item, true
}

// viaLabel は終点までの便の経路へ入れる「（南古谷経由）→ 」です。
// 通るだけの駅は乗り降りの相手ではないので、括弧に入れて停まる駅と区別します。
// 経由の駅で乗り降りする分は、別の便として登録しています。
func (t columnTrip) viaLabel(via stationStop, destination stationStop, stop stationStop) string {
	if stop != destination || t.viaNote(via, destination) == "" {
		return ""
	}
	return "（" + t.viaNote(via, destination) + "）→ "
}

// viaNote は「南古谷経由」のように、通る駅を表す文です。
func (t columnTrip) viaNote(via stationStop, destination stationStop) string {
	if via.empty() || via == destination {
		return ""
	}
	return via.Name + "経由"
}

func firstClock(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// parseNewSheet は新しい形式のシート1枚を元ダイヤへ直します。
func parseNewSheet(rows [][]string, day string, operation int) []Template {
	vehicle := valueAt(rows, 0, 1)
	width := 1
	for _, row := range rows {
		if len(row) > width {
			width = len(row)
		}
	}
	column := 0
	next := func() int { column++; return column }
	templates := make([]Template, 0, 8)
	for col := 1; col < width; col++ {
		trip, ok := readColumnTrip(rows, col, day, operation, vehicle)
		if !ok {
			continue
		}
		templates = append(templates, trip.templates(next)...)
	}
	return templates
}

// ---------- Excelの読み取り ----------

type sharedStringsXML struct {
	Items []struct {
		Texts    []string `xml:"t"`
		RunTexts []string `xml:"r>t"`
	} `xml:"si"`
}

// sharedStrings は共有文字列表を読み取ります。無いブックもあります。
func sharedStrings(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	var parsed sharedStringsXML
	if err := xml.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	list := make([]string, 0, len(parsed.Items))
	for _, item := range parsed.Items {
		list = append(list, strings.Join(append(append([]string{}, item.Texts...), item.RunTexts...), ""))
	}
	return list
}

// sheetRows はシートを行と列の表へ直します。行は1行目から maxRow 行目までです。
// 共有文字列（type が s の枠）は文字へ戻します。
func sheetRows(data []byte, shared []string, maxRow int) ([][]string, error) {
	var ws worksheetXML
	if err := xml.Unmarshal(data, &ws); err != nil {
		return nil, err
	}
	rows := make([][]string, maxRow)
	for index := range rows {
		rows[index] = make([]string, 1)
	}
	for _, row := range ws.Rows {
		if row.Number < 1 || row.Number > maxRow {
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
			switch cell.Type {
			case "inlineStr":
				value = cell.Inline.Text
			case "s":
				if index, err := strconv.Atoi(strings.TrimSpace(cell.Value)); err == nil && index >= 0 && index < len(shared) {
					value = shared[index]
				}
			}
			rows[row.Number-1][col] = strings.TrimSpace(value)
		}
	}
	return rows, nil
}
