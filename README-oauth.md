## OAuth

sequenceDiagram
    participant Client as MCP Client
    participant Auth as MetaMCP OAuth Server
    participant User as User/Browser
    participant API as MetaMCP API
    
    Note over Client,API: OAuth 2.1 Dynamic Registration & Authorization Flow
    
    Client->>Auth: POST /oauth/register<br/>{redirect_uris, client_name, ...}
    Auth-->>Client: {client_id, endpoints, security_note}
    
    Note over Client,Auth: PKCE Authorization Code Flow
    
    Client->>Client: Generate code_verifier & code_challenge
    Client->>User: Redirect to /oauth/authorize<br/>?client_id=...&code_challenge=...
    User->>Auth: GET /oauth/authorize (with PKCE)
    
    alt User Not Authenticated
        Auth-->>User: Redirect to /login
        User->>Auth: Login credentials
        Auth-->>User: Redirect back to authorize
    end
    
    Auth-->>User: Redirect to client<br/>?code=...&state=...
    User->>Client: Authorization code received
    
    Client->>Auth: POST /oauth/token<br/>{code, code_verifier, client_id}
    Auth->>Auth: Verify PKCE (S256)
    Auth-->>Client: {access_token, token_type, expires_in}
    
    Client->>API: API Request<br/>Authorization: Bearer {access_token}
    API-->>Client: Protected resource response
## Global endpoint

Every named endpoint puts its namespace in the URL (`/metamcp/<endpoint>/mcp`),
so a team needs one endpoint and one connector per namespace. The global
endpoint is a single URL the whole team can share instead:

```
https://<your-metamcp>/metamcp/mcp
```

Each member adds that same URL, signs in as themselves, and picks which of
their namespaces the connection serves. The choice is bound to the OAuth token,
so the URL stays the same while each token reaches only its own namespace.

How the choice is carried:

1. The client connects with no token and gets `401` with
   `WWW-Authenticate: Bearer scope="admin namespace",
   resource_metadata=".../.well-known/oauth-protected-resource/metamcp/mcp"`.
2. That document advertises the `namespace` scope, which marks this resource as
   one that needs a namespace chosen during authorization.
3. `/oauth/authorize` recognises the request (by the `resource` parameter, or by
   the `namespace` scope for clients that omit it), signs the user in if needed,
   and sends them to the namespace picker instead of issuing a code straight
   away.
4. The picked namespace is stored on the authorization code, moves to the access
   token, and is carried across every refresh.
5. Requests to `/metamcp/mcp` read the namespace from the token. The namespace is
   re-checked on each request, so a namespace that was deleted or handed to
   another user stops working immediately.

Notes:

- OAuth only. An API key carries no namespace, so it cannot authenticate here;
  use a named endpoint for API-key access.
- MetaMCP admin tools are never exposed on the global endpoint.
- A user may bind only a namespace they can already reach: their own, or a
  public one.
- To connect to a second namespace, add the same URL again and pick the other
  namespace; the two connections get separate tokens.
