const crypto = require('crypto')

const {
  extractTokenFromPassword,
  verifyCredentials,
  verifyAppCredentials,
  isAllowedApp,
  exchangeCode,
  revokeToken,
  buildAuthResult
} = require('./lib/mastodon')
const { buildServers, resolveServerForLogin } = require('./lib/servers')

const NPM_NAME = 'peertube-plugin-auth-mastodon'
const TOKEN_AUTH_NAME = 'mastodon-token'

const COOKIE_PREFIX = 'peertube-auth-mastodon-'
const COOKIE_MAX_AGE_MS = 1000 * 60 * 10

const SETTING_NAMES = [
  'mastodon-url',
  'allowed-app-ids',
  'auth-display-name',
  'client-id',
  'client-secret',
  'mastodon-servers'
]

const store = {
  // authName -> { server, userAuthenticated }
  webAuths: new Map()
}

async function register ({
  registerIdAndPassAuth,
  registerExternalAuth,
  unregisterExternalAuth,
  registerSetting,
  registerHook,
  settingsManager,
  peertubeHelpers,
  getRouter
}) {
  const { logger } = peertubeHelpers

  registerSetting({
    name: 'mastodon-url',
    label: 'Default Mastodon server URL',
    type: 'input',
    private: true,
    descriptionHTML: 'Example: <code>https://mastodon.example</code>. ' +
      'App token logins with a plain username (<code>alice</code>) use this server. ' +
      'To accept accounts of more servers, add them in "Additional Mastodon servers" below.'
  })
  registerSetting({
    name: 'allowed-app-ids',
    label: 'Allowed Mastodon app IDs on the default server (app token login)',
    type: 'input',
    private: true,
    descriptionHTML: 'IDs of the Mastodon apps whose tokens can sign in, separated by commas. ' +
      'Token sign-in is refused while this is empty. The web login button is not affected.'
  })
  registerSetting({
    name: 'auth-display-name',
    label: 'Login button label for the default server',
    type: 'input',
    private: true,
    default: 'Sign in with Mastodon'
  })
  registerSetting({
    name: 'client-id',
    label: 'Mastodon OAuth client ID for the default server (web button only)',
    type: 'input',
    private: true,
    descriptionHTML: 'Leave the client ID and secret empty to disable the web login button and keep only app token login. ' +
      'Redirect URI to register on Mastodon: <code>' + getRedirectUrl(peertubeHelpers) + '</code>, scope <code>profile</code>.'
  })
  registerSetting({
    name: 'client-secret',
    label: 'Mastodon OAuth client secret for the default server (web button only)',
    type: 'input-password',
    private: true
  })
  registerSetting({
    name: 'mastodon-servers',
    label: 'Additional Mastodon servers',
    type: 'input-textarea',
    private: true,
    descriptionHTML: 'JSON array, one object per server. Only <code>url</code> is required:<br>' +
      '<code>[{"url": "https://other.example", "allowedAppIds": "12, 34", "clientId": "...", "clientSecret": "...", ' +
      '"buttonLabel": "Sign in with other.example", "domain": "example.com"}]</code><br>' +
      'Apps sign in to these servers with the username <code>alice@other.example</code>. ' +
      '<code>domain</code> is only needed when account handles use another domain than <code>url</code>. ' +
      'Each server with a client ID and secret gets its own login button, using the same redirect URI as above.'
  })

  // Apps: POST /api/v1/users/token with grant_type=password, username=<mastodon username>[@<server>],
  // password=mastodon:<mastodon access token>
  registerIdAndPassAuth({
    authName: TOKEN_AUTH_NAME,
    getWeight: () => 60,
    login: body => loginWithMastodonToken(body, { settingsManager, logger })
  })

  // PeerTube rejects passwords over 50 characters after the auth plugins ran, and "mastodon:" + a Mastodon
  // token is longer than that. Once this plugin accepted the login the password is not needed anymore
  registerHook({
    target: 'filter:oauth.password-grant.get-user.params',
    handler: params => dropPasswordOfTokenLogin(params)
  })

  getRouter().get('/callback', (req, res) => handleCallback(req, res, { peertubeHelpers }))

  await loadExternalAuths({ registerExternalAuth, unregisterExternalAuth, settingsManager, peertubeHelpers })

  settingsManager.onSettingsChange(() => {
    loadExternalAuths({ registerExternalAuth, unregisterExternalAuth, settingsManager, peertubeHelpers })
      .catch(err => logger.error('Cannot reload Mastodon external auth after settings change.', { err }))
  })
}

async function unregister () {
  store.webAuths = new Map()
}

module.exports = {
  register,
  unregister
}

// ---------------------------------------------------------------------------

async function loginWithMastodonToken ({ id, password }, { settingsManager, logger }) {
  // Not a Mastodon token: let PeerTube try its other auth methods (local password, other plugins)
  const accessToken = extractTokenFromPassword(password)
  if (!accessToken) return null

  const servers = buildServers(await settingsManager.getSettings(SETTING_NAMES), logger)
  if (servers.length === 0) {
    logger.warn('Mastodon token login attempted but no Mastodon server is set.')
    return null
  }

  const target = resolveServerForLogin(servers, id)
  if (!target) {
    logger.info('Mastodon token login rejected for %s: not an account of a configured Mastodon server.', id)
    return null
  }

  const { server, username } = target

  if (server.allowedAppIds.length === 0) {
    logger.warn('Mastodon token login attempted on %s but no allowed Mastodon app IDs are set for it.', server.host)
    return null
  }

  let account
  try {
    account = await verifyCredentials(server.baseUrl, accessToken)
  } catch (err) {
    logger.info('Mastodon token login rejected for %s: %s', id, err.message)
    return null
  }

  if (typeof account?.username !== 'string' || username.toLowerCase() !== account.username.toLowerCase()) {
    logger.info('Mastodon token login rejected: username %s does not match token owner %s.', id, account?.username)
    return null
  }

  let app
  try {
    app = await verifyAppCredentials(server.baseUrl, accessToken)
  } catch (err) {
    logger.info('Mastodon token login rejected for %s: %s', id, err.message)
    return null
  }

  if (!isAllowedApp(app, server.allowedAppIds)) {
    logger.info('Mastodon token login rejected for %s: token was issued to app %s, which is not allowed.', id, app?.id)
    return null
  }

  return buildAuthResult(account, server.baseUrl)
}

function dropPasswordOfTokenLogin (params) {
  const { bypassLogin } = params
  if (bypassLogin?.bypass !== true || bypassLogin.pluginName !== NPM_NAME || bypassLogin.authName !== TOKEN_AUTH_NAME) {
    return params
  }

  return { ...params, password: undefined }
}

// ---------------------------------------------------------------------------

async function loadExternalAuths ({ registerExternalAuth, unregisterExternalAuth, settingsManager, peertubeHelpers }) {
  const { logger } = peertubeHelpers

  for (const authName of store.webAuths.keys()) {
    unregisterExternalAuth(authName)
  }
  store.webAuths = new Map()

  const servers = buildServers(await settingsManager.getSettings(SETTING_NAMES), logger)
  const webServers = servers.filter(s => s.webLoginEnabled)

  if (webServers.length === 0) {
    logger.info('Mastodon web login button disabled: no Mastodon server has a client ID and secret.')
    return
  }

  for (const server of webServers) {
    const result = registerExternalAuth({
      authName: server.authName,
      authDisplayName: () => server.buttonLabel,
      onAuthRequest: (req, res) => handleAuthRequest(req, res, { server, peertubeHelpers })
    })

    store.webAuths.set(server.authName, { server, userAuthenticated: result.userAuthenticated })
  }
}

function handleAuthRequest (req, res, { server, peertubeHelpers }) {
  try {
    const state = randomString()
    const codeVerifier = randomString()
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

    const cookieOptions = { ...buildCookieOptions(peertubeHelpers), maxAge: COOKIE_MAX_AGE_MS }
    res.cookie(COOKIE_PREFIX + 'state', state, cookieOptions)
    res.cookie(COOKIE_PREFIX + 'verifier', codeVerifier, cookieOptions)
    res.cookie(COOKIE_PREFIX + 'server', server.authName, cookieOptions)

    const url = new URL(`${server.baseUrl}/oauth/authorize`)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: server.clientId,
      redirect_uri: getRedirectUrl(peertubeHelpers),
      scope: 'profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    }).toString()

    return res.redirect(url.href)
  } catch (err) {
    peertubeHelpers.logger.error('Cannot start Mastodon web login.', { err })
    return redirectOnError(res)
  }
}

async function handleCallback (req, res, { peertubeHelpers }) {
  const { logger } = peertubeHelpers

  const expectedState = req.cookies?.[COOKIE_PREFIX + 'state']
  const codeVerifier = req.cookies?.[COOKIE_PREFIX + 'verifier']
  const authName = req.cookies?.[COOKIE_PREFIX + 'server']

  const cookieOptions = buildCookieOptions(peertubeHelpers)
  res.clearCookie(COOKIE_PREFIX + 'state', cookieOptions)
  res.clearCookie(COOKIE_PREFIX + 'verifier', cookieOptions)
  res.clearCookie(COOKIE_PREFIX + 'server', cookieOptions)

  const webAuth = typeof authName === 'string' ? store.webAuths.get(authName) : undefined
  if (!webAuth) {
    logger.error('Received Mastodon callback but the web login is not enabled for this server.')
    return redirectOnError(res)
  }

  const { code, state } = req.query
  if (typeof code !== 'string' || typeof state !== 'string' || !expectedState || !codeVerifier || !safeEqual(state, expectedState)) {
    logger.info('Mastodon callback rejected: missing code or state mismatch.')
    return redirectOnError(res)
  }

  const { server, userAuthenticated } = webAuth

  try {
    const clientOptions = { clientId: server.clientId, clientSecret: server.clientSecret }

    const accessToken = await exchangeCode(server.baseUrl, {
      ...clientOptions,
      code,
      codeVerifier,
      redirectUri: getRedirectUrl(peertubeHelpers)
    })

    const account = await verifyCredentials(server.baseUrl, accessToken)

    // We only needed the token to identify the user
    revokeToken(server.baseUrl, { ...clientOptions, token: accessToken })
      .catch(err => logger.debug('Cannot revoke Mastodon token after web login.', { err }))

    return userAuthenticated({ req, res, ...buildAuthResult(account, server.baseUrl) })
  } catch (err) {
    logger.error('Mastodon web login failed.', { err })
    return redirectOnError(res)
  }
}

// ---------------------------------------------------------------------------

function getRedirectUrl (peertubeHelpers) {
  return `${peertubeHelpers.config.getWebserverUrl()}/plugins/auth-mastodon/router/callback`
}

function buildCookieOptions (peertubeHelpers) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: peertubeHelpers.config.getWebserverUrl().startsWith('https://'),
    path: '/plugins/auth-mastodon'
  }
}

function redirectOnError (res) {
  res.redirect('/login?externalAuthError=true')
}

function randomString () {
  return crypto.randomBytes(32).toString('base64url')
}

function safeEqual (a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)

  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}
