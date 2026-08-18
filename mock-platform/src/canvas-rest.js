// Canvas-shaped REST endpoints.
//
// LTI Advantage (NRPS/AGS) is how a launched tool reads course data. It is not
// how a scheduled script does it -- signing a JWT assertion from Apps Script is
// possible but unusual, and real Canvas automations use the REST API with an
// admin token instead.
//
// So this mirrors the shape of the Canvas endpoints an Apps Script integration
// would actually call, including the parts that are annoying in practice:
// Link-header pagination, bearer auth, and submissions carrying workflow_state
// rather than a bare score.
//
// Paths and field names match real Canvas, so the Apps Script client works
// against a real instance by changing one base URL.

import { CONTEXT, MEMBERS, LINE_ITEMS, RESULTS } from './seed.js';

const TOKEN = process.env.CANVAS_API_TOKEN ?? 'demo-canvas-token';

// Canvas numeric ids. The mock uses strings like "user-42" internally, so map
// them to something Canvas-shaped for anything crossing the REST boundary.
const numericUserId = (userId) => Number(String(userId).replace(/\D/g, '')) || 0;
const numericAssignmentId = (lineItemId) =>
  Number(String(lineItemId).slice(String(lineItemId).lastIndexOf('/') + 1).replace(/\D/g, '')) || 0;

function requireToken(req, res, next) {
  const header = req.get('authorization') || '';
  if (header !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ errors: [{ message: 'Invalid access token.' }] });
  }
  next();
}

/**
 * Canvas paginates with a Link header, not a body field. Clients that ignore
 * it silently process only the first page -- a bug that stays invisible until
 * a cohort grows past 100.
 */
function paginate(req, res, items) {
  const perPage = Math.min(Number(req.query.per_page) || 100, 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const lastPage = Math.max(Math.ceil(items.length / perPage), 1);

  const base = `${req.protocol}://${req.get('host')}${req.path}`;
  const link = (p, rel) => {
    const q = new URLSearchParams({ ...req.query, page: String(p), per_page: String(perPage) });
    return `<${base}?${q}>; rel="${rel}"`;
  };

  const links = [link(1, 'first'), link(lastPage, 'last')];
  if (page < lastPage) links.unshift(link(page + 1, 'next'));
  if (page > 1) links.unshift(link(page - 1, 'prev'));
  res.set('Link', links.join(', '));

  return items.slice((page - 1) * perPage, page * perPage);
}

export function mountCanvasRest(app, { failureMode } = {}) {
  const chaos = (res) => {
    const mode = failureMode?.mode ?? 'off';
    if (mode === 'error') {
      res.status(500).json({ errors: [{ message: 'simulated upstream failure' }] });
      return true;
    }
    if (mode === 'ratelimit') {
      // Canvas signals throttling with 403 and an X-Rate-Limit-Remaining of 0,
      // not 429. A client that only handles 429 will hammer straight through it.
      res.set('X-Rate-Limit-Remaining', '0').status(403)
        .json({ errors: [{ message: '403 Forbidden (Rate Limit Exceeded)' }] });
      return true;
    }
    return false;
  };

  // --- Enrollments --------------------------------------------------------
  app.get('/api/v1/courses/:courseId/enrollments', requireToken, (req, res) => {
    if (chaos(res)) return;
    if (req.params.courseId !== CONTEXT.id) {
      return res.status(404).json({ errors: [{ message: 'The specified resource does not exist.' }] });
    }

    const wanted = [].concat(req.query['type[]'] ?? req.query.type ?? []);
    const states = [].concat(req.query['state[]'] ?? req.query.state ?? []);

    let rows = MEMBERS.map((m) => {
      const isLearner = m.roles.some((r) => r.endsWith('#Learner'));
      return {
        id: numericUserId(m.user_id) + 1000,
        user_id: numericUserId(m.user_id),
        course_id: CONTEXT.id,
        type: isLearner ? 'StudentEnrollment' : 'TeacherEnrollment',
        role: isLearner ? 'StudentEnrollment' : 'TeacherEnrollment',
        enrollment_state: m.status === 'Active' ? 'active' : 'inactive',
        sis_user_id: m.lis_person_sourcedid ?? null,
        user: {
          id: numericUserId(m.user_id),
          name: m.name,
          sortable_name: m.name.split(' ').reverse().join(', '),
          login_id: m.email,
          sis_user_id: m.lis_person_sourcedid ?? null,
        },
      };
    });

    if (wanted.length) rows = rows.filter((r) => wanted.includes(r.type));
    if (states.length) rows = rows.filter((r) => states.includes(r.enrollment_state));

    res.json(paginate(req, res, rows));
  });

  // --- Assignments --------------------------------------------------------
  app.get('/api/v1/courses/:courseId/assignments', requireToken, (req, res) => {
    if (chaos(res)) return;
    if (req.params.courseId !== CONTEXT.id) {
      return res.status(404).json({ errors: [{ message: 'The specified resource does not exist.' }] });
    }

    const rows = LINE_ITEMS.map((item) => ({
      id: numericAssignmentId(item.id),
      course_id: CONTEXT.id,
      name: item.label,
      points_possible: item.scoreMaximum,
      // Requirements match on this. It is the SIS-facing identifier and
      // survives a course copy, unlike the numeric assignment id.
      integration_id: item.resourceId,
      published: true,
      grading_type: 'points',
      submission_types: ['online_upload'],
    }));

    res.json(paginate(req, res, rows));
  });

  // --- Submissions --------------------------------------------------------
  // Richer than AGS results: workflow_state and submitted_at distinguish
  // "handed in but ungraded" from "never handed in", which AGS cannot express.
  app.get('/api/v1/courses/:courseId/students/submissions', requireToken, (req, res) => {
    if (chaos(res)) return;
    if (req.params.courseId !== CONTEXT.id) {
      return res.status(404).json({ errors: [{ message: 'The specified resource does not exist.' }] });
    }

    const rows = [];
    for (const item of LINE_ITEMS) {
      const key = item.id.slice(item.id.lastIndexOf('/') + 1);
      const graded = RESULTS[key] ?? [];
      const gradedByUser = new Map(graded.map((g) => [g.userId, g]));

      for (const member of MEMBERS) {
        if (!member.roles.some((r) => r.endsWith('#Learner'))) continue;
        const hit = gradedByUser.get(member.user_id);

        rows.push({
          id: `${numericAssignmentId(item.id)}-${numericUserId(member.user_id)}`,
          assignment_id: numericAssignmentId(item.id),
          user_id: numericUserId(member.user_id),
          score: hit ? hit.resultScore : null,
          grade: hit ? String(hit.resultScore) : null,
          workflow_state: hit ? 'graded' : 'unsubmitted',
          submitted_at: hit ? '2026-08-01T10:00:00Z' : null,
          graded_at: hit ? '2026-08-02T10:00:00Z' : null,
          late: false,
          missing: !hit,
        });
      }
    }

    const studentIds = [].concat(req.query['student_ids[]'] ?? req.query.student_ids ?? []);
    const filtered = studentIds.length && !studentIds.includes('all')
      ? rows.filter((r) => studentIds.map(Number).includes(r.user_id))
      : rows;

    res.json(paginate(req, res, filtered));
  });

  // --- Identity check -----------------------------------------------------
  // Apps Script setup calls this first to confirm the token works before
  // anything more interesting fails for a less obvious reason.
  app.get('/api/v1/users/self', requireToken, (req, res) => {
    res.json({ id: 1, name: 'Integration Service Account', login_id: 'svc@example.com' });
  });
}
