# Google Authentication Setup

OpenGeoMetadata Studio uses Google Identity Services (GIS) for browser sign-in. The app remains readable without authentication, but mutating workflows require a signed-in Google account:

- Creating or editing resources.
- Opening resource admin views.
- Importing or exporting data.
- Running enrichment workflows.

This is a browser-side access gate for the Studio UI. It is not a backend authorization system. Protect private data, storage credentials, and provider keys through the local enrichment proxy, environment variables, storage permissions, and deployment access controls.

## Implementation Map

| Area | File | Role |
| --- | --- | --- |
| Auth provider | `web/src/auth/AuthContext.tsx` | Loads GIS, initializes the OAuth client, parses the returned ID token, checks allowed emails, and exposes auth state. |
| Auth hook | `web/src/auth/useAuth.ts` | Gives UI components access to `user`, `isSignedIn`, `signIn`, and `signOut`. |
| Sign-in UI | `web/src/ui/GoogleAuthButton.tsx` | Renders the GIS button when available and shows the signed-in profile/sign-out control. |
| App gates | `web/src/ui/App.tsx` | Redirects unsigned users away from CRUD views and blocks Import/Export and Enrichments. |
| GIS typings | `web/src/google-gsi.d.ts` | Minimal TypeScript declarations for `window.google.accounts.id`. |
| Env template | `web/.env.example` | Documents the build-time variables used by the auth layer. |

## Runtime Flow

1. `AuthProvider` reads `VITE_GOOGLE_CLIENT_ID` from the Vite build environment.
2. If a client ID is configured, the browser loads `https://accounts.google.com/gsi/client`.
3. The provider calls `google.accounts.id.initialize({ client_id, callback })`.
4. The GIS button or prompt returns an ID token credential to the callback.
5. The app decodes that JWT in the browser with `jwt-decode` and reads `email`, `name`, and `picture`.
6. The email is compared with `VITE_GOOGLE_ALLOWED_EMAILS`. If that variable is blank, the app defaults to allowing only `ewlarson@gmail.com`.
7. A successful sign-in stores only `email`, `name`, and `picture` in `sessionStorage` under `aardvark-google-profile`. The ID token is not persisted and is not used for GitHub, S3, OCR, Gemini, Kimi, or OpenAI calls.
8. Sign-out clears that `sessionStorage` entry and calls `google.accounts.id.disableAutoSelect()` when GIS is available.

## Google Cloud Console Setup

Create one OAuth 2.0 Web application client for the browser app.

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select the Google Cloud project that should own the OAuth client.
3. Open **APIs & Services** -> **OAuth consent screen**.
4. Configure the app name, support email, developer contact email, and publishing mode.
5. If the consent screen is in testing mode, add the Google accounts that should be able to test sign-in.
6. Open **APIs & Services** -> **Credentials**.
7. Choose **Create credentials** -> **OAuth client ID**.
8. Select **Web application**.
9. Add every deployed origin that will serve the Studio app.

| Environment | Authorized JavaScript origin |
| --- | --- |
| Local Vite dev server | `http://localhost:5173` |
| Local Vite preview, if used | `http://localhost:4173` |
| This repository on GitHub Pages | `https://ewlarson.github.io` |
| Custom production host | `https://your-host.example.edu` |
| Vercel or other preview host | The exact preview origin, such as `https://project-name.vercel.app` |

Use origins only: scheme, host, and optional port. Do not include the `/ogm-metadata-studio/` base path in Google Cloud's Authorized JavaScript origins.

The current GIS flow does not use redirect mode, so Authorized redirect URIs are not required. Add redirect URIs only if the app is changed later to use `ux_mode: "redirect"`.

Copy the generated client ID. It should look like:

```text
1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com
```

## Local Configuration

From the repository root:

```bash
cp web/.env.example web/.env
```

Set the browser auth variables in `web/.env`:

```bash
VITE_GOOGLE_CLIENT_ID=1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com
VITE_GOOGLE_ALLOWED_EMAILS=alice@example.edu,bob@example.edu
```

Notes:

- `VITE_GOOGLE_CLIENT_ID` is required for sign-in.
- `VITE_GOOGLE_ALLOWED_EMAILS` is optional. It accepts comma-separated, space-separated, or mixed comma/space-separated emails.
- Emails are normalized to lowercase before comparison.
- If `VITE_GOOGLE_ALLOWED_EMAILS` is blank or unset, the app allows only `ewlarson@gmail.com`.
- Vite exposes variables prefixed with `VITE_` to browser code. Do not put secrets in these variables.
- The Google OAuth client ID is public configuration, not a secret.
- Restart `npm run dev` after changing `web/.env`; Vite reads these values at startup.

Start the app:

```bash
cd web
npm run dev
```

Open:

```text
http://localhost:5173/ogm-metadata-studio/
```

## Production Configuration

Production builds also need the same `VITE_` values at build time:

```bash
VITE_GOOGLE_CLIENT_ID=1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com
VITE_GOOGLE_ALLOWED_EMAILS=alice@example.edu,bob@example.edu
npm run build
```

For hosted deployments, set those variables in the deployment environment before the Vite build runs, then rebuild and redeploy. Changing the Google client ID or allowed email list after a static build has already been produced will not change the deployed app until it is rebuilt.

Make sure the deployed site origin is listed in the Google Cloud OAuth client's Authorized JavaScript origins. For GitHub Pages, that means the origin such as `https://ewlarson.github.io`, not the full project URL with `/ogm-metadata-studio/`.

## Verification Checklist

1. Visit the app while signed out.
2. Confirm search, dashboard browsing, and resource viewing still work.
3. Open Import / Export or Enrichments and confirm the app asks for Google sign-in.
4. Sign in with an allowed Google account.
5. Confirm the header shows the user's Google name/avatar and a Sign out control.
6. Reopen Import / Export or Enrichments and confirm the signed-in workflow is available.
7. Sign out and confirm the protected views return to the sign-in gate.

In local development, the browser console should include an auth diagnostic similar to:

```text
[Auth] VITE_GOOGLE_CLIENT_ID loaded: yes
```

## Managing Access

Update `VITE_GOOGLE_ALLOWED_EMAILS` when operators change. After the update:

1. Restart the local dev server or rebuild/redeploy production.
2. Ask removed users to sign out, close the browser session, or clear site data.
3. If you need immediate hard enforcement beyond the current browser session, enforce access at the deployment, proxy, or storage layer as well.

The current allowlist is checked when a Google credential is accepted. A profile already restored from `sessionStorage` can remain signed in until sign-out or session storage is cleared.

## Distinguish Google Sign-In From Google APIs

Google Sign-In is separate from the Google API credentials used by enrichment:

| Purpose | Variable/profile field | Where it is used |
| --- | --- | --- |
| Browser sign-in | `VITE_GOOGLE_CLIENT_ID` | React/Vite app, loaded into browser code. |
| Browser sign-in allowlist | `VITE_GOOGLE_ALLOWED_EMAILS` | React/Vite app, loaded into browser code. |
| Google Cloud Vision OCR | `GOOGLE_CLOUD_VISION_API_KEY` | Local enrichment proxy, referenced by a Vision OCR profile. |
| Gemini label extraction | `GEMINI_API_KEY`, `GOOGLE_GEMINI_API_KEY`, or related fallback vars | Local enrichment proxy, referenced by Gemini model profiles. |
| Gemini service account experiments | `GOOGLE_GEMINI_SERVICE_ACCOUNT` | Local enrichment proxy only. |

Do not paste Google API keys, service account JSON, S3 keys, OpenAI keys, Gemini keys, or Kimi keys into `VITE_` variables. `VITE_` variables are bundled into the browser app.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Sign-in not configured. Set VITE_GOOGLE_CLIENT_ID...` | `VITE_GOOGLE_CLIENT_ID` is missing, malformed, or the dev server was not restarted. | Set the value in `web/.env`, then restart `npm run dev`. |
| Google says the origin is not allowed | The current site origin is missing from the OAuth client. | Add the exact origin, such as `http://localhost:5173`, without any path. |
| The GIS script does not load | Browser extension, content blocker, network policy, or failed request to `accounts.google.com`. | Allow `accounts.google.com` for the site, try a clean browser profile, and check the Network tab. |
| Prompt was not displayed or was skipped | GIS suppressed One Tap/prompt UX for the browser state. | Use the rendered Google sign-in button in the header or sign-in gate. |
| `This Google account is not allowed to access this app.` | The signed-in account email is not in `VITE_GOOGLE_ALLOWED_EMAILS`. | Add the email, restart/rebuild, and sign in again. |
| Works locally but not after deploy | Production build did not receive the env vars or the hosted origin is not authorized. | Set build-time env vars, rebuild, redeploy, and add the production origin to Google Cloud. |
| Removed account still appears signed in | The old profile is still in `sessionStorage`. | Sign out, close the browser session, or clear site data for the app origin. |
| UI still shows old auth behavior after env edits | Vite/browser cache is stale. | Stop the dev server, remove `web/node_modules/.vite`, restart, and hard-refresh the browser. |

Cache reset command:

```bash
cd web
rm -rf node_modules/.vite
npm run dev
```

## Security Notes

- The Google OAuth client ID and allowed-email list are public browser configuration.
- The current app decodes the Google ID token in browser code and uses it to unlock UI workflows. It does not send that token to a backend for verification.
- The auth gate improves operator workflow safety, but it should not be treated as the only control for sensitive data or privileged infrastructure.
- Keep provider secrets in `web/.env`, `web/.env.local`, deployment secret stores, or the shell that starts the local proxy. Do not commit them.
- Enrichment profiles should store environment variable names, not secret values.
- GitHub import tokens are entered separately in the Import / Export workflow and are not provided by Google Sign-In.
