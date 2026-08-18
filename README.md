# LTI 1.3 Round 1 Reference Implementation

Companion code for `lti13-practice-curriculum.md`. This covers milestones
**M1–M4**: keys/registration, OIDC login, id_token validation, and a
resource-link launch. Deep linking (M5) and service calls (M6) are left for
you to add during a later round — the curriculum doc has the claim names and
checklist for those.

Two independent Express apps, talking over plain HTTP on localhost. Treat
`mock-platform` as a black box "LMS" you don't get to cheat by importing code
from — everything crosses the wire as real HTTP requests and signed JWTs,
just like a real integration.

## Run it

Two terminals:

```bash
cd mock-platform
npm install
npm start        # http://localhost:4000
```

```bash
cd tool
npm install
npm start        # http://localhost:4001
```

Then open **http://localhost:4000** in a browser and click **Launch Tool**.
You should land on the tool's launch page showing the decoded LTI claims.

## What to trace through, in order

1. `mock-platform/src/server.js` — `GET /` (the launch button) →
   `POST /login-init` (simulates the platform sending the browser to the
   tool's login endpoint).
2. `tool/src/login.js` — validates the request, generates `state`/`nonce`,
   stores them server-side, redirects to the platform's `/authorize`.
3. `mock-platform/src/server.js` — `GET /authorize` builds and signs the
   id_token, returns an auto-submitting HTML form.
4. `tool/src/launch.js` — receives the POST, verifies the JWT against the
   platform's JWKS, checks `state`/`nonce`/`deployment_id`, renders claims.

## Where the keys live

Each app generates its own RSA keypair on startup (`src/keys.js`) and
publishes the public half at `/.well-known/jwks.json`. Nothing is persisted
to disk — restart either server and it gets a fresh keypair (fine here since
both sides fetch JWKS live on every verification; not how you'd do key
rotation in production, but correct for practice).

## This is Round 1 only

Per the curriculum, don't keep coming back to edit this repo. Study it, then
for Round 2 start a **new, empty folder** and rebuild from the cheat sheet
alone. Come back to this repo only to diff against what you produce.
