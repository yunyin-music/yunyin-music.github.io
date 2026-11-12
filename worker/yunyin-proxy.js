/* 云音 CORS 中转 Worker（Cloudflare Workers，免费额度 10 万次/天）
   用途：代理 music.163.com 的官方接口，解决公共 CORS 代理限流导致的
        榜单/评论/相似推荐加载失败。部署后把地址填入 player.js 的 WORKER 常量。

   部署步骤：
   1. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Worker
   2. 粘贴本文件全部内容覆盖默认代码 → Deploy
   3. 复制 https://<你的子域>.workers.dev 地址，填到 player.js：
        const WORKER = "https://<你的子域>.workers.dev";
   调用方式：WORKER + "/?url=" + encodeURIComponent("https://music.163.com/api/...") */

const ALLOW_HOST = "music.163.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    const u = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const raw = u.searchParams.get("url");
    if (!raw) return json({ error: "missing url" }, 400);

    let target;
    try {
      target = new URL(raw);
    } catch (e) {
      return json({ error: "bad url" }, 400);
    }
    if (target.hostname !== ALLOW_HOST) return json({ error: "host not allowed" }, 403);

    const cache = caches.default;
    const cacheKey = new Request(target.toString(), { method: "GET" });
    let hit = await cache.match(cacheKey);

    if (!hit) {
      const upstream = await fetch(target.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
          Referer: "https://music.163.com/",
          Cookie: "appver=2.0.2;",
        },
        cf: { cacheEverything: true, cacheTtl: 300 },
      });
      hit = new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...CORS,
          "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
      if (upstream.ok) await cache.put(cacheKey, hit.clone());
    }

    return new Response(hit.body, {
      status: hit.status,
      headers: {
        ...CORS,
        "Content-Type": hit.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
