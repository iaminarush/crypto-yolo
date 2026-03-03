import { Handler } from "aws-lambda";
import { Resource } from "sst";

export const handler: Handler = async (event) => {
  const message = formatTelegramMessage(event);

  await fetch(
    `https://api.telegram.org/bot${Resource.TELEGRAM_TOKEN.value}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Resource.TELEGRAM_ID.value,
        text: message,
        parse_mode: "HTML",
      }),
    },
  );
};

const formatTelegramMessage = (event: unknown) => {
  return `⚠️ <b>Lambda Failed!</b>\n\n<a href="https://console.sst.dev/extended-yolo">View in SST Console</a>`;
};
