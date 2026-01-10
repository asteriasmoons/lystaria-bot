/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const ENDPOINT = mustGetEnv("ENDPOINT");
const SECRET = mustGetEnv("SECRET");
const SITE_BASE_URL = mustGetEnv("SITE_BASE_URL");

const BLOG_CONTENT_DIR_1 = process.env.BLOG_CONTENT_DIR_1 || "";
const BLOG_CONTENT_DIR_2 = process.env.BLOG_CONTENT_DIR_2 || "";
const PUBLIC_BLOG_PREFIX = process.env.PUBLIC_BLOG_PREFIX || "/blog";

const BEFORE = process.env.GITHUB_BEFORE;
const AFTER = process.env.GITHUB_SHA;

function run(cmd) {
  const { execSync } = require("child_process");
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function isWithin(dir, file) {
  if (!dir) return false;
  const normDir = dir.replace(/\/+$/, "") + "/";
  return file.startsWith(normDir);
}

function stripExt(p) {
  return p.replace(/\.(md|mdx)$/i, "");
}

// Astro content collections commonly use folder/index.md patterns.
// If file is .../slug/index.md -> slug
function slugFromFile(contentDir, file) {
  const rel = file.slice(contentDir.replace(/\/+$/, "").length + 1); // remove dir + slash
  const noExt = stripExt(rel);

  // Handle "index" files
  if (noExt.endsWith("/index")) {
    return noExt.slice(0, -"/index".length);
  }
  return noExt;
}

function absoluteUrl(maybeUrl) {
  if (!maybeUrl || typeof maybeUrl !== "string") return undefined;
  const u = maybeUrl.trim();
  if (!u) return undefined;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return SITE_BASE_URL.replace(/\/+$/, "") + u;
  // relative path without leading slash
  return SITE_BASE_URL.replace(/\/+$/, "") + "/" + u;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function prettifySlug(slug) {
  const last = slug.split("/").filter(Boolean).pop() || slug;
  return last.replace(/[-_]+/g, " ").trim();
}

async function postJson(payload) {
  // Node 20 has fetch built-in.
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Make-Secret": SECRET,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Announcer HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

function getChangedMarkdownFiles() {
  // Only Added/Modified files, ignore deleted/renamed noise
  const cmd = `git diff --name-only --diff-filter=AM ${BEFORE} ${AFTER} | grep -E '\\.(md|mdx)$' || true`;
  const out = run(cmd);
  if (!out) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function readPost(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = matter(raw);

  const fm = parsed.data || {};

  const title = pickFirst(fm, ["title", "name", "heading"]);
  const description = pickFirst(fm, ["description", "excerpt", "summary"]);
  const image = pickFirst(fm, ["image", "cover", "banner", "thumbnail", "ogImage"]);

  return {
    title,
    description,
    image: absoluteUrl(image),
  };
}

(async () => {
  if (!BEFORE || !AFTER || BEFORE === "0000000000000000000000000000000000000000") {
    console.log("No valid BEFORE sha; skipping announce to avoid accidental backfill.");
    process.exit(0);
  }

  const files = getChangedMarkdownFiles();
  if (!files.length) {
    console.log("No changed markdown files detected.");
    process.exit(0);
  }

  const announcements = [];

  for (const file of files) {
    let contentDir = null;

    if (isWithin(BLOG_CONTENT_DIR_1, file)) contentDir = BLOG_CONTENT_DIR_1.replace(/\/+$/, "");
    else if (isWithin(BLOG_CONTENT_DIR_2, file)) contentDir = BLOG_CONTENT_DIR_2.replace(/\/+$/, "");

    if (!contentDir) continue;

    const slug = slugFromFile(contentDir, file);
    if (!slug) continue;

    const url =
      SITE_BASE_URL.replace(/\/+$/, "") +
      PUBLIC_BLOG_PREFIX +
      (PUBLIC_BLOG_PREFIX.endsWith("/") ? "" : "/") +
      slug;

    const { title, description, image } = readPost(path.resolve(file));

    announcements.push({
      sha: AFTER,
      requestId: url, // stable dedupe key
      post: {
        title: title || prettifySlug(slug),
        url,
        excerpt: description || "",
        image: image || "",
      },
    });
  }

  if (!announcements.length) {
    console.log("No blog posts matched content dirs.");
    process.exit(0);
  }

  console.log(`Announcing ${announcements.length} post(s).`);

  for (const payload of announcements) {
    console.log(`POST: ${payload.post.title} -> ${payload.post.url}`);
    const resp = await postJson(payload);
    console.log(`OK: ${resp.slice(0, 200)}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
