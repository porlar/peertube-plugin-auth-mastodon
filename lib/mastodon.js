const REQUEST_TIMEOUT_MS = 10000

// Mastodon tokens are passed in the password field with this prefix, so that ordinary
// PeerTube passwords (which core offers to every auth plugin) are never sent to Mastodon
const TOKEN_PASSWORD_PREFIX = 'mastodon:'

// PeerTube constraints (CONSTRAINTS_FIELDS.USERS)
const USERNAME_MAX_LENGTH = 50
const DISPLAY_NAME_MAX_LENGTH = 120

const USER_ROLE = 2 // Admin = 0, Moderator = 1, User = 2

function normalizeBaseUrl (value) {
  if (!value) return null

  const trimmed = value.trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  return new URL(withScheme).origin
}

function extractTokenFromPassword (password) {
  if (typeof password !== 'string' || !password.startsWith(TOKEN_PASSWORD_PREFIX)) return null

  const token = password.slice(TOKEN_PASSWORD_PREFIX.length).trim()
  return token || null
}

async function getWithToken (baseUrl, path, accessToken, fetchImpl) {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const err = new Error(`Mastodon ${path} returned HTTP ${res.status}`)
    err.status = res.status
    throw err
  }

  return res.json()
}

function verifyCredentials (baseUrl, accessToken, fetchImpl = fetch) {
  return getWithToken(baseUrl, '/api/v1/accounts/verify_credentials', accessToken, fetchImpl)
}

// Returns the Mastodon app the token was issued to
function verifyAppCredentials (baseUrl, accessToken, fetchImpl = fetch) {
  return getWithToken(baseUrl, '/api/v1/apps/verify_credentials', accessToken, fetchImpl)
}

function parseAllowedAppIds (value) {
  if (typeof value !== 'string') return []

  return value.split(/[\s,]+/).filter(Boolean)
}

// App names are not checked: anyone can register a Mastodon app with any name
function isAllowedApp (app, allowedAppIds) {
  if (app?.id === undefined || app?.id === null) return false

  return allowedAppIds.includes(String(app.id))
}

async function exchangeCode (baseUrl, { code, redirectUri, clientId, clientSecret, codeVerifier }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier
  })

  const res = await fetchImpl(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) throw new Error(`Mastodon token endpoint returned HTTP ${res.status}`)

  const json = await res.json()
  if (!json.access_token) throw new Error('Mastodon token endpoint did not return an access token')

  return json.access_token
}

async function revokeToken (baseUrl, { token, clientId, clientSecret }, fetchImpl = fetch) {
  await fetchImpl(`${baseUrl}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
}

// Maps a Mastodon Account entity to a PeerTube RegisterServerAuthenticatedResult
function buildAuthResult (account, baseUrl) {
  if (!account || !account.id || !account.username) {
    throw new Error('Mastodon account is missing id or username')
  }

  // Mastodon usernames are [A-Za-z0-9_], PeerTube ones are [a-z0-9._]
  const username = account.username
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '_')
    .slice(0, USERNAME_MAX_LENGTH)

  const displayName = (account.display_name || '').trim().slice(0, DISPLAY_NAME_MAX_LENGTH) || username

  // Mastodon never exposes the user's email to OAuth apps. Build a stable placeholder from the
  // account id (not the username) so a Mastodon rename does not collide with another account
  const host = new URL(baseUrl).hostname
  const email = `mastodon-${account.id}@${host}`

  return {
    username,
    email,
    displayName,
    role: USER_ROLE,
    // Users are matched on this first, so renaming the Mastodon account keeps the same PeerTube account
    externalId: `${host}:${account.id}`
  }
}

module.exports = {
  TOKEN_PASSWORD_PREFIX,
  normalizeBaseUrl,
  extractTokenFromPassword,
  verifyCredentials,
  verifyAppCredentials,
  parseAllowedAppIds,
  isAllowedApp,
  exchangeCode,
  revokeToken,
  buildAuthResult
}
