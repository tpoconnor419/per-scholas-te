// Asana API client.
//
// Deliberately small: create a task, comment on one, complete one. Everything
// clever about deduplication lives in report-issues.js, because that logic
// belongs with the Airtable state that makes it possible.
//
// Errors carry the same `classification` vocabulary as the LTI and Airtable
// layers, so the sync has one error taxonomy rather than three.

const API = 'https://app.asana.com/api/1.0';

export class AsanaError extends Error {
  constructor(message, { status, classification }) {
    super(message);
    this.name = 'AsanaError';
    this.status = status;
    this.classification = classification;
  }
}

function classify(status) {
  if (status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'config';
  return 'permanent';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AsanaClient {
  constructor({ token, projectGid, maxAttempts = 3 } = {}) {
    this.token = token ?? process.env.ASANA_PAT;
    this.projectGid = projectGid ?? process.env.ASANA_PROJECT_GID;
    this.maxAttempts = maxAttempts;

    if (!this.token) {
      throw new AsanaError('ASANA_PAT is required', { status: 0, classification: 'config' });
    }
  }

  async request(path, { method = 'GET', body } = {}) {
    let lastError;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify({ data: body }) } : {}),
      });

      if (res.ok) {
        const json = await res.json();
        return json.data;
      }

      const detail = (await res.text()).slice(0, 300);
      const classification = classify(res.status);
      lastError = new AsanaError(`${method} ${path} -> ${res.status}: ${detail}`, {
        status: res.status,
        classification,
      });

      if (classification !== 'transient') throw lastError;

      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500;
      if (attempt < this.maxAttempts) await sleep(backoff);
    }

    throw lastError;
  }

  /** Workspaces the token can see. Used by the setup script. */
  listWorkspaces() {
    return this.request('/workspaces');
  }

  listProjects(workspaceGid) {
    return this.request(`/projects?workspace=${workspaceGid}&limit=100`);
  }

  async createTask({ name, notes, dueOn }) {
    if (!this.projectGid) {
      throw new AsanaError('ASANA_PROJECT_GID is required to create tasks', {
        status: 0,
        classification: 'config',
      });
    }

    const task = await this.request('/tasks', {
      method: 'POST',
      body: {
        name,
        notes,
        projects: [this.projectGid],
        ...(dueOn ? { due_on: dueOn } : {}),
      },
    });

    return {
      gid: task.gid,
      url: `https://app.asana.com/0/${this.projectGid}/${task.gid}`,
    };
  }

  addComment(taskGid, text) {
    return this.request(`/tasks/${taskGid}/stories`, { method: 'POST', body: { text } });
  }

  setCompleted(taskGid, completed) {
    return this.request(`/tasks/${taskGid}`, { method: 'PUT', body: { completed } });
  }

  getTask(taskGid) {
    return this.request(`/tasks/${taskGid}?opt_fields=gid,name,completed`);
  }
}
