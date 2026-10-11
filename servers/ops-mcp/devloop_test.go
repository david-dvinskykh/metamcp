package main

import (
	"testing"
	"time"
)

func testWatchConfig() *WatchConfig {
	return &WatchConfig{Debounce: 20 * time.Second, MinInterval: 120 * time.Second, MaxFiresHour: 3}
}

func TestStoreAppendAndLease(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	if err := s.Append([]Event{{Kind: "message", Text: "a"}, {Kind: "message", Text: "b"}}, 101); err != nil {
		t.Fatal(err)
	}
	evs, _ := s.Events(0, 0)
	if len(evs) != 2 || evs[0].Seq != 1 || evs[1].Seq != 2 {
		t.Fatalf("events numbered wrong: %+v", evs)
	}
	st, _ := s.State()
	if st.TGOffset != 101 || st.LastSeq != 2 {
		t.Fatalf("state: %+v", st)
	}

	if _, ok, _ := s.AcquireLease("session_A", time.Hour, now); !ok {
		t.Fatal("A should acquire")
	}
	if lease, ok, _ := s.AcquireLease("session_B", time.Hour, now); ok || lease.SessionID != "session_A" {
		t.Fatal("B must not steal a live lease")
	}
	if _, err := s.RenewLease("session_B", time.Hour, 1, "", now); err == nil {
		t.Fatal("B cannot renew A's lease")
	}
	if _, err := s.ReleaseLease("session_B", 2); err == nil {
		t.Fatal("B cannot release A's lease")
	}
	st, err = s.ReleaseLease("session_A", 1)
	if err != nil || st.HandledUpTo != 1 || st.Lease != nil {
		t.Fatalf("release: %+v %v", st, err)
	}
	// An expired lease is taken over.
	_, _, _ = s.AcquireLease("session_C", time.Minute, now)
	if _, ok, _ := s.AcquireLease("session_D", time.Hour, now.Add(2*time.Minute)); !ok {
		t.Fatal("D should take over the expired lease")
	}
}

func TestDecide(t *testing.T) {
	cfg := testWatchConfig()
	start := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	msg := func(seq, id int64) Event { return Event{Seq: seq, Kind: "message", ChatID: -100, MessageID: id} }

	if d := decide(State{}, nil, start, cfg, time.Time{}); d.Fire {
		t.Fatal("nothing to fire on")
	}
	pending := State{PendingSince: start}
	evs := []Event{msg(1, 672), msg(2, 673), msg(3, 675)}
	if d := decide(pending, evs, start.Add(19*time.Second), cfg, time.Time{}); d.Fire || !d.At.Equal(start.Add(20*time.Second)) {
		t.Fatalf("must debounce 20 s from the first message: %+v", d)
	}
	d := decide(pending, evs, start.Add(20*time.Second), cfg, time.Time{})
	if !d.Fire || d.Through != 3 || wakeText(d.IDs) != "DEVLOOP-WAKE chat=-100 ids=672,673,675 (last=675)" {
		t.Fatalf("three messages, one fire: %+v %q", d, wakeText(d.IDs))
	}

	// Minimum interval from the last successful fire.
	fired := State{FiredThrough: 3, Fires: []time.Time{start.Add(20 * time.Second)}, PendingSince: start.Add(30 * time.Second)}
	next := []Event{msg(4, 676)}
	if d := decide(fired, next, start.Add(90*time.Second), cfg, time.Time{}); d.Fire || !d.At.Equal(start.Add(140*time.Second)) {
		t.Fatalf("minimum interval must hold: %+v", d)
	}
	if d := decide(fired, next, start.Add(140*time.Second), cfg, time.Time{}); !d.Fire || d.Through != 4 {
		t.Fatalf("should fire once the interval has passed: %+v", d)
	}
	// Retry delay.
	if d := decide(fired, next, start.Add(140*time.Second), cfg, start.Add(150*time.Second)); d.Fire {
		t.Fatal("retry delay must hold")
	}
	// Already fired: not pending.
	if d := decide(State{FiredThrough: 3}, evs, start.Add(time.Hour), cfg, time.Time{}); d.Fire {
		t.Fatal("fired events must not fire again")
	}
	// Bot messages and presses are recorded but never fire.
	bot := msg(1, 5)
	bot.FromBot = true
	press := Event{Seq: 2, Kind: "callback", ChatID: -100, MessageID: 6}
	if d := decide(State{}, []Event{bot, press}, start.Add(time.Hour), cfg, time.Time{}); d.Fire || d.Through != 2 {
		t.Fatalf("bot message / press must not fire: %+v", d)
	}
	// Hourly budget.
	budget := State{Fires: []time.Time{start.Add(-50 * time.Minute), start.Add(-40 * time.Minute), start.Add(-35 * time.Minute)}}
	if d := decide(budget, []Event{msg(1, 1)}, start, cfg, time.Time{}); d.Fire {
		t.Fatal("budget spent")
	}
}
