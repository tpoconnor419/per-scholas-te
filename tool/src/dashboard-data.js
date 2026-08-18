// Assembles everything the dashboard needs from Airtable in one shape.
//
// Kept separate from the route handlers so the view model can be built and
// inspected without an HTTP request -- and so the page has exactly one source
// of data rather than six fetches racing each other.

export async function getDashboardData(airtable, contextId) {
  const cohorts = await airtable.list('Cohorts', {
    filterByFormula: `{canvas_context_id} = '${contextId}'`,
  });

  if (cohorts.length === 0) {
    const err = new Error(`No cohort configured for course ${contextId}`);
    err.classification = 'config';
    err.status = 404;
    throw err;
  }

  const cohort = cohorts[0];
  const trackIds = cohort.fields.track ?? [];

  const [allRequirements, allLearners, allReadiness, allRuns, allIssues] = await Promise.all([
    airtable.list('Requirements'),
    airtable.list('Learners'),
    airtable.list('Readiness'),
    airtable.list('Sync Runs'),
    airtable.list('Sync Issues'),
  ]);

  const requirements = allRequirements
    .filter((r) => (r.fields.track ?? []).some((id) => trackIds.includes(id)))
    .sort((a, b) => (a.fields.sort_order ?? 0) - (b.fields.sort_order ?? 0));

  const requirementById = new Map(requirements.map((r) => [r.id, r]));

  const learners = allLearners
    .filter((l) => (l.fields.cohort ?? []).includes(cohort.id))
    .sort((a, b) => (a.fields.display_name ?? '').localeCompare(b.fields.display_name ?? ''));

  const learnerIds = new Set(learners.map((l) => l.id));

  // Readiness keyed by learner record id, then requirement record id, so the
  // matrix can look up any cell in constant time.
  const cells = new Map();
  for (const row of allReadiness) {
    const learnerId = (row.fields.learner ?? [])[0];
    const requirementId = (row.fields.requirement ?? [])[0];
    if (!learnerId || !requirementId || !learnerIds.has(learnerId)) continue;
    if (!cells.has(learnerId)) cells.set(learnerId, new Map());
    cells.get(learnerId).set(requirementId, row.fields);
  }

  const runs = allRuns
    .filter((r) => (r.fields.cohort ?? []).includes(cohort.id))
    .sort((a, b) => new Date(b.fields.started_at ?? 0) - new Date(a.fields.started_at ?? 0));

  const issues = allIssues
    .filter((i) => !i.fields.resolved && (i.fields.cohort ?? []).includes(cohort.id))
    .sort((a, b) => new Date(b.fields.last_seen ?? 0) - new Date(a.fields.last_seen ?? 0));

  // How many learners cleared each requirement. This is the number that turns
  // the table into something you can act on -- it names the bottleneck.
  const clearedByRequirement = new Map();
  for (const requirement of requirements) {
    let cleared = 0;
    for (const learner of learners) {
      if (cells.get(learner.id)?.get(requirement.id)?.met) cleared += 1;
    }
    clearedByRequirement.set(requirement.id, cleared);
  }

  return {
    cohort: {
      name: cohort.fields.name,
      contextId: cohort.fields.canvas_context_id,
      status: cohort.fields.status ?? null,
      voucherDeadline: cohort.fields.voucher_deadline ?? null,
    },
    requirements: requirements.map((r) => ({
      id: r.id,
      name: r.fields.name,
      type: r.fields.type,
      threshold: r.fields.threshold ?? null,
      resourceId: r.fields.line_item_resource_id ?? null,
      cleared: clearedByRequirement.get(r.id) ?? 0,
    })),
    learners: learners.map((l) => ({
      id: l.id,
      name: l.fields.display_name ?? l.fields.canvas_user_id,
      sourcedId: l.fields.sourced_id,
      status: l.fields.readiness_status ?? 'needs_review',
      met: l.fields.requirements_met ?? 0,
      total: l.fields.requirements_total ?? requirements.length,
      blocking: l.fields.blocking_summary ?? '',
      cells: requirements.map((r) => {
        const cell = cells.get(l.id)?.get(r.id);
        return {
          requirementId: r.id,
          met: Boolean(cell?.met),
          label: cell?.observed_label ?? null,
          value: cell?.observed_value ?? null,
        };
      }),
    })),
    counts: {
      total: learners.length,
      ready: learners.filter((l) => l.fields.readiness_status === 'ready').length,
      notReady: learners.filter((l) => l.fields.readiness_status === 'not_ready').length,
      needsReview: learners.filter((l) => l.fields.readiness_status === 'needs_review').length,
    },
    lastRun: runs[0]
      ? {
          runId: runs[0].fields.run_id,
          status: runs[0].fields.status,
          trigger: runs[0].fields.trigger,
          startedAt: runs[0].fields.started_at,
          finishedAt: runs[0].fields.finished_at ?? null,
          learnersEvaluated: runs[0].fields.learners_evaluated ?? null,
        }
      : null,
    issues: issues.map((i) => ({
      title: i.fields.title,
      detail: i.fields.detail,
      classification: i.fields.classification,
      occurrences: i.fields.occurrence_count ?? 1,
      lastSeen: i.fields.last_seen ?? null,
      asanaUrl: i.fields.asana_task_url ?? null,
    })),
  };
}
