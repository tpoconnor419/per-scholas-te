// Platforms this tool trusts. In a real tool this is stored per-tenant in a
// database, keyed by issuer (+ client_id, since one issuer can have multiple
// deployments/clients).

export const platforms = {
  'http://localhost:4000': {
    issuer: 'http://localhost:4000',
    clientId: 'demo-tool-client-id',
    deploymentId: 'demo-deployment-1',
    authorizationEndpoint: 'http://localhost:4000/authorize',
    tokenEndpoint: 'http://localhost:4000/token',
    jwksUri: 'http://localhost:4000/.well-known/jwks.json',
  },
};
