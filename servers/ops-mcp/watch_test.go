package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWatcherRecordsAndFires(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	var fired []map[string]string
	var answered []string
	var served bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/getUpdates"):
			if served {
				_, _ = io.WriteString(w, `{"ok":true,"result":[]}`)
				return
			}
			served = true
			_, _ = io.WriteString(w, `{"ok":true,"result":[
			 {"update_id":10,"message":{"message_id":501,"date":1760000000,"from":{"id":7,"first_name":"Olena"},"chat":{"id":-100},"text":"#баг не відкривається графік","photo":[{"file_id":"small","file_size":10},{"file_id":"big","file_size":900}]}},
			 {"update_id":11,"message":{"message_id":502,"date":1760000001,"from":{"id":8,"first_name":"X"},"chat":{"id":-999},"text":"other chat"}},
			 {"update_id":12,"callback_query":{"id":"cb1","from":{"id":7},"data":"Q-501:ok","message":{"message_id":503,"chat":{"id":-100},"text":"Чи правильно я зрозумів?"}}}
			]}`)
		case strings.HasSuffix(r.URL.Path, "/answerCallbackQuery"):
			_ = r.ParseForm()
			answered = append(answered, r.Form.Get("callback_query_id"))
			_, _ = io.WriteString(w, `{"ok":true}`)
		case strings.HasSuffix(r.URL.Path, "/v1/claude_code/routines/trig_1/fire"):
			if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("anthropic-version") != "2023-06-01" {
				w.WriteHeader(401)
				return
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			fired = append(fired, body)
			_, _ = io.WriteString(w, `{"type":"routine_fire","claude_code_session_id":"session_x","claude_code_session_url":"https://claude.ai/code/session_x"}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	store, _ := NewStore(dir)
	cfg := &WatchConfig{
		BotToken: "123:abc", APIBase: srv.URL, ChatIDs: map[int64]bool{-100: true},
		RoutineID: "trig_1", RoutineToken: "tok", RoutineAPI: srv.URL,
		CallbackQueue: filepath.Join(dir, "callbacks.jsonl"),
		Debounce:      time.Minute, MaxWait: 3 * time.Minute, RetryAfter: 30 * time.Minute, MaxFiresHour: 20,
		PollTimeout: time.Second,
	}
	w := NewWatcher(cfg, store)
	w.now = func() time.Time { return time.Unix(1760000000, 0).Add(5 * time.Minute) }

	if err := w.pollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	evs, _ := store.Events(0, 0)
	if len(evs) != 2 {
		t.Fatalf("want the group message and the press, got %+v", evs)
	}
	if evs[0].Files[0].FileID != "big" || evs[0].FromName != "Olena" {
		t.Fatalf("message parsed wrong: %+v", evs[0])
	}
	if evs[1].Kind != "callback" || evs[1].CallbackData != "Q-501:ok" {
		t.Fatalf("press parsed wrong: %+v", evs[1])
	}
	st, _ := store.State()
	if st.TGOffset != 13 {
		t.Fatalf("offset %d", st.TGOffset)
	}
	q, _ := os.ReadFile(cfg.CallbackQueue)
	if !strings.Contains(string(q), `"answered":true`) || len(answered) != 1 {
		t.Fatalf("press not queued/answered: %s %v", q, answered)
	}

	w.maybeFire(context.Background())
	w.maybeFire(context.Background()) // second tick must not fire again
	if len(fired) != 1 || !strings.Contains(fired[0]["text"], "msg 501") {
		t.Fatalf("fired %+v", fired)
	}
	st, _ = store.State()
	if st.FiredThrough != 2 || st.LastSession != "https://claude.ai/code/session_x" {
		t.Fatalf("state after fire %+v", st)
	}
}
