package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// startSSHServer runs a tiny SSH server whose "shell" echoes the command and
// exits 3 when the command is "fail".
func startSSHServer(t *testing.T, clientKey ssh.PublicKey) (addr string, hostKey ssh.Signer) {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ = ssh.NewSignerFromKey(priv)
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		if string(k.Marshal()) == string(clientKey.Marshal()) {
			return nil, nil
		}
		return nil, ssh.ErrNoAuth
	}}
	cfg.AddHostKey(hostKey)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(conn, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					ch, creqs, _ := nc.Accept()
					go func() {
						for req := range creqs {
							if req.Type != "exec" {
								req.Reply(false, nil)
								continue
							}
							cmd := string(req.Payload[4:])
							req.Reply(true, nil)
							ch.Write([]byte("ran: " + cmd))
							status := make([]byte, 4)
							if cmd == "fail" {
								binary.BigEndian.PutUint32(status, 3)
							}
							ch.SendRequest("exit-status", false, status)
							ch.Close()
						}
					}()
				}
			}()
		}
	}()
	return ln.Addr().String(), hostKey
}

func TestSSHExec(t *testing.T) {
	_, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	block, _ := ssh.MarshalPrivateKey(clientPriv, "")
	signer, _ := ssh.NewSignerFromKey(clientPriv)
	addr, hostKey := startSSHServer(t, signer.PublicKey())
	t.Setenv("OPS_TEST_KEY", strings.ReplaceAll(string(pem.EncodeToMemory(block)), "\n", `\n`))

	cfg := &Config{DataDir: t.TempDir(), Hosts: map[string]Host{
		"netcup":  {Name: "netcup", Addr: addr, User: "root", KeyEnv: "OPS_TEST_KEY", Mode: "full"},
		"freepbx": {Name: "freepbx", Addr: addr, User: "root", KeyEnv: "OPS_TEST_KEY"},
		"pinned":  {Name: "pinned", Addr: addr, User: "root", KeyEnv: "OPS_TEST_KEY", Mode: "full", HostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"},
	}}
	r := NewSSHRunner(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := r.Exec(ctx, "netcup", "docker compose up -d", nil, 0)
	if err != nil || res.ExitCode != 0 || res.Stdout != "ran: docker compose up -d" {
		t.Fatalf("full host exec: %+v %v", res, err)
	}
	res, err = r.Exec(ctx, "netcup", "fail", nil, 0)
	if err != nil || res.ExitCode != 3 {
		t.Fatalf("exit status: %+v %v", res, err)
	}
	// TOFU recorded the key; it is reported by fingerprint.
	if fp := r.KnownFingerprint(cfg.Hosts["netcup"]); fp != ssh.FingerprintSHA256(hostKey.PublicKey()) {
		t.Fatalf("fingerprint %q", fp)
	}
	// Read-only host: inspection passes, change is refused before dialing.
	if _, err := r.Exec(ctx, "freepbx", "tail -n 5 /var/log/asterisk/full", nil, 0); err != nil {
		t.Fatalf("read-only inspection: %v", err)
	}
	if _, err := r.Exec(ctx, "freepbx", "fwconsole reload", nil, 0); err == nil {
		t.Fatal("read-only host must refuse fwconsole reload")
	}
	// A pinned key that does not match is refused.
	if _, err := r.Exec(ctx, "pinned", "ls", nil, 0); err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("pinned mismatch should fail: %v", err)
	}
	// Missing credentials are reported, not panicked on.
	t.Setenv("OPS_TEST_KEY", "")
	if _, err := r.Exec(ctx, "netcup", "ls", nil, 0); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("empty key: %v", err)
	}
}
