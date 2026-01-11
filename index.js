import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import { Client, GatewayIntentBits } from "discord.js";

const {
  DISCORD_TOKEN,
  PORT = 3000,
  MAKE_SECRET,
  ANNOUNCE_CHANNEL_ID,
  PING_ROLE_ID,
  MONGODB_URI,
  MONGODB_DB_NAME = "lystaria_bot",
  EMBED_COLOR = "#00dbff",
} = process.env;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!MAKE_SECRET) throw new Error("Missing MAKE_SECRET in .env");
if (!ANNOUNCE_CHANNEL_ID)
  throw new Error("Missing ANNOUNCE_CHANNEL_ID in .env");
if (!PING_ROLE_ID) throw new Error("Missing PING_ROLE_ID in .env");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Minimal intents: we only need to send messages and fetch channels
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// --------------------
// Helpers
// --------------------
function parseEmbedColor(input) {
  if (!input || typeof input !== "string") return undefined;
  const hex = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return parseInt(hex, 16);
}

function requireSecret(req, res) {
  const secret = req.header("X-Make-Secret");
  if (!secret || secret !== MAKE_SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// --------------------
// MongoDB (permanent dedupe)
// --------------------
const announcedPostSchema = new mongoose.Schema(
  {
    // Primary dedupe key (stable across re-runs)
    url: { type: String, required: true, unique: true, index: true },

    // Optional metadata (nice for debugging)
    title: { type: String },
    requestId: { type: String },
    sha: { type: String },

    announcedAt: { type: Date, default: Date.now },
  },
  { collection: "announced_posts" }
);

const AnnouncedPost = mongoose.model("AnnouncedPost", announcedPostSchema);

async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(MONGODB_URI, { dbName: MONGODB_DB_NAME });
  console.log("Mongo connected");
}

app.post("/make/blog-published", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { requestId, post, sha } = req.body || {};
  const title = post?.title;
  const url = post?.url;
  const excerpt = post?.excerpt;
  const image = post?.image;

  if (!title || typeof title !== "string") {
    return res.status(400).json({ ok: false, error: "Missing post.title" });
  }
  if (!url || typeof url !== "string" || !isValidUrl(url)) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing/invalid post.url" });
  }

  // Permanent dedupe (MongoDB) by URL
  try {
    await AnnouncedPost.create({
      url,
      title: typeof title === "string" ? title.slice(0, 256) : undefined,
      requestId: typeof requestId === "string" ? requestId : undefined,
      sha: typeof sha === "string" ? sha : undefined,
    });
  } catch (e) {
    if (e?.code === 11000) {
      return res.json({ ok: true, deduped: true });
    }
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }

  try {
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      return res
        .status(500)
        .json({ ok: false, error: "Announce channel not accessible" });
    }

    const roleMention = `<@&${PING_ROLE_ID}>`;
    const embedColor = parseEmbedColor(EMBED_COLOR);

    const embed = {
      color: embedColor,
      title: title.slice(0, 256),
      url,
      description:
        typeof excerpt === "string" && excerpt.trim()
          ? excerpt.trim().slice(0, 4096)
          : undefined,
      image:
        typeof image === "string" && isValidUrl(image)
          ? { url: image }
          : undefined,
    };

    const content = `${roleMention}\n${url}`;

    const msg = await channel.send({
      content,
      embeds: [embed],
      allowedMentions: { roles: [PING_ROLE_ID] },
    });

    return res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

client.once("ready", async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  try {
    await connectMongo();
  } catch (e) {
    console.error("Mongo connection failed:", e?.message || e);
    process.exit(1);
  }

  app.listen(Number(PORT), () =>
    console.log(`HTTP server listening on ${PORT}`)
  );
});

client.login(DISCORD_TOKEN);