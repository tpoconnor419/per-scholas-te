import express from 'express';
import { SignJWT } from 'jose';
import { initKeys, getPrivateKey, getKid, getJwks } from './keys.js';
import { tools, PLATFORM_ISSUER } from './registrations.js';
import { handleToken } from './token.js';
import { mountServices, failureMode } from './services.js';
import { MEMBERS, CONTEXT } from './seed.js';
import { mountCanvasRest } from './canvas-rest.js';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.post('/token', handleToken);
mountServices(app);
mountCanvasRest(app, { failureMode });

await initKeys();

const TOOL = tools['demo-tool-client-id'];

// Who can launch. Identity AND role come from the roster the platform already
// serves over NRPS, so the id_token cannot disagree with the membership list --
// which it would if the role were a separate parameter someone had to keep in
// sync by hand.
function findMember(userId) {
  return MEMBERS.find((m) => m.user_id === userId);
}

const LAUNCHABLE = MEMBERS.filter((m) => m.status === 'Active');

function shortRole(member) {
  const role = member.roles[0] ?? '';
  return role.slice(role.lastIndexOf('#') + 1);
}

// --- Course home page ------------------------------------------------------
app.get('/', (req, res) => {
  const buttons = LAUNCHABLE.map((member) => {
    const role = shortRole(member);
    const isStaff = role !== 'Learner';
    return `
      <form action="/login-init" method="POST" class="row">
        <input type="hidden" name="iss" value="${PLATFORM_ISSUER}" />
        <input type="hidden" name="login_hint" value="${member.user_id}" />
        <input type="hidden" name="target_link_uri" value="http://localhost:4001/launch" />
        <input type="hidden" name="client_id" value="${TOOL.clientId}" />
        <input type="hidden" name="lti_deployment_id" value="${TOOL.deploymentId}" />
        <input type="hidden" name="lti_message_hint" value="resource-link-1" />
        <div>
          <strong>${member.name}</strong>
          <span class="role ${isStaff ? 'staff' : ''}">${role}</span>
          <div class="sub">${member.user_id}${member.lis_person_sourcedid ? ` &middot; ${member.lis_person_sourcedid}` : ' &middot; no program ID'}</div>
        </div>
        <button type="submit"${isStaff ? ' class="primary"' : ''}>Launch</button>
      </form>`;
  }).join('');

  res.send(`<!doctype html>
    <html><head><meta charset="utf-8"><title>Mock LMS</title><style>
      body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #16233b; }
      h1 { font-size: 22px; margin-bottom: 4px; }
      p.lede { color: #55617a; margin-top: 0; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
             padding: 14px 0; border-bottom: 1px solid #dde3ec; margin: 0; }
      .sub { font-family: ui-monospace, monospace; font-size: 12px; color: #7a869c; margin-top: 2px; }
      .role { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
              background: #eef1f5; color: #55617a; padding: 2px 7px; border-radius: 3px; margin-left: 8px; }
      .role.staff { background: #e2f0e9; color: #17714f; }
      button { font: inherit; padding: 8px 16px; border: 1px solid #c3ccda; background: #fff;
               border-radius: 3px; cursor: pointer; }
      button.primary { background: #2b52c4; border-color: #2b52c4; color: #fff; font-weight: 600; }
      .note { margin-top: 24px; font-size: 13px; color: #55617a; }
    </style></head><body>
      <h1>Mock LMS &mdash; ${CONTEXT.title}</h1>
      <p class="lede">Launching as a member of this course sends a signed LTI 1.3 id_token to the tool.</p>
      ${buttons}
      <p class="note">Staff launches open the certification readiness dashboard.
      Learner launches receive the same id_token but are refused by the dashboard,
      which is the authorization check working.</p>
    </body></html>`);
});

// --- Step 1: platform sends the browser to the TOOL's login endpoint -------
// In a real deployment, the platform stores the tool's "initiate_login_uri"
// and sends the browser straight there when a resource link is clicked. This
// route just simulates that hop for the demo.
app.post('/login-init', (req, res) => {
  const params = new URLSearchParams(req.body).toString();
  res.redirect(`http://localhost:4001/login?${params}`);
});

// --- JWKS ------------------------------------------------------------------
app.get('/.well-known/jwks.json', (req, res) => {
  res.json(getJwks());
});

// --- Step 3: OIDC authorization endpoint -----------------------------------
// The tool redirects the browser here (step 2, handled tool-side). This
// endpoint authenticates the user (skipped for the demo), builds the LTI
// id_token, signs it, and auto-POSTs it back to the tool.
app.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, login_hint, state, nonce, lti_message_hint } = req.query;

  const tool = tools[client_id];
  if (!tool) return res.status(400).send('Unknown client_id');
  if (!tool.redirectUris.includes(redirect_uri)) {
    return res.status(400).send('Unregistered redirect_uri for this client');
  }

  // A real platform authenticates the browser session here and matches it to
  // login_hint. We trust the hint because this is a mock.
  const member = findMember(login_hint);
  if (!member) return res.status(400).send(`No course member with id "${login_hint}"`);

  const now = Math.floor(Date.now() / 1000);

  const idToken = await new SignJWT({
    // Standard OIDC claims
    sub: member.user_id,
    nonce,
    name: member.name,
    email: member.email,

    // Core LTI 1.3 claims
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': tool.deploymentId,
    'https://purl.imsglobal.org/spec/lti/claim/target_link_uri': redirect_uri,
    'https://purl.imsglobal.org/spec/lti/claim/resource_link': {
      id: lti_message_hint || 'resource-link-1',
      title: 'Certification Readiness',
    },
    'https://purl.imsglobal.org/spec/lti/claim/roles': member.roles,
    'https://purl.imsglobal.org/spec/lti/claim/context': {
      id: CONTEXT.id,
      label: CONTEXT.label,
      title: CONTEXT.title,
      type: CONTEXT.type,
    },

    // Canvas also sends the SIS id here. The tool reads it from NRPS instead,
    // because a background sync has no id_token to read.
    'https://purl.imsglobal.org/spec/lti/claim/lis': member.lis_person_sourcedid
      ? { person_sourcedid: member.lis_person_sourcedid }
      : {},

    'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint': {
      scope: [
        'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly',
        'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
      ],
      lineitems: `${PLATFORM_ISSUER}/context/${CONTEXT.id}/line_items`,
    },
    'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice': {
      context_memberships_url: `${PLATFORM_ISSUER}/context/${CONTEXT.id}/memberships`,
      service_versions: ['2.0'],
    },
  })
    .setProtectedHeader({ alg: 'RS256', kid: getKid() })
    .setIssuer(PLATFORM_ISSUER)
    .setAudience(client_id)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(getPrivateKey());

  // The id_token travels to the tool via a browser POST (form_post), not a
  // redirect -- this auto-submitting form is the standard way to do that.
  res.send(`
    <html>
      <body onload="document.forms[0].submit()">
        <p>Signing in as ${member.name}&hellip;</p>
        <form action="${redirect_uri}" method="POST">
          <input type="hidden" name="id_token" value="${idToken}" />
          <input type="hidden" name="state" value="${state}" />
        </form>
      </body>
    </html>
  `);
});

app.listen(4000, () => {
  console.log('mock-platform listening on http://localhost:4000');
  console.log(`  ${LAUNCHABLE.length} launchable members, ${LAUNCHABLE.filter((m) => shortRole(m) !== 'Learner').length} staff`);
});
