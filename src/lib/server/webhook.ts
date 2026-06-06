export type ForwardedWebhookResult = {
  delivered: boolean;
  configured: boolean;
};

export function getRequestContext(headers: Headers) {
  return {
    referrer: headers.get("referer") ?? "",
    userAgent: headers.get("user-agent") ?? "",
    country: headers.get("x-vercel-ip-country") ?? "",
    region: headers.get("x-vercel-ip-country-region") ?? "",
    city: headers.get("x-vercel-ip-city") ?? ""
  };
}

export async function forwardToWebhook(
  webhookUrl: string | undefined,
  payload: unknown
): Promise<ForwardedWebhookResult> {
  if (!webhookUrl) {
    return { delivered: false, configured: false };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}`);
  }

  return { delivered: true, configured: true };
}
