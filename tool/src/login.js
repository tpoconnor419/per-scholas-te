import { randomUUID } from 'crypto';
import { platforms } from './registrations.js';
import { saveState } from './state-store.js';

export function handleLogin(req, res) {
  const params = { ...req.query, ...req.body };
  const { iss, login_hint, target_link_uri, client_id, lti_deployment_id, lti_message_hint } =
    params;

  if (!iss || !login_hint || !target_link_uri || !client_id) {
    return res.status(400).send('Missing required OIDC login parameters');
  }

  const platform = platforms[iss];
  if (!platform) return res.status(400).send('Unknown platform issuer');
  if (platform.clientId !== client_id) return res.status(400).send('client_id mismatch');
  if (lti_deployment_id && lti_deployment_id !== platform.deploymentId) {
    return res.status(400).send('Unknown deployment_id');
  }

  const state = randomUUID();
  const nonce = randomUUID();

  saveState(state, { nonce, iss });

  const authUrl = new URL(platform.authorizationEndpoint);
  authUrl.searchParams.set('scope', 'openid');
  authUrl.searchParams.set('response_type', 'id_token');
  authUrl.searchParams.set('response_mode', 'form_post');
  authUrl.searchParams.set('prompt', 'none');
  authUrl.searchParams.set('client_id', client_id);
  authUrl.searchParams.set('redirect_uri', target_link_uri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('login_hint', login_hint);
  if (lti_message_hint) authUrl.searchParams.set('lti_message_hint', lti_message_hint);

  res.redirect(authUrl.toString());
}
