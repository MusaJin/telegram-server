import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is not set");
  process.exit(1);
}
const chatId = process.env.CHAT_ID;
const tagName = process.env.TAG_NAME;
const app = express();
const port = 443;

console.log(token)
console.log(chatId)
console.log(tagName)


const corsOptions = {
  origin: "*",
  methods: ["GET"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors(corsOptions));
app.use("/refs", express.static("static"));

const sslOptions = {
  key: fs.readFileSync('../../../etc/letsencrypt/live/backend.stardom09.ru/privkey.pem'),
  cert: fs.readFileSync('../../../etc/letsencrypt/live/backend.stardom09.ru/fullchain.pem')
};

const downloadPhoto = async (fileId, filePath) => {
  try {
    const fileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
    const fileResponse = await axios.get(fileUrl);
    const filePathOnServer = fileResponse.data.result.file_path;

    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePathOnServer}`;

    const response = await axios({
      url: downloadUrl,
      method: "GET",
      responseType: "stream",
    });

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    console.error("Ошибка при загрузке фотографии:", error);
  }
};

const formatDate = (timestamp) => {
  const date = new Date(timestamp * 1000);
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  return `${year}-${month}-${day}`;
};

const EIGHT_HOURS = 8 * 60 * 60 * 1000; // 8 часов в мс


const processUpdate = async () => {
  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates`;
    const response = await axios.get(url);

    if (!response.data.ok) {
      console.error("Ошибка Telegram API:", response.data);
      return null;
    }

    const messages = response.data.result;

    const staticDir = path.join(__dirname, "static");
    if (!fs.existsSync(staticDir)) {
      fs.mkdirSync(staticDir);
    }

    const groupedMessages = {};
    for (const data of messages) {
      if (data.channel_post) {
        const mediaGroupId = data.channel_post.media_group_id;
        if (mediaGroupId) {
          if (!groupedMessages[mediaGroupId]) {
            groupedMessages[mediaGroupId] = [];
          }
          groupedMessages[mediaGroupId].push(data);
        } else {
          groupedMessages[data.update_id] = [data];
        }
      }
    }

    const textsAndPhotos = await Promise.all(
      Object.values(groupedMessages).map(async (group) => {
        const firstPost = group[0].channel_post;
        const date = formatDate(firstPost.date);
        let caption = firstPost.caption || "";

        if (!caption.endsWith(tagName)) return null;

        caption = caption.replace(tagName, "").trim();

        const parts = caption.split("\n\n");
        let title = "";
        let text = "";

        if (parts.length > 1) {
          title = parts[0];
          text = parts.slice(1).join("\n\n");
        }

        const photos = await Promise.all(
          group.map(async (data) => {
            if (data.channel_post.photo) {
              const photo =
                data.channel_post.photo[data.channel_post.photo.length - 1];
              const filePath = path.join(staticDir, `${photo.file_id}.jpg`);
              await downloadPhoto(photo.file_id, filePath);
              return `${photo.file_id}.jpg`;
            }
            return null;
          })
        );

        const validPhotos = photos.filter(Boolean);

        try {
          const apiUrl = `https://stardom09.ru/api/add_news.php?title=${encodeURIComponent(
            title
          )}&text=${encodeURIComponent(text)}&img=${validPhotos.join(
            ","
          )}&date=${date}`;
          const apiResponse = await axios.get(apiUrl);
          console.log(apiResponse.data);
        } catch (error) {
          console.error(`Проблема с запросом: ${error.message}`);
        }

        return {
          message_id: firstPost.message_id,
          caption,
          date,
          title,
          text,
          photos: validPhotos.map((fileId) => ({
            url: `/refs/${fileId}`,
          })),
        };
      })
    );

    const result = textsAndPhotos.filter(Boolean);
    console.log(result);
    return result;
  } catch (error) {
    console.error("Ошибка при получении сообщений:", error);
    throw error;
  }
};

app.get("/get_messages", async (req, res) => {
  try {
    const data = await processUpdate();
    console.log("start")
    res.json({ ok: true, data });
    console.log("end")
  } catch (error) {
    console.error("Ошибка при получении сообщений:", error);
    res.status(500).json({ error: "Не удалось получить сообщения" });
  }
});

setInterval(() => {
  processUpdate().catch((err) => {
    console.error("Ошибка при получении новости из телеграма", err);
  });
}, EIGHT_HOURS);

https.createServer(sslOptions, app).listen(port, () => {
  console.log(`HTTPS server running on port ${port}`);
});
