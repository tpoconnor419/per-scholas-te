// Dashboard routes.
//
// The one non-obvious piece: POST /api/sync starts the job and returns a run
// id immediately rather than awaiting it. A full sync takes about five
// seconds, which is fine for a scheduled job and far too long to hold an HTTP
// request open while someone watches a spinner. The page polls instead.
//
// This is also why the orchestrator opens its ledger row before doing any
// expensive work -- the poll endpoint has something to report from the moment
// the job starts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDashboardData } from './dashboard-data.js';
import { syncCohort } from './sync-cohort.js';
import { reportIssues, recordSyncFailure } from './report-issues.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In-memory job registry. A real deployment needs a queue -- if the process
// restarts mid-sync, the run is orphaned and only the Airtable ledger row
// (status "running", no finished_at) records that it happened.
const jobs = new Map();

const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function createSession(data) {
  const id = crypto.randomUUID();
  sessions.set(id, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

function readSession(req) {
  const raw = req.headers.cookie ?? '';
  const match = raw.split(';').map((c) => c.trim().split('=')).find(([k]) => k === 'sid');
  if (!match) return null;

  const session = sessions.get(match[1]);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  return session;
}

const INSTRUCTOR_ROLES = ['#Instructor', '#Administrator', '#ContentDeveloper', '#Mentor'];

function requireStaff(req, res, next) {
  const session = readSession(req);

  // Development escape hatch: without it you cannot open the dashboard
  // without performing a full LTI launch first, which makes iterating on the
  // page tedious. Never enable this in a real deployment.
  if (!session && process.env.NODE_ENV !== 'production' && req.query.context) {
    req.session = { contextId: req.query.context, name: 'Developer', roles: ['#Instructor'] };
    return next();
  }

  if (!session) {
    return res.status(401).send('Open this page from your course in Canvas.');
  }
  if (!session.roles.some((r) => INSTRUCTOR_ROLES.some((allowed) => r.endsWith(allowed)))) {
    return res.status(403).send('This view is for course staff.');
  }

  req.session = session;
  next();
}

export function mountDashboard(app, { airtable, asana, fetchSnapshot, platforms }) {
  app.get('/dashboard', requireStaff, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  });

  app.get('/api/dashboard', requireStaff, async (req, res) => {
    try {
      const data = await getDashboardData(airtable, req.session.contextId);
      res.json({ ...data, viewer: { name: req.session.name } });
    } catch (err) {
      res.status(err.status ?? 500).json({
        error: err.message,
        classification: err.classification ?? 'unclassified',
      });
    }
  });

  app.post('/api/sync', requireStaff, (req, res) => {
    const contextId = req.session.contextId;

    // One sync per cohort at a time. Two concurrent runs would race on the
    // same upsert keys and produce a confusing ledger.
    const running = [...jobs.values()].find(
      (j) => j.contextId === contextId && j.status === 'running'
    );
    if (running) {
      return res.status(409).json({ error: 'A sync is already running', jobId: running.jobId });
    }

    const jobId = crypto.randomUUID();
    const platform = platforms[req.session.issuer] ?? Object.values(platforms)[0];
    const job = { jobId, contextId, status: 'running', startedAt: Date.now() };
    jobs.set(jobId, job);

    // Deliberately not awaited.
    (async () => {
      let failure = null;
      let result = null;

      try {
        result = await syncCohort(
          { airtable, fetchSnapshot, platform },
          { contextId, trigger: 'manual', verbose: false }
        );
      } catch (err) {
        failure = err;
        try {
          await recordSyncFailure(airtable, err, { contextId, runId: job.jobId });
        } catch (recordErr) {
          job.recordWarning = recordErr.message;
        }
      }

      // Runs whether the sync succeeded or died. A hard failure is exactly the
      // case staff most need told about.
      if (asana) {
        try {
          await reportIssues({ airtable, asana }, {
            cohortName: contextId,
            runId: result?.runId ?? 'failed-run',
          });
        } catch (err) {
          job.asanaWarning = err.message;
        }
      }

      Object.assign(job, failure
        ? {
            status: 'error',
            finishedAt: Date.now(),
            error: failure.message,
            classification: failure.classification ?? 'unclassified',
          }
        : {
            status: 'done',
            finishedAt: Date.now(),
            summary: result.summary,
            issues: result.issues.length,
          });
    })();

    res.status(202).json({ jobId });
  });

  app.get('/api/sync/:jobId', requireStaff, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Unknown job' });
    res.json(job);
  });
}
