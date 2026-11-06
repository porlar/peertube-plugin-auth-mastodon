# PeerTube Mastodon sign-in plugin: setup

Lets the mobile app sign users in to PeerTube with their Mastodon account. No changes to PeerTube core or Mastodon are needed.

**Requires:** PeerTube 8.0+, the `root` login, `curl` and `jq`, and HTTPS outbound access from PeerTube to Mastodon. Tested on the official Docker image, v8.3.2.

## 1. Check PeerTube config

- `trust_proxy` must include your reverse proxy. Logins are limited to 15 per 5 minutes per IP, so if the proxy isn't trusted, all users share one limit.
- Set `user.video_quota`. The default is unlimited, and every Mastodon user gets an account automatically.
- Serve PeerTube over HTTPS, and allow upload requests of at least 5 MB on `/api/v1/videos/upload-resumable`.

## 2. Copy the plugin

Keep it on the `/data` volume, because PeerTube records this path.

```bash
CONTAINER=<peertube container name>

docker exec "$CONTAINER" mkdir -p /data/plugin-src
docker cp ./peertube-plugin-auth-mastodon "$CONTAINER":/data/plugin-src/
docker exec "$CONTAINER" chown -R peertube:peertube /data/plugin-src
```

## 3. Get an admin token

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

## 4. Install and configure

No restart is needed. First find the ID of each Mastodon app whose tokens may sign in, using the client ID and secret that app build uses:

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

Then install and configure, putting those IDs in `allowed-app-ids`, separated by commas. Token sign-in is refused while this setting is empty.

```bash
# Expected: 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PT/api/v1/plugins/install" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"path":"/data/plugin-src/peertube-plugin-auth-mastodon"}'

# Expected: 204
curl -s -o /dev/null -w '%{http_code}\n' -X PUT \
  "$PT/api/v1/plugins/peertube-plugin-auth-mastodon/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"settings":{"mastodon-url":"https://<mastodon domain>","allowed-app-ids":"<app id>"}}'
```

## 5. Verify

```bash
# Expected: "mastodon-token"
curl -s "$PT/api/v1/config" | jq '.plugin.registeredIdAndPassAuths[].authName'

# Expected: status 400, code invalid_grant
curl -s "$PT/api/v1/users/token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  -d grant_type=password -d username=nobody_test \
  --data-urlencode 'password=mastodon:not-a-real-token' | jq '{status, code}'
```

Then send the PeerTube URL to the app team, as each app build needs it in `PEERTUBE_URL`.

## Upgrade

Repeat step 2, then run the install request from step 4. Settings are kept. When upgrading from 0.1.0, set `allowed-app-ids` too, or token sign-in stops working.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every sign-in returns `400 invalid_grant` | `mastodon-url` is wrong, `allowed-app-ids` is empty or missing the app, PeerTube can't reach Mastodon, or the username doesn't match the token's owner |
| `429` responses | Login rate limit reached. Check `trust_proxy` first. |

## Known risk

`allowed-app-ids` blocks tokens from other Mastodon apps. It can't stop someone who extracts the client ID and secret from an app build and gets a user to authorize them, or who steals a token issued to an allowed app.

See `INSTALL.md` for the real-account sign-in test, the optional web login button and other details.
