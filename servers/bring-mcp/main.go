// Command bring-mcp is a small stdio MCP server for Bring! shopping lists.
// It replaces the TypeScript bring-mcp (npx bring-mcp@latest) under MetaMCP
// with the same tools: one static binary, no Node, no npm download at start,
// lazy login and a session cached on disk so new processes skip the login.
//
//	bring-mcp           stdio MCP server (what MetaMCP launches)
//	bring-mcp version
//
// Environment: BRING_EMAIL, BRING_PASSWORD (MAIL / PW accepted too);
// BRING_STATE_DIR — where the session is cached (default /var/lib/bring-mcp,
// falling back to the user cache dir; "off" disables the cache).
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var version = "dev"

func main() {
	log.SetOutput(os.Stderr)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "", "serve", "stdio":
		if err := serve(ctx); err != nil && ctx.Err() == nil {
			log.Fatal(err)
		}
	case "version", "--version":
		fmt.Println(version)
	default:
		log.Fatalf("unknown command %q (serve | version)", cmd)
	}
}

func serve(ctx context.Context) error {
	email := firstEnv("BRING_EMAIL", "MAIL")
	password := firstEnv("BRING_PASSWORD", "PW")
	if email == "" || password == "" {
		// Do not exit: MetaMCP would only see a crash. Tools answer with the
		// reason instead.
		log.Print("bring-mcp: BRING_EMAIL / BRING_PASSWORD not set; tools will fail until they are")
	}
	s := &Server{bc: NewClient(email, password, cacheFile())}
	srv := mcp.NewServer(&mcp.Implementation{Name: "bring-mcp", Version: version}, nil)
	s.register(srv)
	return srv.Run(ctx, &mcp.StdioTransport{})
}

func cacheFile() string {
	dir := os.Getenv("BRING_STATE_DIR")
	if dir == "off" {
		return ""
	}
	if dir == "" {
		dir = "/var/lib/bring-mcp"
		if !writable(dir) {
			c, err := os.UserCacheDir()
			if err != nil {
				return ""
			}
			dir = filepath.Join(c, "bring-mcp")
		}
	}
	return filepath.Join(dir, "session.json")
}

func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(f.Name())
	return true
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}
