package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const testList = "11111111-2222-3333-4444-555555555555"

type fakeBring struct {
	t       *testing.T
	logins  atomic.Int32
	refresh atomic.Int32
	reject  atomic.Int32 // number of upcoming API calls to answer with 401
	mu      sync.Mutex
	puts    []url.Values
	tokenN  atomic.Int32
}

func jwt(exp time.Time) string {
	enc := base64.RawURLEncoding
	payload, _ := json.Marshal(map[string]int64{"exp": exp.Unix()})
	return enc.EncodeToString([]byte(`{"alg":"none"}`)) + "." + enc.EncodeToString(payload) + ".sig"
}

func (f *fakeBring) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rest/v2/bringauth", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("email") != "me@example.com" || r.Form.Get("password") != "pw" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":"unauthorized","message":"bad credentials"}`)
			return
		}
		f.logins.Add(1)
		n := f.tokenN.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"uuid": "user-1", "access_token": jwt(time.Now().Add(time.Hour)) + fmt.Sprint(n),
			"refresh_token": "rt", "expires_in": 3600, "bringListUUID": testList})
	})
	mux.HandleFunc("POST /rest/v2/bringauth/token", func(w http.ResponseWriter, r *http.Request) {
		f.refresh.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"access_token": jwt(time.Now().Add(time.Hour)), "expires_in": 3600})
	})
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-BRING-API-KEY") != bringAPIKey || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") ||
				r.Header.Get("X-BRING-USER-UUID") != "user-1" {
				w.WriteHeader(401)
				return
			}
			if f.reject.Load() > 0 {
				f.reject.Add(-1)
				w.WriteHeader(401)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("GET /rest/v2/bringusers/user-1/lists", auth(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"lists":[{"listUuid":%q,"name":"Список продуктов","theme":"ch.publisheria.bring.theme.home"}]}`, testList)
	}))
	mux.HandleFunc("GET /rest/v2/bringlists/"+testList, auth(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"uuid":"`+testList+`","status":"SHARED","purchase":[{"name":"Milch","specification":"2 l"}],"recently":[{"name":"Brot","specification":""}]}`)
	}))
	mux.HandleFunc("PUT /rest/v2/bringlists/"+testList, auth(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		v, err := url.ParseQuery(string(b))
		if err != nil {
			f.t.Errorf("bad form %q: %v", b, err)
		}
		f.mu.Lock()
		f.puts = append(f.puts, v)
		f.mu.Unlock()
		w.WriteHeader(204)
	}))
	mux.HandleFunc("GET /rest/v2/bringusersettings/user-1", auth(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"usersettings":[{"key":"autoPush","value":"ON"}],"userlistsettings":[{"listUuid":%q,"usersettings":[{"key":"listArticleLanguage","value":"de-DE"}]}]}`, testList)
	}))
	mux.HandleFunc("GET /locale/catalog.de-DE.json", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"language":"de-DE","catalog":{"sections":[]}}`)
	})
	return mux
}

func newTestClient(t *testing.T, srv *httptest.Server, cache string) *Client {
	c := NewClient("me@example.com", "pw", cache)
	c.apiBase = srv.URL + "/rest/v2/"
	c.localeBase = srv.URL + "/locale/"
	return c
}

func setup(t *testing.T) (*fakeBring, *httptest.Server) {
	f := &fakeBring{t: t}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return f, srv
}

func TestLoginOnceAndSessionCacheAcrossProcesses(t *testing.T) {
	f, srv := setup(t)
	cache := filepath.Join(t.TempDir(), "session.json")
	ctx := context.Background()

	c1 := newTestClient(t, srv, cache)
	for i := 0; i < 3; i++ {
		if _, err := c1.LoadLists(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// A second process (new Client) reuses the cached session.
	c2 := newTestClient(t, srv, cache)
	if _, err := c2.LoadLists(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.logins.Load(); got != 1 {
		t.Fatalf("logins = %d, want 1", got)
	}
}

func TestRetryAfter401(t *testing.T) {
	f, srv := setup(t)
	c := newTestClient(t, srv, "")
	ctx := context.Background()
	if _, err := c.LoadLists(ctx); err != nil {
		t.Fatal(err)
	}
	f.reject.Store(1)
	if _, err := c.LoadLists(ctx); err != nil {
		t.Fatalf("after 401: %v", err)
	}
	if f.refresh.Load()+f.logins.Load() < 2 {
		t.Fatalf("expected a refresh or re-login after 401")
	}
}

func TestExpiredSessionIsRefreshed(t *testing.T) {
	f, srv := setup(t)
	c := newTestClient(t, srv, "")
	ctx := context.Background()
	if _, err := c.LoadLists(ctx); err != nil {
		t.Fatal(err)
	}
	c.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err := c.LoadLists(ctx); err != nil {
		t.Fatal(err)
	}
	if f.refresh.Load() != 1 || f.logins.Load() != 1 {
		t.Fatalf("refresh=%d logins=%d, want 1/1", f.refresh.Load(), f.logins.Load())
	}
}

func TestBadCredentials(t *testing.T) {
	_, srv := setup(t)
	c := newTestClient(t, srv, "")
	c.password = "wrong"
	_, err := c.LoadLists(context.Background())
	if err == nil || !strings.Contains(err.Error(), "bad credentials") {
		t.Fatalf("err = %v", err)
	}
}

// connect runs the MCP server in memory and returns a client session.
func connect(t *testing.T, bc *Client) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	srv := mcp.NewServer(&mcp.Implementation{Name: "bring-mcp", Version: "test"}, nil)
	(&Server{bc: bc}).register(srv)
	st, ct := mcp.NewInMemoryTransports()
	if _, err := srv.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cl := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil)
	cs, err := cl.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res.Content[0].(*mcp.TextContent).Text, res.IsError
}

func TestToolSetMatchesTypeScriptServer(t *testing.T) {
	_, srv := setup(t)
	cs := connect(t, newTestClient(t, srv, ""))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
		if tl.Description == "" {
			t.Errorf("%s: empty description", tl.Name)
		}
	}
	sort.Strings(names)
	want := []string{"deleteMultipleItemsFromList", "getAllUsersFromList", "getDefaultList", "getItems", "getItemsDetails",
		"getPendingInvitations", "getUserSettings", "loadCatalog", "loadLists", "loadTranslations", "moveToRecentList",
		"removeItem", "removeItemImage", "saveItem", "saveItemBatch", "saveItemImage"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools = %v\nwant %v", names, want)
	}
}

func TestToolsEndToEnd(t *testing.T) {
	f, srv := setup(t)
	cs := connect(t, newTestClient(t, srv, ""))

	out, isErr := call(t, cs, "getItems", map[string]any{"listUuid": testList})
	if isErr || !strings.Contains(out, `"itemId":"Milch"`) || !strings.Contains(out, `"itemId":"Brot"`) {
		t.Fatalf("getItems: %s", out)
	}

	out, isErr = call(t, cs, "saveItem", map[string]any{"listUuid": testList, "itemName": "Fish & Chips", "specification": "50% + extra"})
	if isErr {
		t.Fatalf("saveItem: %s", out)
	}
	out, isErr = call(t, cs, "saveItemBatch", map[string]any{"listUuid": testList, "items": []map[string]any{{"itemName": "Eier", "specification": "10"}, {"itemName": "Äpfel"}}})
	if isErr || !strings.Contains(out, `"count":2`) {
		t.Fatalf("saveItemBatch: %s", out)
	}
	out, isErr = call(t, cs, "deleteMultipleItemsFromList", map[string]any{"listUuid": testList, "itemNames": []string{"Eier", "Äpfel"}})
	if isErr {
		t.Fatalf("delete: %s", out)
	}
	if _, isErr = call(t, cs, "moveToRecentList", map[string]any{"listUuid": testList, "itemId": "Milch"}); isErr {
		t.Fatal("moveToRecentList failed")
	}

	f.mu.Lock()
	puts := f.puts
	f.mu.Unlock()
	if len(puts) != 6 {
		t.Fatalf("puts = %d, want 6", len(puts))
	}
	if puts[0].Get("purchase") != "Fish & Chips" || puts[0].Get("specification") != "50% + extra" || puts[0].Get("sender") != "null" {
		t.Fatalf("escaping broken: %v", puts[0])
	}
	got := map[string]string{}
	for _, p := range puts[1:5] {
		for _, k := range []string{"purchase", "remove"} {
			if v := p.Get(k); v != "" {
				got[k+":"+v] = p.Get("specification")
			}
		}
	}
	for _, k := range []string{"purchase:Eier", "purchase:Äpfel", "remove:Eier", "remove:Äpfel"} {
		if _, ok := got[k]; !ok {
			t.Errorf("missing %s in %v", k, got)
		}
	}
	if puts[5].Get("recently") != "Milch" {
		t.Fatalf("recently: %v", puts[5])
	}

	out, _ = call(t, cs, "getDefaultList", nil)
	if !strings.Contains(out, testList) {
		t.Fatalf("getDefaultList: %s", out)
	}
	out, _ = call(t, cs, "getUserSettings", nil)
	if !strings.Contains(out, `"listSettings":[{"listUuid":"`+testList) || !strings.Contains(out, `"key":"autoPush"`) {
		t.Fatalf("getUserSettings: %s", out)
	}
	out, isErr = call(t, cs, "loadCatalog", map[string]any{"locale": "de-DE"})
	if isErr || !strings.Contains(out, `"language":"de-DE"`) {
		t.Fatalf("loadCatalog: %s", out)
	}
}

func TestValidation(t *testing.T) {
	_, srv := setup(t)
	cs := connect(t, newTestClient(t, srv, ""))
	if out, isErr := call(t, cs, "getItems", map[string]any{"listUuid": "not-a-uuid"}); !isErr || !strings.Contains(out, "not a UUID") {
		t.Fatalf("got %v %s", isErr, out)
	}
	if out, isErr := call(t, cs, "saveItem", map[string]any{"listUuid": testList, "itemName": "  "}); !isErr {
		t.Fatalf("empty name accepted: %s", out)
	}
	if out, isErr := call(t, cs, "saveItemImage", map[string]any{"itemId": "x", "imageData": "%%%"}); !isErr {
		t.Fatalf("bad base64 accepted: %s", out)
	}
}

func TestMissingCredentialsDoNotCrash(t *testing.T) {
	cs := connect(t, NewClient("", "", ""))
	out, isErr := call(t, cs, "loadLists", nil)
	if !isErr || !strings.Contains(out, "BRING_EMAIL") {
		t.Fatalf("got %v %s", isErr, out)
	}
}
