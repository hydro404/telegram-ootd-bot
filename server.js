import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";

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
    const url = `${WEBHOOK_URL}/webhook`;

    const response = await axios.get(`${TELEGRAM_API}/setWebhook?url=${url}`);

    res.json(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/webhook", (req, res) => {
  // Telegram expects a fast 200 response. Do work asynchronously.
  res.sendStatus(200);

  handleTelegramUpdate(req.body).catch((error) => {
    console.error(error.response?.data || error.message);
  });
});

async function handleTelegramUpdate(update) {
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

async function handleIncomingPhoto(chatId, photoSizes) {
  const state = userPhotos.get(chatId) || { fileIds: [], timerId: null };

  const fileId = photoSizes[photoSizes.length - 1].file_id;
  state.fileIds.push(fileId);

  // If this is the first photo, start a short timer to allow a 2nd photo.
  if (state.fileIds.length === 1) {
    userPhotos.set(chatId, state);

    await sendMessage(
      chatId,
      "Photo received (1/2). Send a second photo within ~8 seconds for outfit+person, or wait to generate from 1 photo.",
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

  try {
    const imageUrls = [];
    for (const fileId of state.fileIds.slice(0, 2)) {
      const fileUrl = await getTelegramFileURL(fileId);
      imageUrls.push(fileUrl);
    }

    const generatedImage = await generateOOTDImage(imageUrls);
    await sendPhoto(chatId, generatedImage);
  } catch (error) {
    await sendMessage(
      chatId,
      "Sorry — something went wrong while generating the image. Try again in a bit.",
    );
    throw error;
  } finally {
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
  try {
    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt: IMAGE_PROMPT,
      size: "1024x1792",
      image: imageUrls,
    });

    const imageBase64 = result.data[0].b64_json;

    return `data:image/png;base64,${imageBase64}`;
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function sendMessage(chatId, text) {
  const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
  });

  return response.data?.result;
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
  await axios.post(`${TELEGRAM_API}/sendPhoto`, {
    chat_id: chatId,
    photo: photoBase64,
    caption: "Generated by OOTD AI Bot",
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
