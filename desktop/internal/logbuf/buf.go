// Package logbuf keeps a bounded ring of log lines for the desktop UI.
//
// The buffer is fed by every moving part (app, tor manager, node proxy
// stdout/stderr) and drained by the UI through a sequence-number cursor, so
// polling stays cheap and no line is shown twice.
package logbuf

import (
	"strings"
	"sync"
	"time"
)

// Entry is one log line.
type Entry struct {
	Seq   uint64 `json:"seq"`
	Time  string `json:"time"`
	Scope string `json:"scope"`
	Level string `json:"level"`
	Line  string `json:"line"`
}

// Buffer is a concurrency-safe bounded log ring.
type Buffer struct {
	mu      sync.Mutex
	entries []Entry
	nextSeq uint64
	max     int
}

// New creates a buffer holding at most max entries (1200 when max <= 0).
func New(max int) *Buffer {
	if max <= 0 {
		max = 1200
	}
	return &Buffer{max: max}
}

// Add appends one line. Empty lines are dropped; the trailing newline is
// trimmed.
func (b *Buffer) Add(scope, level, line string) {
	line = strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(line) == "" {
		return
	}
	level = strings.ToLower(strings.TrimSpace(level))
	if level == "" {
		level = "info"
	}
	if scope == "" {
		scope = "app"
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextSeq++
	b.entries = append(b.entries, Entry{
		Seq:   b.nextSeq,
		Time:  time.Now().Format("15:04:05.000"),
		Scope: scope,
		Level: level,
		Line:  line,
	})
	if len(b.entries) > b.max {
		b.entries = append([]Entry(nil), b.entries[len(b.entries)-b.max:]...)
	}
}

// After returns up to limit entries with Seq > after, plus the latest
// sequence number (the cursor to poll with next time).
func (b *Buffer) After(after uint64, limit int) ([]Entry, uint64) {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Entry, 0, 64)
	for _, entry := range b.entries {
		if entry.Seq > after {
			out = append(out, entry)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, b.nextSeq
}

// Tail returns the last n entries (oldest first).
func (b *Buffer) Tail(n int) []Entry {
	if n <= 0 {
		n = 200
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.entries) <= n {
		return append([]Entry(nil), b.entries...)
	}
	return append([]Entry(nil), b.entries[len(b.entries)-n:]...)
}
