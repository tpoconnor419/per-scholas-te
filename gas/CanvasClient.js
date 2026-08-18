/**
 Canvas REST client.
 
  Two things that catch people out and are handled here:
 
  1. Canvas paginates with a Link header, not a body field. A client that
     ignores it silently reads only the first 100 records -- which looks
     correct until a cohort grows.
 
  2. Canvas throttles with 403 and an exhausted X-Rate-Limit-Remaining, not
     429. Code that only retries on 429 walks straight into it.
 */

function canvasGet_(path, params) {
  const url = CONFIG.canvasBaseUrl + path + (params ? '?' + toQuery_(params) : '');
  return canvasFetch_(url);
}

/** Follows rel="next" until Canvas stops offering one. */
function canvasGetAll_(path, params) {
  let url = CONFIG.canvasBaseUrl + path + '?' + toQuery_(
    Object.assign({ per_page: 100 }, params || {})
  );

  const all = [];
  let pages = 0;

  while (url && pages < 50) {
    const page = canvasFetch_(url, true);
    all.push.apply(all, page.body);
    url = nextLink_(page.headers);
    pages += 1;
  }

  if (pages >= 50) {
    throw new SyncError('Canvas pagination exceeded 50 pages; refusing to continue', 'permanent');
  }
  return all;
}

function canvasFetch_(url, withHeaders) {
  let last = null;

  for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + CONFIG.canvasToken,
        Accept: 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      muteHttpExceptions: true,   // otherwise a 4xx throws before we can classify it
      followRedirects: true,
      validateHttpsCertificates: true,
    });

    const status = response.getResponseCode();
    const text = response.getContentText();

    if (status >= 200 && status < 300) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new SyncError('Canvas returned non-JSON: ' + text.slice(0, 200), 'permanent');
      }
      return withHeaders
        ? { body: parsed, headers: response.getAllHeaders() }
        : parsed;
    }

    const classification = classifyHttp_(status, text);
    last = new SyncError(
      'Canvas ' + status + ' for ' + url.replace(CONFIG.canvasBaseUrl, '') + ': ' + text.slice(0, 200),
      classification,
      { status: status }
    );

    if (classification !== 'transient') throw last;

    // Exponential backoff with jitter. Without jitter, several triggers firing
    // at once would retry in lockstep and re-collide every time.
    if (attempt < CONFIG.MAX_ATTEMPTS) {
      Utilities.sleep(Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 400));
    }
  }

  throw last;
}

/** Link: <url>; rel="next", <url>; rel="last" */
function nextLink_(headers) {
  const raw = headers.Link || headers.link;
  if (!raw) return null;

  const parts = String(raw).split(',');
  for (let i = 0; i < parts.length; i++) {
    const match = parts[i].match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match && match[2] === 'next') return match[1];
  }
  return null;
}

function toQuery_(params) {
  const pairs = [];
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v) => pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(v)));
    } else {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    }
  });
  return pairs.join('&');
}

/**
  Everything the evaluator needs, in exactly the shape the LTI provider
  returns. That is the point: the evaluator does not know or care which
  system the data came from, so Canvas REST and LTI Advantage are
  interchangeable behind this boundary.
 
  @returns {{context, learners, lineItems, scores, fetchedAt}}
 */
function fetchCourseSnapshot_() {
  const courseId = CONFIG.canvasCourseId;

  const enrollments = canvasGetAll_('/api/v1/courses/' + courseId + '/enrollments', {
    'type[]': 'StudentEnrollment',
  });

  const assignments = canvasGetAll_('/api/v1/courses/' + courseId + '/assignments');

  const submissions = canvasGetAll_(
    '/api/v1/courses/' + courseId + '/students/submissions',
    { 'student_ids[]': 'all' }
  );

  // Inactive enrolments are dropped here rather than in the evaluator. A
  // dropped learner is not "not ready" -- they are not in the cohort at all.
  const learners = enrollments
    .filter((e) => e.enrollment_state === 'active')
    .map((e) => ({
      userId: String(e.user_id),
      name: (e.user && e.user.name) || null,
      email: (e.user && e.user.login_id) || null,
      sourcedId: e.sis_user_id || (e.user && e.user.sis_user_id) || null,
    }));

  const lineItems = assignments.map((a) => ({
    id: String(a.id),
    label: a.name,
    tag: null,
    resourceId: a.integration_id || null,
    scoreMaximum: a.points_possible,
  }));

  const maximumById = {};
  lineItems.forEach((item) => { maximumById[item.id] = item.scoreMaximum; });

  const scores = {};
  lineItems.forEach((item) => { scores[item.id] = {}; });

  submissions.forEach((sub) => {
    const assignmentId = String(sub.assignment_id);
    if (!scores[assignmentId]) return;

    const submitted = sub.workflow_state !== 'unsubmitted' && sub.submitted_at !== null;
    const maximum = maximumById[assignmentId];

    // Only record a cell if there is something to say. An untouched assignment
    // produces no entry, which the evaluator reads as "no result".
    if (!submitted && sub.score === null) return;

    scores[assignmentId][String(sub.user_id)] = {
      score: sub.score,
      maximum: maximum,
      percent: sub.score === null || !maximum ? null : sub.score / maximum,
      // REST can distinguish "handed in but ungraded" from "never handed in".
      // AGS cannot -- it only has result rows. The evaluator uses this when
      // present and falls back to row existence when it is absent.
      submitted: submitted,
    };
  });

  return {
    context: { id: courseId, label: courseId, title: courseId },
    learners: learners,
    lineItems: lineItems,
    scores: scores,
    fetchedAt: new Date().toISOString(),
  };
}