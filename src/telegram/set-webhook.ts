/**
 * Points the HRMS bot at this service's webhook. Run by hand, once:
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
 *     node dist/telegram/set-webhook.js https://hrms-copilot.u-code.io/telegram/webhook
 *
 * Deliberately not done at boot. The bot has ONE update queue: the moment a
 * webhook exists, `getUpdates` starts returning 409 forever, and the group /
 * phone binding in hickvision polls with it today. Doing this automatically
 * would mean any pod that came up with a token silently took the queue over —
 * including a local one.
 *
 * Order of operations, because the queue cannot be shared:
 *   1. deploy the copilot with the forwarding path (this webhook) live;
 *   2. run this;
 *   3. redeploy hickvision with TELEGRAM_POLLING=0 so its cron stops logging
 *      one 409 every five minutes.
 *
 * To undo, delete the webhook and polling resumes on the next cron tick:
 *   curl -X POST "https://api.telegram.org/bot<token>/deleteWebhook"
 */
const main = async (): Promise<void> => {
  const url = process.argv[2];
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!url || !token || !secret) {
    console.error(
      "Usage: TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node dist/telegram/set-webhook.js <https url>",
    );
    process.exit(1);
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      // my_chat_member is what "the bot was added to a group" arrives as, and
      // an update type left off this list is simply never delivered — the group
      // binding would go quiet with nothing to show for it.
      allowed_updates: ["message", "callback_query", "my_chat_member"],
      drop_pending_updates: false,
    }),
  });

  const body = await res.text();
  console.log(`setWebhook -> ${res.status}: ${body}`);
  process.exit(res.ok ? 0 : 1);
};

void main();
