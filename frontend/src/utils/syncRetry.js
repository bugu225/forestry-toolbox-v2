/**
 * Retry POST for flaky networks; skips retry on client errors (except 408/429).
 */
export async function postWithSyncRetry(apiClient, url, payload, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await apiClient.post(url, payload);
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) break;
      const status = error?.response?.status;
      const networkIssue = !error?.response && error?.request;
      const retryable =
        networkIssue || (status >= 500 && status < 600) || status === 429 || status === 408;
      if (!retryable) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}
