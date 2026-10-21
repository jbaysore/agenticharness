export async function api(path, body, method) {
  const response = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "X-Harness-Client": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // While the host restarts, Cloudflare answers with its own HTML error page.
  const data = await response.json().catch(() => {
    const error = new Error(
      `Harness didn't answer (HTTP ${response.status}). It may be restarting.`,
    );
    error.status = response.status;
    error.unreachable = true;
    throw error;
  });
  if (!response.ok) {
    const error = new Error(data.error ?? "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}
