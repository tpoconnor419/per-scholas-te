# LTI 1.3 Reference Implementation

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

