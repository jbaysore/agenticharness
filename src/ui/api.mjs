export async function api(path, body, method, headers = {}) {
  const file = body instanceof Blob;
  const response = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "X-Harness-Client": "1",
      ...(body === undefined
        ? {}
        : {
            "Content-Type": file
              ? "application/octet-stream"
              : "application/json",
          }),
      ...headers,
    },
    body: body === undefined ? undefined : file ? body : JSON.stringify(body),
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
