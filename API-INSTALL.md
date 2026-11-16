# Installing through the PeerTube API

Use this guide when you have the PeerTube `root` login but no shell or Docker access to the server. The plugin is installed from npm (`peertube-plugin-auth-mastodon`), so nothing needs to be copied to the server.

If you do have server access, you can also install from a folder. See [INSTALL.md](INSTALL.md).

## Before you start

You need:

- PeerTube 8.0 or newer, with the `root` login
- `curl` and `jq` on your computer
- The PeerTube server must be able to reach `registry.npmjs.org` and your Mastodon servers over HTTPS
- For each Mastodon server: its URL and the ID of each Mastodon app whose tokens may sign in (see [Find the Mastodon app IDs](#find-the-mastodon-app-ids))

Run all the commands below in **one terminal window**, because later steps reuse the variables set by earlier ones.

## 1. Log in as admin

Set the PeerTube URL:

```bash
PT=https://<peertube domain>
```

Run this line **on its own**, then type the root password and press Enter:

```bash
printf 'PeerTube root password: '; read -rs ROOT_PASSWORD; echo
```

> Don't paste this line together with the next block. If you do, `read` takes the next pasted line as the password and the login fails without any message.

Then get an admin token:

```bash
CLIENT=$(curl -s "$PT/api/v1/oauth-clients/local")
CLIENT_ID=$(echo "$CLIENT" | jq -r .client_id)
CLIENT_SECRET=$(echo "$CLIENT" | jq -r .client_secret)

LOGIN=$(curl -s "$PT/api/v1/users/token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  -d grant_type=password -d username=root \
  --data-urlencode "password=$ROOT_PASSWORD")
echo "$LOGIN" | jq '{error, code, token_type}'
ADMIN_TOKEN=$(echo "$LOGIN" | jq -r .access_token)
```

Expected result: `"token_type": "Bearer"`. If you see an error instead, check the password and run the password line again.

The token expires after about a day. If a later request returns `401`, repeat this step.

## 2. Install the plugin

Always give the version you want. Without `pluginVersion`, PeerTube installs the version listed in the joinpeertube.org plugin index, which can lag behind npm by hours or days.

Check the newest version on npm (or on https://www.npmjs.com/package/peertube-plugin-auth-mastodon):

```bash
npm view peertube-plugin-auth-mastodon version
```

Then install it, replacing `0.3.0` with that version:

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST "$PT/api/v1/plugins/install" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"npmName":"peertube-plugin-auth-mastodon","pluginVersion":"0.3.0"}'
```

Check `"version"` in the response: it must be the version you asked for. `"latestVersion"` comes from the joinpeertube.org index and can be older; ignore it.

If an older version is already installed, this request upgrades it and keeps its settings.

Expected result: the plugin details followed by `HTTP 200`. No restart is needed.

Check the installed version again at any time:

```bash
curl -s "$PT/api/v1/plugins/peertube-plugin-auth-mastodon" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .version
```

## 3. Configure it

### Find the Mastodon app IDs

Token sign-in only accepts tokens issued to allowed Mastodon apps. Get the ID of each app from its client ID and secret, once per Mastodon server:

```bash
MASTODON=https://<mastodon domain>
printf 'Mastodon app client ID: '; read -r APP_CLIENT_ID
printf 'Mastodon app client secret: '; read -rs APP_CLIENT_SECRET; echo
```

Then run:

```bash
APP_TOKEN=$(curl -s "$MASTODON/oauth/token" \
  --data-urlencode "client_id=$APP_CLIENT_ID" \
  --data-urlencode "client_secret=$APP_CLIENT_SECRET" \
  -d grant_type=client_credentials | jq -r .access_token)

curl -s "$MASTODON/api/v1/apps/verify_credentials" \
  -H "Authorization: Bearer $APP_TOKEN" | jq '{id, name}'
```

App IDs are different on each Mastodon server, even for the same app.

### Save the settings

Send **all** settings in one request. Any setting left out of the request is cleared.

One Mastodon server:

```bash
curl -s -w '\nHTTP %{http_code}\n' -X PUT \
  "$PT/api/v1/plugins/peertube-plugin-auth-mastodon/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"settings":{
        "mastodon-url":"https://<mastodon domain>",
        "allowed-app-ids":"<app id>"}}'
```

Several Mastodon servers: the first one goes in `mastodon-url`, and the others go in `mastodon-servers` as a JSON array:

```bash
SERVERS='[
  {"url":"https://<second mastodon domain>","allowedAppIds":"<app id on that server>"},
  {"url":"https://<third mastodon domain>","allowedAppIds":"<app id on that server>"}
]'

curl -s -w '\nHTTP %{http_code}\n' -X PUT \
  "$PT/api/v1/plugins/peertube-plugin-auth-mastodon/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg servers "$SERVERS" '{settings:{
        "mastodon-url":"https://<first mastodon domain>",
        "allowed-app-ids":"<app id on the first server>",
        "mastodon-servers":$servers}}')"
```

Expected result: `HTTP 204`.

Fields for each entry in `mastodon-servers`:

| Field | Required | Notes |
|---|---|---|
| `url` | yes | Mastodon server URL |
| `allowedAppIds` | for app sign-in | App IDs on this server, comma-separated |
| `clientId`, `clientSecret` | for the web button | Only if this server should have a "Sign in" button on the PeerTube website |
| `buttonLabel` | no | Default: "Sign in with &lt;host&gt;" |
| `domain` | no | Only when account handles use another domain than `url` |

If you use the web login button on the first server, also include `client-id`, `client-secret` and `auth-display-name` in the same request.

You can also set all of this in the web interface: **Administration → Plugins → auth-mastodon → Settings**.

### Tell the app team

- The PeerTube URL (`PEERTUBE_URL` in each app build)
- Users of the first server sign in with their plain username, for example `alice`
- Users of the other servers sign in with `username@server`, for example `alice@second.example`

## 4. Check it works

The plugin is registered:

```bash
curl -s "$PT/api/v1/config" | jq '.plugin.registeredIdAndPassAuths[].authName'
```

Expected result: `"mastodon-token"`.

A fake token is refused:

```bash
curl -s "$PT/api/v1/users/token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  -d grant_type=password -d username=nobody_test \
  --data-urlencode 'password=mastodon:not-a-real-token' | jq '{status, code}'
```

Expected result: status `400`, code `invalid_grant`.

To test a real sign-in, see "Check a real sign-in" in [INSTALL.md](INSTALL.md#check-a-real-sign-in). For a user of an additional server, use `username=<name>@<server domain>`.

## Upgrade

After a new version is published to npm, repeat [step 2](#2-install-the-plugin) with the new version number. Settings are kept.

Don't rely on the `/plugins/update` endpoint or the "Update" button in the web interface for a fresh release. They also use the joinpeertube.org index and may install an older version, or report that nothing needs updating.

## Uninstall

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST "$PT/api/v1/plugins/uninstall" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"npmName":"peertube-plugin-auth-mastodon"}'
```

Mastodon sign-in stops working. Users already created by the plugin stay in PeerTube.

## Troubleshooting

| Response | Likely cause | What to do |
|---|---|---|
| `401` on any admin request | `ADMIN_TOKEN` is empty, `null` or expired | Repeat step 1 and check that it shows `"token_type": "Bearer"` |
| `400 Should have either npmName or path` | The JSON body was broken, usually by curly quotes when copying | Retype the `-d '{...}'` part with straight quotes |
| `400 Cannot install plugin ...` with `path` | The API can only install from a folder that already exists on the server | Use `npmName` as in step 2 |
| `400 Cannot install plugin ...` with `npmName` | The server can't reach npm, the version doesn't exist, or the install failed | Check the version with `npm view peertube-plugin-auth-mastodon versions`. Otherwise the reason is only in the PeerTube server log. Ask someone with server access to check it. |
| Install returns `200` but `"version"` is older than expected | `pluginVersion` was missing or empty, or `/plugins/update` was used, so PeerTube took the version from the joinpeertube.org index, which hasn't seen the new release yet | Run the install from step 2 with the version written in the command |
| Settings `400` | The settings JSON is invalid | Check the JSON with `echo "$SERVERS" \| jq .` |
| Every app sign-in returns `400 invalid_grant` | Wrong `mastodon-url`, app ID missing from the allowlist, the `@server` part is not a configured server, or the username doesn't match the token owner | Check the settings. PeerTube logs the reason at `info` level. |
| An additional server is ignored | Its entry in `mastodon-servers` is invalid or repeats another server | Check the JSON. PeerTube logs `Ignoring invalid Mastodon server setting`. |

## For maintainers: publishing a new version

1. Update `version` in `package.json`.
2. Run `npm test`.
3. Run `npm publish` with an npm account that maintains `peertube-plugin-auth-mastodon`.
4. Upgrade each PeerTube as in [Upgrade](#upgrade), giving the new version explicitly.
