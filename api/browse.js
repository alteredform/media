const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;   // e.g. "username/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const RAW_EXTENSIONS = /\.(mp4|mkv|webm|avi|mov|mp3|flac|ogg|opus|wav|aac|jpg|jpeg|png|gif|webp|svg|pdf|zip|tar|gz|7z|txt|srt|ass|vtt|nfo|json|xml|html|htm|css|js)$/i;

function githubHeaders() {
  const h = { "Accept": "application/vnd.github+json" };
  if (GITHUB_TOKEN) h["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function getContents(repoPath) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) return null;
  return res.json();
}

async function getLastModifiedMap(entries, repoPath) {
  const base = repoPath ? repoPath.replace(/\/$/, "") + "/" : "";
  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const path = base + entry.name;
      const url  = `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${encodeURIComponent(path)}&sha=${GITHUB_BRANCH}&per_page=1`;
      const res  = await fetch(url, { headers: githubHeaders() });
      if (!res.ok) return { name: entry.name, date: null };
      const data = await res.json();
      const date = data?.[0]?.commit?.committer?.date ?? data?.[0]?.commit?.author?.date ?? null;
      return { name: entry.name, date };
    })
  );
  const map = {};
  for (const r of results) {
    if (r.status === "fulfilled") map[r.value.name] = r.value.date;
  }
  return map;
}

function formatDate(isoString) {
  if (!isoString) return "-";
  const d = new Date(isoString);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const hh  = String(d.getUTCHours()).padStart(2, "0");
  const mm  = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}-${mon}-${year} ${hh}:${mm}`;
}

function formatSize(bytes) {
  if (bytes == null || bytes === 0) return "-";
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

function pad(str, len) {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function renderIndex(urlPath, entries, dateMap) {
  const title = `Index of ${urlPath}`;
  const dirs  = entries.filter(e => e.type === "dir").sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => e.type === "file").sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [...dirs, ...files];
  const parentPath = urlPath === "/" ? null : urlPath.replace(/\/[^/]+\/?$/, "/") || "/";

  let rows = "";
  if (parentPath !== null) rows += `<a href="${parentPath}">../</a>\n`;

  for (const entry of sorted) {
    const isDir  = entry.type === "dir";
    const name   = entry.name + (isDir ? "/" : "");
    const href   = urlPath.replace(/\/$/, "") + "/" + entry.name + (isDir ? "/" : "");
    const size   = isDir ? "-" : formatSize(entry.size);
    const date   = formatDate(dateMap[entry.name]);
    rows += `<a href="${encodeURI(href)}">${pad(name, 50)}</a>${pad(date, 17)}${size.padStart(10)}\n`;
  }

  return `<!DOCTYPE html>
<html>
<head><title>${title}</title><meta charset="utf-8"></head>
<body>
<h1>${title}</h1><hr><pre>${rows}</pre><hr>
</body>
</html>`;
}

export default async function handler(req, res) {
  // Read the real URL path (before the rewrite), strip query string
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  // Strip leading /api/browse if Vercel exposes it that way (it won't, but safety)
  const cleanPath = urlPath.replace(/^\/api\/browse/, "") || "/";

  // Derive the repo path (strip leading slash)
  const repoPath = cleanPath.replace(/^\//, "").replace(/\/$/, "");

  // Direct file — redirect to raw GitHub
  if (RAW_EXTENSIONS.test(cleanPath)) {
    res.redirect(302, `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${repoPath}`);
    return;
  }

  const contents = await getContents(repoPath);

  if (!contents) {
    res.status(404).send(`<!DOCTYPE html><html><body><h1>404 Not Found</h1><p>${cleanPath}</p></body></html>`);
    return;
  }

  if (!Array.isArray(contents)) {
    res.redirect(302, contents.download_url);
    return;
  }

  // Hide infra files/folders from the root listing
  const ROOT_HIDDEN = new Set(["api", "vercel.json", ".env", ".env.example", ".gitignore"]);
  const visible = (repoPath === "")
    ? contents.filter(e => !ROOT_HIDDEN.has(e.name))
    : contents;

  const dateMap = await getLastModifiedMap(visible, repoPath);
  const normalizedPath = cleanPath.endsWith("/") ? cleanPath : cleanPath + "/";
  const html = renderIndex(normalizedPath, visible, dateMap);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
