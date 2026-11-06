const crypto = require('crypto')

const {
  normalizeBaseUrl,
  extractTokenFromPassword,
  verifyCredentials,
  verifyAppCredentials,
  parseAllowedAppIds,
  isAllowedApp,
  exchangeCode,
  revokeToken,
  buildAuthResult
} = require('./lib/mastodon')

const NPM_NAME = 'peertube-plugin-auth-mastodon'
const TOKEN_AUTH_NAME = 'mastodon-token'
const EXTERNAL_AUTH_NAME = 'mastodon'

const COOKIE_PREFIX = 'peertube-auth-mastodon-'
const COOKIE_MAX_AGE_MS = 1000 * 60 * 10

const SETTING_NAMES = [ 'mastodon-url', 'auth-display-name', 'client-id', 'client-secret' ]

const store = {
  userAuthenticated: null,
  externalAuthRegistered: false
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
    label: 'Mastodon server URL',
    type: 'input',
    private: true,
    descriptionHTML: 'Example: <code>https://mastodon.example</code>. Only accounts of this server can sign in.'
  })
  registerSetting({
    name: 'allowed-app-ids',
    label: 'Allowed Mastodon app IDs (app token login)',
    type: 'input',
    private: true,
    descriptionHTML: 'IDs of the Mastodon apps whose tokens can sign in, separated by commas. ' +
      'Token sign-in is refused while this is empty. The web login button is not affected.'
  })
  registerSetting({
    name: 'auth-display-name',
    label: 'Login button label',
    type: 'input',
    private: true,
    default: 'Sign in with Mastodon'
  })
  registerSetting({
    name: 'client-id',
    label: 'Mastodon OAuth client ID (web button only)',
    type: 'input',
    private: true,
    descriptionHTML: 'Leave the client ID and secret empty to disable the web login button and keep only app token login. ' +
      'Redirect URI to register on Mastodon: <code>' + getRedirectUrl(peertubeHelpers) + '</code>, scope <code>profile</code>.'
  })
  registerSetting({
    name: 'client-secret',
    label: 'Mastodon OAuth client secret (web button only)',
    type: 'input-password',
    private: true
  })

  // Apps: POST /api/v1/users/token with grant_type=password, username=<mastodon username>, password=mastodon:<mastodon access token>
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

  getRouter().get('/callback', (req, res) => handleCallback(req, res, { settingsManager, peertubeHelpers }))

  await loadExternalAuth({ registerExternalAuth, unregisterExternalAuth, settingsManager, peertubeHelpers })

  settingsManager.onSettingsChange(() => {
    loadExternalAuth({ registerExternalAuth, unregisterExternalAuth, settingsManager, peertubeHelpers })
      .catch(err => logger.error('Cannot reload Mastodon external auth after settings change.', { err }))
  })
}

async function unregister () {
  store.userAuthenticated = null
  store.externalAuthRegistered = false
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

  const baseUrl = normalizeBaseUrl(await settingsManager.getSetting('mastodon-url'))
  if (!baseUrl) {
    logger.warn('Mastodon token login attempted but the Mastodon server URL is not set.')
    return null
  }

  const allowedAppIds = parseAllowedAppIds(await settingsManager.getSetting('allowed-app-ids'))
  if (allowedAppIds.length === 0) {
    logger.warn('Mastodon token login attempted but no allowed Mastodon app IDs are set.')
    return null
  }

  let account
  try {
    account = await verifyCredentials(baseUrl, accessToken)
  } catch (err) {
    logger.info('Mastodon token login rejected for %s: %s', id, err.message)
    return null
  }

  if (typeof id !== 'string' || id.toLowerCase() !== account.username.toLowerCase()) {
    logger.info('Mastodon token login rejected: username %s does not match token owner %s.', id, account.username)
    return null
  }

  let app
  try {
    app = await verifyAppCredentials(baseUrl, accessToken)
  } catch (err) {
    logger.info('Mastodon token login rejected for %s: %s', id, err.message)
    return null
  }

  if (!isAllowedApp(app, allowedAppIds)) {
    logger.info('Mastodon token login rejected for %s: token was issued to app %s, which is not allowed.', id, app?.id)
    return null
  }

  return buildAuthResult(account, baseUrl)
}

function dropPasswordOfTokenLogin (params) {
  const { bypassLogin } = params
  if (bypassLogin?.bypass !== true || bypassLogin.pluginName !== NPM_NAME || bypassLogin.authName !== TOKEN_AUTH_NAME) {
    return params
  }

  return { ...params, password: undefined }
}

// ---------------------------------------------------------------------------

async function loadExternalAuth ({ registerExternalAuth, unregisterExternalAuth, settingsManager, peertubeHelpers }) {
  const { logger } = peertubeHelpers

  if (store.externalAuthRegistered) {
    unregisterExternalAuth(EXTERNAL_AUTH_NAME)
    store.externalAuthRegistered = false
    store.userAuthenticated = null
  }

  const settings = await settingsManager.getSettings(SETTING_NAMES)
  if (!settings['mastodon-url'] || !settings['client-id'] || !settings['client-secret']) {
    logger.info('Mastodon web login button disabled: server URL, client ID or client secret is not set.')
    return
  }

  const result = registerExternalAuth({
    authName: EXTERNAL_AUTH_NAME,
    authDisplayName: () => settings['auth-display-name'] || 'Sign in with Mastodon',
    onAuthRequest: (req, res) => handleAuthRequest(req, res, { settings, peertubeHelpers })
  })

  store.userAuthenticated = result.userAuthenticated
  store.externalAuthRegistered = true
}

function handleAuthRequest (req, res, { settings, peertubeHelpers }) {
  try {
    const baseUrl = normalizeBaseUrl(settings['mastodon-url'])

    const state = randomString()
    const codeVerifier = randomString()
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

    const cookieOptions = { ...buildCookieOptions(peertubeHelpers), maxAge: COOKIE_MAX_AGE_MS }
    res.cookie(COOKIE_PREFIX + 'state', state, cookieOptions)
    res.cookie(COOKIE_PREFIX + 'verifier', codeVerifier, cookieOptions)

    const url = new URL(`${baseUrl}/oauth/authorize`)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: settings['client-id'],
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

async function handleCallback (req, res, { settingsManager, peertubeHelpers }) {
  const { logger } = peertubeHelpers

  const expectedState = req.cookies?.[COOKIE_PREFIX + 'state']
  const codeVerifier = req.cookies?.[COOKIE_PREFIX + 'verifier']

  const cookieOptions = buildCookieOptions(peertubeHelpers)
  res.clearCookie(COOKIE_PREFIX + 'state', cookieOptions)
  res.clearCookie(COOKIE_PREFIX + 'verifier', cookieOptions)

  if (!store.userAuthenticated) {
    logger.error('Received Mastodon callback but the web login is not enabled.')
    return redirectOnError(res)
  }

  const { code, state } = req.query
  if (typeof code !== 'string' || typeof state !== 'string' || !expectedState || !codeVerifier || !safeEqual(state, expectedState)) {
    logger.info('Mastodon callback rejected: missing code or state mismatch.')
    return redirectOnError(res)
  }

  try {
    const settings = await settingsManager.getSettings(SETTING_NAMES)
    const baseUrl = normalizeBaseUrl(settings['mastodon-url'])
    const clientOptions = { clientId: settings['client-id'], clientSecret: settings['client-secret'] }

    const accessToken = await exchangeCode(baseUrl, {
      ...clientOptions,
      code,
      codeVerifier,
      redirectUri: getRedirectUrl(peertubeHelpers)
    })

    const account = await verifyCredentials(baseUrl, accessToken)

    // We only needed the token to identify the user
    revokeToken(baseUrl, { ...clientOptions, token: accessToken })
      .catch(err => logger.debug('Cannot revoke Mastodon token after web login.', { err }))

    return store.userAuthenticated({ req, res, ...buildAuthResult(account, baseUrl) })
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
