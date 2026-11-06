const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const { buildAuthResult, extractTokenFromPassword, normalizeBaseUrl, parseAllowedAppIds } = require('../lib/mastodon')
const plugin = require('../main')

const ACCOUNT = { id: '109876', username: 'Alice_W', display_name: 'Alice W 🎬' }
const ACCOUNT_PATH = '/api/v1/accounts/verify_credentials'
const APP_PATH = '/api/v1/apps/verify_credentials'
const TOKEN_LOGIN_SETTINGS = { 'mastodon-url': 'https://mastodon.example', 'allowed-app-ids': '12, 34' }

function buildFakePeerTube (settings) {
  const registered = { passAuths: [], externalAuths: [], routes: {}, hooks: {} }
  let settingsChangeCb

  const api = {
    registerIdAndPassAuth: options => registered.passAuths.push(options),
    registerExternalAuth: options => {
      registered.externalAuths.push(options)
      return { userAuthenticated: result => { registered.authenticated = result } }
    },
    unregisterExternalAuth: name => {
      registered.externalAuths = registered.externalAuths.filter(a => a.authName !== name)
    },
    registerSetting: () => {},
    registerHook: ({ target, handler }) => { registered.hooks[target] = handler },
    settingsManager: {
      getSetting: async name => settings[name],
      getSettings: async names => Object.fromEntries(names.map(n => [ n, settings[n] ])),
      onSettingsChange: cb => { settingsChangeCb = cb }
    },
    peertubeHelpers: {
      logger: { info () {}, warn () {}, error () {}, debug () {} },
      config: { getWebserverUrl: () => 'https://tube.example' }
    },
    getRouter: () => ({ get: (path, handler) => { registered.routes[path] = handler } })
  }

  return { api, registered, changeSettings: () => settingsChangeCb() }
}

function buildRes () {
  return {
    cookies: {},
    cleared: [],
    redirectedTo: null,
    cookie (name, value) { this.cookies[name] = value },
    clearCookie (name) { this.cleared.push(name) },
    redirect (url) { this.redirectedTo = url }
  }
}

let fetchCalls
let fetchResponses
const realFetch = global.fetch

beforeEach(() => {
  fetchCalls = []
  fetchResponses = {}
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options })
    const path = new URL(url).pathname
    const response = fetchResponses[path] || { status: 404, body: {} }
    return { ok: response.status < 300, status: response.status, json: async () => response.body }
  }
})

afterEach(() => {
  global.fetch = realFetch
})

// ---------------------------------------------------------------------------

test('buildAuthResult maps a Mastodon account to a PeerTube user', () => {
  assert.deepEqual(buildAuthResult(ACCOUNT, 'https://mastodon.example'), {
    username: 'alice_w',
    email: 'mastodon-109876@mastodon.example',
    displayName: 'Alice W 🎬',
    role: 2,
    externalId: 'mastodon.example:109876'
  })
})

test('buildAuthResult falls back to the username when the display name is empty', () => {
  assert.equal(buildAuthResult({ ...ACCOUNT, display_name: '  ' }, 'https://m.example').displayName, 'alice_w')
})

test('extractTokenFromPassword only accepts prefixed passwords', () => {
  assert.equal(extractTokenFromPassword('mastodon:abc123'), 'abc123')
  assert.equal(extractTokenFromPassword('hunter2'), null)
  assert.equal(extractTokenFromPassword('mastodon:'), null)
  assert.equal(extractTokenFromPassword(undefined), null)
})

test('normalizeBaseUrl accepts bare domains and trailing slashes', () => {
  assert.equal(normalizeBaseUrl('mastodon.example'), 'https://mastodon.example')
  assert.equal(normalizeBaseUrl('https://mastodon.example/'), 'https://mastodon.example')
  assert.equal(normalizeBaseUrl('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeBaseUrl(''), null)
})

// ---------------------------------------------------------------------------

test('parseAllowedAppIds accepts commas and spaces', () => {
  assert.deepEqual(parseAllowedAppIds('12, 34\n56'), [ '12', '34', '56' ])
  assert.deepEqual(parseAllowedAppIds(' '), [])
  assert.deepEqual(parseAllowedAppIds(undefined), [])
})

test('token login verifies the Mastodon token and app, and returns the user', async () => {
  const { api, registered } = buildFakePeerTube(TOKEN_LOGIN_SETTINGS)
  await plugin.register(api)
  fetchResponses[ACCOUNT_PATH] = { status: 200, body: ACCOUNT }
  fetchResponses[APP_PATH] = { status: 200, body: { id: '34', name: 'Our app' } }

  const result = await registered.passAuths[0].login({ id: 'alice_w', password: 'mastodon:tok' })

  assert.equal(result.username, 'alice_w')
  assert.equal(fetchCalls[0].url, 'https://mastodon.example/api/v1/accounts/verify_credentials')
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer tok')
  assert.equal(fetchCalls[1].url, 'https://mastodon.example/api/v1/apps/verify_credentials')
  assert.equal(fetchCalls[1].options.headers.Authorization, 'Bearer tok')
})

test('token login rejects a token issued to an app that is not allowed', async () => {
  const { api, registered } = buildFakePeerTube(TOKEN_LOGIN_SETTINGS)
  await plugin.register(api)
  fetchResponses[ACCOUNT_PATH] = { status: 200, body: ACCOUNT }

  // Same name as an allowed app, and an ID that only contains an allowed one
  fetchResponses[APP_PATH] = { status: 200, body: { id: '345', name: 'Our app' } }
  assert.equal(await registered.passAuths[0].login({ id: 'alice_w', password: 'mastodon:tok' }), null)
})

test('token login rejects when the app cannot be identified', async () => {
  const { api, registered } = buildFakePeerTube(TOKEN_LOGIN_SETTINGS)
  await plugin.register(api)
  const login = registered.passAuths[0].login
  fetchResponses[ACCOUNT_PATH] = { status: 200, body: ACCOUNT }

  fetchResponses[APP_PATH] = { status: 200, body: { name: 'Older Mastodon, no id' } }
  assert.equal(await login({ id: 'alice_w', password: 'mastodon:tok' }), null)

  fetchResponses[APP_PATH] = { status: 500, body: {} }
  assert.equal(await login({ id: 'alice_w', password: 'mastodon:tok' }), null)
})

test('token login is refused without calling Mastodon while no apps are allowed', async () => {
  const { api, registered } = buildFakePeerTube({ 'mastodon-url': 'https://mastodon.example' })
  await plugin.register(api)

  assert.equal(await registered.passAuths[0].login({ id: 'alice_w', password: 'mastodon:tok' }), null)
  assert.equal(fetchCalls.length, 0)
})

test('token login never sends a plain PeerTube password to Mastodon', async () => {
  const { api, registered } = buildFakePeerTube(TOKEN_LOGIN_SETTINGS)
  await plugin.register(api)

  assert.equal(await registered.passAuths[0].login({ id: 'root', password: 'root-password' }), null)
  assert.equal(fetchCalls.length, 0)
})

test('token login rejects invalid tokens and username mismatches', async () => {
  const { api, registered } = buildFakePeerTube(TOKEN_LOGIN_SETTINGS)
  await plugin.register(api)
  const login = registered.passAuths[0].login
  fetchResponses[APP_PATH] = { status: 200, body: { id: '12' } }

  fetchResponses[ACCOUNT_PATH] = { status: 401, body: {} }
  assert.equal(await login({ id: 'alice_w', password: 'mastodon:bad' }), null)

  fetchResponses[ACCOUNT_PATH] = { status: 200, body: ACCOUNT }
  assert.equal(await login({ id: 'someone_else', password: 'mastodon:tok' }), null)
})

test('password-grant hook drops the over-long password only for this plugin token logins', async () => {
  const { api, registered } = buildFakePeerTube({ 'mastodon-url': 'https://mastodon.example' })
  await plugin.register(api)
  const hook = registered.hooks['filter:oauth.password-grant.get-user.params']

  const password = 'mastodon:' + 'x'.repeat(43)
  const ours = { bypass: true, pluginName: 'peertube-plugin-auth-mastodon', authName: 'mastodon-token' }
  assert.equal(hook({ usernameOrEmail: 'alice_w', password, bypassLogin: ours }).password, undefined)

  const other = { bypass: true, pluginName: 'peertube-plugin-auth-ldap', authName: 'ldap' }
  assert.equal(hook({ usernameOrEmail: 'alice_w', password, bypassLogin: other }).password, password)
  assert.equal(hook({ usernameOrEmail: 'root', password: 'root-password', bypassLogin: undefined }).password, 'root-password')
})

// ---------------------------------------------------------------------------

test('web button is only registered when client credentials are set', async () => {
  const settings = { 'mastodon-url': 'https://mastodon.example' }
  const { api, registered, changeSettings } = buildFakePeerTube(settings)
  await plugin.register(api)
  assert.equal(registered.externalAuths.length, 0)

  Object.assign(settings, { 'client-id': 'cid', 'client-secret': 'secret' })
  await changeSettings()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registered.externalAuths.length, 1)
})

test('web flow: authorize redirect, then callback authenticates the user', async () => {
  const { api, registered } = buildFakePeerTube({
    'mastodon-url': 'https://mastodon.example',
    'client-id': 'cid',
    'client-secret': 'secret'
  })
  await plugin.register(api)

  const startRes = buildRes()
  registered.externalAuths[0].onAuthRequest({}, startRes)

  const authorizeUrl = new URL(startRes.redirectedTo)
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://mastodon.example/oauth/authorize')
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://tube.example/plugins/auth-mastodon/router/callback')
  assert.equal(authorizeUrl.searchParams.get('scope'), 'profile')
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')

  fetchResponses['/oauth/token'] = { status: 200, body: { access_token: 'web-tok' } }
  fetchResponses['/oauth/revoke'] = { status: 200, body: {} }
  fetchResponses['/api/v1/accounts/verify_credentials'] = { status: 200, body: ACCOUNT }

  const req = {
    query: { code: 'the-code', state: authorizeUrl.searchParams.get('state') },
    cookies: {
      'peertube-auth-mastodon-state': startRes.cookies['peertube-auth-mastodon-state'],
      'peertube-auth-mastodon-verifier': startRes.cookies['peertube-auth-mastodon-verifier']
    }
  }
  await registered.routes['/callback'](req, buildRes())

  assert.equal(registered.authenticated.username, 'alice_w')
  assert.equal(registered.authenticated.externalId, 'mastodon.example:109876')

  const tokenBody = fetchCalls.find(c => c.url.endsWith('/oauth/token')).options.body
  assert.equal(tokenBody.get('code_verifier'), startRes.cookies['peertube-auth-mastodon-verifier'])
})

test('web flow: callback with a mismatched state is rejected', async () => {
  const { api, registered } = buildFakePeerTube({
    'mastodon-url': 'https://mastodon.example',
    'client-id': 'cid',
    'client-secret': 'secret'
  })
  await plugin.register(api)
  registered.authenticated = undefined

  const res = buildRes()
  await registered.routes['/callback']({
    query: { code: 'c', state: 'forged' },
    cookies: { 'peertube-auth-mastodon-state': 'real', 'peertube-auth-mastodon-verifier': 'v' }
  }, res)

  assert.equal(res.redirectedTo, '/login?externalAuthError=true')
  assert.equal(registered.authenticated, undefined)
  assert.equal(fetchCalls.length, 0)
})
