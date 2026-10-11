package main

import (
	"fmt"
	"strings"
)

// Read-only hosts (FreePBX first of all: David decides every change to the
// clinic's PBX) accept a pipeline of inspection commands and nothing else.
// The check is deliberately conservative: anything it cannot classify is
// refused, and the refusal says so, so the agent asks instead of guessing.

var readOnlyCommands = map[string]bool{
	"cat": true, "ls": true, "grep": true, "egrep": true, "zgrep": true, "zcat": true,
	"tail": true, "head": true, "wc": true, "df": true, "du": true, "free": true,
	"uptime": true, "ps": true, "top": true, "uname": true, "hostname": true,
	"date": true, "whoami": true, "id": true, "stat": true, "find": true,
	"sort": true, "uniq": true, "cut": true, "awk": true, "sed": true, "jq": true,
	"journalctl": true, "ss": true, "ip": true, "lsblk": true, "md5sum": true,
	"sha256sum": true, "file": true, "less": false, "echo": true,
}

// Sub-command allow-lists for tools that can both read and change state.
var readOnlySubcommands = map[string][]string{
	"systemctl": {"status", "is-active", "is-enabled", "list-units", "list-timers", "show"},
	"docker":    {"ps", "logs", "inspect", "images", "stats --no-stream", "compose ps", "compose logs", "compose config", "version", "info"},
	"fwconsole": {"--version", "ma list", "ma showupgrades", "chown --help"},
	"git":       {"log", "status", "show", "diff", "rev-parse"},
}

var forbiddenTokens = []string{";", "&&", "||", "`", "$(", ">", "<(", "\n", "&"}

func checkReadOnly(command string) error {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return fmt.Errorf("empty command")
	}
	for _, tok := range forbiddenTokens {
		if strings.Contains(cmd, tok) {
			return fmt.Errorf("read-only host: %q is not allowed (no chaining, redirection or background jobs)", tok)
		}
	}
	for _, segment := range strings.Split(cmd, "|") {
		if err := checkReadOnlySegment(strings.TrimSpace(segment)); err != nil {
			return err
		}
	}
	return nil
}

func checkReadOnlySegment(seg string) error {
	fields := strings.Fields(seg)
	if len(fields) == 0 {
		return fmt.Errorf("empty pipeline segment")
	}
	name := fields[0]
	if name == "sudo" {
		return fmt.Errorf("read-only host: sudo is not allowed")
	}
	rest := strings.Join(fields[1:], " ")
	switch name {
	case "sed":
		if strings.Contains(rest, "-i") {
			return fmt.Errorf("read-only host: sed -i edits files")
		}
	case "find":
		for _, f := range fields[1:] {
			if f == "-delete" || f == "-exec" || f == "-execdir" || f == "-ok" {
				return fmt.Errorf("read-only host: find %s is not allowed", f)
			}
		}
	case "awk":
		if strings.Contains(rest, "system(") || strings.Contains(rest, "print >") {
			return fmt.Errorf("read-only host: awk with system() or output redirection")
		}
	case "asterisk":
		// asterisk -rx "<cli command>": only show/status/list CLI commands.
		if !strings.HasPrefix(rest, "-rx ") {
			return fmt.Errorf("read-only host: only asterisk -rx \"<show command>\" is allowed")
		}
		cli := strings.Trim(strings.TrimSpace(strings.TrimPrefix(rest, "-rx ")), `"'`)
		words := strings.Fields(cli)
		ok := false
		for _, w := range words {
			if w == "show" || w == "status" || w == "list" {
				ok = true
			}
			if w == "reload" || w == "restart" || w == "stop" || w == "set" || w == "originate" || w == "hangup" {
				return fmt.Errorf("read-only host: asterisk %q changes the PBX", cli)
			}
		}
		if !ok {
			return fmt.Errorf("read-only host: asterisk CLI %q is not a show/status/list command", cli)
		}
		return nil
	case "mysql":
		// mysql -e "SELECT ...": a single read query.
		idx := strings.Index(rest, "-e")
		if idx < 0 {
			return fmt.Errorf("read-only host: mysql needs -e \"SELECT ...\"")
		}
		q := strings.ToUpper(strings.Trim(strings.TrimSpace(rest[idx+2:]), `"'`))
		if !(strings.HasPrefix(q, "SELECT") || strings.HasPrefix(q, "SHOW") || strings.HasPrefix(q, "DESCRIBE")) {
			return fmt.Errorf("read-only host: only SELECT/SHOW/DESCRIBE queries")
		}
		for _, bad := range []string{"INTO OUTFILE", "INTO DUMPFILE", "FOR UPDATE"} {
			if strings.Contains(q, bad) {
				return fmt.Errorf("read-only host: %s is not allowed", bad)
			}
		}
		return nil
	}
	if subs, ok := readOnlySubcommands[name]; ok {
		for _, s := range subs {
			if rest == s || strings.HasPrefix(rest, s+" ") {
				return nil
			}
		}
		return fmt.Errorf("read-only host: %s %q is not an inspection command", name, firstWords(rest, 2))
	}
	if !readOnlyCommands[name] {
		return fmt.Errorf("read-only host: %q is not on the inspection allow-list; ask David to run changes on this host", name)
	}
	return nil
}

func firstWords(s string, n int) string {
	f := strings.Fields(s)
	if len(f) > n {
		f = f[:n]
	}
	return strings.Join(f, " ")
}
