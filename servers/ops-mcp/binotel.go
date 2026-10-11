package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// Binotel (Kyiv branch telephony) speaks one JSON-over-POST API:
// POST https://api.binotel.com/api/4.0/<group>/<method>.json with key+secret
// in the body. The secret stays in this process; the model names a method.

var binotelMethodRe = regexp.MustCompile(`^[a-z0-9-]+/[a-z0-9-]+$`)

// Read methods are allowed outright. Anything else (originating calls,
// editing customers or routing) changes the clinic's phone system and needs
// BINOTEL_ALLOW_WRITE=true, which David sets only if he wants it.
var binotelReadPrefixes = []string{
	"stats/", "settings/list-of-", "settings/get-", "customers/list", "customers/take-by-",
	"customers/search", "customers/list-of-labels", "smsSending/list",
}

type BinotelClient struct {
	base string
	http *http.Client
}

func NewBinotelClient() *BinotelClient {
	return &BinotelClient{
		base: strings.TrimRight(envOr("BINOTEL_API_BASE", "https://api.binotel.com/api/4.0"), "/"),
		http: &http.Client{Timeout: 60 * time.Second},
	}
}

func binotelIsRead(method string) bool {
	for _, p := range binotelReadPrefixes {
		if strings.HasPrefix(method, p) {
			return true
		}
	}
	return false
}

func (b *BinotelClient) Call(ctx context.Context, method string, params map[string]any, maxBytes int) (json.RawMessage, bool, error) {
	if !binotelMethodRe.MatchString(method) {
		return nil, false, fmt.Errorf("method must look like 'stats/incoming-calls-for-period'")
	}
	if !binotelIsRead(method) && os.Getenv("BINOTEL_ALLOW_WRITE") != "true" {
		return nil, false, fmt.Errorf("binotel %s changes the phone system; it is disabled (BINOTEL_ALLOW_WRITE). Prepare the change and ask David", method)
	}
	key, secret := os.Getenv("BINOTEL_KEY"), os.Getenv("BINOTEL_SECRET")
	if key == "" || secret == "" {
		return nil, false, fmt.Errorf("BINOTEL_KEY / BINOTEL_SECRET are not set in this server's env")
	}
	body := map[string]any{}
	for k, v := range params {
		body[k] = v
	}
	body["key"], body["secret"] = key, secret
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/%s.json", b.base, method), bytes.NewReader(payload))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.http.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("binotel %s: %w", method, err)
	}
	defer resp.Body.Close()
	if maxBytes <= 0 {
		maxBytes = 256 * 1024
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, int64(maxBytes)+1))
	if err != nil {
		return nil, false, err
	}
	truncated := len(raw) > maxBytes
	if truncated {
		raw = raw[:maxBytes]
		return json.RawMessage(mustJSONString(string(raw))), true, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("binotel %s: HTTP %d: %s", method, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if !json.Valid(raw) {
		return json.RawMessage(mustJSONString(string(raw))), false, nil
	}
	return raw, false, nil
}

func mustJSONString(s string) []byte {
	b, _ := json.Marshal(s)
	return b
}
