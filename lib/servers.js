const { normalizeBaseUrl, parseAllowedAppIds } = require('./mastodon')

const DEFAULT_AUTH_NAME = 'mastodon'
const DEFAULT_BUTTON_LABEL = 'Sign in with Mastodon'

// Builds the list of Mastodon servers from the plugin settings. The single-server settings
// (mastodon-url, allowed-app-ids, client-id...) come first and keep the "mastodon" auth name,
// so deployments configured before multi-server support keep working unchanged.
// Additional servers come from the "mastodon-servers" JSON setting.
function buildServers (settings, logger) {
  const servers = []
  const errors = []

  const add = (raw, { authName, defaultLabel, source }) => {
    let server
    try {
      server = buildServer(raw, { authName, defaultLabel })
    } catch (err) {
      errors.push(`${source}: ${err.message}`)
      return
    }

    if (servers.some(s => s.host === server.host)) {
      errors.push(`${source}: ${server.host} is already configured`)
      return
    }

    // Two hosts can map to the same auth name (a.b and a-b)
    let name = server.authName
    for (let i = 2; servers.some(s => s.authName === name); i++) name = `${server.authName}-${i}`
    server.authName = name

    servers.push(server)
  }

  if (settings['mastodon-url']) {
    add({
      url: settings['mastodon-url'],
      allowedAppIds: settings['allowed-app-ids'],
      clientId: settings['client-id'],
      clientSecret: settings['client-secret'],
      buttonLabel: settings['auth-display-name']
    }, { authName: DEFAULT_AUTH_NAME, defaultLabel: DEFAULT_BUTTON_LABEL, source: 'Mastodon server URL' })
  }

  const extra = parseServersSetting(settings['mastodon-servers'])
  if (extra.error) errors.push(`Additional Mastodon servers: ${extra.error}`)

  extra.servers.forEach((raw, index) => {
    add(raw, { authName: null, defaultLabel: null, source: `Additional Mastodon servers, entry ${index + 1}` })
  })

  for (const error of errors) logger?.error(`Ignoring invalid Mastodon server setting. ${error}`)

  return servers
}

function parseServersSetting (value) {
  if (typeof value !== 'string' || !value.trim()) return { servers: [] }

  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (err) {
    return { servers: [], error: `not valid JSON (${err.message})` }
  }

  if (!Array.isArray(parsed)) return { servers: [], error: 'must be a JSON array' }

  return { servers: parsed }
}

function buildServer (raw, { authName, defaultLabel }) {
  if (!raw || typeof raw !== 'object') throw new Error('must be an object')
  if (typeof raw.url !== 'string' || !raw.url.trim()) throw new Error('"url" is required')

  let baseUrl
  try {
    baseUrl = normalizeBaseUrl(raw.url)
  } catch {
    throw new Error(`"url" is not a valid URL: ${raw.url}`)
  }

  const host = new URL(baseUrl).hostname.toLowerCase()

  // Account domain, when the server uses a different domain for handles than for its web/API URL
  // (Mastodon LOCAL_DOMAIN vs WEB_DOMAIN)
  const domains = [ host ]
  if (raw.domain !== undefined && raw.domain !== null && raw.domain !== '') {
    if (typeof raw.domain !== 'string') throw new Error('"domain" must be a string')
    const domain = raw.domain.trim().toLowerCase()
    if (!domains.includes(domain)) domains.push(domain)
  }

  const allowedAppIds = Array.isArray(raw.allowedAppIds)
    ? raw.allowedAppIds.map(String).map(s => s.trim()).filter(Boolean)
    : parseAllowedAppIds(raw.allowedAppIds)

  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : ''
  const clientSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : ''

  return {
    baseUrl,
    host,
    domains,
    allowedAppIds,
    clientId,
    clientSecret,
    webLoginEnabled: !!(clientId && clientSecret),
    buttonLabel: (typeof raw.buttonLabel === 'string' && raw.buttonLabel.trim()) || defaultLabel || `Sign in with ${host}`,
    authName: authName || 'mastodon-' + host.replace(/[^a-z0-9]+/g, '-')
  }
}

// Picks the server a token login is meant for:
//   "alice"                    -> the first configured server
//   "alice@mastodon.example"   -> the server with that host or account domain
//   "@alice@mastodon.example"  -> same
// Returns null when the domain is not configured, so tokens are never sent to unknown servers.
function resolveServerForLogin (servers, id) {
  if (typeof id !== 'string' || servers.length === 0) return null

  const handle = id.trim().replace(/^@/, '')
  const at = handle.lastIndexOf('@')

  if (at === -1) {
    return handle ? { server: servers[0], username: handle } : null
  }

  const username = handle.slice(0, at)
  const domain = handle.slice(at + 1).toLowerCase()
  if (!username || !domain) return null

  const server = servers.find(s => s.domains.includes(domain))
  return server ? { server, username } : null
}

module.exports = {
  DEFAULT_AUTH_NAME,
  buildServers,
  resolveServerForLogin
}
