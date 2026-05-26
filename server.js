import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import FormData from "form-data";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TG_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// chatId -> { fileIds: string[], timerId?: NodeJS.Timeout | null }
const userPhotos = new Map();

const IMAGE_PROMPT = `
You are a specialized AI fashion image generator focused on realistic Philippine streetwear OOTD photography.

When 2 images are provided:
- Image 1 = outfit reference only
- Image 2 = subject/person reference only

Never mix the identity from Image 1 with the person from Image 2.

Use Image 1 only for:
- clothing design
- garment structure
- color
- fabric
- silhouette
- texture
- styling
- fit
- stitching/details

Use Image 2 only for:
- exact face identity
- hairstyle
- skin tone
- body proportions
- facial structure
- natural appearance

Preserve the exact identity from Image 2.

Generate exactly ONE image only.

Format:
- vertical 9:16
- realistic smartphone photo
- raw unfiltered look
- 4K quality
- candid streetwear OOTD vibe

Allowed Philippine locations:
- sidewalks
- MRT/LRT stations
- stairways
- footbridges
- local shops
- sari-sari stores
- walkways
- concrete gates
- public waiting areas
- building entrances
- curbside spots
- terminal areas
- outdoor stairs
- quiet street corners

Lighting:
- natural Philippine daylight
- humid tropical atmosphere
- mild shadows
- realistic smartphone exposure

Final goal:
A highly realistic Philippine streetwear OOTD image featuring the exact person from Image 2 wearing the exact outfit from Image 1, captured like a casual smartphone photo taken by a friend in a believable everyday Philippine setting.
`;

app.get("/", (req, res) => {
  res.send("Telegram OOTD Bot Running");
});

app.get("/set-webhook", async (req, res) => {
  try {
    if (!WEBHOOK_URL) {
      return res.status(400).json({
        error:
          "WEBHOOK_URL is not set. Example: https://telegram-ootd-bot.onrender.com",
      });
    }

    const baseUrl = normalizeWebhookBaseUrl(WEBHOOK_URL);
    const url = `${baseUrl}/webhook`;

    const response = await axios.get(`${TELEGRAM_API}/setWebhook?url=${url}`);

    res.json(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({
      error: error.message,
    });
  }
});

function webhookHandler(req, res) {
  // Telegram expects a fast 200 response. Do work asynchronously.
  res.sendStatus(200);

  handleTelegramUpdate(req.body).catch((error) => {
    console.error(error.response?.data || error.message);
  });
}

app.post("/webhook", webhookHandler);
// Compatibility route if webhook was mistakenly set to '/webhook/webhook'
app.post("/webhook/webhook", webhookHandler);

function normalizeWebhookBaseUrl(input) {
  const trimmed = String(input).trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  return withoutTrailingSlash.replace(/\/webhook$/i, "");
}

async function handleTelegramUpdate(update) {
  if (update?.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message =
    update?.message || update?.edited_message || update?.channel_post;

  if (!message) return;

  const chatId = message.chat?.id;
  if (!chatId) return;

  const text = typeof message.text === "string" ? message.text.trim() : "";

  // /start can arrive as '/start@BotName' or '/start foo'
  if (text && /^\/start(\s|@|$)/i.test(text)) {
    await sendMessage(
      chatId,
      `Send:\n\n1 photo = subject only\n2 photos = outfit + subject\n\nPhoto Order:\n1st photo = outfit\n2nd photo = person\n\nTip: If you only send 1 photo, I'll generate after a few seconds.`,
    );
    return;
  }

  if (message.photo) {
    await handleIncomingPhoto(chatId, message.photo);
    return;
  }
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery?.data;
  const chatId = callbackQuery?.message?.chat?.id;

  // Always answer callback queries to remove Telegram's loading spinner.
  if (callbackQuery?.id) {
    await answerCallbackQuery(callbackQuery.id);
  }

  if (!chatId || !data) return;

  if (data === "process_now") {
    // Remove the inline keyboard (best-effort) so it can't be spam-clicked.
    if (callbackQuery?.message?.message_id) {
      await editMessageReplyMarkup(chatId, callbackQuery.message.message_id, {
        inline_keyboard: [],
      });
    }

    const state = userPhotos.get(chatId);
    if (!state || !Array.isArray(state.fileIds) || state.fileIds.length === 0) {
      await sendMessage(chatId, "Nothing to process right now. Send a photo.");
      return;
    }

    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    userPhotos.set(chatId, state);

    await sendMessage(chatId, "Generating now...");
    await generateAndSendFromState(chatId);
  }
}

async function handleIncomingPhoto(chatId, photoSizes) {
  const state = userPhotos.get(chatId) || { fileIds: [], timerId: null };

  const fileId = photoSizes[photoSizes.length - 1].file_id;
  state.fileIds.push(fileId);

  // If this is the first photo, start a short timer to allow a 2nd photo.
  if (state.fileIds.length === 1) {
    userPhotos.set(chatId, state);

    await sendMessage(
      chatId,
      "Photo received (1/2). Send a second photo within ~8 seconds for outfit+person, or tap Process now to generate from 1 photo.",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Process now", callback_data: "process_now" }]],
        },
      },
    );

    state.timerId = setTimeout(() => {
      generateAndSendFromState(chatId).catch((error) => {
        console.error(error.response?.data || error.message);
      });
    }, 8000);

    return;
  }

  // If second photo arrives before timer fires, cancel timer and generate now.
  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }

  userPhotos.set(chatId, state);
  await sendMessage(chatId, "Photo received (2/2). Generating now...");
  await generateAndSendFromState(chatId);
}

async function generateAndSendFromState(chatId) {
  const state = userPhotos.get(chatId);
  if (!state || !Array.isArray(state.fileIds) || state.fileIds.length === 0) {
    return;
  }

  // Prevent duplicate generation if both timer and second photo race.
  userPhotos.delete(chatId);

  const processing = await sendMessage(
    chatId,
    "Processing your photo(s)… please wait.",
  );

  // Native Telegram UI indicator (dots) while we work.
  const stopIndicator = startChatActionLoop(chatId, "upload_photo");

  try {
    const imageUrls = [];
    for (const fileId of state.fileIds.slice(0, 2)) {
      const fileUrl = await getTelegramFileURL(fileId);
      imageUrls.push(fileUrl);
    }

    const generatedImage = await generateOOTDImage(imageUrls);
    await sendPhoto(chatId, generatedImage);
  } catch (error) {
    const details = getErrorDetails(error);
    console.error("Generation failed:", details);

    await sendMessage(
      chatId,
      `Sorry — something went wrong while generating the image.\n\n${details.userMessage}`,
    );
    throw error;
  } finally {
    stopIndicator();
    if (processing?.message_id) {
      await deleteMessage(chatId, processing.message_id);
    }
  }
}

async function getTelegramFileURL(fileId) {
  const response = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);

  const filePath = response.data.result.file_path;

  return `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
}

async function generateOOTDImage(imageUrls) {
  if (!openai?.responses?.create) {
    throw new Error(
      "OpenAI SDK does not support Responses API. Upgrade the 'openai' package to v6+.",
    );
  }

  // The Images generations endpoint does not accept reference images.
  // Use the Responses API image_generation tool, which supports input images.
  const content = [{ type: "input_text", text: IMAGE_PROMPT }];

  for (const url of imageUrls) {
    content.push({
      type: "input_image",
      image_url: url,
    });
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || "gpt-5.2",
    input: [
      {
        role: "user",
        content,
      },
    ],
    tools: [
      {
        type: "image_generation",
        size: "1024x1792",
      },
    ],
  });

  const imageCall = response.output?.find(
    (o) => o.type === "image_generation_call" && o.result,
  );

  if (!imageCall?.result) {
    throw new Error("Image generation returned no result.");
  }

  // Base64-encoded image bytes
  return imageCall.result;
}

function getErrorDetails(error) {
  const requestId = error?.request_id || error?._request_id;
  const status = error?.status || error?.response?.status;
  const apiMessage =
    error?.error?.message ||
    error?.response?.data?.error?.message ||
    error?.message ||
    "Unknown error";

  // Keep user-facing message short and actionable.
  let userMessage = apiMessage;

  if (String(apiMessage).toLowerCase().includes("organization verification")) {
    userMessage =
      "Your OpenAI org/project may need verification for GPT Image. Check your OpenAI dashboard verification settings.";
  } else if (String(apiMessage).toLowerCase().includes("tool") && String(apiMessage).toLowerCase().includes("not")) {
    userMessage =
      "Your selected model may not support image generation tool. Try setting OPENAI_TEXT_MODEL to a GPT-5.x model that supports image_generation.";
  }

  const suffix = [
    status ? `status=${status}` : null,
    requestId ? `request_id=${requestId}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    status,
    requestId,
    apiMessage,
    userMessage: suffix ? `${userMessage}\n${suffix}` : userMessage,
  };
}

async function sendMessage(chatId, text, options = {}) {
  const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...options,
  });

  return response.data?.result;
}

async function answerCallbackQuery(callbackQueryId) {
  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
  }
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
  }
}

async function sendChatAction(chatId, action) {
  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, {
      chat_id: chatId,
      action,
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
  }
}

function startChatActionLoop(chatId, action) {
  let stopped = false;

  // Fire once immediately so the user sees feedback quickly.
  sendChatAction(chatId, action);

  const intervalId = setInterval(() => {
    if (stopped) return;
    sendChatAction(chatId, action);
  }, 4000);

  return () => {
    stopped = true;
    clearInterval(intervalId);
  };
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (error) {
    // Best-effort: deletion can fail for older messages or permissions.
    console.error(error.response?.data || error.message);
  }
}

async function sendPhoto(chatId, photoBase64) {
  const base64 = extractBase64(photoBase64);
  const imageBuffer = Buffer.from(base64, "base64");

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", "Generated by OOTD AI Bot");
  form.append("photo", imageBuffer, {
    filename: "ootd.png",
    contentType: "image/png",
  });

  await axios.post(`${TELEGRAM_API}/sendPhoto`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
  });
}

function extractBase64(value) {
  if (typeof value !== "string") {
    throw new Error("Expected base64 string");
  }

  // Accept both raw base64 and data URLs.
  const dataUrlMatch = value.match(/^data:[^;]+;base64,(.+)$/);
  if (dataUrlMatch) return dataUrlMatch[1];

  return value;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
