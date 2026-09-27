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
// 経由便は乗車人数を分けて数えるため、駅ごとに別の便として登録します。
// 例 学校 → 本川越 → 南古谷 → 学校 は「学校 → 本川越 → 学校」と
// 「南古谷 → 学校」の2便にします。車庫の出入りは回送なので、
// 便は学校を起点にしたまま、時刻は詳細情報へ残します。

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
	parts = append(parts, extra...)
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
		return "後夜祭終了後、順次発車"
	case "回送", "団体専用", "|", "^", "<":
		return ""
	}
	return note
}

// templates は1列を、アプリの元ダイヤへ直します。
// 経由の駅は乗車人数を分けて数えるため、別の便として登録します。
func (t columnTrip) templates(nextColumn func() int) []Template {
	destination := t.destination()
	if destination.empty() {
		return nil
	}
	list := make([]Template, 0, 3)
	list = append(list, t.roundTemplate(destination, nextColumn()))
	// 往路の途中で降りる駅は「学校 → 駅」の片道便にします。
	if !t.OutboundVia.empty() && t.OutboundVia != destination {
		if item, ok := t.outboundLegTemplate(t.OutboundVia, destination, nextColumn()); ok {
			list = append(list, item)
		}
	}
	// 復路の途中で乗る駅は「駅 → 学校」の片道便にします。
	if !t.InboundVia.empty() && t.InboundVia != destination {
		if item, ok := t.inboundLegTemplate(t.InboundVia, destination, nextColumn()); ok {
			list = append(list, item)
		}
	}
	return list
}

// roundTemplate は学校と目的の駅を往復する便です。
// 学校発が無ければ駅から学校へ向かう迎えの便、学校着が無ければ片道の便になります。
func (t columnTrip) roundTemplate(stop stationStop, column int) Template {
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
		Day: t.Day, OperationNo: t.Operation, ColumnNo: column,
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
	extra := make([]string, 0, 1)
	if !hasOutbound && t.GarageDepart.Clock != "" {
		extra = append(extra, "車庫から"+stop.Name+"へ回送")
	}
	item.Details = t.notes(extra...)
	return item
}

// outboundLegTemplate は往路の途中で降りる駅の便です。復路はありません。
func (t columnTrip) outboundLegTemplate(stop stationStop, destination stationStop, column int) (Template, bool) {
	if t.SchoolDeparture.Clock == "" || stop.Arrival.Clock == "" {
		return Template{}, false
	}
	item := Template{
		Day: t.Day, OperationNo: t.Operation, ColumnNo: column,
		Line:              t.lineName(),
		Route:             schoolNode + " → " + stop.Name,
		OutboundType:      t.outboundType(),
		InboundType:       "none",
		OutboundDeparture: t.SchoolDeparture.Clock,
		OutboundArrival:   stop.Arrival.Clock,
		PlannedDeparture:  t.SchoolDeparture.Clock,
		PlannedArrival:    stop.Arrival.Clock,
	}
	item.Details = t.notes(destination.Name + "行きと同じ車両の" + stop.Name + "区間")
	return item, true
}

// inboundLegTemplate は復路の途中から乗る駅の便です。往路はありません。
func (t columnTrip) inboundLegTemplate(stop stationStop, destination stationStop, column int) (Template, bool) {
	if stop.Depart.Clock == "" || t.SchoolArrival.Clock == "" {
		return Template{}, false
	}
	item := Template{
		Day: t.Day, OperationNo: t.Operation, ColumnNo: column,
		Line:             t.lineName(),
		Route:            stop.Name + " → " + schoolNode,
		OutboundType:     "none",
		InboundType:      t.inboundType(),
		InboundDeparture: stop.Depart.Clock,
		InboundArrival:   t.SchoolArrival.Clock,
		PlannedDeparture: stop.Depart.Clock,
		PlannedArrival:   t.SchoolArrival.Clock,
	}
	item.Details = t.notes(destination.Name + "発と同じ車両の" + stop.Name + "区間")
	return item, true
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
