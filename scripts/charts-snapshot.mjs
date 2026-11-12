/* 每日榜单/歌单静态快照生成器
   从 player.js 中读取 CHARTS / PLAYLISTS 配置，抓取网易云官方歌单详情，
   生成 data/<id>.json 供前端「通道零」直接读取（不依赖任何第三方中转）。
   用法：node scripts/charts-snapshot.mjs */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const PLAYER_JS = path.join(ROOT, "player.js");
const OUT_DIR = path.join(ROOT, "data");
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
  Referer: "https://music.163.com/",
  Cookie: "appver=2.0.2;",
};

function extractBlock(src, name) {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(src);
  if (!m) throw new Error(`找不到 ${name} 配置`);
  const items = [];
  const re = /\{\s*id:"(\d+)"[\s\S]*?name:"([^"]+)"/g;
  let hit;
  while ((hit = re.exec(m[1]))) items.push({ id: hit[1], name: hit[2] });
  return items;
}

function mapTrack(t) {
  const ar = (t.ar && t.ar[0]) || null;
  const al = t.al || null;
  return {
    id: String(t.id),
    name: t.name || "未知歌曲",
    artist: (t.ar || []).map((a) => a.name).join(" / ") || "未知歌手",
    pic: al && al.picUrl ? `${al.picUrl}?param=200y200`.replace(/^http:/, "https:") : "",
    url: "",
    lrc: "",
    album: (al && al.name) || "",
    dur: t.dt || 0,
    artistId: ar ? String(ar.id || "") : "",
    albumId: al ? String(al.id || "") : "",
  };
}

async function getJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchPlaylist(id) {
  const data = await getJSON(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=1`);
  const pl = data && data.playlist;
  if (!pl) throw new Error("歌单不存在");
  const ids = (pl.trackIds || []).map((x) => x.id).slice(0, 100);
  let tracks = pl.tracks || [];
  // detail 接口对普通歌单只返回 10 首，用 trackIds 分批补全
  if (ids.length > tracks.length) {
    const got = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const sd = await getJSON(`https://music.163.com/api/song/detail?ids=%5B${chunk.join(",")}%5D`);
      if (sd && Array.isArray(sd.songs)) got.push(...sd.songs);
      await sleep(200);
    }
    if (got.length > tracks.length) tracks = got;
  }
  if (!tracks.length) throw new Error("空歌单");
  return { name: pl.name, list: tracks.map(mapTrack) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const src = fs.readFileSync(PLAYER_JS, "utf8");
  const charts = extractBlock(src, "CHARTS");
  const playlists = extractBlock(src, "PLAYLISTS");
  const all = [...charts, ...playlists];
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = { updatedAt: new Date().toISOString(), items: [] };
  let ok = 0;
  for (const item of all) {
    try {
      const { name, list } = await fetchPlaylist(item.id);
      fs.writeFileSync(
        path.join(OUT_DIR, `${item.id}.json`),
        JSON.stringify({ id: item.id, name: name || item.name, updatedAt: new Date().toISOString(), list })
      );
      manifest.items.push({ id: item.id, name: name || item.name, count: list.length });
      ok++;
      console.log(`✓ ${item.id} ${name} ${list.length} 首`);
    } catch (e) {
      console.warn(`✗ ${item.id} ${item.name} -> ${e.message}（保留旧快照）`);
    }
    await sleep(350);
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`完成：${ok}/${all.length} 个歌单已更新`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
