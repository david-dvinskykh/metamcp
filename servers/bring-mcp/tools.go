package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tool names, descriptions and argument names match the TypeScript bring-mcp
// (npm bring-mcp 1.1.10) so existing prompts and MetaMCP tool overrides keep
// working after the swap.

type Server struct{ bc *Client }

const maxImageBytes = 5 << 20

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type noArgs struct{}

type listIn struct {
	ListUUID string `json:"listUuid" jsonschema:"UUID of the shopping list (from loadLists or getDefaultList)"`
}

type saveItemIn struct {
	ListUUID      string  `json:"listUuid" jsonschema:"UUID of the shopping list (from loadLists or getDefaultList)"`
	ItemName      string  `json:"itemName" jsonschema:"item name, e.g. Milk"`
	Specification *string `json:"specification,omitempty" jsonschema:"details such as quantity or type, e.g. 2 liters"`
}

type batchItem struct {
	ItemName      string  `json:"itemName" jsonschema:"item name"`
	Specification *string `json:"specification,omitempty" jsonschema:"quantity or type"`
}

type saveBatchIn struct {
	ListUUID string      `json:"listUuid" jsonschema:"UUID of the shopping list (from loadLists or getDefaultList)"`
	Items    []batchItem `json:"items" jsonschema:"items to add, at least one"`
}

type itemIn struct {
	ListUUID string `json:"listUuid" jsonschema:"UUID of the shopping list (from loadLists or getDefaultList)"`
	ItemID   string `json:"itemId" jsonschema:"item id as returned by getItems (equals the item name)"`
}

type deleteManyIn struct {
	ListUUID  string   `json:"listUuid" jsonschema:"UUID of the shopping list (from loadLists or getDefaultList)"`
	ItemNames []string `json:"itemNames" jsonschema:"names of the items to remove, at least one"`
}

type imageIn struct {
	ItemID    string `json:"itemId" jsonschema:"item UUID from getItemsDetails"`
	ImageData string `json:"imageData" jsonschema:"base64-encoded image, at most 5 MiB decoded"`
}

type imageItemIn struct {
	ItemID string `json:"itemId" jsonschema:"item UUID from getItemsDetails"`
}

type localeIn struct {
	Locale string `json:"locale" jsonschema:"the locale for the catalog, e.g. de-DE or en-US"`
}

type optLocaleIn struct {
	Locale string `json:"locale,omitempty" jsonschema:"the locale for translations, e.g. de-DE or fr-FR; default en-US"`
}

var (
	readOnly = &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: ptr(false), OpenWorldHint: ptr(true)}
	mutating = &mcp.ToolAnnotations{IdempotentHint: true, DestructiveHint: ptr(true), OpenWorldHint: ptr(true)}
)

func ptr[T any](v T) *T { return &v }

func result(v any) (*mcp.CallToolResult, any, error) {
	var b []byte
	switch t := v.(type) {
	case json.RawMessage:
		b = t
	default:
		var err error
		if b, err = json.Marshal(v); err != nil {
			return nil, nil, err
		}
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, nil, nil
}

func failure(msg string, err error) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: msg + ": " + err.Error()}}}, nil, nil
}

func checkList(id string) error {
	if !uuidRe.MatchString(id) {
		return fmt.Errorf("listUuid %q is not a UUID; call loadLists or getDefaultList first", id)
	}
	return nil
}

func nonEmpty(field, v string) error {
	if strings.TrimSpace(v) == "" {
		return fmt.Errorf("%s must not be empty", field)
	}
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// tool registers a handler with uniform error wrapping.
func tool[In any](srv *mcp.Server, name, desc string, ann *mcp.ToolAnnotations, fail string,
	fn func(context.Context, In) (any, error)) {
	mcp.AddTool(srv, &mcp.Tool{Name: name, Description: desc, Annotations: ann},
		func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
			out, err := fn(ctx, in)
			if err != nil {
				return failure(fail, err)
			}
			return result(out)
		})
}

// parallel runs fn for each index with at most n in flight and joins errors.
func parallel(count, n int, fn func(i int) error) error {
	errs := make([]error, count)
	sem := make(chan struct{}, n)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			errs[i] = fn(i)
		}(i)
	}
	wg.Wait()
	return errors.Join(errs...)
}

func (s *Server) register(srv *mcp.Server) {
	bc := s.bc

	tool(srv, "loadLists", "Load all shopping lists from Bring!", readOnly, "Failed to load lists",
		func(ctx context.Context, _ noArgs) (any, error) { return bc.LoadLists(ctx) })

	tool(srv, "getDefaultList", "Get the UUID of the default shopping list for the authenticated user. Use this if the user does not ask for a special list.",
		readOnly, "Failed to get default list UUID", s.defaultList)

	tool(srv, "getItems", "Get all items from a specific shopping list.", readOnly, "Failed to get items",
		func(ctx context.Context, in listIn) (any, error) {
			if err := checkList(in.ListUUID); err != nil {
				return nil, err
			}
			return bc.GetItems(ctx, in.ListUUID)
		})

	tool(srv, "getItemsDetails", "Get detailed item metadata for a shopping list.", readOnly, "Failed to get item details",
		func(ctx context.Context, in listIn) (any, error) {
			if err := checkList(in.ListUUID); err != nil {
				return nil, err
			}
			return bc.GetItemsDetails(ctx, in.ListUUID)
		})

	tool(srv, "saveItem", `Save an item to a shopping list. Use the "specification" parameter to add details like quantity or type (e.g., itemName: "Milk", specification: "2 liters").`,
		mutating, "Failed to save item",
		func(ctx context.Context, in saveItemIn) (any, error) {
			if err := errors.Join(checkList(in.ListUUID), nonEmpty("itemName", in.ItemName)); err != nil {
				return nil, err
			}
			if err := bc.SaveItem(ctx, in.ListUUID, in.ItemName, deref(in.Specification)); err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "listUuid": in.ListUUID, "itemName": in.ItemName, "specification": in.Specification}, nil
		})

	tool(srv, "saveItemBatch", `Save multiple items to a shopping list. For each item, you can provide an "itemName" and an optional "specification" for details like quantity or type (input e.g., [{ "itemName": "Eggs", "specification": "dozen" },{ "itemName":"Apples", "specification": "10" }]).`,
		mutating, "Failed to save batch items",
		func(ctx context.Context, in saveBatchIn) (any, error) {
			if err := checkList(in.ListUUID); err != nil {
				return nil, err
			}
			if len(in.Items) == 0 {
				return nil, errors.New("items must contain at least one item")
			}
			for i, it := range in.Items {
				if err := nonEmpty(fmt.Sprintf("items[%d].itemName", i), it.ItemName); err != nil {
					return nil, err
				}
			}
			if err := parallel(len(in.Items), 4, func(i int) error {
				it := in.Items[i]
				if err := bc.SaveItem(ctx, in.ListUUID, it.ItemName, deref(it.Specification)); err != nil {
					return fmt.Errorf("%s: %w", it.ItemName, err)
				}
				return nil
			}); err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "listUuid": in.ListUUID, "count": len(in.Items), "items": in.Items}, nil
		})

	tool(srv, "removeItem", "Remove an item from a specific shopping list.", mutating, "Failed to remove item",
		func(ctx context.Context, in itemIn) (any, error) {
			if err := errors.Join(checkList(in.ListUUID), nonEmpty("itemId", in.ItemID)); err != nil {
				return nil, err
			}
			if err := bc.RemoveItem(ctx, in.ListUUID, in.ItemID); err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "listUuid": in.ListUUID, "itemId": in.ItemID}, nil
		})

	tool(srv, "moveToRecentList", "Move an item from a shopping list to the recently used items list.", mutating, "Failed to move item to recent list",
		func(ctx context.Context, in itemIn) (any, error) {
			if err := errors.Join(checkList(in.ListUUID), nonEmpty("itemId", in.ItemID)); err != nil {
				return nil, err
			}
			if err := bc.MoveToRecent(ctx, in.ListUUID, in.ItemID); err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "listUuid": in.ListUUID, "itemId": in.ItemID}, nil
		})

	tool(srv, "deleteMultipleItemsFromList", "Delete multiple items from a specific shopping list by their names.", mutating, "Failed to delete multiple items",
		func(ctx context.Context, in deleteManyIn) (any, error) {
			if err := checkList(in.ListUUID); err != nil {
				return nil, err
			}
			if len(in.ItemNames) == 0 {
				return nil, errors.New("itemNames must contain at least one name")
			}
			for i, n := range in.ItemNames {
				if err := nonEmpty(fmt.Sprintf("itemNames[%d]", i), n); err != nil {
					return nil, err
				}
			}
			if err := parallel(len(in.ItemNames), 4, func(i int) error {
				if err := bc.RemoveItem(ctx, in.ListUUID, in.ItemNames[i]); err != nil {
					return fmt.Errorf("%s: %w", in.ItemNames[i], err)
				}
				return nil
			}); err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "listUuid": in.ListUUID, "count": len(in.ItemNames), "itemNames": in.ItemNames}, nil
		})

	tool(srv, "saveItemImage", "Save an image for an item. Provide the image as base64-encoded data (maximum decoded size: 5 MiB).", mutating, "Failed to save item image",
		func(ctx context.Context, in imageIn) (any, error) {
			if err := nonEmpty("itemId", in.ItemID); err != nil {
				return nil, err
			}
			n, err := base64.StdEncoding.DecodeString(in.ImageData)
			if err != nil || len(n) == 0 {
				return nil, errors.New("imageData must be non-empty standard base64")
			}
			if len(n) > maxImageBytes {
				return nil, fmt.Errorf("image is %d bytes; the limit is 5 MiB", len(n))
			}
			raw, err := bc.SaveItemImage(ctx, in.ItemID, in.ImageData)
			if err != nil {
				return nil, err
			}
			out := map[string]any{"success": true, "itemId": in.ItemID}
			var r struct {
				ImageURL string `json:"imageUrl"`
			}
			if json.Unmarshal(raw, &r) == nil && r.ImageURL != "" {
				out["imageUrl"] = r.ImageURL
			}
			return out, nil
		})

	tool(srv, "removeItemImage", "Remove an image from an item on a shopping list.", mutating, "Failed to remove item image",
		func(ctx context.Context, in imageItemIn) (any, error) {
			if err := nonEmpty("itemId", in.ItemID); err != nil {
				return nil, err
			}
			if err := bc.RemoveItemImage(ctx, in.ItemID); err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "itemId": in.ItemID}, nil
		})

	tool(srv, "getAllUsersFromList", "Get all users associated with a specific shopping list.", readOnly, "Failed to get all users from list",
		func(ctx context.Context, in listIn) (any, error) {
			if err := checkList(in.ListUUID); err != nil {
				return nil, err
			}
			return bc.GetAllUsersFromList(ctx, in.ListUUID)
		})

	tool(srv, "getUserSettings", "Get the settings for the current authenticated user.", readOnly, "Failed to get user settings",
		func(ctx context.Context, _ noArgs) (any, error) {
			raw, err := bc.GetUserSettings(ctx)
			if err != nil {
				return nil, err
			}
			return normalizeUserSettings(raw), nil
		})

	tool(srv, "getPendingInvitations", "Get any pending invitations for the authenticated user to join shopping lists.", readOnly, "Failed to get pending invitations",
		func(ctx context.Context, _ noArgs) (any, error) { return bc.GetPendingInvitations(ctx) })

	tool(srv, "loadTranslations", "Load translations for item names and other UI elements. Optionally specify a locale (e.g., 'de-DE', 'en-US'). Defaults to 'en-US'.",
		readOnly, "Failed to load translations",
		func(ctx context.Context, in optLocaleIn) (any, error) {
			loc := in.Locale
			if loc == "" {
				loc = "en-US"
			}
			return bc.LoadTranslations(ctx, loc)
		})

	tool(srv, "loadCatalog", "Load the Bring! catalog for a specific locale. This contains standard items.", readOnly, "Failed to load catalog",
		func(ctx context.Context, in localeIn) (any, error) {
			if err := nonEmpty("locale", in.Locale); err != nil {
				return nil, err
			}
			return bc.LoadCatalog(ctx, in.Locale)
		})
}

type setting struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type listSettings struct {
	ListUUID string    `json:"listUuid"`
	Settings []setting `json:"settings"`
}

type userSettings struct {
	Settings     []setting      `json:"settings"`
	ListSettings []listSettings `json:"listSettings"`
}

// normalizeUserSettings flattens Bring's {usersettings, userlistsettings}
// into {settings, listSettings}, as the TypeScript server did.
func normalizeUserSettings(raw json.RawMessage) userSettings {
	var src map[string]json.RawMessage
	_ = json.Unmarshal(raw, &src)
	pick := func(m map[string]json.RawMessage, keys ...string) json.RawMessage {
		for _, k := range keys {
			if v, ok := m[k]; ok {
				return v
			}
		}
		return nil
	}
	parse := func(v json.RawMessage) []setting {
		var rows []map[string]any
		_ = json.Unmarshal(v, &rows)
		out := []setting{}
		for _, r := range rows {
			k, ok1 := r["key"].(string)
			val, ok2 := r["value"].(string)
			if ok1 && ok2 {
				out = append(out, setting{k, val})
			}
		}
		return out
	}
	res := userSettings{Settings: parse(pick(src, "usersettings", "userSettings", "settings")), ListSettings: []listSettings{}}
	var lists []map[string]json.RawMessage
	_ = json.Unmarshal(pick(src, "userlistsettings", "userListSettings"), &lists)
	for _, l := range lists {
		var id string
		if json.Unmarshal(l["listUuid"], &id) != nil || id == "" {
			continue
		}
		res.ListSettings = append(res.ListSettings, listSettings{ListUUID: id, Settings: parse(pick(l, "usersettings", "userSettings", "settings"))})
	}
	return res
}

func (s *Server) defaultList(ctx context.Context, _ noArgs) (any, error) {
	raw, err := s.bc.GetUserSettings(ctx)
	if err != nil {
		return nil, err
	}
	us := normalizeUserSettings(raw)
	all := append([]setting{}, us.Settings...)
	for _, l := range us.ListSettings {
		all = append(all, l.Settings...)
	}
	for _, st := range all {
		if st.Key == "defaultListUUID" && st.Value != "" {
			return map[string]any{"listUuid": st.Value, "source": "configured"}, nil
		}
	}
	if id := s.bc.LoginDefaultList(ctx); id != "" {
		return map[string]any{"listUuid": id, "source": "account"}, nil
	}
	listsRaw, err := s.bc.LoadLists(ctx)
	if err != nil {
		return nil, err
	}
	var lists struct {
		Lists []struct {
			ListUUID string `json:"listUuid"`
		} `json:"lists"`
	}
	if json.Unmarshal(listsRaw, &lists) == nil && len(lists.Lists) == 1 && lists.Lists[0].ListUUID != "" {
		return map[string]any{"listUuid": lists.Lists[0].ListUUID, "source": "only-list"}, nil
	}
	return map[string]any{"listUuid": nil, "source": "not-configured",
		"message": "No default list is configured. Set one in the Bring app, or call loadLists to choose."}, nil
}
