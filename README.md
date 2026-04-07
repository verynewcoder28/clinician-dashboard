# Clinician Performance Dashboard

SMART on FHIR provider-facing dashboard.
Launched from an EHR context (Cerner Millennium). Not a standalone app.

---

## App Registration

| Field | Value |
|---|---|
| Cerner Code Console Client ID | `7b891b95-d872-453d-aa7c-d5c602cde619` |
| SMART Version | v1 |
| FHIR Version | R4 |
| Application Privacy | Confidential |
| Launch URL | `https://verynewcoder28.github.io/clinician-dashboard/launch.html` |
| Redirect URI | `https://verynewcoder28.github.io/clinician-dashboard/` |

---

## Scopes

```
launch
openid
profile
online_access
user/Appointment.read
user/Encounter.read
user/ServiceRequest.read
user/Practitioner.read
user/Patient.read
```

---

## File Structure

```
clinician-dashboard/
├── launch.html                          # SMART EHR launch entry point
├── index.html                           # Post-auth debug view (token + Practitioner dump)
├── health.html                          # Simple health check — returns "OK"
├── README.md
└── lib/
    ├── fhir-client.js                   # fhirclient npm package (local copy)
    └── fhir-client-cerner-additions.min.js  # Cerner SMART additions (MPages compatibility)
```

### File roles

**`launch.html`**
The URL registered as the Launch URL in Cerner Code Console. Calls `FHIR.oauth2.authorize()` to kick off the OAuth 2.0 authorisation code flow. The EHR calls this with `launch` and `iss` query parameters attached.

**`index.html`**
The Redirect URI. Calls `FHIR.oauth2.ready()` to complete the token exchange. Currently a debug view — dumps the token state and fetches/renders the Practitioner resource as JSON. This will become the full dashboard UI in a later phase.

**`health.html`**
Returns a plain `OK` response. Used to verify the GitHub Pages deployment is live.

**`lib/fhir-client.js`**
Local copy of the [fhirclient](https://github.com/smart-on-fhir/client-js) library. Do not replace with a CDN link — MPages requires all assets to be local.

**`lib/fhir-client-cerner-additions.min.js`**
Local copy of Cerner's [fhir-client-cerner-additions](https://github.com/cerner/fhir-client-cerner-additions). Detects PowerChart (`window.external.DiscernObjectFactory`) and adjusts `fullSessionStorageSupport` so session data is shared correctly across tabs in the embedded context.

---

## How to Test with SMART App Launcher

1. Go to [https://launch.smarthealthit.org/](https://launch.smarthealthit.org/)
2. Set **FHIR Version** to `R4`
3. Set **App Launch URL** to `https://verynewcoder28.github.io/clinician-dashboard/launch.html`
4. Under **App Type**, select `Provider EHR Launch`
5. Choose a Practitioner from the patient/provider picker (optional but recommended)
6. Click **Launch**
7. The launcher redirects to `launch.html`, which redirects to the launcher's authorisation screen, then back to `index.html`
8. `index.html` should show:
   - Green status bar: "Authorised — token received"
   - Token fields (type, expiry, scope, patient, encounter)
   - ID token claims decoded from the JWT
   - Practitioner resource JSON fetched from the FHIR server

**Troubleshooting the SMART Launcher**

| Symptom | Likely cause |
|---|---|
| Red error bar with `No 'state' parameter` | `launch.html` did not run before `index.html` — always start at `launch.html` |
| Practitioner fetch shows `404` | The launcher sandbox may not have a Practitioner resource for the selected user — try selecting a different provider or using a specific Practitioner ID |
| Blank page | GitHub Pages may not have the latest deploy yet — wait 1–2 minutes |

---

## How to Update for Cerner Non-Prod

1. Log in to [Cerner Code Console](https://code.cerner.com/) and open your app registration.
2. Update the **FHIR Server URL** to the non-prod Cerner tenant URL provided by your Cerner implementation team (format: `https://<tenant>.cernerworks.com/...` or similar).
3. In `launch.html`, no code change is needed — the `iss` parameter injected by the EHR points `fhir-client` at the correct server automatically.
4. Ensure the **Launch URL** and **Redirect URI** in the Code Console match exactly what is deployed to GitHub Pages (including the trailing slash on the redirect URI).
5. Test from within the Cerner non-prod PowerChart by navigating to the app via its registered launch URL.
6. If launching inside PowerChart (MPage embed), `fhir-client-cerner-additions.min.js` will automatically disable `fullSessionStorageSupport` — no additional configuration needed.

---

## Updating the Local JS Libraries

**fhir-client.js**
```bash
curl -o lib/fhir-client.js \
  https://cdn.jsdelivr.net/npm/fhirclient/build/fhir-client.js
```

**fhir-client-cerner-additions.min.js**
```bash
curl -o lib/fhir-client-cerner-additions.min.js \
  https://raw.githubusercontent.com/cerner/fhir-client-cerner-additions/main/dist/js/fhir-client-cerner-additions-1.0.0.min.js
```

---

## Status

- [x] SMART EHR launch flow (`launch.html`)
- [x] Post-auth token + Practitioner debug view (`index.html`)
- [x] Health check (`health.html`)
- [ ] Dashboard UI (Phase 2)
