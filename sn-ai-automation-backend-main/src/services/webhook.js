import axios from "axios";

const webhookTimeoutMs = Number.parseInt(process.env.WEBHOOK_TIMEOUT_MS || "15000", 10) || 15000;

export async function sendWebhook(event, data) {
  const webhookUrl = process.env.WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.log("No webhook URL configured");
    return;
  }

  try {
    await axios.post(webhookUrl, {
      event,
      timestamp: new Date().toISOString(),
      data
    }, {
      timeout: webhookTimeoutMs
    });

    console.log(`Webhook sent for event: ${event}`);
  } catch (err) {
    console.error("Webhook delivery failed:", err.message);
  }
}