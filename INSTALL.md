# Installing peertube-plugin-auth-mastodon

This plugin lets the mobile app sign users in to PeerTube with their Mastodon account. It does not require any change to PeerTube core or Mastodon, and it has no npm dependencies. It is not on npm, so it is installed from a folder on the server.

Tested on PeerTube 8.3.2 with the official Docker image (`chocobozzz/peertube:v8.3.2-trixie`, Node 22). Other setups are marked as untested below.

## Before you start

You need:

- PeerTube 8.0 or newer, with the admin (`root`) login
- The plugin folder (`peertube-plugin-auth-mastodon`)
- The Mastodon server URL for this community, for example `https://mastodon.example`. Each deployment serves one Mastodon server.
- The client ID and secret of each Mastodon app whose tokens may sign in, usually the app the mobile build uses
- HTTPS outbound access from PeerTube to that Mastodon server
- `curl` and `jq` on the machine running the API commands

## Check these settings first

| Setting | What to do | Why |
|---|---|---|
| `trust_proxy` (`PEERTUBE_TRUST_PROXY` in Docker) | Must include your reverse proxy | PeerTube limits logins to 15 attempts per 5 minutes per IP (`rates_limit.login`). If the proxy isn't trusted, all users appear to share one IP and get locked out together. |
| `rates_limit.login` | Review the limit | Users behind one mobile carrier or office IP share this limit. |
| Public signup | Can stay closed | On the test server, the plugin created users with public signup turned off. |
| `user.video_quota` | Set a per-user limit | The default on the test server is unlimited (`-1`), and every Mastodon user gets a PeerTube account automatically. |
| Reverse proxy upload size | Use the official PeerTube nginx template, or allow requests of at least 5 MB on `/api/v1/videos/upload-resumable` | The app uploads in 5 MB chunks. |
| PeerTube URL | Must be HTTPS in production | The app sends Mastodon tokens to this server during sign-in. |

## Install (Docker)

### 1. Copy the plugin into persistent storage

PeerTube copies the plugin when it installs, but it also records the source path in `/data/plugins/package.json`. Keep the source folder on the `/data` volume so it survives container replacement.

```bash
CONTAINER=<peertube container name>

docker exec "$CONTAINER" mkdir -p /data/plugin-src
docker cp ./peertube-plugin-auth-mastodon "$CONTAINER":/data/plugin-src/
docker exec "$CONTAINER" chown -R peertube:peertube /data/plugin-src
```

### 2. Get an admin token

```bash
PT=https://<peertube domain>
printf 'PeerTube root password: '; read -rs ROOT_PASSWORD; echo

CLIENT=$(curl -s "$PT/api/v1/oauth-clients/local")
CLIENT_ID=$(echo "$CLIENT" | jq -r .client_id)
CLIENT_SECRET=$(echo "$CLIENT" | jq -r .client_secret)

ADMIN_TOKEN=$(curl -s "$PT/api/v1/users/token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  -d grant_type=password -d username=root \
  --data-urlencode "password=$ROOT_PASSWORD" | jq -r .access_token)
```

### 3. Install the plugin

No restart is needed.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PT/api/v1/plugins/install" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"path":"/data/plugin-src/peertube-plugin-auth-mastodon"}'
```

Expected result: `200`.

### 4. Configure it

First find the ID of each allowed Mastodon app:

```bash
MASTODON=https://<mastodon domain>
printf 'Mastodon app client ID: '; read -r CLIENT_ID_APP
printf 'Mastodon app client secret: '; read -rs CLIENT_SECRET_APP; echo

APP_TOKEN=$(curl -s "$MASTODON/oauth/token" \
  --data-urlencode "client_id=$CLIENT_ID_APP" \
  --data-urlencode "client_secret=$CLIENT_SECRET_APP" \
  -d grant_type=client_credentials | jq -r .access_token)

curl -s "$MASTODON/api/v1/apps/verify_credentials" \
  -H "Authorization: Bearer $APP_TOKEN" | jq '{id, name}'
```

Then save the settings, with the IDs separated by commas:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PUT \
  "$PT/api/v1/plugins/peertube-plugin-auth-mastodon/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"settings":{"mastodon-url":"https://<mastodon domain>","allowed-app-ids":"<app id>"}}'
```

Expected result: `204`.

Token sign-in is refused while `allowed-app-ids` is empty. Each app ID belongs to one Mastodon server, so it differs between deployments.

This is all the mobile app needs. To add the optional web button, see [Optional: web login button](#optional-web-login-button).

## Verify

### Check the plugin is registered

```bash
curl -s "$PT/api/v1/config" | jq '.plugin.registeredIdAndPassAuths[].authName'
```

Expected result: `"mastodon-token"`.

### Check a bad token is refused

```bash
curl -s "$PT/api/v1/users/token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  -d grant_type=password -d username=nobody_test \
  --data-urlencode 'password=mastodon:not-a-real-token' | jq '{status, code}'
```

Expected result: status `400`, code `invalid_grant`.

### Check a real sign-in

Use a test Mastodon account and its access token. This creates a PeerTube user for that account if it doesn't have one yet.

```bash
MASTODON_USERNAME=<test account username>
printf 'Mastodon access token: '; read -rs MASTODON_TOKEN; echo

USER_TOKEN=$(curl -s "$PT/api/v1/users/token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  -d grant_type=password \
  --data-urlencode "username=$MASTODON_USERNAME" \
  --data-urlencode "password=mastodon:$MASTODON_TOKEN" | jq -r .access_token)

curl -s "$PT/api/v1/users/me" -H "Authorization: Bearer $USER_TOKEN" \
  | jq '{username, pluginAuth, channels: [.videoChannels[].name]}'
```

Expected result: `pluginAuth` is `peertube-plugin-auth-mastodon`, and the user has one channel. The PeerTube username can differ from the Mastodon one, for example `alice-1` if `alice` is taken.

## Upgrade

Replace the folder and run the install again. Settings are kept. When upgrading from 0.1.0, set `allowed-app-ids` too, or token sign-in stops working.

```bash
docker cp ./peertube-plugin-auth-mastodon "$CONTAINER":/data/plugin-src/
docker exec "$CONTAINER" chown -R peertube:peertube /data/plugin-src
```

Then repeat [step 3](#3-install-the-plugin) and check the version:

```bash
curl -s "$PT/api/v1/plugins/peertube-plugin-auth-mastodon" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .version
```

`docker cp` doesn't remove files that were deleted from a newer version. If a release removes files, clear the old folder first.

## Tell the app team

Each app build needs `PEERTUBE_URL` set to the PeerTube URL for that community. Without it, PeerTube sign-in and upload stay off.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every token request returns `400 invalid_grant` | `mastodon-url` is unset or wrong, `allowed-app-ids` is empty or missing the app, PeerTube can't reach Mastodon, or `username` doesn't match the token's owner |
| Requests return `429` | Login rate limit reached. Check `trust_proxy` first. |
| Valid token refused for a user of another Mastodon server | Expected. Only accounts on the configured server can sign in. |
| Install fails | Check that the path is correct inside the container and owned by `peertube`, then check the PeerTube logs. |

The plugin logs rejected logins at `info` level. It doesn't log or store Mastodon tokens.

## Optional: web login button

This adds "Sign in with Mastodon" to the PeerTube website. The mobile app doesn't need it.

1. On Mastodon, create an application with scope `profile` and this redirect URI: `https://<peertube domain>/plugins/auth-mastodon/router/callback`. The `profile` scope needs Mastodon 4.3 or newer.
2. In PeerTube, go to Administration > Plugins > auth-mastodon > Settings, and enter the client ID and secret. Store the secret in your secrets manager.

These fields can also be set through the settings API. Send all settings in the same request.

## Known risks

- **The app allowlist has limits.** `allowed-app-ids` blocks tokens from other Mastodon apps, but a mobile app's client ID and secret can be extracted from its build. Someone with them could get a user to authorize a token that passes the check. A stolen token issued to an allowed app also still works.
- **Existing sessions keep working.** The allowlist is checked at sign-in. PeerTube sessions created earlier keep working until they expire or are revoked.
- **Placeholder email addresses.** Mastodon doesn't share email addresses with apps, so users get `mastodon-<account id>@<mastodon domain>`. These aren't real mailboxes, so any PeerTube email sent to them may bounce. Check the notification defaults and your SMTP sender reputation.
- **Display names aren't synced.** Display names are copied once, when the account is created.

## Not tested

The following steps come from PeerTube's documented tools and have not been run for this plugin:

**Installing without Docker**

```bash
cd /var/www/peertube/peertube-latest
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production \
  npm run plugin:install -- --plugin-path /path/to/peertube-plugin-auth-mastodon
sudo systemctl restart peertube
```

**Uninstalling**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PT/api/v1/plugins/uninstall" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"npmName":"peertube-plugin-auth-mastodon"}'
```

Sign-in stops working after uninstalling. Check what happens to existing plugin-created users on a test server before doing this in production.
