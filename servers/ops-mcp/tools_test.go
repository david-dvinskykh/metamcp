package main

import (
	"context"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestToolsOverMCP(t *testing.T) {
	ctx := context.Background()
	cfg := &Config{DataDir: t.TempDir(), Hosts: map[string]Host{
		"freepbx": {Name: "freepbx", Addr: "127.0.0.1:1", User: "root", KeyEnv: "NOPE"},
	}}
	store, _ := NewStore(t.TempDir())
	_ = store.Append([]Event{{Kind: "message", ChatID: -100, MessageID: 5, Text: "hi"}}, 2)
	s := &Server{cfg: cfg, ssh: NewSSHRunner(cfg), binotel: NewBinotelClient(), store: store}
	srv := mcp.NewServer(&mcp.Implementation{Name: "ops-mcp"}, nil)
	s.register(srv)

	ct, st := mcp.NewInMemoryTransports()
	if _, err := srv.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	want := "ops_hosts ops_exec binotel_request devloop_inbox devloop_lease"
	for _, n := range strings.Fields(want) {
		if !strings.Contains(strings.Join(names, " "), n) {
			t.Fatalf("missing tool %s in %v", n, names)
		}
	}

	call := func(name string, args map[string]any) *mcp.CallToolResult {
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	text := func(r *mcp.CallToolResult) string { return r.Content[0].(*mcp.TextContent).Text }

	if r := call("ops_hosts", map[string]any{}); r.IsError || !strings.Contains(text(r), `"Credentials": false`) {
		t.Fatalf("ops_hosts: %s", text(r))
	}
	if r := call("ops_exec", map[string]any{"host": "freepbx", "command": "fwconsole reload"}); !r.IsError || !strings.Contains(text(r), "read-only") {
		t.Fatalf("read-only refusal expected: %s", text(r))
	}
	if r := call("binotel_request", map[string]any{"method": "calls/internal-number-to-external-number"}); !r.IsError || !strings.Contains(text(r), "BINOTEL_ALLOW_WRITE") {
		t.Fatalf("binotel write refusal expected: %s", text(r))
	}
	if r := call("devloop_inbox", map[string]any{}); r.IsError || !strings.Contains(text(r), `"message_id": 5`) {
		t.Fatalf("inbox: %s", text(r))
	}
	if r := call("devloop_lease", map[string]any{"action": "acquire", "session_id": "session_1"}); r.IsError || !strings.Contains(text(r), `"acquired": true`) {
		t.Fatalf("lease: %s", text(r))
	}
	if r := call("devloop_lease", map[string]any{"action": "release", "session_id": "session_1", "cursor": 1}); r.IsError || !strings.Contains(text(r), `"handled_up_to": 1`) {
		t.Fatalf("release: %s", text(r))
	}
}
