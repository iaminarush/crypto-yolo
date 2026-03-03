import { Handler } from "aws-lambda";
import { Resource } from "sst";
import ky from "ky";

export const handler: Handler = async (event) => {
  const message = formatTelegramMessage(event);

  await ky.post(
    `https://api.telegram.org/bot${Resource.TELEGRAM_TOKEN.value}/sendMessage`,
    {
      json: {
        chat_id: Resource.TELEGRAM_ID.value,
        text: message,
        parse_mode: "HTML",
      },
    },
  );
};

const formatTelegramMessage = (event: unknown) => {
  return `⚠️ <b>Lambda Failed!</b>\n\n<a href="https://console.sst.dev/extended-yolo">View in SST Console</a>`;
};
