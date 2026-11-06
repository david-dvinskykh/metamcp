package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Public constants of the Bring! web app; the API rejects requests without them.
const (
	defaultAPIBase    = "https://api.getbring.com/rest/v2/"
	defaultLocaleBase = "https://web.getbring.com/locale/"
	bringAPIKey       = "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp"
)

// session is what a login returns; it is cached on disk so that each new
// process MetaMCP spawns can skip the login round trip.
type session struct {
	Email        string    `json:"email"`
	UUID         string    `json:"uuid"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	DefaultList  string    `json:"bringListUUID,omitempty"`
}

func (s *session) valid(now time.Time) bool {
	return s != nil && s.AccessToken != "" && s.UUID != "" && now.Before(s.ExpiresAt)
}

// APIError is a non-2xx answer from Bring!.
type APIError struct {
	Method, Path string
	Status       int
	Body         string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("Bring! API %s %s failed (%d): %s", e.Method, e.Path, e.Status, e.Body)
}

// Client is a minimal Bring! API client: one keep-alive HTTP client, lazy
// login, token refresh, one retry after a 401.
type Client struct {
	email, password string
	apiBase         string
	localeBase      string
	cacheFile       string // "" disables the on-disk session cache
	http            *http.Client
	now             func() time.Time

	mu   sync.Mutex
	sess *session
}

func NewClient(email, password, cacheFile string) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConnsPerHost = 8
	tr.IdleConnTimeout = 90 * time.Second
	return &Client{
		email:      email,
		password:   password,
		apiBase:    defaultAPIBase,
		localeBase: defaultLocaleBase,
		cacheFile:  cacheFile,
		http:       &http.Client{Transport: tr, Timeout: 30 * time.Second},
		now:        time.Now,
	}
}

var errNoCredentials = errors.New("missing BRING_EMAIL or BRING_PASSWORD environment variables")

// auth returns a valid session, loading it from the cache, refreshing or
// logging in as needed.
func (c *Client) auth(ctx context.Context, force bool) (*session, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.email == "" || c.password == "" {
		return nil, errNoCredentials
	}
	now := c.now()
	if !force && c.sess.valid(now) {
		return c.sess, nil
	}
	if !force && c.sess == nil {
		if s := c.loadCache(); s.valid(now) {
			c.sess = s
			return s, nil
		} else if s != nil {
			c.sess = s // expired, but its refresh token may still work
		}
	}
	if c.sess != nil && c.sess.RefreshToken != "" {
		if s, err := c.refresh(ctx, c.sess); err == nil {
			c.setSession(s)
			return s, nil
		}
	}
	s, err := c.login(ctx)
	if err != nil {
		return nil, err
	}
	c.setSession(s)
	return s, nil
}

func (c *Client) setSession(s *session) {
	c.sess = s
	c.saveCache(s)
}

type authResponse struct {
	UUID         string `json:"uuid"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	ListUUID     string `json:"bringListUUID"`
	Error        string `json:"error"`
	Message      string `json:"message"`
}

func (c *Client) login(ctx context.Context) (*session, error) {
	form := url.Values{"email": {c.email}, "password": {c.password}}
	ar, err := c.postAuth(ctx, "bringauth", form, nil)
	if err != nil {
		return nil, fmt.Errorf("cannot login: %w", err)
	}
	return c.toSession(ar, nil), nil
}

func (c *Client) refresh(ctx context.Context, old *session) (*session, error) {
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {old.RefreshToken}}
	ar, err := c.postAuth(ctx, "bringauth/token", form, old)
	if err != nil {
		return nil, err
	}
	return c.toSession(ar, old), nil
}

func (c *Client) postAuth(ctx context.Context, path string, form url.Values, old *session) (*authResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiBase+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	c.baseHeaders(req)
	if old != nil {
		req.Header.Set("X-BRING-USER-UUID", old.UUID)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var ar authResponse
	_ = json.Unmarshal(body, &ar)
	if resp.StatusCode/100 != 2 || ar.Error != "" || ar.AccessToken == "" {
		msg := ar.Message
		if msg == "" {
			msg = truncate(string(body), 300)
		}
		return nil, &APIError{Method: http.MethodPost, Path: "/" + path, Status: resp.StatusCode, Body: msg}
	}
	return &ar, nil
}

func (c *Client) toSession(ar *authResponse, old *session) *session {
	s := &session{Email: c.email, UUID: ar.UUID, AccessToken: ar.AccessToken, RefreshToken: ar.RefreshToken, DefaultList: ar.ListUUID}
	if old != nil {
		if s.UUID == "" {
			s.UUID = old.UUID
		}
		if s.RefreshToken == "" {
			s.RefreshToken = old.RefreshToken
		}
		if s.DefaultList == "" {
			s.DefaultList = old.DefaultList
		}
	}
	exp := jwtExpiry(ar.AccessToken)
	if exp.IsZero() && ar.ExpiresIn > 0 {
		exp = c.now().Add(time.Duration(ar.ExpiresIn) * time.Second)
	}
	if exp.IsZero() {
		exp = c.now().Add(time.Hour)
	}
	// Renew a few minutes early so a call never races the expiry.
	s.ExpiresAt = exp.Add(-5 * time.Minute)
	return s
}

// jwtExpiry reads the exp claim of a JWT without verifying it.
func jwtExpiry(tok string) time.Time {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return time.Time{}
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Exp == 0 {
		return time.Time{}
	}
	return time.Unix(claims.Exp, 0)
}

func (c *Client) loadCache() *session {
	if c.cacheFile == "" {
		return nil
	}
	b, err := os.ReadFile(c.cacheFile)
	if err != nil {
		return nil
	}
	var s session
	if json.Unmarshal(b, &s) != nil || s.Email != c.email {
		return nil
	}
	return &s
}

// saveCache is best effort: a read-only disk only costs a login per process.
func (c *Client) saveCache(s *session) {
	if c.cacheFile == "" || s == nil {
		return
	}
	b, err := json.Marshal(s)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(c.cacheFile), 0o700); err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.cacheFile), ".session-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), c.cacheFile) != nil {
		os.Remove(tmp.Name())
	}
}

func (c *Client) baseHeaders(req *http.Request) {
	req.Header.Set("X-BRING-API-KEY", bringAPIKey)
	req.Header.Set("X-BRING-CLIENT", "webApp")
	req.Header.Set("X-BRING-CLIENT-SOURCE", "webApp")
	req.Header.Set("X-BRING-COUNTRY", "DE")
	req.Header.Set("Accept", "application/json")
}

// do sends an authenticated request to the API. path is relative to the API
// base; {user} is replaced with the user's uuid. On 401 it logs in again and
// retries once.
func (c *Client) do(ctx context.Context, method, path, contentType string, body []byte) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		s, err := c.auth(ctx, attempt > 0)
		if err != nil {
			return nil, err
		}
		p := strings.ReplaceAll(path, "{user}", url.PathEscape(s.UUID))
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.apiBase+p, rd)
		if err != nil {
			return nil, err
		}
		c.baseHeaders(req)
		req.Header.Set("X-BRING-USER-UUID", s.UUID)
		req.Header.Set("Authorization", "Bearer "+s.AccessToken)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		out, rerr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if rerr != nil {
			return nil, rerr
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			continue
		}
		if resp.StatusCode/100 != 2 {
			return nil, &APIError{Method: method, Path: "/" + strings.SplitN(p, "?", 2)[0], Status: resp.StatusCode, Body: truncate(string(out), 300)}
		}
		return out, nil
	}
}

func (c *Client) getJSON(ctx context.Context, path string) (json.RawMessage, error) {
	b, err := c.do(ctx, http.MethodGet, path, "", nil)
	if err != nil {
		return nil, err
	}
	return asJSON(b)
}

// getPublic fetches the unauthenticated locale files (catalog, translations).
func (c *Client) getPublic(ctx context.Context, file string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.localeBase+file, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, &APIError{Method: http.MethodGet, Path: "/locale/" + file, Status: resp.StatusCode, Body: truncate(string(b), 300)}
	}
	return asJSON(b)
}

func asJSON(b []byte) (json.RawMessage, error) {
	b = bytes.TrimSpace(b)
	if len(b) == 0 {
		return json.RawMessage("null"), nil
	}
	if !json.Valid(b) {
		return nil, fmt.Errorf("unexpected non-JSON answer: %s", truncate(string(b), 200))
	}
	return json.RawMessage(b), nil
}

// --- API calls --------------------------------------------------------------

func (c *Client) LoadLists(ctx context.Context) (json.RawMessage, error) {
	return c.getJSON(ctx, "bringusers/{user}/lists")
}

func (c *Client) GetItems(ctx context.Context, list string) (json.RawMessage, error) {
	raw, err := c.getJSON(ctx, "bringlists/"+url.PathEscape(list))
	if err != nil {
		return nil, err
	}
	return addItemIDs(raw)
}

// addItemIDs copies each item's name into itemId, as the TypeScript server
// did: the legacy endpoints address items by name.
func addItemIDs(raw json.RawMessage) (json.RawMessage, error) {
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return raw, nil
	}
	for _, key := range []string{"purchase", "recently"} {
		var items []map[string]any
		if v, ok := doc[key]; !ok || json.Unmarshal(v, &items) != nil {
			continue
		}
		for _, it := range items {
			if name, ok := it["name"]; ok {
				it["itemId"] = name
			}
		}
		b, err := json.Marshal(items)
		if err != nil {
			return nil, err
		}
		doc[key] = b
	}
	return json.Marshal(doc)
}

func (c *Client) GetItemsDetails(ctx context.Context, list string) (json.RawMessage, error) {
	return c.getJSON(ctx, "bringlists/"+url.PathEscape(list)+"/details")
}

func (c *Client) GetAllUsersFromList(ctx context.Context, list string) (json.RawMessage, error) {
	return c.getJSON(ctx, "bringlists/"+url.PathEscape(list)+"/users")
}

func (c *Client) GetUserSettings(ctx context.Context) (json.RawMessage, error) {
	return c.getJSON(ctx, "bringusersettings/{user}")
}

func (c *Client) GetPendingInvitations(ctx context.Context) (json.RawMessage, error) {
	return c.getJSON(ctx, "bringusers/{user}/invitations?status=pending")
}

func (c *Client) LoadTranslations(ctx context.Context, locale string) (json.RawMessage, error) {
	return c.getPublic(ctx, "articles."+url.PathEscape(locale)+".json")
}

func (c *Client) LoadCatalog(ctx context.Context, locale string) (json.RawMessage, error) {
	return c.getPublic(ctx, "catalog."+url.PathEscape(locale)+".json")
}

// mutate calls the legacy list-mutation endpoint with properly escaped form
// fields (names with &, + or % survive).
func (c *Client) mutate(ctx context.Context, list string, fields map[string]string) error {
	form := url.Values{"purchase": {""}, "recently": {""}, "specification": {""}, "remove": {""}, "sender": {"null"}}
	for k, v := range fields {
		form.Set(k, v)
	}
	_, err := c.do(ctx, http.MethodPut, "bringlists/"+url.PathEscape(list),
		"application/x-www-form-urlencoded; charset=UTF-8", []byte(form.Encode()))
	return err
}

func (c *Client) SaveItem(ctx context.Context, list, name, spec string) error {
	return c.mutate(ctx, list, map[string]string{"purchase": name, "specification": spec})
}

func (c *Client) RemoveItem(ctx context.Context, list, name string) error {
	return c.mutate(ctx, list, map[string]string{"remove": name})
}

func (c *Client) MoveToRecent(ctx context.Context, list, name string) error {
	return c.mutate(ctx, list, map[string]string{"recently": name})
}

func (c *Client) SaveItemImage(ctx context.Context, itemUUID, imageData string) (json.RawMessage, error) {
	form := url.Values{"imageData": {imageData}}
	b, err := c.do(ctx, http.MethodPut, "bringlistitemdetails/"+url.PathEscape(itemUUID)+"/image",
		"application/x-www-form-urlencoded; charset=UTF-8", []byte(form.Encode()))
	if err != nil {
		return nil, err
	}
	return asJSON(b)
}

func (c *Client) RemoveItemImage(ctx context.Context, itemUUID string) error {
	_, err := c.do(ctx, http.MethodDelete, "bringlistitemdetails/"+url.PathEscape(itemUUID)+"/image", "", nil)
	return err
}

// LoginDefaultList is the bringListUUID the login returned, if any.
func (c *Client) LoginDefaultList(ctx context.Context) string {
	s, err := c.auth(ctx, false)
	if err != nil {
		return ""
	}
	return s.DefaultList
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
