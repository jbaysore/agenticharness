import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { subscriptionEnvironment } from "../security/environment.mjs";

const exec = promisify(execFile);
const apiRoot = "https://api.github.com";
// Conditional responses need a cached body, but CI output can contain large
// logs/annotations. Persist only the fields used to evaluate and display CI.
const pick = (item, fields) =>
  Object.fromEntries(fields.map((field) => [field, item?.[field]]));
function compact(endpoint, body) {
  if (endpoint.includes("/check-runs") && Array.isArray(body?.check_runs))
    return {
      check_runs: body.check_runs.map((c) => ({
        ...pick(c, [
          "id",
          "name",
          "status",
          "conclusion",
          "head_sha",
          "html_url",
        ]),
        app: pick(c.app, ["id", "slug"]),
        check_suite: pick(c.check_suite, ["id"]),
      })),
    };
  if (endpoint.includes("/actions/runs") && Array.isArray(body?.workflow_runs))
    return {
      workflow_runs: body.workflow_runs.map((r) =>
        pick(r, [
          "id",
          "workflow_id",
          "name",
          "event",
          "head_branch",
          "check_suite_id",
          "run_attempt",
          "status",
          "conclusion",
          "html_url",
        ]),
      ),
    };
  if (
    /\/commits\/[^/]+\/status\?/.test(endpoint) &&
    Array.isArray(body?.statuses)
  )
    return {
      statuses: body.statuses.map((s) =>
        pick(s, ["id", "context", "state", "target_url"]),
      ),
    };
  if (/\/pulls\/\d+\/reviews(?:\?|$)/.test(endpoint) && Array.isArray(body))
    return body.map((review) => ({
      ...pick(review, ["id", "state", "submitted_at"]),
      user: pick(review.user, ["login"]),
      body: label(review.body),
    }));
  if (
    /\/(?:pulls|issues)\/\d+\/comments(?:\?|$)/.test(endpoint) &&
    Array.isArray(body)
  )
    return body.map((comment) => ({
      ...pick(comment, ["id", "created_at"]),
      user: pick(comment.user, ["login"]),
      body: label(comment.body),
    }));
  if (/\/pulls\/\d+$/.test(endpoint) && body?.head)
    return {
      ...pick(body, ["merge_commit_sha", "state", "html_url", "merged_at", "title"]),
      user: pick(body.user, ["login"]),
      head: pick(body.head, ["sha"]),
    };
  return body;
}
export class GitHubError extends Error {
  constructor(message, { retryAt = null, retryable = false } = {}) {
    super(message);
    this.retryAt = retryAt;
    this.retryable = retryable;
  }
}

// gh keeps its existing authentication in its own credential store. No tokens
// are read, stored or passed through the model. All watcher requests are GETs.
export async function ghRequest(endpoint, etag, signal) {
  const args = [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "--include",
    "-H",
    "Accept: application/vnd.github+json",
  ];
  if (etag) args.push("-H", `If-None-Match: ${etag}`);
  args.push(endpoint);
  let output;
  try {
    output = (
      await exec("gh", args, {
        windowsHide: true,
        signal,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...subscriptionEnvironment(),
          GH_PROMPT_DISABLED: "1",
          GH_PAGER: "cat",
        },
      })
    ).stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    output = error.stdout ?? "";
    if (!/^HTTP\//m.test(output)) {
      if (error.code === "ENOENT")
        throw new GitHubError(
          "Install GitHub CLI and sign in with gh auth login to watch CI.",
        );
      if (
        /auth login|authentication|not logged|GH_TOKEN/i.test(
          error.stderr ?? "",
        )
      )
        throw new GitHubError(
          "Sign in to GitHub CLI with gh auth login to watch CI.",
        );
      throw new GitHubError(
        "GitHub could not be reached. The host will retry.",
        { retryable: true },
      );
    }
  }
  const blocks = output.replace(/\r\n/g, "\n").split(/\n\n/);
  let header, status;
  while (blocks.length && /^HTTP\//.test(blocks[0])) {
    header = blocks.shift();
    status = Number(/^HTTP\/\S+\s+(\d+)/.exec(header)?.[1]);
  }
  if (!status)
    throw new GitHubError("GitHub CLI returned an unreadable response.", {
      retryable: true,
    });
  const headers = Object.fromEntries(
    header
      .split("\n")
      .slice(1)
      .map((line) => {
        const colon = line.indexOf(":");
        return [
          line.slice(0, colon).toLowerCase(),
          line.slice(colon + 1).trim(),
        ];
      }),
  );
  let body = null;
  if (status !== 304 && blocks.join("\n\n").trim()) {
    try {
      body = JSON.parse(blocks.join("\n\n"));
    } catch {
      throw new GitHubError("GitHub returned invalid JSON.", {
        retryable: true,
      });
    }
  }
  return { status, headers, body };
}

const latest = (items, key) => [
  ...items
    .reduce((map, item) => {
      const k = key(item),
        previous = map.get(k);
      if (
        !previous ||
        item.id > previous.id ||
        (item.id === previous.id && item.run_attempt > previous.run_attempt)
      )
        map.set(k, item);
      return map;
    }, new Map())
    .values(),
];
const label = (value) => String(value ?? "").slice(0, 250);
const link = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

export function ciResult({ checks = [], statuses = [], workflows = [] }) {
  const runs = latest(
    workflows,
    (r) => `${r.workflow_id}:${r.event}:${r.head_branch}`,
  );
  const suites = new Set(runs.map((r) => r.check_suite_id));
  const reportedChecks = latest(
    checks.filter(
      (c) =>
        c.app?.slug !== "github-actions" ||
        !runs.length ||
        suites.has(c.check_suite?.id),
    ),
    (c) => `${c.app?.id}:${c.check_suite?.id}:${c.name}:${c.head_sha}`,
  );
  const items = [
    ...runs.map((r) => ({
      name: label(r.name),
      state: r.status === "completed" ? r.conclusion : "pending",
      url: link(r.html_url),
      id: `run:${r.id}:${r.run_attempt}`,
    })),
    ...reportedChecks.map((c) => ({
      name: label(c.name),
      state: c.status === "completed" ? c.conclusion : "pending",
      url: link(c.html_url),
      id: `check:${c.id}`,
    })),
    ...latest(statuses, (s) => `${s._sha ?? ""}:${s.context}`).map((s) => ({
      name: label(s.context),
      state: s.state,
      url: link(s.target_url),
      id: `status:${s.id}`,
    })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  let status = "pending";
  if (
    items.length &&
    !items.some(
      (c) =>
        !c.state ||
        ["pending", "queued", "in_progress", "waiting", "requested"].includes(
          c.state,
        ),
    )
  ) {
    if (
      items.some((c) =>
        [
          "failure",
          "error",
          "timed_out",
          "action_required",
          "stale",
          "startup_failure",
        ].includes(c.state),
      )
    )
      status = "failure";
    else if (items.some((c) => c.state === "cancelled")) status = "cancelled";
    else if (items.every((c) => ["skipped", "neutral"].includes(c.state)))
      status = "skipped";
    else if (
      items.every((c) => ["success", "skipped", "neutral"].includes(c.state))
    )
      status = "success";
  }
  return { status, items };
}

const maxId = (items) => items.reduce((max, item) => Math.max(max, item.id || 0), 0);
const latestReviews = (reviews) => [
  ...reviews
    .reduce((map, review) => {
      const previous = map.get(review.user);
      if (!previous || review.id > previous.id) map.set(review.user, review);
      return map;
    }, new Map())
    .values(),
];
const reviewSnapshot = (reviews) =>
  Object.fromEntries(latestReviews(reviews).map((review) => [review.user, review.state]));
const pullCursor = (view) => ({
  state: view.state,
  merged: view.merged,
  head: view.head,
  reviews: reviewSnapshot(view.reviews),
  commentId: maxId(view.comments),
  reviewCommentId: maxId(view.reviewComments),
});
const pullItem = (id, name, state, excerpt) => ({
  id,
  name: label(name),
  state,
  excerpt: excerpt ? label(excerpt) : null,
});

// The first observation records what is already there. Later observations
// report only a merge, a close, a new review decision, a new comment, or a new commit.
export function pullOutcome(cursor, view) {
  const next = pullCursor(view);
  const title = view.title || "Pull request";
  if (view.merged)
    return {
      status: "success",
      reason: "Pull request merged.",
      cursor: next,
      items: [pullItem("pr", title, "merged")],
    };
  if (view.state === "closed")
    return {
      status: "failure",
      reason: "Pull request closed without merging.",
      cursor: next,
      items: [pullItem("pr", title, "closed")],
    };
  if (!cursor)
    return { status: "pending", reason: null, cursor: next, items: [] };
  const reviews = latestReviews(view.reviews);
  const changes = reviews.find(
    (review) =>
      review.state === "CHANGES_REQUESTED" &&
      cursor.reviews?.[review.user] !== "CHANGES_REQUESTED",
  );
  if (changes)
    return {
      status: "failure",
      reason: `${changes.user || "A reviewer"} requested changes.`,
      cursor: next,
      items: [
        pullItem(
          `review:${changes.id}`,
          changes.user || "Review",
          "changes requested",
          changes.excerpt,
        ),
      ],
    };
  const approved = reviews.find(
    (review) =>
      review.state === "APPROVED" && cursor.reviews?.[review.user] !== "APPROVED",
  );
  if (approved)
    return {
      status: "success",
      reason: `${approved.user || "A reviewer"} approved the pull request.`,
      cursor: next,
      items: [
        pullItem(
          `review:${approved.id}`,
          approved.user || "Review",
          "approved",
          approved.excerpt,
        ),
      ],
    };
  const comments = [
    ...view.comments.filter((comment) => comment.id > (cursor.commentId ?? 0)),
    ...view.reviewComments.filter(
      (comment) => comment.id > (cursor.reviewCommentId ?? 0),
    ),
  ];
  if (comments.length || view.head !== cursor.head) {
    const items = comments.map((comment) =>
      pullItem(
        `comment:${comment.id}`,
        comment.user || "Comment",
        "comment",
        comment.excerpt,
      ),
    );
    if (view.head !== cursor.head)
      items.push(pullItem(`head:${view.head}`, "New commit", view.head.slice(0, 8)));
    return {
      status: "updated",
      reason: "Pull request activity changed.",
      cursor: next,
      items,
    };
  }
  return { status: "pending", reason: null, cursor: next, items: [] };
}

export class GitHubCI {
  constructor({ request = ghRequest, now = Date.now } = {}) {
    this.request = request;
    this.now = now;
    this.tail = Promise.resolve();
    this.notBefore = 0;
  }
  async get(endpoint, cache, signal) {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (signal?.aborted) throw signal.reason;
        if (this.now() < this.notBefore)
          throw new GitHubError(
            "GitHub requests are waiting for a rate limit reset.",
            { retryable: true, retryAt: this.notBefore },
          );
        const previous = cache[endpoint];
        const response = await this.request(endpoint, previous?.etag, signal);
        const headers = response.headers ?? {};
        if (response.status === 403 || response.status === 429) {
          const reset = Number(headers["x-ratelimit-reset"]) * 1000;
          if (
            response.status === 429 ||
            headers["retry-after"] ||
            headers["x-ratelimit-remaining"] === "0" ||
            /rate limit/i.test(response.body?.message ?? "")
          ) {
            this.notBefore = Math.max(
              this.now() + 60_000,
              Number.isFinite(Number(headers["retry-after"]))
                ? this.now() + Number(headers["retry-after"]) * 1000
                : Date.parse(headers["retry-after"]) || 0,
              headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset)
                ? reset
                : 0,
            );
            throw new GitHubError(
              "GitHub rate limit reached; checks will resume after the reset.",
              { retryable: true, retryAt: this.notBefore },
            );
          }
        }
        if (response.status === 304 && previous) {
          previous.pollInterval = Math.max(
            previous.pollInterval ?? 0,
            (Number(headers["x-poll-interval"]) || 0) * 1000,
          );
          return previous;
        }
        if (response.status === 401 || response.status === 403)
          throw new GitHubError(
            "GitHub CLI needs access to this repository. Check its sign-in and permissions.",
          );
        if (response.status === 404)
          throw new GitHubError(
            "GitHub repository, revision or CI data was not found or is not accessible.",
          );
        if (response.status < 200 || response.status >= 300)
          throw new GitHubError("GitHub could not return CI status.", {
            retryable: response.status >= 500,
          });
        const value = {
          body: compact(endpoint, response.body),
          etag: headers.etag,
          link: headers.link,
          pollInterval:
            Math.max(0, Number(headers["x-poll-interval"]) || 0) * 1000,
        };
        cache[endpoint] = value;
        return value;
      });
    this.tail = operation;
    return operation;
  }
  async pages(endpoint, field, cache, signal) {
    const items = [];
    for (let page = 0; endpoint && page < 100; page++) {
      const result = await this.get(endpoint, cache, signal);
      if (!Array.isArray(result.body?.[field]))
        throw new GitHubError("GitHub returned incomplete CI data.", {
          retryable: true,
        });
      items.push(...result.body[field]);
      const next = /<([^>]+)>;\s*rel="next"/.exec(result.link ?? "")?.[1];
      endpoint = null;
      if (next) {
        const url = new URL(next);
        if (url.origin !== apiRoot || !url.pathname.startsWith("/repos/"))
          throw new GitHubError(
            "GitHub returned an unexpected pagination link.",
          );
        endpoint = url.pathname.slice(1) + url.search;
      }
    }
    if (endpoint)
      throw new GitHubError("CI has too many pages to verify completely.");
    return items;
  }
  async read(watch, target, signal) {
    const base = `repos/${watch.repository}`;
    let identity = watch.commit,
      shas = [watch.commit],
      url = `https://github.com/${watch.repository}/commit/${watch.commit}`;
    if (watch.pr) {
      const { body: pr } = await this.get(
        `${base}/pulls/${watch.pr}`,
        target.cache,
        signal,
      );
      if (!/^[a-f0-9]{40}$/i.test(pr?.head?.sha ?? ""))
        throw new GitHubError("GitHub returned a PR without a head revision.", {
          retryable: true,
        });
      identity = `${pr.head.sha}:${pr.merge_commit_sha ?? ""}`;
      shas = [
        ...new Set(
          [
            pr.head.sha,
            pr.state === "open" ? pr.merge_commit_sha : null,
          ].filter((sha) => /^[a-f0-9]{40}$/i.test(sha ?? "")),
        ),
      ];
      url =
        link(pr.html_url) ??
        `https://github.com/${watch.repository}/pull/${watch.pr}`;
    }
    const data = { checks: [], statuses: [], workflows: [] };
    for (const sha of shas) {
      data.checks.push(
        ...(await this.pages(
          `${base}/commits/${sha}/check-runs?per_page=100&filter=latest`,
          "check_runs",
          target.cache,
          signal,
        )),
      );
      data.statuses.push(
        ...(
          await this.pages(
            `${base}/commits/${sha}/status?per_page=100`,
            "statuses",
            target.cache,
            signal,
          )
        ).map((status) => ({ ...status, _sha: sha })),
      );
      data.workflows.push(
        ...(await this.pages(
          `${base}/actions/runs?head_sha=${sha}&per_page=100`,
          "workflow_runs",
          target.cache,
          signal,
        )),
      );
    }
    return {
      ...ciResult(data),
      identity,
      sha: shas[0],
      url,
      pollInterval: Math.max(
        0,
        ...Object.values(target.cache).map((entry) => entry.pollInterval ?? 0),
      ),
    };
  }
  async collection(endpoint, cache, signal) {
    const items = [];
    for (let page = 0; endpoint && page < 10; page++) {
      const result = await this.get(endpoint, cache, signal);
      const pageItems = Array.isArray(result.body) ? result.body : null;
      if (!pageItems)
        throw new GitHubError("GitHub returned incomplete pull request data.", {
          retryable: true,
        });
      items.push(...pageItems);
      const next = /<([^>]+)>;\s*rel="next"/.exec(result.link ?? "")?.[1];
      endpoint = null;
      if (next) {
        const url = new URL(next);
        if (url.origin !== apiRoot || !url.pathname.startsWith("/repos/"))
          throw new GitHubError(
            "GitHub returned an unexpected pagination link.",
          );
        endpoint = url.pathname.slice(1) + url.search;
      }
    }
    if (endpoint)
      throw new GitHubError("Pull request activity has too many pages to compare.");
    return items;
  }
  async readPull(watch, target, signal) {
    const base = `repos/${watch.repository}`;
    const since = encodeURIComponent(new Date(watch.createdAt).toISOString());
    const { body: pr } = await this.get(
      `${base}/pulls/${watch.pr}`,
      target.cache,
      signal,
    );
    if (!/^[a-f0-9]{40}$/i.test(pr?.head?.sha ?? ""))
      throw new GitHubError("GitHub returned a PR without a head revision.", {
        retryable: true,
      });
    const [reviews, comments, reviewComments] = await Promise.all([
      this.collection(
        `${base}/pulls/${watch.pr}/reviews?per_page=100`,
        target.cache,
        signal,
      ),
      this.collection(
        `${base}/issues/${watch.pr}/comments?per_page=100&since=${since}`,
        target.cache,
        signal,
      ),
      this.collection(
        `${base}/pulls/${watch.pr}/comments?per_page=100&since=${since}`,
        target.cache,
        signal,
      ),
    ]);
    const view = {
      state: pr.state,
      merged: Boolean(pr.merged_at),
      head: pr.head.sha,
      title: pr.title,
      url:
        link(pr.html_url) ??
        `https://github.com/${watch.repository}/pull/${watch.pr}`,
      reviews: reviews.map((review) => ({
        id: review.id,
        user: review.user?.login ?? "",
        state: review.state,
        excerpt: review.body,
      })),
      comments: comments.map((comment) => ({
        id: comment.id,
        user: comment.user?.login ?? "",
        excerpt: comment.body,
      })),
      reviewComments: reviewComments.map((comment) => ({
        id: comment.id,
        user: comment.user?.login ?? "",
        excerpt: comment.body,
      })),
    };
    return {
      ...pullOutcome(watch.cursor ?? null, view),
      url: view.url,
      sha: view.head,
      pollInterval: Math.max(
        0,
        ...Object.values(target.cache).map((entry) => entry.pollInterval ?? 0),
      ),
    };
  }
}
