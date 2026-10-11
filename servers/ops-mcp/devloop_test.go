package main

import (
	"testing"
	"time"
)

func testWatchConfig() *WatchConfig {
	return &WatchConfig{Debounce: time.Minute, MaxWait: 3 * time.Minute, RetryAfter: 30 * time.Minute, MaxFiresHour: 3}
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
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	ev := func(seq int64, ago time.Duration) Event {
		return Event{Seq: seq, Kind: "message", Date: now.Add(-ago)}
	}

	if d := decide(State{}, nil, now, cfg); d.Fire {
		t.Fatal("nothing to fire on")
	}
	if d := decide(State{}, []Event{ev(1, 10*time.Second)}, now, cfg); d.Fire || d.Reason != "debouncing" {
		t.Fatalf("fresh message should debounce: %+v", d)
	}
	if d := decide(State{}, []Event{ev(1, 2*time.Minute)}, now, cfg); !d.Fire || d.Through != 1 {
		t.Fatalf("quiet message should fire: %+v", d)
	}
	// A chatty thread still fires once the oldest message waited MaxWait.
	chatty := []Event{ev(1, 4*time.Minute), ev(2, 5*time.Second)}
	if d := decide(State{}, chatty, now, cfg); !d.Fire || d.Through != 2 {
		t.Fatalf("max wait should force a fire: %+v", d)
	}
	// Bot echoes never fire.
	bot := ev(1, 2*time.Minute)
	bot.FromBot = true
	if d := decide(State{}, []Event{bot}, now, cfg); d.Fire {
		t.Fatal("bot messages must not fire")
	}
	// A live lease blocks; the session will pick the event up itself.
	leased := State{Lease: &Lease{SessionID: "s", Until: now.Add(time.Minute)}}
	if d := decide(leased, []Event{ev(1, 2*time.Minute)}, now, cfg); d.Fire {
		t.Fatal("lease must block")
	}
	// Already fired, session not back yet: wait, then retry after RetryAfter.
	fired := State{FiredThrough: 1, Fires: []time.Time{now.Add(-5 * time.Minute)}}
	if d := decide(fired, []Event{ev(1, 6*time.Minute)}, now, cfg); d.Fire {
		t.Fatal("must wait for the fired session")
	}
	fired.Fires = []time.Time{now.Add(-31 * time.Minute)}
	if d := decide(fired, []Event{ev(1, 32*time.Minute)}, now, cfg); !d.Fire {
		t.Fatal("should retry a session that never took the lease")
	}
	// Handled events are not pending.
	if d := decide(State{HandledUpTo: 1}, []Event{ev(1, time.Hour)}, now, cfg); d.Fire {
		t.Fatal("handled events must not fire")
	}
	// Hourly budget.
	budget := State{Fires: []time.Time{now.Add(-50 * time.Minute), now.Add(-40 * time.Minute), now.Add(-35 * time.Minute)}}
	if d := decide(budget, []Event{ev(1, 2*time.Minute)}, now, cfg); d.Fire {
		t.Fatal("budget spent")
	}
}
