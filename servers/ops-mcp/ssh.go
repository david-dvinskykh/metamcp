package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHRunner opens a fresh connection per call. Calls are rare (a deploy
// check, a log tail), so a pool would only add stale-connection bugs.
type SSHRunner struct {
	cfg *Config
	mu  sync.Mutex // guards the TOFU known-hosts file
	// dial is replaceable in tests.
	dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

func NewSSHRunner(cfg *Config) *SSHRunner {
	d := &net.Dialer{Timeout: 15 * time.Second}
	return &SSHRunner{cfg: cfg, dial: d.DialContext}
}

type ExecResult struct {
	Host      string `json:"host"`
	ExitCode  int    `json:"exit_code"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated,omitempty"`
	Duration  string `json:"duration"`
}

func (r *SSHRunner) Exec(ctx context.Context, hostName, command string, stdin io.Reader, maxOutput int) (*ExecResult, error) {
	host, ok := r.cfg.Hosts[hostName]
	if !ok {
		return nil, fmt.Errorf("unknown host %q (known: %s)", hostName, strings.Join(r.cfg.HostNames(), ", "))
	}
	if host.ReadOnly() {
		if err := checkReadOnly(command); err != nil {
			return nil, err
		}
		if stdin != nil {
			return nil, fmt.Errorf("read-only host %q does not accept uploads", hostName)
		}
	}
	started := time.Now()
	client, closeAll, err := r.connect(ctx, host, 0)
	if err != nil {
		return nil, err
	}
	defer closeAll()

	session, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open session on %s: %w", hostName, err)
	}
	defer session.Close()

	stdout := &limitedBuffer{limit: maxOutput}
	stderr := &limitedBuffer{limit: maxOutput / 4}
	session.Stdout = stdout
	session.Stderr = stderr
	if stdin != nil {
		session.Stdin = stdin
	}

	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()

	exit := 0
	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		return nil, fmt.Errorf("command on %s timed out after %s", hostName, time.Since(started).Round(time.Second))
	case err := <-done:
		var exitErr *ssh.ExitError
		switch {
		case err == nil:
		case errors.As(err, &exitErr):
			exit = exitErr.ExitStatus()
		default:
			return nil, fmt.Errorf("run on %s: %w", hostName, err)
		}
	}

	res := &ExecResult{
		Host:      hostName,
		ExitCode:  exit,
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		Truncated: stdout.truncated || stderr.truncated,
		Duration:  time.Since(started).Round(time.Millisecond).String(),
	}
	r.audit(hostName, command, exit)
	return res, nil
}

// connect dials host, through its jump host when it has one.
func (r *SSHRunner) connect(ctx context.Context, host Host, depth int) (*ssh.Client, func(), error) {
	if depth > 3 {
		return nil, nil, fmt.Errorf("jump chain too deep at %s", host.Name)
	}
	cc, err := r.clientConfig(host)
	if err != nil {
		return nil, nil, err
	}
	if host.Jump == "" {
		conn, err := r.dial(ctx, "tcp", host.Addr)
		if err != nil {
			return nil, nil, fmt.Errorf("dial %s (%s): %w", host.Name, host.Addr, err)
		}
		c, chans, reqs, err := ssh.NewClientConn(conn, host.Addr, cc)
		if err != nil {
			conn.Close()
			return nil, nil, fmt.Errorf("ssh handshake with %s: %w", host.Name, err)
		}
		client := ssh.NewClient(c, chans, reqs)
		return client, func() { client.Close() }, nil
	}

	jump := r.cfg.Hosts[host.Jump]
	jumpClient, closeJump, err := r.connect(ctx, jump, depth+1)
	if err != nil {
		return nil, nil, err
	}
	conn, err := jumpClient.DialContext(ctx, "tcp", host.Addr)
	if err != nil {
		closeJump()
		return nil, nil, fmt.Errorf("dial %s via %s: %w", host.Name, jump.Name, err)
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, host.Addr, cc)
	if err != nil {
		conn.Close()
		closeJump()
		return nil, nil, fmt.Errorf("ssh handshake with %s via %s: %w", host.Name, jump.Name, err)
	}
	client := ssh.NewClient(c, chans, reqs)
	return client, func() { client.Close(); closeJump() }, nil
}

func (r *SSHRunner) clientConfig(host Host) (*ssh.ClientConfig, error) {
	var auths []ssh.AuthMethod
	if host.KeyEnv != "" {
		pem := os.Getenv(host.KeyEnv)
		if pem == "" {
			return nil, fmt.Errorf("host %s: private key variable %s is empty; David fills it in MetaMCP (server env)", host.Name, host.KeyEnv)
		}
		// MetaMCP env fields are single-line; accept literal \n as well.
		pem = strings.ReplaceAll(pem, `\n`, "\n")
		signer, err := ssh.ParsePrivateKey([]byte(pem))
		if err != nil {
			return nil, fmt.Errorf("host %s: parse key from %s: %w", host.Name, host.KeyEnv, err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	}
	if host.PasswordEnv != "" {
		if pw := os.Getenv(host.PasswordEnv); pw != "" {
			auths = append(auths, ssh.Password(pw))
		}
	}
	if len(auths) == 0 {
		return nil, fmt.Errorf("host %s has no credentials configured (key_env / password_env)", host.Name)
	}
	return &ssh.ClientConfig{
		User:            host.User,
		Auth:            auths,
		HostKeyCallback: r.hostKeyCallback(host),
		Timeout:         20 * time.Second,
	}, nil
}

// hostKeyCallback pins the configured key, or records the first key seen
// (TOFU) in <data>/known_hosts.json and enforces it afterwards.
func (r *SSHRunner) hostKeyCallback(host Host) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		got := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
		if host.HostKey != "" {
			if normalizeKey(host.HostKey) != normalizeKey(got) {
				return fmt.Errorf("host key mismatch for %s: got %s", host.Name, ssh.FingerprintSHA256(key))
			}
			return nil
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		known := r.loadKnown()
		if prev, ok := known[host.Name]; ok {
			if normalizeKey(prev) != normalizeKey(got) {
				return fmt.Errorf("host key for %s changed (now %s); if the server was reinstalled, pin the new key in the host config", host.Name, ssh.FingerprintSHA256(key))
			}
			return nil
		}
		known[host.Name] = got
		return r.saveKnown(known)
	}
}

func normalizeKey(k string) string {
	f := strings.Fields(k)
	if len(f) >= 2 {
		return f[0] + " " + f[1]
	}
	return strings.TrimSpace(k)
}

func (r *SSHRunner) knownPath() string { return filepath.Join(r.cfg.DataDir, "known_hosts.json") }

func (r *SSHRunner) loadKnown() map[string]string {
	known := map[string]string{}
	if b, err := os.ReadFile(r.knownPath()); err == nil {
		_ = json.Unmarshal(b, &known)
	}
	return known
}

func (r *SSHRunner) saveKnown(known map[string]string) error {
	if err := os.MkdirAll(r.cfg.DataDir, 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(known, "", "  ")
	return os.WriteFile(r.knownPath(), b, 0o600)
}

// KnownFingerprint reports the pinned or recorded key, for ops_hosts.
func (r *SSHRunner) KnownFingerprint(host Host) string {
	k := host.HostKey
	if k == "" {
		r.mu.Lock()
		k = r.loadKnown()[host.Name]
		r.mu.Unlock()
	}
	if k == "" {
		return ""
	}
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(k))
	if err != nil {
		return "unparsable"
	}
	return ssh.FingerprintSHA256(pub)
}

// audit appends one line per command. The command text is kept (it is the
// point of an audit log); outputs are not.
func (r *SSHRunner) audit(host, command string, exit int) {
	if err := os.MkdirAll(r.cfg.DataDir, 0o700); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(r.cfg.DataDir, "audit.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	line, _ := json.Marshal(map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "host": host, "command": command, "exit": exit})
	_, _ = f.Write(append(line, '\n'))
}

// limitedBuffer keeps the first limit bytes; the tail of a long log is what
// usually matters, so callers are told to pipe through `tail` when truncated.
type limitedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.limit <= 0 {
		b.limit = 64 * 1024
	}
	room := b.limit - b.buf.Len()
	if room <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		b.buf.Write(p[:room])
		b.truncated = true
		return len(p), nil
	}
	return b.buf.Write(p)
}

func (b *limitedBuffer) String() string { return b.buf.String() }
