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
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (mongoose.connection.readyState === 1) return;

  await mongoose.connect(MONGODB_URI, { dbName: MONGODB_DB_NAME });
  console.log("Mongo connected");
}

// --------------------
// Simple in-memory dedupe (still helpful for rapid retries)
// --------------------
const seen = new Map(); // requestId -> timestamp
const TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(id);
  }
}, 60 * 1000).unref();

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

  // In-memory dedupe (quick retry shield)
  if (requestId && typeof requestId === "string") {
    if (seen.has(requestId)) return res.json({ ok: true, deduped: true });
    seen.set(requestId, Date.now());
  }

  // Permanent dedupe (MongoDB)
  // We dedupe by URL because it's stable and uniquely identifies the post.
  try {
    await AnnouncedPost.create({
      url,
      title: typeof title === "string" ? title.slice(0, 256) : undefined,
      requestId: typeof requestId === "string" ? requestId : undefined,
      sha: typeof sha === "string" ? sha : undefined,
    });
  } catch (e) {
    // Duplicate key error => already announced
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

    // Discord embed object
    const embed = {
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
      // timestamp is optional; if you want, we can accept post.publishedAt later
    };

    // You wanted role mention + link posted
    const content = `${roleMention}\n${url}`;

    const msg = await channel.send({
      content,
      embeds: [embed],
      allowedMentions: { roles: [PING_ROLE_ID] }, // ensures only that role is mentionable
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
