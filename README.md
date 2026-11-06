# peertube-plugin-auth-mastodon

Sign in to PeerTube with a Mastodon account. No changes to Mastodon or PeerTube core.

- **App token login (silent):** an app that already holds a Mastodon access token exchanges it for a PeerTube token with one request. The PeerTube user is created on first use.
- **Web button (optional):** "Sign in with Mastodon" on the PeerTube login page (OAuth2 authorization code + PKCE, scope `profile`).

Both methods create the same PeerTube account for a given Mastodon account.

Requires PeerTube >= 8.0 and a Mastodon server with the `profile` scope (Mastodon >= 4.3).

## Settings

| Setting | Required for | Notes |
|---|---|---|
| Mastodon server URL | both | e.g. `https://mastodon.example`. Only accounts on this server can sign in. |
| Allowed Mastodon app IDs | app token login | Comma-separated. Only tokens issued to these Mastodon apps can sign in. Token sign-in is refused while this is empty. |
| Client ID / secret | web button | Create an app on Mastodon with scope `profile` and redirect URI `https://<peertube>/plugins/auth-mastodon/router/callback`. Leave empty for app-only login. |
| Login button label | web button | Default "Sign in with Mastodon". |

## App token login

```
POST https://<peertube>/api/v1/users/token
Content-Type: application/x-www-form-urlencoded

client_id=<from GET /api/v1/oauth-clients/local>
client_secret=<from GET /api/v1/oauth-clients/local>
grant_type=password
username=<Mastodon username, e.g. alice_w>
password=mastodon:<Mastodon access token>
```

The response is a normal PeerTube token (`access_token`, `refresh_token`, `expires_in`). Refresh it with `grant_type=refresh_token` as usual. When the refresh token expires, repeat the exchange with the current Mastodon token.

- The `mastodon:` prefix is required. Passwords without it are never sent to Mastodon, so local PeerTube logins (e.g. `root`) are unaffected.
- `username` must match the owner of the Mastodon token (case-insensitive). This is the Mastodon username, which can differ from the PeerTube one (see below): read the PeerTube username from `GET /api/v1/users/me`.
- PeerTube rejects login passwords over 50 characters, which `mastodon:<token>` exceeds. The plugin uses the `filter:oauth.password-grant.get-user.params` hook to drop the password once it has accepted the login, so this limit does not apply to Mastodon tokens.
- The Mastodon token is checked against `GET /api/v1/accounts/verify_credentials` and `GET /api/v1/apps/verify_credentials`, and is not stored. The app's `id` must be in the allowed list. Names are not checked, because anyone can register an app with any name.
- On logout, revoke the PeerTube token too (`POST /api/v1/users/revoke-token`): revoking the Mastodon token does not end the PeerTube session.

## Account mapping

| PeerTube | From Mastodon |
|---|---|
| Username | `username`, lowercased. PeerTube adds a suffix (`alice-1`) if the name is taken, including by a deleted user. |
| Display name | `display_name` (falls back to the username) |
| Email | `mastodon-<account id>@<mastodon host>`. Placeholder: Mastodon does not share emails with OAuth apps. |
| External ID | `<mastodon host>:<account id>`. Accounts are matched on this, so a Mastodon rename keeps the same PeerTube account. |
| Role | User |

Display name changes on Mastodon are not synced after the account is created.

## Development

```
npm test
```

To try it on a local PeerTube running in Docker, mount this folder into the container and install it by path:

```
POST /api/v1/plugins/install   {"path": "/plugin-dev/peertube-plugin-auth-mastodon"}
```
