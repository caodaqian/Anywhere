// MCP OAuth v1 OAuthClientProvider adapter + finishAuth orchestrator.
//
// Bridges:
//   - mcp_oauth_store.js (encrypted persistence of tokens/client/verifier)
//   - mcp_oauth_cb.js (callback capture + browser open)
// to the SDK's v1 OAuthClientProvider interface (auth.d.ts):
//   redirectUrl, clientMetadata, clientInformation(), saveClientInformation?(),
//   tokens(), saveTokens(), redirectToAuthorization(url),
//   codeVerifier(), saveCodeVerifier(v),
//   optional: state(), clientMetadataUrl?, invalidateCredentials?(scope)
//
// The SDK (StreamableHTTPClientTransport / SSEClientTransport) drives discovery,
// DCR, PKCE, and the 401 retry; our provider only supplies identity + storage +
// redirect handling. finishAuthFlow() is invoked by Phase B (mcp.js) when the
// SDK throws UnauthorizedError, to exchange the captured code for tokens.

const crypto = require('crypto');
const store = require('./mcp_oauth_store.js');
const cb = require('./mcp_oauth_cb.js');

const DEFAULT_REDIRECT_PORT = 0; // ephemeral loopback

// ---------------------------------------------------------------------------
// buildOAuthClientProvider
// ---------------------------------------------------------------------------

/**
 * Build a v1 OAuthClientProvider for a given MCP server.
 *
 * @param {string} serverId
 * @param {object} serverConfig - full server config (must contain auth.oauth)
 * @returns {object} OAuthClientProvider implementation
 */
function buildOAuthClientProvider(serverId, serverConfig = {}) {
  const oauth = (serverConfig.auth && serverConfig.auth.oauth) || {};
  const redirectPort = (oauth.redirectPath && Number(oauth.redirectPath)) || DEFAULT_REDIRECT_PORT;
  const redirectUri = cb.determineRedirectUri(redirectPort);

  // Bound state for the in-flight authorization (so the provider's
  // redirectToAuthorization and the orchestrator's runAuthFlowWithFallback
  // share the same expected state).
  let pendingState = null;

  const provider = {
    // --- required ---
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadata() {
      return {
        client_name: 'Anywhere MCP Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        token_endpoint_auth_method: oauth.clientSecret
          ? 'client_secret_post'
          : 'none'
      };
    },
    async clientInformation() {
      // Prefer user-supplied manual client (useDcr=false), else stored DCR result.
      if (oauth.clientId) {
        return {
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret || undefined,
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_method: oauth.clientSecret
            ? 'client_secret_post'
            : 'none'
        };
      }
      return await store.loadClientInfo(serverId);
    },
    async saveClientInformation(info) {
      await store.saveClientInfo(serverId, info);
    },
    async tokens() {
      return await store.loadTokens(serverId);
    },
    async saveTokens(tokens) {
      // The SDK calls this after token exchange; store also refreshes happen via SDK.
      await store.saveTokens(serverId, tokens);
    },
    async redirectToAuthorization(url) {
      // SDK hands us the fully-built authorize URL (with state, code_challenge).
      // Capture state from the URL so the callback runtime can validate it.
      try {
        const u = new URL(String(url));
        pendingState = u.searchParams.get('state') || pendingState;
      } catch (_) { /* ignore */ }
      cb.openAuthorizationInExternal(url);
    },
    async codeVerifier() {
      return await store.loadCodeVerifier(serverId);
    },
    async saveCodeVerifier(v) {
      await store.saveCodeVerifier(serverId, v);
    },

    // --- optional (v1) / forward-looking (v2) ---
    async state() {
      pendingState = crypto.randomBytes(16).toString('hex');
      return pendingState;
    },
    async invalidateCredentials(scope) {
      await store.invalidateCredentials(serverId, scope || 'all');
    },

    // --- exposed to orchestrator (not part of the interface contract) ---
    _serverId: serverId,
    _getPendingState() { return pendingState; },
    _redirectUri: redirectUri
  };

  return provider;
}

// ---------------------------------------------------------------------------
// finishAuthFlow — exchange captured code for tokens, then reconnect path
// ---------------------------------------------------------------------------

/**
 * Complete the authorization-code exchange using the SDK's auth() helper
 * (preferred) or the transport.finishAuth(code) method when a transport is
 * available (Phase B path A). After this, provider.tokens() returns the new
 * token set; the caller reconnects the MCP client.
 *
 * @param {object} args
 * @param {string} args.serverId
 * @param {object} args.provider - OAuthClientProvider from buildOAuthClientProvider
 * @param {object} args.serverConfig
 * @param {object} [args.transport] - SDK transport with finishAuth(code) (optional)
 * @param {object} args.callbackParams - { code, state, iss? } from callback runtime
 * @param {string} [args.serverUrl] - required when transport is null (for auth() helper)
 * @returns {Promise<{tokens:object}>}
 */
async function finishAuthFlow({ serverId, provider, serverConfig, transport, callbackParams, serverUrl }) {
  const { code } = callbackParams;
  if (!code) throw new Error('finishAuthFlow: missing authorization code');

  // Path A: transport available → use its finishAuth (SDK-managed).
  if (transport && typeof transport.finishAuth === 'function') {
    await transport.finishAuth(code);
    const tokens = await provider.tokens();
    return { tokens };
  }

  // Path B: no transport → call the SDK auth() helper directly to exchange.
  const { auth } = loadSdkAuth();
  const url = serverUrl || serverConfig?.url || serverConfig?.baseUrl;
  if (!url) throw new Error('finishAuthFlow: serverUrl required when transport is absent');
  const result = await auth(provider, {
    serverUrl: url,
    authorizationCode: code,
    scope: serverConfig?.auth?.oauth?.scopes?.join(' '),
    // resourceMetadataUrl left to SDK discovery
  });
  if (result !== 'AUTHORIZED') {
    // SDK throws UnauthorizedError internally on failure; reaching here means
    // a non-success result that didn't throw — surface it.
    const { UnauthorizedError } = loadSdkAuth();
    throw new UnauthorizedError('finishAuthFlow: authorization exchange did not complete');
  }
  const tokens = await provider.tokens();
  return { tokens };
}

// Resolve the SDK's CJS auth module. It's a transitive dependency (via
// @langchain/mcp-adapters), so we resolve it from the adapter's own directory
// so Node follows the adapter's dependency tree (under pnpm isolation the SDK
// lives in the adapter's scoped node_modules, not the top-level one).
function loadSdkAuth() {
  const subpaths = [
    '@modelcontextprotocol/sdk/client/auth.js',
    '@modelcontextprotocol/sdk/dist/cjs/client/auth.js'
  ];
  // First, try resolving each subpath from the adapter's location (its
  // require stack sees the scoped SDK).
  try {
    const adapterMain = require.resolve('@langchain/mcp-adapters');
    const adapterDir = require('path').dirname(adapterMain);
    for (const sub of subpaths) {
      try {
        const resolved = require.resolve(sub, { paths: [adapterDir] });
        return require(resolved);
      } catch (_) { /* try next */ }
    }
  } catch (_) { /* adapter not resolvable — fall through */ }
  // Fallback: resolve from this module's own directory (works if SDK is
  // hoisted to top-level or this module's tree can see it).
  for (const sub of subpaths) {
    try {
      const resolved = require.resolve(sub, { paths: [__dirname] });
      return require(resolved);
    } catch (_) { /* try next */ }
  }
  throw new Error('Could not resolve @modelcontextprotocol/sdk auth module');
}

// ---------------------------------------------------------------------------
// helpers for Phase B
// ---------------------------------------------------------------------------

function isUnauthorizedError(err) {
  if (!err) return false;
  if (err.name === 'UnauthorizedError') return true;
  // Duck-type (SDK error class identity may differ across resolutions).
  return err.message === 'Unauthorized' || /unauthorized/i.test(String(err.message));
}

/**
 * Build the full authorize URL ourselves is NOT needed — the SDK constructs it
 * during discovery+DCR and hands it to provider.redirectToAuthorization(). This
 * helper only exists to give Phase B a single entrypoint when it wants to
 * start the interactive flow on demand (prepareAuth). Currently it just returns
 * the provider so the caller can call the SDK auth() helper to trigger
 * discovery+DCR (which then calls redirectToAuthorization).
 */
function getProvider(serverId, serverConfig) {
  return buildOAuthClientProvider(serverId, serverConfig);
}

module.exports = {
  buildOAuthClientProvider,
  finishAuthFlow,
  isUnauthorizedError,
  getProvider,
  loadSdkAuth
};
