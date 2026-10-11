// Command ops-mcp gives Claude sessions running under MetaMCP access to the
// clinic's servers (SSH), Binotel, and the AI Bridge Dovira dev loop, with
// every credential held in this process's environment rather than in the
// conversation.
//
//	ops-mcp            stdio MCP server (what MetaMCP launches)
//	ops-mcp watch      long-running Telegram watcher that fires the routine
//	ops-mcp version
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
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
	var err error
	switch cmd {
	case "", "serve", "stdio":
		err = serve(ctx)
	case "watch":
		err = watch(ctx)
	case "version", "--version":
		fmt.Println(version)
	default:
		err = fmt.Errorf("unknown command %q (serve | watch | version)", cmd)
	}
	if err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}

func serve(ctx context.Context) error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	store, err := NewStore(devloopDir(cfg))
	if err != nil {
		return err
	}
	s := &Server{cfg: cfg, ssh: NewSSHRunner(cfg), binotel: NewBinotelClient(), store: store}
	srv := mcp.NewServer(&mcp.Implementation{Name: "ops-mcp", Version: version}, nil)
	s.register(srv)
	return srv.Run(ctx, &mcp.StdioTransport{})
}

func watch(ctx context.Context) error {
	// Off until the dev-loop bot and the routine are set up.
	if os.Getenv("DEVLOOP_ENABLED") != "true" {
		log.Print("devloop watcher: disabled (set DEVLOOP_ENABLED=true); idling")
		<-ctx.Done()
		return nil
	}
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	wc, err := LoadWatchConfig()
	if err != nil {
		return err
	}
	store, err := NewStore(devloopDir(cfg))
	if err != nil {
		return err
	}
	return NewWatcher(wc, store).Run(ctx)
}

// devloopDir is shared by the watcher and every MCP process, so both must
// see the same volume (DEVLOOP_DATA_DIR, default <OPS_DATA_DIR>/devloop).
func devloopDir(cfg *Config) string {
	if d := os.Getenv("DEVLOOP_DATA_DIR"); d != "" {
		return d
	}
	return cfg.DataDir + "/devloop"
}
