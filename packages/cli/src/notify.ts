/**
 * Push notifications without push infrastructure: POST plain text to a
 * webhook. Point notify_url at an ntfy.sh topic (https://ntfy.sh/your-topic)
 * and every decision gate lands on your phone's lock screen today.
 */
export async function notify(url: string, message: string, options: string[] = []): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Title": "Kraken needs a decision",
        "Priority": "high",
        "Tags": "octopus",
      },
      body: options.length ? `${message}\nOptions: ${options.join(" | ")}` : message,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Notification failure must never break a run; the decision is in the queue regardless.
  }
}
