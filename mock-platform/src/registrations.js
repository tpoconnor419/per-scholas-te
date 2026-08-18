// Tools that this platform has "registered". In a real LMS this data lives
// in a database and is entered by an admin when the tool is installed.

//export const PLATFORM_ISSUER = 'http://localhost:4000';

export const tools = {
  'demo-tool-client-id': {
    clientId: 'demo-tool-client-id',
    deploymentId: 'demo-deployment-1',
    redirectUris: ['http://localhost:4001/launch'],
    jwksUri: 'http://localhost:4001/.well-known/jwks.json',
  },
};

export const PLATFORM_ISSUER = 'http://localhost:4000';
export const PLATFORM_TOKEN_ENDPOINT = `${PLATFORM_ISSUER}/token`;
