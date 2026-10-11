package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The watcher is the dev loop's only always-on part, and it spends no model
// tokens. It long-polls the dev-loop bot's updates, records group messages and
// button presses in the inbox, hands presses to the bot's MCP server through
// the callback queue, and wakes the «Dovira Task Coordinator» routine with the
// ids of new human messages. It does not read their content to decide
// anything and never writes to the group: what to do is the coordinator's call.

const (
	defaultDebounce    = 20 * time.Second
	defaultMinInterval = 120 * time.Second

	retryBase = 15 * time.Second
	retryMax  = 5 * time.Minute

	alertAfterFailures = 3
	alertAfterOffline  = 10 * time.Minute
	alertEvery         = time.Hour
)

type WatchConfig struct {
	BotToken      string
	APIBase       string
	ChatIDs       map[int64]bool
	RoutineID     string
	RoutineToken  string
	RoutineAPI    string
	CallbackQueue string
	AlertBotToken string
	AlertChatID   string
	Debounce      time.Duration
	MinInterval   time.Duration
	MaxFiresHour  int
	PollTimeout   time.Duration
}

// LoadWatchConfig reads the watcher env. The WATCH_* / ROUTINE_* names win;
// the older DEVLOOP_* / TELEGRAM_BOT_TOKEN names still work. A missing
// required variable is reported by name, all of them at once.
func LoadWatchConfig() (*WatchConfig, error) {
	wc := &WatchConfig{
		BotToken:      firstEnv("WATCH_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"),
		APIBase:       strings.TrimRight(envOr("TELEGRAM_API_BASE", "https://api.telegram.org"), "/"),
		ChatIDs:       map[int64]bool{},
		RoutineID:     firstEnv("ROUTINE_ID", "DEVLOOP_ROUTINE_ID"),
		RoutineToken:  firstEnv("ROUTINE_TOKEN", "DEVLOOP_ROUTINE_TOKEN"),
		RoutineAPI:    strings.TrimRight(firstEnv("ROUTINE_API_BASE", "DEVLOOP_ROUTINE_API"), "/"),
		CallbackQueue: strings.TrimSpace(os.Getenv("TELEGRAM_CALLBACK_QUEUE_FILE")),
		AlertBotToken: strings.TrimSpace(os.Getenv("WATCH_ALERT_BOT_TOKEN")),
		AlertChatID:   strings.TrimSpace(os.Getenv("WATCH_ALERT_CHAT_ID")),
		MaxFiresHour:  envInt("DEVLOOP_MAX_FIRES_PER_HOUR", 30),
		PollTimeout:   envDuration("DEVLOOP_POLL_TIMEOUT", 50*time.Second),
	}
	if wc.RoutineAPI == "" {
		wc.RoutineAPI = "https://api.anthropic.com"
	}
	var err error
	if wc.Debounce, err = envSeconds("WATCH_DEBOUNCE_SECONDS", "DEVLOOP_DEBOUNCE", defaultDebounce); err != nil {
		return nil, err
	}
	if wc.MinInterval, err = envSeconds("WATCH_MIN_INTERVAL_SECONDS", "", defaultMinInterval); err != nil {
		return nil, err
	}
	chats := firstEnv("WATCH_CHAT_ID", "DEVLOOP_CHAT_IDS")
	for _, raw := range strings.Split(chats, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("WATCH_CHAT_ID: %q is not a chat id", raw)
		}
		wc.ChatIDs[id] = true
	}

	var missing []string
	if wc.BotToken == "" {
		missing = append(missing, "WATCH_BOT_TOKEN")
	}
	if len(wc.ChatIDs) == 0 {
		missing = append(missing, "WATCH_CHAT_ID")
	}
	if wc.RoutineID == "" {
		missing = append(missing, "ROUTINE_ID")
	}
	if wc.RoutineToken == "" {
		missing = append(missing, "ROUTINE_TOKEN")
	}
	if len(missing) > 0 {
		return nil, &missingEnvError{names: missing}
	}
	return wc, nil
}

type missingEnvError struct{ names []string }

func (e *missingEnvError) Error() string {
	return "missing required environment: " + strings.Join(e.names, ", ")
}

type Watcher struct {
	cfg   *WatchConfig
	store *Store
	http  *http.Client
	fireC *http.Client
	now   func() time.Time

	// In-memory only: a restart clears them, which is the documented way to
	// retry after fixing the configuration.
	failures      int
	retryAt       time.Time
	configErr     string
	lastTelegram  time.Time
	telegramError string
}

func NewWatcher(cfg *WatchConfig, store *Store) *Watcher {
	w := &Watcher{
		cfg: cfg, store: store,
		http:  &http.Client{Timeout: cfg.PollTimeout + 20*time.Second},
		fireC: &http.Client{Timeout: 30 * time.Second},
		now:   time.Now,
	}
	w.lastTelegram = w.now()
	return w
}

func (w *Watcher) Run(ctx context.Context) error {
	st, err := w.store.State()
	if err != nil {
		return err
	}
	queue := w.cfg.CallbackQueue
	if queue == "" {
		queue = "(not set)"
	}
	log.Printf("devloop watcher: started chats=%v routine=%s debounce=%s min_interval=%s offset=%d fired_through=%d callback_queue=%s",
		keys(w.cfg.ChatIDs), w.cfg.RoutineID, w.cfg.Debounce, w.cfg.MinInterval, st.TGOffset, st.FiredThrough, queue)

	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	polled := make(chan error, 1)
	go func() {
		backoff := time.Second
		for ctx.Err() == nil {
			err := w.pollOnce(ctx)
			polled <- err
			if err == nil {
				backoff = time.Second
				continue
			}
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			backoff = min(backoff*2, time.Minute)
		}
	}()
	for {
		select {
		case <-ctx.Done():
			log.Print("devloop watcher: stopped")
			return nil
		case err := <-polled:
			if err != nil && ctx.Err() == nil {
				w.telegramError = redact(err.Error(), w.cfg.BotToken)
				log.Printf("devloop watcher: ERROR telegram: %s", w.telegramError)
			} else if err == nil {
				w.lastTelegram = w.now()
				w.telegramError = ""
			}
			w.maybeFire(ctx)
		case <-tick.C:
			w.maybeFire(ctx)
			w.checkHealth(ctx)
		}
	}
}

// --- Telegram ----------------------------------------------------------------

type tgUser struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

type tgFile struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	FileSize int64  `json:"file_size"`
}

type tgMessage struct {
	MessageID int64   `json:"message_id"`
	Date      int64   `json:"date"`
	From      *tgUser `json:"from"`
	Chat      struct {
		ID int64 `json:"id"`
	} `json:"chat"`
	Text     string     `json:"text"`
	Caption  string     `json:"caption"`
	ReplyTo  *tgMessage `json:"reply_to_message"`
	Photo    []tgFile   `json:"photo"`
	Document *tgFile    `json:"document"`
	Video    *tgFile    `json:"video"`
	Voice    *tgFile    `json:"voice"`
	Audio    *tgFile    `json:"audio"`
	Sticker  *tgFile    `json:"sticker"`
}

type tgUpdate struct {
	UpdateID      int64      `json:"update_id"`
	Message       *tgMessage `json:"message"`
	EditedMessage *tgMessage `json:"edited_message"`
	CallbackQuery *struct {
		ID      string     `json:"id"`
		From    tgUser     `json:"from"`
		Message *tgMessage `json:"message"`
		Data    string     `json:"data"`
	} `json:"callback_query"`
}

// serviceKeys mark a message as a service event (someone joined, the title
// changed, a message was pinned...) rather than something a person wrote.
var serviceKeys = []string{
	"new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo",
	"delete_chat_photo", "group_chat_created", "supergroup_chat_created",
	"channel_chat_created", "message_auto_delete_timer_changed",
	"migrate_to_chat_id", "migrate_from_chat_id", "pinned_message",
	"successful_payment", "refunded_payment", "users_shared", "chat_shared",
	"connected_website", "write_access_allowed", "proximity_alert_triggered",
	"boost_added", "chat_background_set", "forum_topic_created",
	"forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
	"general_forum_topic_hidden", "general_forum_topic_unhidden",
	"giveaway_created", "giveaway_completed", "video_chat_scheduled",
	"video_chat_started", "video_chat_ended", "video_chat_participants_invited",
	"gift", "unique_gift", "paid_message_price_changed",
	"checklist_tasks_done", "checklist_tasks_added", "direct_message_price_changed",
}

func (w *Watcher) pollOnce(ctx context.Context) error {
	st, err := w.store.State()
	if err != nil {
		return err
	}
	q := url.Values{}
	q.Set("timeout", strconv.Itoa(int(w.cfg.PollTimeout.Seconds())))
	q.Set("allowed_updates", `["message","edited_message","callback_query"]`)
	if st.TGOffset > 0 {
		q.Set("offset", strconv.FormatInt(st.TGOffset, 10))
	}
	var body struct {
		OK          bool              `json:"ok"`
		ErrorCode   int               `json:"error_code"`
		Result      []json.RawMessage `json:"result"`
		Description string            `json:"description"`
	}
	if err := w.botCall(ctx, w.cfg.BotToken, "getUpdates", q, &body); err != nil {
		return err
	}
	if !body.OK {
		if body.ErrorCode == http.StatusConflict {
			return fmt.Errorf("getUpdates: %s (another getUpdates reader or a webhook holds this bot; the watcher must be the only one)", body.Description)
		}
		return fmt.Errorf("getUpdates: %s", body.Description)
	}
	var events []Event
	offset := st.TGOffset
	for _, raw := range body.Result {
		var u tgUpdate
		if err := json.Unmarshal(raw, &u); err != nil {
			continue
		}
		if u.UpdateID+1 > offset {
			offset = u.UpdateID + 1
		}
		if ev, ok := w.handleUpdate(ctx, u, raw); ok {
			events = append(events, ev)
		}
	}
	if err := w.store.Append(events, offset); err != nil {
		return err
	}
	var woke []int64
	for _, e := range events {
		if e.Wakes() {
			woke = append(woke, e.MessageID)
		}
	}
	if len(woke) > 0 {
		now := w.now()
		_ = w.store.withLock(func(s *State) error {
			if s.PendingSince.IsZero() {
				s.PendingSince = now
			}
			return nil
		})
		log.Printf("devloop watcher: new messages ids=%s", joinIDs(woke))
	}
	return nil
}

func (w *Watcher) handleUpdate(ctx context.Context, u tgUpdate, raw json.RawMessage) (Event, bool) {
	switch {
	case u.CallbackQuery != nil:
		cq := u.CallbackQuery
		// Nobody else reads this bot's getUpdates: hand the press to the bot's
		// MCP server through its queue file, already answered.
		if err := w.queueCallback(raw); err != nil {
			log.Printf("devloop watcher: ERROR callback update_id=%d not queued: %v", u.UpdateID, err)
		}
		if err := w.botCall(ctx, w.cfg.BotToken, "answerCallbackQuery", url.Values{"callback_query_id": {cq.ID}}, nil); err != nil {
			log.Printf("devloop watcher: ERROR answerCallbackQuery: %v", err)
		}
		if cq.Message == nil || !w.cfg.ChatIDs[cq.Message.Chat.ID] {
			return Event{}, false
		}
		return Event{
			Kind: "callback", ChatID: cq.Message.Chat.ID, MessageID: cq.Message.MessageID,
			Date: w.now().UTC(), FromID: cq.From.ID, FromName: displayName(cq.From),
			CallbackData: cq.Data, Text: cq.Message.Text,
		}, true
	case u.Message != nil:
		return w.messageEvent("message", u.Message, isService(raw, "message"))
	case u.EditedMessage != nil:
		return w.messageEvent("edited", u.EditedMessage, isService(raw, "edited_message"))
	}
	return Event{}, false
}

// isService reports whether the update's message is a service event.
func isService(update json.RawMessage, field string) bool {
	var outer map[string]json.RawMessage
	if json.Unmarshal(update, &outer) != nil {
		return false
	}
	var msg map[string]json.RawMessage
	if json.Unmarshal(outer[field], &msg) != nil {
		return false
	}
	for _, key := range serviceKeys {
		if _, ok := msg[key]; ok {
			return true
		}
	}
	return false
}

func (w *Watcher) messageEvent(kind string, m *tgMessage, service bool) (Event, bool) {
	if !w.cfg.ChatIDs[m.Chat.ID] || service {
		return Event{}, false
	}
	ev := Event{
		Kind: kind, ChatID: m.Chat.ID, MessageID: m.MessageID,
		Date: time.Unix(m.Date, 0).UTC(), Text: m.Text,
	}
	if m.From != nil {
		ev.FromID, ev.FromName, ev.FromBot = m.From.ID, displayName(*m.From), m.From.IsBot
	} else {
		// No sender (a channel post or an anonymous admin): not a person we
		// can tell apart from a bot, so it never wakes the routine.
		ev.FromBot = true
	}
	if ev.Text == "" {
		ev.Text = m.Caption
	}
	if m.ReplyTo != nil {
		ev.ReplyTo = m.ReplyTo.MessageID
	}
	if n := len(m.Photo); n > 0 {
		p := m.Photo[n-1] // largest size
		ev.Files = append(ev.Files, FileRef{Kind: "photo", FileID: p.FileID, MimeType: "image/jpeg", Size: p.FileSize,
			FileName: fmt.Sprintf("photo_%d.jpg", m.MessageID)})
	}
	for kind, f := range map[string]*tgFile{"document": m.Document, "video": m.Video, "voice": m.Voice, "audio": m.Audio, "sticker": m.Sticker} {
		if f != nil {
			ev.Files = append(ev.Files, FileRef{Kind: kind, FileID: f.FileID, FileName: f.FileName, MimeType: f.MimeType, Size: f.FileSize})
		}
	}
	return ev, true
}

// queueCallback appends the press in the shape better-telegram-mcp's bot
// backend reads from TELEGRAM_CALLBACK_QUEUE_FILE: the Bot API update plus
// "answered": true.
func (w *Watcher) queueCallback(raw json.RawMessage) error {
	if w.cfg.CallbackQueue == "" {
		return nil
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return err
	}
	obj["answered"] = true
	line, _ := json.Marshal(obj)
	if err := os.MkdirAll(filepath.Dir(w.cfg.CallbackQueue), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(w.cfg.CallbackQueue, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func (w *Watcher) botCall(ctx context.Context, token, method string, q url.Values, out any) error {
	endpoint := fmt.Sprintf("%s/bot%s/%s", w.cfg.APIBase, token, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(q.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := w.http.Do(req)
	if err != nil {
		// The URL carries the token: never let it into a log line.
		return fmt.Errorf("telegram %s: %s", method, redact(redact(err.Error(), w.cfg.BotToken), w.cfg.AlertBotToken))
	}
	defer resp.Body.Close()
	if out == nil {
		var ack struct {
			OK          bool   `json:"ok"`
			Description string `json:"description"`
		}
		if json.NewDecoder(resp.Body).Decode(&ack) == nil && !ack.OK {
			return fmt.Errorf("telegram %s: %s", method, ack.Description)
		}
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// --- firing the routine ------------------------------------------------------

type fireDecision struct {
	Fire    bool
	Reason  string
	At      time.Time // when it may fire, if not now
	IDs     map[int64][]int64
	Through int64
}

// decide is pure, so the timing rules are unit-tested without a clock. It
// fires once the debounce has run since the first pending message, the
// minimum interval since the last successful fire, and any retry delay.
func decide(st State, events []Event, now time.Time, cfg *WatchConfig, retryAt time.Time) fireDecision {
	ids := map[int64][]int64{}
	var through int64
	for _, e := range events {
		if e.Seq <= st.FiredThrough {
			continue
		}
		through = e.Seq
		if e.Wakes() {
			ids[e.ChatID] = appendUnique(ids[e.ChatID], e.MessageID)
		}
	}
	if len(ids) == 0 {
		return fireDecision{Reason: "nothing new", Through: through}
	}
	at := st.PendingSince.Add(cfg.Debounce)
	if st.PendingSince.IsZero() {
		at = now
	}
	if n := len(st.Fires); n > 0 {
		if next := st.Fires[n-1].Add(cfg.MinInterval); next.After(at) {
			at = next
		}
	}
	if retryAt.After(at) {
		at = retryAt
	}
	recent := 0
	for _, t := range st.Fires {
		if now.Sub(t) < time.Hour {
			recent++
		}
	}
	if recent >= cfg.MaxFiresHour {
		return fireDecision{Reason: "hourly fire budget spent", At: st.Fires[len(st.Fires)-recent].Add(time.Hour)}
	}
	if now.Before(at) {
		return fireDecision{Reason: "waiting", At: at}
	}
	return fireDecision{Fire: true, Reason: "new messages", IDs: ids, Through: through}
}

func appendUnique(list []int64, id int64) []int64 {
	for _, have := range list {
		if have == id {
			return list
		}
	}
	return append(list, id)
}

func (w *Watcher) maybeFire(ctx context.Context) {
	if w.configErr != "" {
		return
	}
	st, err := w.store.State()
	if err != nil {
		log.Printf("devloop watcher: ERROR state: %v", err)
		return
	}
	events, err := w.store.Events(st.FiredThrough, 0)
	if err != nil {
		log.Printf("devloop watcher: ERROR inbox: %v", err)
		return
	}
	d := decide(st, events, w.now(), w.cfg, w.retryAt)
	if !d.Fire {
		return
	}
	text := wakeText(d.IDs)
	res := w.fire(ctx, text)
	now := w.now()
	switch res.outcome {
	case fireOK:
		_ = w.store.withLock(func(s *State) error {
			s.Fires = append(s.Fires, now)
			if len(s.Fires) > 100 {
				s.Fires = s.Fires[len(s.Fires)-100:]
			}
			if d.Through > s.FiredThrough {
				s.FiredThrough = d.Through
			}
			s.PendingSince = time.Time{}
			s.LastFireErr = ""
			s.LastSession = res.sessionURL
			return nil
		})
		w.failures, w.retryAt = 0, time.Time{}
		log.Printf("devloop watcher: fired %q session=%s", text, res.sessionURL)
	case fireRetry:
		w.failures++
		delay := res.retryAfter
		if delay == 0 {
			delay = backoff(w.failures)
		}
		w.retryAt = now.Add(delay)
		w.recordFireErr(res.detail)
		log.Printf("devloop watcher: ERROR fire failed (%s); retry in %s, ids kept", res.detail, delay)
	case fireConfig:
		w.failures++
		w.configErr = res.detail
		w.recordFireErr(res.detail)
		log.Printf("devloop watcher: ERROR CONFIG fire rejected (%s). Not retrying until restart: check ROUTINE_ID and ROUTINE_TOKEN; ids kept", res.detail)
	}
}

func (w *Watcher) recordFireErr(detail string) {
	_ = w.store.withLock(func(s *State) error { s.LastFireErr = detail; return nil })
}

// wakeText is the one line per chat the coordinator receives: ids only, the
// coordinator reads the messages itself.
func wakeText(ids map[int64][]int64) string {
	chats := make([]int64, 0, len(ids))
	for chat := range ids {
		chats = append(chats, chat)
	}
	sort.Slice(chats, func(i, j int) bool { return chats[i] < chats[j] })
	var lines []string
	for _, chat := range chats {
		list := append([]int64(nil), ids[chat]...)
		sort.Slice(list, func(i, j int) bool { return list[i] < list[j] })
		lines = append(lines, fmt.Sprintf("DEVLOOP-WAKE chat=%d ids=%s (last=%d)", chat, joinIDs(list), list[len(list)-1]))
	}
	return strings.Join(lines, "\n")
}

type fireOutcome int

const (
	fireOK     fireOutcome = iota // 200: counted, never repeated
	fireRetry                     // no answer at all, 429 or 5xx
	fireConfig                    // 4xx: configuration, not repeated until restart
)

type fireResult struct {
	outcome    fireOutcome
	retryAfter time.Duration
	sessionURL string
	detail     string
}

// fire posts to the routine. The API has no idempotency key, so only a
// missing answer, 429 and 5xx are retried.
func (w *Watcher) fire(ctx context.Context, text string) fireResult {
	payload, _ := json.Marshal(map[string]string{"text": text})
	endpoint := fmt.Sprintf("%s/v1/claude_code/routines/%s/fire", w.cfg.RoutineAPI, url.PathEscape(w.cfg.RoutineID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return fireResult{outcome: fireConfig, detail: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+w.cfg.RoutineToken)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("anthropic-beta", "experimental-cc-routine-2026-04-01")
	req.Header.Set("Content-Type", "application/json")
	resp, err := w.fireC.Do(req)
	if err != nil {
		return fireResult{outcome: fireRetry, detail: "no response: " + redact(err.Error(), w.cfg.RoutineToken)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	detail := fmt.Sprintf("HTTP %d: %s", resp.StatusCode, oneLine(body))
	switch {
	case resp.StatusCode == http.StatusOK:
		var out struct {
			SessionURL string `json:"claude_code_session_url"`
		}
		_ = json.Unmarshal(body, &out)
		return fireResult{outcome: fireOK, sessionURL: out.SessionURL}
	case resp.StatusCode == http.StatusTooManyRequests:
		return fireResult{outcome: fireRetry, retryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), w.now()), detail: detail}
	case resp.StatusCode >= 500:
		return fireResult{outcome: fireRetry, detail: detail}
	default:
		return fireResult{outcome: fireConfig, detail: detail}
	}
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if secs, err := strconv.Atoi(value); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at.Sub(now)
	}
	return 0
}

func backoff(failures int) time.Duration {
	delay := retryBase
	for i := 1; i < failures && delay < retryMax; i++ {
		delay *= 2
	}
	return min(delay, retryMax)
}

// --- health ------------------------------------------------------------------

func (w *Watcher) healthProblem(now time.Time) string {
	var problems []string
	if w.configErr != "" {
		problems = append(problems, "рутина отклонила запуск как ошибку конфигурации ("+w.configErr+")")
	} else if w.failures >= alertAfterFailures {
		problems = append(problems, fmt.Sprintf("%d запусков рутины подряд не удались", w.failures))
	}
	if offline := now.Sub(w.lastTelegram); offline > alertAfterOffline {
		text := fmt.Sprintf("нет связи с Telegram %s", offline.Round(time.Minute))
		if w.telegramError != "" {
			text += " (" + w.telegramError + ")"
		}
		problems = append(problems, text)
	}
	return strings.Join(problems, "; ")
}

// checkHealth sends David one direct message per hour at most while something
// is wrong. It never writes to the watched group.
func (w *Watcher) checkHealth(ctx context.Context) {
	now := w.now()
	problem := w.healthProblem(now)
	if problem == "" {
		return
	}
	send := false
	_ = w.store.withLock(func(s *State) error {
		if now.Sub(s.LastAlertAt) >= alertEvery {
			s.LastAlertAt, send = now, true
		}
		return nil
	})
	if !send {
		return
	}
	text := "⚠️ Сторож группы AI Bridge Dovira: " + problem + "."
	if w.cfg.AlertBotToken == "" || w.cfg.AlertChatID == "" {
		log.Printf("devloop watcher: ALERT (WATCH_ALERT_BOT_TOKEN/WATCH_ALERT_CHAT_ID not set, log only): %s", text)
		return
	}
	if err := w.botCall(ctx, w.cfg.AlertBotToken, "sendMessage", url.Values{"chat_id": {w.cfg.AlertChatID}, "text": {text}}, nil); err != nil {
		log.Printf("devloop watcher: ERROR alert not delivered: %v", err)
		return
	}
	log.Printf("devloop watcher: ALERT sent: %s", text)
}

// --- helpers -----------------------------------------------------------------

func displayName(u tgUser) string {
	name := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if u.Username != "" {
		name += " @" + u.Username
	}
	return strings.TrimSpace(name)
}

func redact(s, secret string) string {
	if secret == "" {
		return s
	}
	return strings.ReplaceAll(s, secret, "<token>")
}

func oneLine(raw []byte) string {
	text := strings.Join(strings.Fields(string(raw)), " ")
	if len(text) > 300 {
		text = text[:300] + "…"
	}
	return text
}

func joinIDs(ids []int64) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	return strings.Join(parts, ",")
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v
		}
	}
	return ""
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

// envSeconds reads a number of seconds from name, or a Go duration from the
// legacy name.
func envSeconds(name, legacy string, fallback time.Duration) (time.Duration, error) {
	if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
		secs, err := strconv.ParseFloat(raw, 64)
		if err != nil || secs < 0 {
			return 0, fmt.Errorf("%s: %q is not a number of seconds", name, raw)
		}
		return time.Duration(secs * float64(time.Second)), nil
	}
	if legacy != "" {
		return envDuration(legacy, fallback), nil
	}
	return fallback, nil
}

func envDuration(name string, fallback time.Duration) time.Duration {
	if d, err := time.ParseDuration(strings.TrimSpace(os.Getenv(name))); err == nil && d > 0 {
		return d
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && n > 0 {
		return n
	}
	return fallback
}

func keys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
