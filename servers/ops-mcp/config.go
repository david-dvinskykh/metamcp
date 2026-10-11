package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Host is one machine the agent may reach over SSH. Secrets never live in
// this struct's JSON: KeyEnv / PasswordEnv name environment variables that the
// operator fills in MetaMCP's encrypted server env, so the config itself can
// be shown to the model (ops_hosts) without leaking anything.
type Host struct {
	Name        string `json:"name"`
	Addr        string `json:"addr"`
	User        string `json:"user"`
	KeyEnv      string `json:"key_env,omitempty"`
	PasswordEnv string `json:"password_env,omitempty"`
	// HostKey pins the server key ("ssh-ed25519 AAAA..."). Empty means
	// trust-on-first-use: the first key seen is recorded in the data dir and
	// every later connection must match it.
	HostKey string `json:"host_key,omitempty"`
	// Jump names another host used as a bastion (FreePBX sits behind the
	// clinic VM).
	Jump string `json:"jump,omitempty"`
	// Mode is "full" (any command) or "read_only" (allow-listed inspection
	// commands only). Unknown values are treated as read_only.
	Mode string `json:"mode,omitempty"`
	// Description is free text shown by ops_hosts ("prod Bridge, Netcup").
	Description string `json:"description,omitempty"`
}

func (h Host) ReadOnly() bool { return h.Mode != "full" }

type Config struct {
	Hosts   map[string]Host
	DataDir string
}

// LoadConfig reads OPS_HOSTS_JSON (inline JSON array) or OPS_HOSTS_FILE.
func LoadConfig() (*Config, error) {
	cfg := &Config{Hosts: map[string]Host{}, DataDir: dataDir()}
	raw := strings.TrimSpace(os.Getenv("OPS_HOSTS_JSON"))
	if raw == "" {
		if path := strings.TrimSpace(os.Getenv("OPS_HOSTS_FILE")); path != "" {
			b, err := os.ReadFile(path)
			if err != nil {
				return nil, fmt.Errorf("read OPS_HOSTS_FILE: %w", err)
			}
			raw = string(b)
		}
	}
	if raw == "" {
		return cfg, nil
	}
	var hosts []Host
	if err := json.Unmarshal([]byte(raw), &hosts); err != nil {
		return nil, fmt.Errorf("parse hosts config: %w", err)
	}
	for _, h := range hosts {
		if h.Name == "" || h.Addr == "" || h.User == "" {
			return nil, fmt.Errorf("host %q: name, addr and user are required", h.Name)
		}
		if !strings.Contains(h.Addr, ":") {
			h.Addr += ":22"
		}
		if _, dup := cfg.Hosts[h.Name]; dup {
			return nil, fmt.Errorf("host %q is defined twice", h.Name)
		}
		cfg.Hosts[h.Name] = h
	}
	for _, h := range cfg.Hosts {
		if h.Jump != "" {
			if _, ok := cfg.Hosts[h.Jump]; !ok {
				return nil, fmt.Errorf("host %q: jump host %q is not defined", h.Name, h.Jump)
			}
			if h.Jump == h.Name {
				return nil, fmt.Errorf("host %q jumps through itself", h.Name)
			}
		}
	}
	return cfg, nil
}

func (c *Config) HostNames() []string {
	names := make([]string, 0, len(c.Hosts))
	for n := range c.Hosts {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func dataDir() string {
	if d := strings.TrimSpace(os.Getenv("OPS_DATA_DIR")); d != "" {
		return d
	}
	return filepath.Join(os.TempDir(), "ops-mcp")
}
