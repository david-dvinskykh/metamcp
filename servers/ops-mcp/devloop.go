package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// The dev loop's shared state lives in two files in the data dir, written by
// the watcher (a long-running process that owns the bot's getUpdates stream)
// and read by the MCP server (one process per MetaMCP connection):
//
//	inbox.jsonl  one Event per line, append-only, numbered by Seq
//	state.json   cursors, the fire history and the session lease
//
// Both processes take an exclusive flock on state.lock around every
// read-modify-write, so neither needs to trust the other's timing.

type FileRef struct {
	Kind     string `json:"kind"` // photo | document | video | voice | audio | sticker
	FileID   string `json:"file_id"`
	FileName string `json:"file_name,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	Size     int64  `json:"size,omitempty"`
}

type Event struct {
	Seq       int64     `json:"seq"`
	Kind      string    `json:"kind"` // message | edited | callback
	ChatID    int64     `json:"chat_id"`
	MessageID int64     `json:"message_id"`
	Date      time.Time `json:"date"`
	FromID    int64     `json:"from_id"`
	FromName  string    `json:"from_name,omitempty"`
	FromBot   bool      `json:"from_bot,omitempty"`
	Text      string    `json:"text,omitempty"`
	ReplyTo   int64     `json:"reply_to,omitempty"`
	Files     []FileRef `json:"files,omitempty"`
	// Callback presses (inline buttons under the bot's own questions).
	CallbackData string `json:"callback_data,omitempty"`
}

type Lease struct {
	SessionID string    `json:"session_id"`
	Until     time.Time `json:"until"`
	// Cursor is the last Seq the session has taken into account. Events
	// after it make the watcher fire again once the lease ends.
	Cursor int64 `json:"cursor"`
	// Note is a free-text "what I'm on" shown to the next session.
	Note string `json:"note,omitempty"`
}

type State struct {
	LastSeq      int64       `json:"last_seq"`
	TGOffset     int64       `json:"tg_offset"`
	FiredThrough int64       `json:"fired_through"`
	HandledUpTo  int64       `json:"handled_up_to"`
	Fires        []time.Time `json:"fires,omitempty"`
	Lease        *Lease      `json:"lease,omitempty"`
	LastFireErr  string      `json:"last_fire_error,omitempty"`
	LastSession  string      `json:"last_session_url,omitempty"`
}

type Store struct{ dir string }

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

func (s *Store) path(name string) string { return filepath.Join(s.dir, name) }

// withLock runs fn holding the cross-process lock, with the current state.
// fn may modify the state; it is saved when fn returns nil.
func (s *Store) withLock(fn func(st *State) error) error {
	lf, err := os.OpenFile(s.path("state.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lf.Close()
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lf.Fd()), syscall.LOCK_UN) //nolint:errcheck

	st := &State{}
	if b, err := os.ReadFile(s.path("state.json")); err == nil {
		if err := json.Unmarshal(b, st); err != nil {
			return fmt.Errorf("corrupt state.json: %w", err)
		}
	}
	if err := fn(st); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	tmp := s.path("state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path("state.json"))
}

// State returns a snapshot.
func (s *Store) State() (State, error) {
	var out State
	err := s.withLock(func(st *State) error { out = *st; return nil })
	return out, err
}

// Append numbers and stores events, advancing the Telegram offset in the same
// locked step so a crash cannot store an update twice or skip one.
func (s *Store) Append(events []Event, newOffset int64) error {
	return s.withLock(func(st *State) error {
		if len(events) > 0 {
			f, err := os.OpenFile(s.path("inbox.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			defer f.Close()
			for i := range events {
				st.LastSeq++
				events[i].Seq = st.LastSeq
				line, _ := json.Marshal(events[i])
				if _, err := f.Write(append(line, '\n')); err != nil {
					return err
				}
			}
		}
		if newOffset > st.TGOffset {
			st.TGOffset = newOffset
		}
		return nil
	})
}

// Events returns events with Seq > after, at most limit of them.
func (s *Store) Events(after int64, limit int) ([]Event, error) {
	f, err := os.Open(s.path("inbox.jsonl"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var e Event
		if json.Unmarshal(sc.Bytes(), &e) != nil || e.Seq <= after {
			continue
		}
		out = append(out, e)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, sc.Err()
}

// AcquireLease takes the lease for a session, or reports who holds it.
func (s *Store) AcquireLease(sessionID string, ttl time.Duration, now time.Time) (*Lease, bool, error) {
	var lease *Lease
	acquired := false
	err := s.withLock(func(st *State) error {
		if st.Lease != nil && st.Lease.Until.After(now) && st.Lease.SessionID != sessionID {
			lease = st.Lease
			return nil
		}
		cursor := st.HandledUpTo
		if st.Lease != nil && st.Lease.SessionID == sessionID {
			cursor = st.Lease.Cursor
		}
		st.Lease = &Lease{SessionID: sessionID, Until: now.Add(ttl), Cursor: cursor}
		lease, acquired = st.Lease, true
		return nil
	})
	return lease, acquired, err
}

// RenewLease extends a held lease and records progress.
func (s *Store) RenewLease(sessionID string, ttl time.Duration, cursor int64, note string, now time.Time) (*Lease, error) {
	var lease *Lease
	err := s.withLock(func(st *State) error {
		if st.Lease == nil || st.Lease.SessionID != sessionID {
			return fmt.Errorf("session %s does not hold the lease", sessionID)
		}
		st.Lease.Until = now.Add(ttl)
		if cursor > st.Lease.Cursor {
			st.Lease.Cursor = cursor
		}
		if note != "" {
			st.Lease.Note = note
		}
		lease = st.Lease
		return nil
	})
	return lease, err
}

// ReleaseLease ends the session's lease; events up to cursor count as handled.
func (s *Store) ReleaseLease(sessionID string, cursor int64) (State, error) {
	var out State
	err := s.withLock(func(st *State) error {
		if st.Lease != nil && st.Lease.SessionID != sessionID {
			return fmt.Errorf("lease is held by %s, not %s", st.Lease.SessionID, sessionID)
		}
		if st.Lease != nil && st.Lease.Cursor > cursor {
			cursor = st.Lease.Cursor
		}
		if cursor > st.HandledUpTo {
			st.HandledUpTo = cursor
		}
		st.Lease = nil
		out = *st
		return nil
	})
	return out, err
}
