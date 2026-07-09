// browse.js
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;   // e.g. "username/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const RAW_EXTENSIONS = /\.(mp4|mkv|webm|avi|mov|mp3|flac|ogg|opus|wav|aac|jpg|jpeg|png|gif|webp|svg|pdf|zip|tar|gz|7z|txt|srt|ass|vtt|nfo|json|xml|html|htm|css|js)$/i;

// ------------------ GitHub helpers (unchanged) ------------------
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

// ------------------ Virtual videos from list.txt ------------------
const VIDEOS_LIST_PATH = "videos/list.txt";

/**
 * Fetch the raw content of videos/list.txt from the GitHub repo.
 */
async function fetchVideosListText() {
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${VIDEOS_LIST_PATH}`;
  const headers = {};
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.text();
}

/**
 * Parse one line of the list: "virtualPath;url"
 * virtualPath may be e.g. "07.07.2026" or "/new/02.03.2026"
 * Returns { segments, filename, dateStr, fullUrl } where:
 *   - segments: array of directory parts (e.g. ['new'] or [])
 *   - filename: final file name with extension (e.g. '02.03.2026.mp4')
 *   - dateStr: raw date string from the virtual path (e.g. '02.03.2026')
 *   - fullUrl: the original Dropbox URL, with ?raw=1 forced
 */
function parseListEntry(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const semiIdx = trimmed.indexOf(";");
  if (semiIdx === -1) return null;
  const rawVirtual = trimmed.slice(0, semiIdx).trim();
  let dropboxUrl   = trimmed.slice(semiIdx + 1).trim();

  if (!dropboxUrl) return null;

  // Ensure raw download
  if (!dropboxUrl.includes("raw=1")) {
    dropboxUrl += (dropboxUrl.includes("?") ? "&" : "?") + "raw=1";
  }

  // virtual path may start with / – strip it
  const cleanVirtual = rawVirtual.replace(/^\//, "");
  const parts = cleanVirtual.split("/").filter(Boolean);
  if (parts.length === 0) return null; // no filename

  const baseName = parts.pop(); // e.g. "02.03.2026"
  // get extension from the original Dropbox URL
  const urlObj = new URL(dropboxUrl);
  const originalFilename = decodeURIComponent(urlObj.pathname.split("/").pop() || "");
  const extMatch = originalFilename.match(/\.[^./?]+$/);
  const extension = extMatch ? extMatch[0] : ".mp4"; // fallback to .mp4

  const filename = baseName + extension;

  return {
    segments: parts,                // directories inside /videos/
    filename,
    dateStr: baseName,              // e.g. "02.03.2026"
    fullUrl: dropboxUrl,
  };
}

/**
 * Build a virtual directory tree from the parsed list entries.
 * Returns a root node: { dirs: { name: node }, files: [{ name, date, url }] }
 */
function buildTree(entries) {
  const root = { dirs: {}, files: [] };

  for (const entry of entries) {
    let node = root;
    // walk/create directories
    for (const dir of entry.segments) {
      if (!node.dirs[dir]) {
        node.dirs[dir] = { dirs: {}, files: [] };
      }
      node = node.dirs[dir];
    }
    // add file at final node
    node.files.push({
      name: entry.filename,
      date: entry.dateStr,
      url:  entry.fullUrl,
    });
  }

  return root;
}

let _videosTreePromise = null;
let _videosTreeCache  = null;
let _videosCacheTime  = 0;
const VIDEOS_CACHE_TTL = 60_000; // 1 minute – re-fetch list.txt after that

/**
 * Get the virtual videos tree (with caching).
 */
async function getVideosTree() {
  if (_videosTreeCache && Date.now() - _videosCacheTime < VIDEOS_CACHE_TTL) {
    return _videosTreeCache;
  }
  // avoid concurrent fetches
  if (!_videosTreePromise) {
    _videosTreePromise = (async () => {
      const text = await fetchVideosListText();
      if (!text) throw new Error("videos/list.txt not found");
      const entries = text.split(/\r?\n/).map(parseListEntry).filter(Boolean);
      return buildTree(entries);
    })();
  }
  try {
    _videosTreeCache = await _videosTreePromise;
    _videosCacheTime = Date.now();
  } finally {
    _videosTreePromise = null;
  }
  return _videosTreeCache;
}

/**
 * Format a date string "DD.MM.YYYY" to the same format used for GitHub commits.
 */
function formatDateFromParts(dateStr) {
  if (!dateStr) return "-";
  const parts = dateStr.split(".");
  if (parts.length !== 3) return dateStr; // fallback
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // JS months 0-based
  const year = parseInt(parts[2], 10);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return dateStr;
  const d = new Date(Date.UTC(year, month, day, 0, 0, 0));
  return formatDate(d.toISOString()); // will produce e.g. "07-Jul-2026 00:00"
}

/**
 * Render an HTML directory listing for a virtual videos node.
 * @param {string} urlPath - current request path with trailing slash, e.g. "/videos/"
 * @param {object} node - the directory node (with .dirs and .files)
 * @param {string|null} parentPath - parent URL path, or null if root
 */
function renderVirtualIndex(urlPath, node, parentPath) {
  const title = `Index of ${urlPath}`;

  const dirEntries = Object.keys(node.dirs).sort((a, b) => a.localeCompare(b));
  const fileEntries = node.files.sort((a, b) => a.name.localeCompare(b.name));

  let rows = "";
  if (parentPath !== null) {
    rows += `<a href="${parentPath}">../</a>\n`;
  }

  for (const dirName of dirEntries) {
    const name = dirName + "/";
    const href = urlPath + dirName + "/";
    rows += `<a href="${encodeURI(href)}">${pad(name, 50)}</a>${pad("-", 17)}${"-".padStart(10)}\n`;
  }

  for (const file of fileEntries) {
    const href = urlPath + file.name;
    const date = formatDateFromParts(file.date);
    rows += `<a href="${encodeURI(href)}">${pad(file.name, 50)}</a>${pad(date, 17)}${"-".padStart(10)}\n`;
  }

  return `<!DOCTYPE html>
<html>
<head><title>${title}</title><meta charset="utf-8"></head>
<body>
<h1>${title}</h1><hr><pre>${rows}</pre><hr>
</body>
</html>`;
}

/**
 * Proxy the given Dropbox URL to the client (streaming).
 */
async function proxyVideo(res, dropboxUrl) {
  const upstream = await fetch(dropboxUrl, { redirect: "follow" });
  if (!upstream.ok) {
    res.status(502).send("Bad gateway");
    return;
  }

  const contentType = upstream.headers.get("content-type") || "video/mp4";
  const contentLength = upstream.headers.get("content-length");

  res.setHeader("Content-Type", contentType);
  if (contentLength) res.setHeader("Content-Length", contentLength);
  res.status(upstream.status);

  // Stream the body to the Vercel response
  const reader = upstream.body.getReader();
  res.flushHeaders();
  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        break;
      }
      res.write(value);
    }
  };
  pump().catch(() => res.end());
}

// ------------------ Main handler ------------------
export default async function handler(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const cleanPath = urlPath.replace(/^\/api\/browse/, "") || "/";

  // ---------- Virtual /videos/ routing ----------
  if (cleanPath === "/videos" || cleanPath.startsWith("/videos/")) {
    try {
      const tree = await getVideosTree();
    } catch (err) {
      res.status(404).send("videos not available");
      return;
    }

    // Normalize to have trailing slash if it's a directory (or root)
    const hasSlash = cleanPath.endsWith("/");
    // Path relative to /videos, without leading slash
    const rel = cleanPath.slice("/videos".length).replace(/^\//, "");
    const segments = rel ? rel.split("/").filter(s => s !== "") : [];

    // Traverse the tree
    let node = tree;
    let i = 0;
    for (; i < segments.length; i++) {
      const seg = segments[i];
      // Check if we are at a file match on the last segment
      if (i === segments.length - 1 && !hasSlash) {
        // Could be a file
        const file = node.files.find(f => f.name === seg);
        if (file) {
          return proxyVideo(res, file.url);
        }
      }
      // Must be a directory
      if (!node.dirs[seg]) {
        res.status(404).send("Not found");
        return;
      }
      node = node.dirs[seg];
    }

    // If we finished all segments, we are at a directory.
    // If the original request didn't end with a slash, redirect to add it.
    if (!hasSlash) {
      res.writeHead(301, { Location: cleanPath + "/" });
      res.end();
      return;
    }

    // Determine parent path
    let parentPath = null;
    if (segments.length > 0) {
      parentPath = "/videos/" + segments.slice(0, -1).join("/");
      if (parentPath !== "/videos") parentPath += "/";
      else parentPath = "/videos/";
    } else {
      // root /videos/ – parent is "/"
      parentPath = "/";
    }

    const html = renderVirtualIndex(cleanPath, node, parentPath);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
    return;
  }

  // ---------- Original GitHub browsing ----------
  const repoPath = cleanPath.replace(/^\//, "").replace(/\/$/, "");

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
