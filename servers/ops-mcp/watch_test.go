package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	chat     = int64(-1003928414397)
	botTok   = "111:devloop-secret"
	alertTok = "222:alert-secret"
	routeTok = "sk-ant-oat01-secret"
)

// stub is Telegram and the routine API in one server.
type stub struct {
	mu       sync.Mutex
	batches  [][]string
	statuses []int
	calls    map[string][]formVals
	fires    []string
}

type formVals = map[string]string

func newStub(t *testing.T, statuses ...int) (*stub, *httptest.Server) {
	s := &stub{statuses: statuses, calls: map[string][]formVals{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/fire") {
			if r.Header.Get("Authorization") != "Bearer "+routeTok || r.Header.Get("anthropic-version") != "2023-06-01" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.fires = append(s.fires, body["text"])
			status := http.StatusOK
			if len(s.statuses) > 0 {
				status, s.statuses = s.statuses[0], s.statuses[1:]
			}
			if status == http.StatusTooManyRequests {
				w.Header().Set("Retry-After", "7")
			}
			w.WriteHeader(status)
			if status == http.StatusOK {
				fmt.Fprintf(w, `{"type":"routine_fire","claude_code_session_id":"session_%d","claude_code_session_url":"https://claude.ai/code/session_%d"}`, len(s.fires), len(s.fires))
			}
			return
		}
		_ = r.ParseForm()
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		form := formVals{"path": r.URL.Path}
		for k := range r.Form {
			form[k] = r.Form.Get(k)
		}
		s.calls[method] = append(s.calls[method], form)
		if method == "getUpdates" {
			var batch []string
			if len(s.batches) > 0 {
				batch, s.batches = s.batches[0], s.batches[1:]
			}
			fmt.Fprintf(w, `{"ok":true,"result":[%s]}`, strings.Join(batch, ","))
			return
		}
		_, _ = io.WriteString(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(srv.Close)
	return s, srv
}

func (s *stub) push(updates ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.batches = append(s.batches, updates)
}

func (s *stub) fired() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.fires...)
}

func (s *stub) callsOf(method string) []formVals {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]formVals(nil), s.calls[method]...)
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func setup(t *testing.T, statuses ...int) (*Watcher, *stub, *clock, *bytes.Buffer) {
	t.Helper()
	s, srv := newStub(t, statuses...)
	dir := t.TempDir()
	cfg := &WatchConfig{
		BotToken: botTok, APIBase: srv.URL, ChatIDs: map[int64]bool{chat: true},
		RoutineID: "trig_test", RoutineToken: routeTok, RoutineAPI: srv.URL,
		CallbackQueue: filepath.Join(dir, "devloop-bot", "callbacks.jsonl"),
		AlertBotToken: alertTok, AlertChatID: "375465077",
		Debounce: 20 * time.Second, MinInterval: 120 * time.Second, MaxFiresHour: 30,
		PollTimeout: time.Second,
	}
	w, c := restart(t, cfg, dir, &clock{t: time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)})
	logs := &bytes.Buffer{}
	log.SetOutput(logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return w, s, c, logs
}

// restart builds a new watcher over the same data dir: a process restart.
func restart(t *testing.T, cfg *WatchConfig, dir string, c *clock) (*Watcher, *clock) {
	t.Helper()
	store, err := NewStore(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	w := NewWatcher(cfg, store)
	w.now = c.now
	w.lastTelegram = c.now()
	return w, c
}

func human(update, id int) string {
	return fmt.Sprintf(`{"update_id":%d,"message":{"message_id":%d,"date":1760000000,"chat":{"id":%d},"from":{"id":375465077,"is_bot":false,"first_name":"David"},"text":"hi"}}`, update, id, chat)
}

func poll(t *testing.T, w *Watcher, s *stub, updates ...string) {
	t.Helper()
	s.push(updates...)
	if err := w.pollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFilterChatBotsAndServiceEvents(t *testing.T) {
	w, s, c, _ := setup(t)
	poll(t, w, s,
		fmt.Sprintf(`{"update_id":1,"message":{"message_id":700,"chat":{"id":%d},"from":{"id":9,"is_bot":true},"text":"bot"}}`, chat),
		`{"update_id":2,"message":{"message_id":5,"chat":{"id":-100777},"from":{"id":1,"is_bot":false},"text":"other chat"}}`,
		fmt.Sprintf(`{"update_id":3,"message":{"message_id":701,"chat":{"id":%d},"from":{"id":1,"is_bot":false},"new_chat_members":[{"id":2}]}}`, chat),
		fmt.Sprintf(`{"update_id":4,"message":{"message_id":702,"chat":{"id":%d},"text":"no sender"}}`, chat),
	)
	c.advance(time.Hour)
	w.maybeFire(context.Background())
	if f := s.fired(); len(f) != 0 {
		t.Fatalf("no fire expected, got %q", f)
	}
	st, _ := w.store.State()
	if st.TGOffset != 5 {
		t.Fatalf("offset must pass skipped updates: %d", st.TGOffset)
	}

	poll(t, w, s, fmt.Sprintf(`{"update_id":5,"edited_message":{"message_id":650,"chat":{"id":%d},"from":{"id":1,"is_bot":false},"text":"fixed"}}`, chat))
	c.advance(time.Minute)
	w.maybeFire(context.Background())
	if f := s.fired(); len(f) != 1 || f[0] != "DEVLOOP-WAKE chat=-1003928414397 ids=650 (last=650)" {
		t.Fatalf("an edit by a person wakes the routine: %q", f)
	}
}

func TestBurstGoesInOneFireAfterDebounce(t *testing.T) {
	w, s, c, logs := setup(t)
	ctx := context.Background()
	poll(t, w, s, human(10, 672))
	c.advance(5 * time.Second)
	poll(t, w, s, human(11, 673), human(12, 675))
	c.advance(14 * time.Second)
	w.maybeFire(ctx)
	if len(s.fired()) != 0 {
		t.Fatal("fired inside the debounce")
	}
	c.advance(time.Second)
	w.maybeFire(ctx)
	w.maybeFire(ctx)
	f := s.fired()
	if len(f) != 1 || f[0] != "DEVLOOP-WAKE chat=-1003928414397 ids=672,673,675 (last=675)" {
		t.Fatalf("fires %q", f)
	}
	if !strings.Contains(logs.String(), "session=https://claude.ai/code/session_1") {
		t.Fatalf("session url not logged:\n%s", logs)
	}
}

func TestMinimumIntervalHoldsAndKeepsIDs(t *testing.T) {
	w, s, c, _ := setup(t)
	ctx := context.Background()
	poll(t, w, s, human(1, 10))
	c.advance(20 * time.Second)
	w.maybeFire(ctx)
	c.advance(10 * time.Second)
	poll(t, w, s, human(2, 11))
	c.advance(60 * time.Second)
	poll(t, w, s, human(3, 12))
	w.maybeFire(ctx)
	if n := len(s.fired()); n != 1 {
		t.Fatalf("fired inside the minimum interval (%d)", n)
	}
	c.advance(50 * time.Second) // 120 s after the first fire
	w.maybeFire(ctx)
	if f := s.fired(); len(f) != 2 || !strings.Contains(f[1], "ids=11,12 (last=12)") {
		t.Fatalf("held ids must go together: %q", f)
	}
}

func TestFire429RetriesAfterRetryAfter(t *testing.T) {
	w, s, c, _ := setup(t, http.StatusTooManyRequests, http.StatusOK)
	ctx := context.Background()
	poll(t, w, s, human(1, 1))
	c.advance(20 * time.Second)
	w.maybeFire(ctx)
	c.advance(6 * time.Second)
	w.maybeFire(ctx)
	if n := len(s.fired()); n != 1 {
		t.Fatalf("retried before Retry-After (%d)", n)
	}
	c.advance(time.Second)
	w.maybeFire(ctx)
	if f := s.fired(); len(f) != 2 || !strings.Contains(f[1], "ids=1 ") {
		t.Fatalf("ids lost on 429: %q", f)
	}
	st, _ := w.store.State()
	if st.FiredThrough != 1 || len(st.Fires) != 1 {
		t.Fatalf("only the 200 counts: %+v", st)
	}
}

func TestFire5xxBacksOffToFiveMinutes(t *testing.T) {
	w, s, c, _ := setup(t, 503, 500, 502, 503, 503, 503)
	ctx := context.Background()
	poll(t, w, s, human(1, 1))
	c.advance(20 * time.Second)
	var delays []time.Duration
	for range 6 {
		w.maybeFire(ctx)
		delays = append(delays, w.retryAt.Sub(c.now()))
		c.advance(w.retryAt.Sub(c.now()))
	}
	want := []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute}
	for i := range want {
		if delays[i] != want[i] {
			t.Fatalf("backoff %v, want %v", delays, want)
		}
	}
	w.maybeFire(ctx)
	if f := s.fired(); len(f) != 7 || !strings.Contains(f[6], "ids=1 ") {
		t.Fatalf("ids lost on 5xx: %d fires", len(f))
	}
}

func TestFireNoResponseIsRetried(t *testing.T) {
	w, s, c, _ := setup(t)
	w.cfg.RoutineAPI = "http://127.0.0.1:1"
	poll(t, w, s, human(1, 1))
	c.advance(time.Minute)
	w.maybeFire(context.Background())
	if w.failures != 1 || w.retryAt.IsZero() || w.configErr != "" {
		t.Fatalf("no answer must be retried: failures=%d retryAt=%v", w.failures, w.retryAt)
	}
}

func TestFire4xxIsConfigErrorAndNotRetried(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			w, s, c, logs := setup(t, status)
			poll(t, w, s, human(1, 9))
			c.advance(time.Minute)
			w.maybeFire(context.Background())
			c.advance(time.Hour)
			poll(t, w, s, human(2, 10))
			w.maybeFire(context.Background())
			if n := len(s.fired()); n != 1 {
				t.Fatalf("retried a %d (%d fires)", status, n)
			}
			if !strings.Contains(logs.String(), "ERROR CONFIG") {
				t.Fatalf("not logged loudly:\n%s", logs)
			}
			st, _ := w.store.State()
			if st.FiredThrough != 0 {
				t.Fatal("ids must stay pending for after the restart")
			}
		})
	}
}

func TestCallbackQueuedAnsweredAndNotFired(t *testing.T) {
	w, s, c, _ := setup(t)
	poll(t, w, s, fmt.Sprintf(`{"update_id":42,"callback_query":{"id":"cbq-1","from":{"id":375465077},"data":"approve:7","message":{"message_id":800,"chat":{"id":%d},"text":"Q?"}}}`, chat))
	if a := s.callsOf("answerCallbackQuery"); len(a) != 1 || a[0]["callback_query_id"] != "cbq-1" {
		t.Fatalf("answerCallbackQuery: %v", a)
	}
	raw, err := os.ReadFile(w.cfg.CallbackQueue)
	if err != nil {
		t.Fatal(err)
	}
	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(raw), &line); err != nil {
		t.Fatal(err)
	}
	cb, _ := line["callback_query"].(map[string]any)
	if line["answered"] != true || line["update_id"] != float64(42) || cb["data"] != "approve:7" {
		t.Fatalf("queue line: %s", raw)
	}
	c.advance(time.Hour)
	w.maybeFire(context.Background())
	if len(s.fired()) != 0 {
		t.Fatal("a press must not wake the routine")
	}
}

func TestRestartNeitherDuplicatesNorLoses(t *testing.T) {
	w, s, c, _ := setup(t)
	ctx := context.Background()
	poll(t, w, s, human(100, 1))
	c.advance(20 * time.Second)
	w.maybeFire(ctx)
	poll(t, w, s, human(101, 2), human(102, 3))

	dir := filepath.Dir(filepath.Dir(w.cfg.CallbackQueue))
	w2, _ := restart(t, w.cfg, dir, c)
	w2.maybeFire(ctx) // inside the interval of the fire before the restart
	if n := len(s.fired()); n != 1 {
		t.Fatalf("restart broke the minimum interval (%d)", n)
	}
	c.advance(2 * time.Minute)
	w2.maybeFire(ctx)
	w3, _ := restart(t, w.cfg, dir, c)
	c.advance(time.Hour)
	w3.maybeFire(ctx)
	f := s.fired()
	if len(f) != 2 || !strings.Contains(f[1], "ids=2,3 (last=3)") {
		t.Fatalf("fires across restarts: %q", f)
	}
	poll(t, w3, s)
	polls := s.callsOf("getUpdates")
	if polls[len(polls)-1]["offset"] != "103" {
		t.Fatalf("resumed offset %q", polls[len(polls)-1]["offset"])
	}
}

func TestAlertsHourlyAndSecretsStayOut(t *testing.T) {
	w, s, c, logs := setup(t, 503, 503, 503, 503)
	ctx := context.Background()
	poll(t, w, s, human(1, 1))
	c.advance(20 * time.Second)
	for range 3 {
		w.maybeFire(ctx)
		w.checkHealth(ctx)
		c.advance(w.retryAt.Sub(c.now()))
	}
	alerts := s.callsOf("sendMessage")
	if len(alerts) != 1 || alerts[0]["chat_id"] != "375465077" || !strings.Contains(alerts[0]["path"], alertTok) {
		t.Fatalf("one alert through the alert bot expected: %v", alerts)
	}
	w.checkHealth(ctx)
	if len(s.callsOf("sendMessage")) != 1 {
		t.Fatal("more than one alert an hour")
	}

	// Telegram unreachable for over 10 minutes.
	w.failures = 0
	w.lastTelegram = c.now()
	c.advance(time.Hour + 11*time.Minute)
	w.telegramError = redact("dial https://api.telegram.org/bot"+botTok+"/getUpdates: refused", botTok)
	w.checkHealth(ctx)
	alerts = s.callsOf("sendMessage")
	if len(alerts) != 2 || !strings.Contains(alerts[1]["text"], "Telegram") {
		t.Fatalf("offline alert: %v", alerts)
	}
	for _, path := range []string{filepath.Join(filepath.Dir(filepath.Dir(w.cfg.CallbackQueue)), "state", "state.json")} {
		raw, _ := os.ReadFile(path)
		for _, secret := range []string{botTok, alertTok, routeTok} {
			if strings.Contains(string(raw), secret) || strings.Contains(logs.String(), secret) || strings.Contains(alerts[1]["text"], secret) {
				t.Fatalf("secret %q leaked", secret)
			}
		}
	}
	// No group writes, ever.
	for _, a := range s.callsOf("sendMessage") {
		if a["chat_id"] == fmt.Sprint(chat) {
			t.Fatal("the watcher wrote to the group")
		}
	}
}

func TestLoadWatchConfigNamesMissingAndReadsSpecNames(t *testing.T) {
	for _, k := range []string{"WATCH_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "WATCH_CHAT_ID", "DEVLOOP_CHAT_IDS", "ROUTINE_ID", "DEVLOOP_ROUTINE_ID", "ROUTINE_TOKEN", "DEVLOOP_ROUTINE_TOKEN"} {
		t.Setenv(k, "")
	}
	_, err := LoadWatchConfig()
	if err == nil || !strings.Contains(err.Error(), "WATCH_BOT_TOKEN, WATCH_CHAT_ID, ROUTINE_ID, ROUTINE_TOKEN") {
		t.Fatalf("error %v", err)
	}
	t.Setenv("WATCH_BOT_TOKEN", "t")
	t.Setenv("WATCH_CHAT_ID", "-1003928414397")
	t.Setenv("ROUTINE_ID", "trig_x")
	t.Setenv("ROUTINE_TOKEN", "k")
	t.Setenv("WATCH_MIN_INTERVAL_SECONDS", "300")
	wc, err := LoadWatchConfig()
	if err != nil || !wc.ChatIDs[chat] || wc.Debounce != 20*time.Second || wc.MinInterval != 5*time.Minute {
		t.Fatalf("config %+v %v", wc, err)
	}
}
