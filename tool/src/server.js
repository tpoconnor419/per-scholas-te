import express from 'express';
import { initKeys, getJwks } from './keys.js';
import { handleLogin } from './login.js';
import { handleLaunch } from './launch.js';
import { AirtableClient } from './airtable-client.js';
import { AsanaClient } from './asana-client.js';
import { fetchCourseSnapshot } from './lti-provider.js';
import { platforms } from './registrations.js';
import { mountDashboard } from './dashboard.js';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

await initKeys();

app.get('/.well-known/jwks.json', (req, res) => res.json(getJwks()));

// Platforms may send the OIDC login-init as GET or POST depending on config
app.get('/login', handleLogin);
app.post('/login', handleLogin);

app.post('/launch', handleLaunch);

mountDashboard(app, {
  airtable: new AirtableClient(),
  asana: process.env.ASANA_PAT ? new AsanaClient() : null,
  fetchSnapshot: fetchCourseSnapshot,
  platforms,
});

// Temporary: proves the client_credentials round trip works without a launch.
// Delete once the real sync job calls fetchCourseSnapshot.
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/snapshot', async (req, res) => {
    try {
      const snapshot = await fetchCourseSnapshot(platforms['http://localhost:4000'], {
        membershipsUrl: 'http://localhost:4000/context/course-101/memberships',
        lineItemsUrl: 'http://localhost:4000/context/course-101/line_items',
      });
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({
        name: err.name,
        classification: err.classification,
        status: err.status,
        message: err.message,
      });
    }
  });
}

app.listen(4001, () => console.log('tool listening on http://localhost:4001'));

