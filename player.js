const API = "https://api.injahow.cn/meting/";

/* ---------- 网易云官方 API（经 CORS 代理直取，作为 meting 的独立兜底通道） ----------
   meting 公共实例有每日调用上限（会返回 {"message":"请求次数已达上限"}），
   官方 API 走代理可绕开该限制，保证榜单/歌词/音源都有第二条路 */
const NET = "https://music.163.com";
const NET_PROXIES = [
  (u)=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u)=>`https://cors.eu.org/${u}`,
  (u)=>`https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];
async function netJSON(path, ms){
  const target = NET + path;
  for(const px of NET_PROXIES){
    try{
      const r = await fetchTimeout(px(target), ms||15000);
      if(!r || !r.ok) continue;
      const d = await r.json();
      if(d && (d.code===200 || d.status===200 || d.playlist || d.result || d.data || d.songs || d.lrc)) return d;
    }catch(e){}
  }
  return null;
}
/* 播放地址短时缓存：官方下发的链接带过期时间（约 20 分钟），10 分钟内复用 */
const audioUrlCache = new Map();
function resetAudioUrlCache(id){
  if(id) audioUrlCache.delete(String(id));
  else audioUrlCache.clear();
}


/* ---------- Data layer: 网易云音源（meting 中转，全部请求锁定 server=netease） ---------- */
/* meting 列表项不带 id 字段，从它的 url 里反解歌曲 id */
function metingId(u){ const m=/(?:\?|&)id=(\d+)/.exec(u||""); return m?m[1]:""; }
/* 兜底校验：任何非网易域名的音频/封面地址一律丢弃，避免混入其它平台音源 */
function neteaseOnly(u){
  u = String(u||"");
  if(/qqmusic|qq\.com|kugou|kuwo|migu|qpic/i.test(u)) return "";
  return u.replace(/^http:/,"https:");
}
async function fetchPlaylist(pid){
  // 通道一：meting（网易云）
  try{
    const res = await fetchTimeout(`${API}?type=playlist&id=${pid}&server=netease`, 5000);
    const list = res && res.ok ? await res.json() : null;
    if(Array.isArray(list) && list.length && list[0] && list[0].name){
      return list.map(s=>{
        const id = String(s.id || metingId(s.url) || "");
        return {
          id,
          name:s.name||"未知歌曲",
          artist:s.artist||"未知歌手",
          pic:neteaseOnly(s.pic),
          url:neteaseOnly(s.url),
          lrc:neteaseOnly(s.lrc),
          album:"", dur:0
        };
      });
    }
  }catch(e){}
  // 通道三：同源静态兜底（与通道二并行发起，代理被限流时也能展示榜单）
  const fb = (async()=>{
    try{
      const r = await fetchTimeout("./chart-fallback.json?v=1", 6000);
      if(r && r.ok){
        const d2 = await r.json();
        const arr = d2 && d2[pid];
        if(Array.isArray(arr) && arr.length) return arr;
      }
    }catch(e){}
    return null;
  })();
  // 通道二：官方歌单接口（经代理，不受 meting 每日额度影响；n=80 取前 80 首）
  // 代理限流时单次可能很慢，最多等 7 秒就转而使用已并行取回的静态兜底
  const deadline = new Promise(r=>setTimeout(()=>r(null), 7000));
  const d = await Promise.race([netJSON(`/api/v6/playlist/detail?id=${pid}&n=80`, 7000), deadline]);
  const tr = d && d.playlist && d.playlist.tracks;
  if(Array.isArray(tr) && tr.length){
    return tr.map(t=>({
      id:String(t.id),
      name:t.name||"未知歌曲",
      artist:(t.ar||[]).map(a=>a.name).join(" / ")||"未知歌手",
      pic:t.al && t.al.picUrl ? (t.al.picUrl+"?param=200y200").replace(/^http:/,"https:") : "",
      url:"",
      lrc:"",
      album:(t.al && t.al.name)||"",
      dur:t.dt||0
    }));
  }
  const fbList = await fb;
  if(fbList) return fbList;
  return null;
}
/* 直链解析（vkeys 网易云接口，自带 CORS，返回网易 CDN 直链）：快且不受 meting 额度影响 */
async function vkeysUrl(id){
  try{
    const r = await fetchTimeout(`https://api.vkeys.cn/v2/music/netease?id=${id}`, 4000);
    if(!r || !r.ok) return "";
    const d = await r.json();
    const u = d && d.data && d.data.url;
    return u ? neteaseOnly(u) : "";
  }catch(e){ return ""; }
}
// 播放地址解析顺序：vkeys 直链 → outer 兼容地址（免代理、免费曲秒开）→ 官方 enhance（经代理，重试时用）
async function ensurePlayUrl(s, force){
  let id = String(s.id || metingId(s.url) || "");
  if(!id && s.name) id = await lookupSongId(s); // 旧收藏/历史缺少 id 时按歌名补
  if(!id) return neteaseOnly(s.url) || "";
  if(force) resetAudioUrlCache(id);
  const hit = audioUrlCache.get(id);
  if(hit && Date.now()-hit.t < 10*60*1000) return hit.u;
  // 1) vkeys 直链（网易 CDN，约 300ms 返回）
  const vu = await vkeysUrl(id);
  if(vu){ audioUrlCache.set(id, {u:vu, t:Date.now()}); return vu; }
  // 2) outer 兼容地址：免费曲目直接可用（audio 播放跨域无需 CORS），VIP 曲目会在播放失败后重试
  const outer = `https://music.163.com/song/media/outer/url?id=${id}.mp3`;
  if(!s._retried){
    if(s.url && /api\.injahow\.cn/.test(s.url)) return s.url;
    return outer;
  }
  // 3) 重试时才走官方 enhance（经代理，较慢）
  const d = await netJSON(`/api/song/enhance/player/url?id=${id}&ids=%5B${id}%5D&br=128000`, 5000);
  const u = d && d.data && d.data[0] && d.data[0].url;
  if(u){
    const gu = neteaseOnly(u);
    if(gu){ audioUrlCache.set(id, {u:gu, t:Date.now()}); return gu; }
  }
  return outer;
}
/* 旧数据（收藏/最近播放）可能没有歌曲 id：按歌名+歌手走 CORS 代理搜索补齐 */
async function lookupSongId(s){
  const kw = `${s.name||""} ${(s.artist||"").split(" / ")[0]}`.trim();
  if(!kw) return "";
  const target = `https://music.163.com/api/search/get?s=${encodeURIComponent(kw)}&type=1&limit=3`;
  const proxies = [
    (u)=>`https://cors.eu.org/${u}`,
    (u)=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u)=>`https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  ];
  for(const px of proxies){
    try{
      const r = await fetch(px(target), {cache:"no-store"});
      if(!r.ok) continue;
      const d = await r.json();
      const hit = d && d.result && d.result.songs && d.result.songs[0];
      if(hit && hit.id){
        s.id = String(hit.id);
        if(!s.pic && hit.album && hit.album.picUrl) s.pic = (hit.album.picUrl+"?param=200y200").replace(/^http:/,"https:");
        s.lrc = s.lrc || `${API}?type=lrc&id=${s.id}&server=netease`;
        return s.id;
      }
    }catch(e){}
  }
  return "";
}

// Charts config
const CHARTS = [
  { id:"3778678", name:"热歌榜", icon:"i-flame", desc:"云音乐用户一周内收听所有线上歌曲官方 TOP 排行榜，每日更新。" },
  { id:"3779629", name:"新歌榜", icon:"i-sparkle", desc:"云音乐最新歌曲热度排行，汇聚近期首发新歌。" },
  { id:"19723756", name:"飙升榜", icon:"i-bolt", desc:"云音乐近 24 小时内播放量涨幅最快歌曲排行。" },
  { id:"2884035", name:"原创榜", icon:"i-music", desc:"云音乐原创歌曲排行，发现独立音乐人的优质作品。" },
  { id:"2614035974", name:"网红热歌榜", icon:"i-headphone", desc:"全网最火短视频 BGM 与热门网红歌曲合集。" },
  { id:"71385702", name:"电音榜", icon:"i-sliders", desc:"云音乐电音歌曲排行，感受电子音乐的节拍魅力。" },
];

// 推荐歌单（已验证可用）
const PLAYLISTS = [
  { id:"2301490995", name:"华语情歌", icon:"i-heart", count:22,  g:"linear-gradient(135deg,#f43f5e,#fb7185)" },
  { id:"7220139227", name:"怀旧金曲", icon:"i-disc", count:50,  g:"linear-gradient(135deg,#4b6cb7,#182848)" },
  { id:"66518941",   name:"轻柔钢琴", icon:"i-music", count:84,  g:"linear-gradient(135deg,#7f7fd5,#91eae4)" },
  { id:"5314368341", name:"欧美电音", icon:"i-sliders", count:77,  g:"linear-gradient(135deg,#fc466b,#3f5efb)" },
  { id:"508075145",  name:"影视金曲", icon:"i-film", count:82,  g:"linear-gradient(135deg,#f59e0b,#fbbf24)" },
  { id:"2500887487", name:"游戏原声", icon:"i-headphone", count:116, g:"linear-gradient(135deg,#11998e,#38ef7d)" },
];
/* 图标引用统一走 sprite（设计系统里唯一入口） */
const iconSvg = (id, size) => `<svg class="i i-${size||18}"><use href="#${id}"/></svg>`;

/* ---------- Local storage helpers ---------- */
const store = {
  get(k, d){ try{ const v = JSON.parse(localStorage.getItem(k)); return v==null ? d : v; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};
const BASE_TITLE = document.title;
function key(s){ return (s && (s.id || (s.name + "::" + s.artist))) || ""; }
let favs = store.get('yy_favs', []);
let history = store.get('yy_history', []);
let favSet = new Set(favs.map(key));
let listMode = null;      // null: 榜单/歌单/搜索, 'favs', 'history'
let fmMode = false;
let fmPool = [];
let fmStarted = false;
let pendingSeek = null;   // 恢复进度用
let pendingRestore = null;// 启动时恢复上次歌曲
let currentQueueOpen = false;
let lastSaveTime = 0;
let restoring = false;
let failStreak = 0; // 连续播放失败计数，达到阈值暂停而不是无限跳歌

const chartsEl = document.getElementById("charts");
const songListEl = document.getElementById("songList");
const chartTitle = document.getElementById("chartTitle");
const chartDesc = document.getElementById("chartDesc");
const chartTag = document.getElementById("chartTag");
const chartCover = document.getElementById("chartCover");

const audio = document.getElementById("audio");
const vinyl = document.getElementById("vinyl");
const pCover = document.getElementById("pCover");
const pTitle = document.getElementById("pTitle");
const pArtist = document.getElementById("pArtist");
const playBtn = document.getElementById("playBtn");
const playIcon = document.getElementById("playIcon");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const modeBtn = document.getElementById("modeBtn");
const curTimeEl = document.getElementById("curTime");
const durTimeEl = document.getElementById("durTime");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const progressThumb = document.getElementById("progressThumb");
const volBar = document.getElementById("volBar");
const volFill = document.getElementById("volFill");
const volThumb = document.getElementById("volThumb");
const volBtn = document.getElementById("volBtn");
const volIcon = document.getElementById("volIcon");
const playAllBtn = document.getElementById("playAllBtn");
const lrcToggle = document.getElementById("lrcToggle");
const lyricsPanel = document.getElementById("lyricsPanel");
const lrcClose = document.getElementById("lrcClose");
const lrcTrack = document.getElementById("lrcTrack");
const searchInput = document.getElementById("searchInput");
const toastEl = document.getElementById("toast");
const navFavs = document.getElementById("navFavs");
const navDaily = document.getElementById("navDaily");
const navHistory = document.getElementById("navHistory");
const navFM = document.getElementById("navFM");
const favCnt = document.getElementById("favCnt");
const histCnt = document.getElementById("histCnt");
const plWall = document.getElementById("plWall");
const clearBtn = document.getElementById("clearBtn");
const pFavBtn = document.getElementById("pFavBtn");
const queueToggle = document.getElementById("queueToggle");
const queuePanel = document.getElementById("queuePanel");
const qCount = document.getElementById("qCount");
const qList = document.getElementById("qList");
const qClose = document.getElementById("qClose");
const qClear = document.getElementById("qClear");
const qMask = document.getElementById("qMask");

let currentChart = null;
let songs = [];
let currentIdx = -1;
let playMode = 0; // 0: list loop, 1: single loop, 2: shuffle
const modeIcons = [
  iconSvg("i-repeat"),   // 列表循环
  iconSvg("i-repeat1"),  // 单曲循环
  iconSvg("i-shuffle")   // 随机播放
];
const modeNames = ["列表循环","单曲循环","随机播放"];
let lyrics = [];
let lrcOffset = 0;
let lastLrcIdx = -1;

/* ---------- Render sidebar charts ---------- */
function renderCharts(){
  chartsEl.innerHTML = CHARTS.map((c,i)=>`
    <div class="chart-item" data-idx="${i}">
      <div class="ico">${iconSvg(c.icon,15)}</div>
      <span>${c.name}</span>
    </div>
  `).join("");
  chartsEl.querySelectorAll(".chart-item").forEach(el=>{
    el.addEventListener("click",()=>{
      const idx = +el.dataset.idx;
      loadChart(idx);
    });
  });
}

/* ---------- Load chart playlist ---------- */
async function loadChart(idx){
  currentChart = idx;
  listMode = null; fmMode = false;
  currentIdx = -1;
  setActiveNav("chart", idx);
  clearBtn.style.display = "none";
  const c = CHARTS[idx];
  chartTitle.textContent = c.name;
  chartDesc.textContent = c.desc;
  chartTag.textContent = "REAL-TIME";
  chartCover.innerHTML = iconSvg(c.icon,38);
  chartCover.style.background = "linear-gradient(135deg,#efe9df,#e1d9cc)";

  // 榜单本地缓存：命中立即渲染（首开速度 = 0 网络），过期/缺失才走网络
  const ck = "yy_chartcache_"+idx;
  let cached = null;
  try{ cached = JSON.parse(store.get(ck,"null")||"null"); }catch(e){}
  const fresh = cached && Array.isArray(cached.list) && cached.list.length && (Date.now()-cached.t < 10*60*1000);

  if(fresh){
    songs = cached.list;
    renderSongs();
    tryRestore();
  }else{
    songListEl.innerHTML = skelRows(12);
    if(window.WALL && window.WALL.pending) window.WALL.pending();
  }

  // 接口偶发超时/空返回：再补一次（allorigins 等代理首次较慢，给足时间）
  let list = null;
  for(let attempt=0; attempt<2 && !list; attempt++){
    try{
      const l = await fetchPlaylist(c.id);
      if(l && l.length) list = l;
    }catch(e){}
    if(!list && attempt<1) await new Promise(r=>setTimeout(r, 600));
  }

  if(list){
    store.set(ck, JSON.stringify({t:Date.now(), list}));
    // 用户还停留在该榜单时才刷新界面（缓存路径下避免重放恢复逻辑）
    if(currentChart===idx){
      songs = list;
      renderSongs();
      if(!fresh) tryRestore();
    }
  }else if(!fresh && currentChart===idx){
    // 有旧缓存兜底就不报错；仅完全无数据时提示（骨架墙保留，点重试再拉一次）
    if(cached && Array.isArray(cached.list) && cached.list.length){
      songs = cached.list;
      renderSongs();
      tryRestore();
      toast("接口繁忙，已展示缓存的榜单");
    }else{
      songListEl.innerHTML = `<div class="empty"><svg class="i i-38"><use href="#i-refresh"/></svg><p>加载失败，请稍后重试</p><button class="btn-retry" id="retryBtn">重新加载</button></div>`;
      const rb = document.getElementById("retryBtn");
      if(rb) rb.addEventListener("click", ()=>loadChart(idx));
      toast("网络加载失败，已自动重试");
    }
  }
}

/* ---------- Render song list ---------- */
/* 首屏/加载中的骨架行，替代转圈 loader */
function skelRows(n){
  let h="";
  for(let i=0;i<n;i++){
    h+='<div class="song-row skel">'+
      '<div class="idx"><span class="sk sk-num"></span></div>'+
      '<div class="song-info"><div class="thumb sk"></div>'+
        '<div class="meta"><span class="sk sk-line sk-w64"></span><span class="sk sk-line sk-w38"></span></div></div>'+
      '<div class="album"><span class="sk sk-line sk-w52"></span></div>'+
      '<div class="duration"><span class="sk sk-line sk-w32"></span></div>'+
      '<div class="more"></div></div>';
  }
  return h;
}
// 封面统一取小尺寸缩略图（列表 120px 足够），省 60%+ 图片流量
// 仅 126.net 直链可重写 ?param= 尺寸；injahow 等中转链接自带参数，必须原样保留
function thumbUrl(u, size){
  if(!u) return "";
  let s = String(u).replace(/^http:/,"https:");
  if(/126\.net/.test(s)) s = s.split("?")[0] + "?param="+(size||120)+"y"+(size||120);
  return s;
}
function renderSongs(){
  if(!songs.length){
    songListEl.innerHTML = `<div class="empty"><p>暂无歌曲</p></div>`;
    return;
  }
  // use first song's cover as chart cover
  if(songs[0] && songs[0].pic){
    chartCover.innerHTML = `<img src="${thumbUrl(songs[0].pic,200)}" alt="" onerror="this.parentElement.innerHTML=iconSvg('i-flame',38)"/>`;
  }
  const foliaOn = songListEl.classList.contains("folia");
  songListEl.innerHTML = songs.map((s,i)=>`
    <div class="song-row ${i===currentIdx?'playing':''}" data-idx="${i}">
      <div class="idx ${i<3?'top':''}">
        <span class="num">${String(i+1).padStart(2,'0')}</span>
        <span class="play-mini"><svg class="i i-10"><use href="#i-play"/></svg></span>
        <span class="playing-anim"><span></span><span></span><span></span></span>
      </div>
      <div class="song-info">
        <div class="thumb">${s.pic?`<img src="${thumbUrl(s.pic,foliaOn?270:120)}" alt="" loading="lazy" decoding="async"/>`:""}</div>
        <div class="meta">
          <div class="title">${s.name}</div>
          <div class="artist">${s.artist}</div>
        </div>
      </div>
      <div class="album">—</div>
      <div class="duration">--:--</div>
      <div class="more">
        <button class="fav-btn row-fav ${favSet.has(key(s))?'on':''}" data-fav="${i}" title="收藏">
          <svg class="i i-15"><use href="#i-heart"/></svg>
        </button>
      </div>
    </div>
  `).join("");
  songListEl.querySelectorAll(".song-row").forEach(el=>{
    el.addEventListener("click",()=>playSong(+el.dataset.idx));
  });
  songListEl.querySelectorAll(".row-fav").forEach(el=>{
    el.addEventListener("click",(ev)=>{
      ev.stopPropagation();
      const s = songs[+el.dataset.fav];
      if(s) toggleFav(s);
    });
  });
  if(window.WALL) window.WALL.onSongs();
}

/* ---------- Playback ---------- */
/* 页面氛围色：从当前歌封面取主色写入 --page-rgb，驱动 .page-ambient 两层光晕。
   独立实现（不依赖 WALL 内部 coverColor）：126.net 图有 CORS ACAO:*，可 canvas 取色；失败静默回退默认紫。 */
let pageTintTok=0;
function pageTintFromCover(picUrl){
  const rootEl=document.documentElement;
  if(!picUrl){ rootEl.style.setProperty("--page-rgb","167,139,250"); return; }
  const tok=++pageTintTok;
  const fallback=()=>{ if(tok===pageTintTok) rootEl.style.setProperty("--page-rgb","167,139,250"); };
  const im=new Image();
  im.crossOrigin="anonymous";
  im.onload=()=>{
    try{
      const c=document.createElement("canvas");
      c.width=c.height=16;
      const g=c.getContext("2d",{willReadFrequently:true});
      g.drawImage(im,0,0,16,16);
      const d=g.getImageData(0,0,16,16).data;
      let r=0,gg=0,b=0,w=0;
      for(let p=0;p<d.length;p+=4){
        if(d[p+3]<128) continue;
        const R=d[p],G=d[p+1],B=d[p+2];
        const mx=Math.max(R,G,B),mn=Math.min(R,G,B);
        if(mx<28||mn>234) continue;            // 剔除近黑/近白，避免取到一片灰
        const sat=mx?(mx-mn)/mx:0;
        const wt=0.4+sat;                      // 越鲜艳权重越高
        r+=R*wt;gg+=G*wt;b+=B*wt;w+=wt;
      }
      if(w<1) throw new Error("no usable pixel");
      if(tok!==pageTintTok) return;            // 等待期间已切歌，丢弃过期结果
      rootEl.style.setProperty("--page-rgb",Math.round(r/w)+","+Math.round(gg/w)+","+Math.round(b/w));
    }catch(_){ fallback(); }                    // CORS/解码失败静默回退
  };
  im.onerror=fallback;
  im.src=thumbUrl(picUrl,120);
}
async function playSong(idx){
  if(idx<0||idx>=songs.length) return;
  currentIdx = idx;
  try{ navigator.vibrate && navigator.vibrate(8); }catch(_){} // 汽水式切歌触感
  const s = songs[idx];
  if(s.pic) pageTintFromCover(s.pic); // 主界面氛围色跟随当前封面主色
  pTitle.textContent = s.name;
  pArtist.textContent = s.artist;
  pCover.src = thumbUrl(s.pic, 160); // 小唱片按 3x 屏留足像素，避免缩放发糊
  updatePlayPage(s);
  // 记录历史 / 保存状态 / 更新收藏心 / 系统媒体信息 / 标签页标题
  recordHistory(s);
  saveState(s, 0);
  updatePFav();
  setMediaSession(s);
  document.title = `▶ ${s.name} - ${s.artist} | 云音播放器`;
  if(currentQueueOpen) renderQueue();
  // update row highlight
  document.querySelectorAll(".song-row").forEach((e,i)=>e.classList.toggle("playing",i===idx));
  if(window.WALL) window.WALL.onSong();
  // load lyrics
  loadLyrics(s);
  // 评论预取：播放即后台加载，打开播放页时秒开（延迟1.2s避开音源解析高峰）
  setTimeout(()=>{ if(songs[currentIdx]===s) loadComments(s); }, 1200);
  // scroll into view
  const row = songListEl.querySelector(`.song-row[data-idx="${idx}"]`);
  if(row) row.scrollIntoView({behavior:"smooth",block:"nearest"});
  // 获取播放链接并播放
  const url = await ensurePlayUrl(s);
  if(currentIdx!==idx) return; // 等待期间用户已切歌
  if(!url){
    toast("该歌曲暂无可用音源，已跳过");
    setTimeout(()=>{ if(currentIdx===idx) nextSong(); }, 700);
    return;
  }
  audio.src = url;
  audio.play().then(()=>{
    failStreak = 0;
    s._retried = 0;
    setPlaying(true);
    listFx.recolor(); ppFx.recolor(); // Folia 粒子随歌曲色板换色
    preloadNext(idx); // 汽水式无缝切歌：提前取好下一首的播放链接
  }).catch(err=>{
    if(restoring){
      restoring = false;
      toast("点击播放键继续收听上次歌曲");
      return;
    }
    recoverPlayback();
  });
}
/* 播放失败恢复：先换源重试一次（多数是链接过期/抖动），仍失败才跳歌，连续多首失败则暂停 */
function recoverPlayback(){
  const s = songs[currentIdx];
  if(!s) return;
  if(!s._retried){
    s._retried = 1;
    s.id = s.id || metingId(s.url);
    s.url = "";
    resetAudioUrlCache(s.id); // 丢弃已失效的直链，强制重新解析
    setPlaying(false);
    setTimeout(()=>{ if(currentIdx>=0) playSong(currentIdx); }, 260);
    return;
  }
  s._retried = 0;
  failStreak++;
  if(failStreak>=3){
    failStreak = 0;
    setPlaying(false);
    toast("网络异常，播放已暂停，稍后再试");
    return;
  }
  toast("播放失败，自动切换下一首");
  setTimeout(()=>nextSong(),800);
}

// 预加载下一首播放链接：切歌零等待（链接约20分钟有效，预载后立即用没问题）
function preloadNext(idx){
  if(!songs.length) return;
  // 顺序模式预载下一首；随机/FM 下一首不可预测，随机预载一个候选，命中即秒开
  const cand = (fmMode || playMode===2)
    ? songs[Math.floor(Math.random()*songs.length)]
    : songs[(idx+1) % songs.length];
  if(!cand || cand.url || cand===songs[currentIdx]) return;
  ensurePlayUrl(cand).then(u=>{ if(u) cand.url = u; }).catch(()=>{});
}
function setPlaying(playing){
  if(playing){
    playIcon.innerHTML = '<use href="#i-pause"/>';
    vinyl.classList.add("spinning");
  }else{
    playIcon.innerHTML = '<use href="#i-play"/>';
    vinyl.classList.remove("spinning");
  }
}

function togglePlay(){
  if(currentIdx<0 && songs.length){ playSong(0); return; }
  if(audio.paused) fadePlay();
  else fadePause();
}
/* 音量淡入淡出（汽水式）：淡出 180ms 后暂停，开播后渐入 */
let fadeTimer=0;
function fadePause(){
  if(audio.paused) return;
  clearInterval(fadeTimer);
  const v0=audio.volume||1; let n=0;
  fadeTimer=setInterval(()=>{
    n++; applyVolume(Math.max(0,v0*(1-n/6)));
    if(n>=6){ clearInterval(fadeTimer); audio.pause(); }
  },30);
}
function fadePlay(){
  clearInterval(fadeTimer);
  const v0=Math.max(0.05,(typeof lastVol!=="undefined"&&lastVol)||audio.volume||0.7);
  audio.volume=0;
  audio.play().then(()=>{
    let n=0;
    fadeTimer=setInterval(()=>{
      n++; applyVolume(v0*n/6);
      if(n>=6){ clearInterval(fadeTimer); applyVolume(v0); }
    },30);
  }).catch(()=>{ audio.volume=v0; });
}

function nextSong(){
  if(!songs.length) return;
  let idx;
  if(fmMode || playMode===2){
    idx = Math.floor(Math.random()*songs.length);
  }else{
    idx = (currentIdx+1) % songs.length;
  }
  playSong(idx);
}
function prevSong(){
  if(!songs.length) return;
  let idx;
  if(playMode===2){
    idx = Math.floor(Math.random()*songs.length);
  }else{
    idx = (currentIdx-1+songs.length) % songs.length;
  }
  playSong(idx);
}

/* ---------- Mode ---------- */
modeBtn.addEventListener("click",()=>{
  playMode = (playMode+1)%3;
  modeBtn.innerHTML = modeIcons[playMode];
  modeBtn.classList.toggle("active",playMode!==0);
  toast(modeNames[playMode]);
  const st = store.get('yy_state',{}); st.mode = playMode; store.set('yy_state',st);
});

/* ---------- Progress ---------- */
audio.addEventListener("timeupdate",()=>{
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  const pct = dur ? (cur/dur*100) : 0;
  progressFill.style.width = pct+"%";
  progressThumb.style.left = pct+"%";
  curTimeEl.textContent = fmt(cur);
  durTimeEl.textContent = fmt(dur);
  updateLyrics(cur);
  // 记忆播放进度（每3秒保存一次）
  if(cur - lastSaveTime > 3){
    lastSaveTime = cur;
    if(currentIdx>=0 && songs[currentIdx]) saveState(songs[currentIdx], cur);
  }
  // 同步系统媒体面板进度
  try{
    if('mediaSession' in navigator && isFinite(dur) && dur>0){
      navigator.mediaSession.setPositionState({duration:dur, playbackRate:audio.playbackRate, position:Math.min(cur,dur)});
    }
  }catch(e){}
});
audio.addEventListener("loadedmetadata",()=>{
  durTimeEl.textContent = fmt(audio.duration);
  // 恢复上次播放进度
  if(pendingSeek != null && isFinite(audio.duration) && audio.duration > 0){
    try{ audio.currentTime = Math.min(pendingSeek, Math.max(0, audio.duration - 1)); }catch(e){}
    pendingSeek = null;
  }
});
audio.addEventListener("play",()=>{
  setPlaying(true);
  syncPlayPageState();
  try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState = "playing"; }catch(e){}
  const s = songs[currentIdx];
  if(s) document.title = `▶ ${s.name} - ${s.artist} | 云音播放器`;
});
audio.addEventListener("pause",()=>{
  setPlaying(false);
  syncPlayPageState();
  try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState = "paused"; }catch(e){}
  document.title = BASE_TITLE;
});
audio.addEventListener("ended",()=>{
  if(playMode===1){ audio.currentTime=0; audio.play(); }
  else nextSong();
});
// 播放出错：跳到下一首（连续失败过多则停止，避免死循环）
let skipCount = 0;
audio.addEventListener("playing",()=>{ skipCount = 0; });
audio.addEventListener("error",()=>{
  if(!audio.error) return;
  // 初次加载失败统一由 playSong 的 play() catch 处理（避免双触发乱跳歌）
  // 只有已经播过一段后中断（链接失效/断网）才在这里恢复
  if(audio.currentTime > 0) recoverPlayback();
});
// 检测 30 秒 VIP 试听版（网易云 VIP 歌曲无法播放完整版）
audio.addEventListener("loadedmetadata",()=>{
  const d = audio.duration;
  if(isFinite(d) && d > 0 && d <= 31){
    toast("该歌曲为VIP试听版，已自动跳过");
    if(skipCount < 5){
      skipCount++;
      setTimeout(()=>nextSong(),800);
    }
  }
});

function fmt(s){
  if(!isFinite(s)) return "00:00";
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

let dragging = false;
function seekFromBar(e){
  const rect = progressBar.getBoundingClientRect();
  const pct = Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
  if(audio.duration){
    audio.currentTime = pct*audio.duration;
    progressFill.style.width = (pct*100)+"%";
    progressThumb.style.left = (pct*100)+"%";
  }
}
progressBar.addEventListener("mousedown",(e)=>{dragging=true;seekFromBar(e);});
document.addEventListener("mousemove",(e)=>{if(dragging)seekFromBar(e);});
document.addEventListener("mouseup",()=>{dragging=false;});

/* ---------- Volume ---------- */
function applyVolume(v){
  audio.volume = v;
  volFill.style.width = (v*100)+"%";
  volThumb.style.left = (v*100)+"%";
  updateVolIcon();
  const st = store.get('yy_state',{}); st.vol = v; store.set('yy_state',st);
}
function setVolFromBar(e){
  const rect = volBar.getBoundingClientRect();
  const pct = Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
  applyVolume(pct);
}
let volDragging = false;
volBar.addEventListener("mousedown",(e)=>{volDragging=true;setVolFromBar(e);});
document.addEventListener("mousemove",(e)=>{if(volDragging)setVolFromBar(e);});
document.addEventListener("mouseup",()=>{volDragging=false;});

let lastVol = 0.7;
volBtn.addEventListener("click",()=>{
  if(audio.volume>0){ lastVol=audio.volume; audio.volume=0; volFill.style.width="0%"; volThumb.style.left="0%"; }
  else { audio.volume=lastVol; volFill.style.width=(lastVol*100)+"%"; volThumb.style.left=(lastVol*100)+"%"; }
  updateVolIcon();
});
function updateVolIcon(){
  const v = audio.volume;
  if(v===0){
    volIcon.innerHTML = '<use href="#i-volume-mute"/>';
  }else if(v<0.5){
    volIcon.innerHTML = '<use href="#i-volume-1"/>';
  }else{
    volIcon.innerHTML = '<use href="#i-volume"/>';
  }
}

/* ---------- Play all ---------- */
playAllBtn.addEventListener("click",()=>{
  if(songs.length) playSong(0);
});
playBtn.addEventListener("click",togglePlay);
prevBtn.addEventListener("click",prevSong);
nextBtn.addEventListener("click",nextSong);

/* ---------- Keyboard ---------- */
document.addEventListener("keydown",(e)=>{
  const t = e.target;
  if(t && (t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT"||t.isContentEditable)) return;
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  if(e.code==="Space"){e.preventDefault();togglePlay();}
  else if(e.code==="ArrowRight"){audio.currentTime = Math.min(audio.duration,audio.currentTime+5);}
  else if(e.code==="ArrowLeft"){audio.currentTime = Math.max(0,audio.currentTime-5);}
  else if(e.code==="ArrowUp"){e.preventDefault();applyVolume(Math.min(1,audio.volume+0.05));}
  else if(e.code==="ArrowDown"){e.preventDefault();applyVolume(Math.max(0,audio.volume-0.05));}
  else if(e.code==="KeyM"){audio.muted=!audio.muted;toast(audio.muted?"已静音":"已取消静音");}
  else if(e.code==="Escape"){
    if(playPage.classList.contains("open")){ playPage.classList.remove("open"); }
    else if(currentQueueOpen){ currentQueueOpen=false; queuePanel.classList.remove("open"); }
    else if(lyricsPanel.classList.contains("open")){ lyricsPanel.classList.remove("open"); lrcToggle.classList.remove("active"); }
  }
});

/* ---------- Lyrics ---------- */
function setLrcHtml(html){
  lrcTrack.innerHTML = html;
  ppLrcTrack.innerHTML = html;
}
async function loadLyrics(song){
  lyrics = [];
  setLrcHtml('<div class="lrc-empty">加载歌词中...</div>');
  if(!song || !song.id){ setLrcHtml('<div class="lrc-empty">暂无歌词</div>'); return; }
  let text = null;
  // 列表项自带的 lrc 地址（meting 302 实时签发，直接可用）
  if(song.lrc){
    try{
      const t0 = await (await fetch(song.lrc, {cache:"no-store"})).text();
      if(t0 && t0.trim().startsWith("[")) text = t0;
    }catch(e){}
  }
  // vkeys 歌词接口（自带 CORS，最快）
  if(!text){
    try{
      const r = await fetchTimeout(`https://api.vkeys.cn/v2/music/netease/lyric?id=${song.id}`, 8000);
      if(r && r.ok){
        const d = await r.json();
        const t = d && d.data && d.data.lrc;
        if(t && t.trim().startsWith("[")) text = t;
      }
    }catch(e){}
  }
  // injahow 兜底
  if(!text){
    try{
      const d = await netJSON(`/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`, 7000);
      const t3 = d && d.lrc && d.lrc.lyric;
      if(t3 && t3.trim().startsWith("[")) text = t3;
    }catch(e){}
  }
  if(!text){
    try{
      const res2 = await fetch(`${API}?type=lrc&id=${song.id}&server=netease`, {cache:"no-store"});
      const t2 = await res2.text();
      if(t2 && t2.trim().startsWith("[")) text = t2;
    }catch(e){}
  }
  if(text && text.trim()){
    parseLrc(text);
  }else{
    setLrcHtml('<div class="lrc-empty">纯音乐 · 暂无歌词</div>');
  }
}
function parseLrc(text){
  const lines = text.split(/\r?\n/);
  const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  const arr = [];
  for(const line of lines){
    const matches = [...line.matchAll(re)];
    const content = line.replace(re,"").trim();
    if(!matches.length) continue;
    for(const m of matches){
      const t = (+m[1])*60 + (+m[2]);
      if(content) arr.push({t,content});
    }
  }
  arr.sort((a,b)=>a.t-b.t);
  lyrics = arr;
  if(!arr.length){ setLrcHtml('<div class="lrc-empty">暂无歌词</div>'); return; }
  const html = arr.map(l=>`<div class="lrc-line">${l.content}</div>`).join("");
  setLrcHtml(html);
  lastLrcIdx = -1;
  updateLyrics(audio.currentTime);
}
function updateLyrics(cur){
  if(!lyrics.length) return;
  let idx = -1;
  for(let i=0;i<lyrics.length;i++){
    if(lyrics[i].t <= cur) idx = i; else break;
  }
  if(idx===lastLrcIdx) return;
  lastLrcIdx = idx;
  syncLrcTrack(lrcTrack, idx);
  syncLrcTrack(ppLrcTrack, idx);
  pipSync(idx);
}
function syncLrcTrack(track, idx){
  const lines = track.querySelectorAll(".lrc-line");
  lines.forEach((l,i)=>l.classList.toggle("active",i===idx));
  if(idx>=0 && lines[idx]){
    const vp = track.parentElement;
    const offset = lines[idx].offsetTop - vp.clientHeight/2 + lines[idx].clientHeight/2;
    track.style.transform = `translateY(${-offset}px)`;
  }
}
// 歌词点击跳转进度（侧边面板 + 播放页）
function bindLrcClick(track){
  track.addEventListener("click",(e)=>{
    const line = e.target.closest(".lrc-line");
    if(!line) return;
    const idx = Array.from(track.children).indexOf(line);
    if(idx>=0 && lyrics[idx] && isFinite(lyrics[idx].t) && lyrics[idx].t > 0){
      audio.currentTime = lyrics[idx].t;
      if(audio.paused) audio.play();
    }
  });
}
bindLrcClick(lrcTrack);
lrcToggle.addEventListener("click",()=>{
  lyricsPanel.classList.toggle("open");
  lrcToggle.classList.toggle("active");
});
lrcClose.addEventListener("click",()=>{
  lyricsPanel.classList.remove("open");
  lrcToggle.classList.remove("active");
});

/* ---------- Search ---------- */
let searchTimer = null;
searchInput.addEventListener("input",()=>{
  clearTimeout(searchTimer);
  const kw = searchInput.value.trim();
  if(!kw){
    if(listMode==='favs') showFavs();
    else if(listMode==='history') showHistory();
    else if(currentChart!==null) loadChart(currentChart);
    return;
  }
  searchTimer = setTimeout(()=>doSearch(kw),500);
});
async function doSearch(kw){
  listMode = null; fmMode = false; currentIdx = -1; currentChart = null;
  setActiveNav(null);
  clearBtn.style.display = "none";
  chartTitle.textContent = `搜索：${kw}`;
  chartDesc.textContent = `正在搜索"${kw}"...`;
  chartCover.innerHTML = iconSvg('i-search',38);
  songListEl.innerHTML = `<div class="loader"><div class="spinner"></div><p>搜索中...</p></div>`;
  let results = [];
  // 网易云官方搜索（经 CORS 代理，仅网易源）
  if(!results.length){
    const proxies = [
      (u)=>`https://cors.eu.org/${u}`,
      (u)=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      (u)=>`https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
    ];
    const target = `https://music.163.com/api/search/get?s=${encodeURIComponent(kw)}&type=1&limit=40`;
    for(const proxy of proxies){
      try{
        const res = await fetch(proxy(target), {cache:"no-store"});
        if(!res.ok) continue;
        const data = await res.json();
        if(data && data.result && Array.isArray(data.result.songs)){
          results = data.result.songs.map(s=>({
            id:String(s.id),
            name:s.name,
            artist:(s.artists||[]).map(a=>a.name).join(" / "),
            pic:s.album && s.album.picUrl ? (s.album.picUrl + "?param=200y200").replace(/^http:/,"https:") : "",
            album:(s.album&&s.album.name)||"",
            dur:s.duration||0,
            url:"",
            lrc:`${API}?type=lrc&id=${s.id}&server=netease`
          }));
          break;
        }
      }catch(e){}
    }
  }
  if(results.length){
    songs = results;
    renderSongs();
    chartDesc.textContent = `找到 ${results.length} 首与"${kw}"相关的歌曲`;
  }else{
    songs = [];
    songListEl.innerHTML = `<div class="empty"><p>未找到"${kw}"相关歌曲，或搜索服务暂不可用</p></div>`;
    chartDesc.textContent = `未找到相关结果`;
  }
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toastEl.classList.remove("show"),2000);
}

/* ---------- Favorites ---------- */
function toggleFav(s){
  const k = key(s);
  if(favSet.has(k)){
    favSet.delete(k);
    favs = favs.filter(x=>key(x)!==k);
  }else{
    favSet.add(k);
    favs.unshift({id:s.id,name:s.name,artist:s.artist,pic:s.pic,url:s.url,lrc:s.lrc});
    toast("已添加到我喜欢的音乐");
  }
  store.set('yy_favs',favs);
  updatePFav();
  favCnt.textContent = favs.length;
  // 同步当前列表里的红心
  document.querySelectorAll(".row-fav").forEach(el=>{
    const s2 = songs[+el.dataset.fav];
    if(s2) el.classList.toggle("on", favSet.has(key(s2)));
  });
}
function updatePFav(){
  const s = songs[currentIdx];
  pFavBtn.classList.toggle("on", !!(s && favSet.has(key(s))));
}
pFavBtn.addEventListener("click",()=>{
  const s = songs[currentIdx];
  if(!s){ toast("先播放一首歌吧"); return; }
  toggleFav(s);
});
favCnt.textContent = favs.length;

/* ---------- History ---------- */
function recordHistory(s){
  const k = key(s);
  history = history.filter(x=>key(x)!==k);
  history.unshift({id:s.id,name:s.name,artist:s.artist,pic:s.pic,url:s.url,lrc:s.lrc});
  if(history.length>100) history.length = 100;
  store.set('yy_history',history);
  histCnt.textContent = history.length;
}
histCnt.textContent = history.length;

/* ---------- List modes: favs / history ---------- */
function showFavs(){
  listMode = 'favs'; fmMode = false; currentIdx = -1; currentChart = null;
  setActiveNav("favs");
  clearBtn.style.display = "";
  chartTitle.textContent = "我的收藏";
  chartDesc.textContent = favs.length ? `共 ${favs.length} 首，红心标记的歌曲都在这里` : "还没有收藏，点击歌曲右侧的红心试试";
  chartTag.textContent = "LOCAL";
  chartCover.innerHTML = iconSvg('i-heart',38);
  chartCover.style.background = "linear-gradient(135deg,#f7e2d5,#e0a07a)";
  songs = favs.slice();
  renderSongs();
  chartTag.style.display = songs.length ? "" : "none";
}
function showHistory(){
  listMode = 'history'; fmMode = false; currentIdx = -1; currentChart = null;
  setActiveNav("history");
  clearBtn.style.display = "";
  chartTitle.textContent = "最近播放";
  chartDesc.textContent = history.length ? `共 ${history.length} 条播放记录` : "暂无播放记录";
  chartTag.textContent = "LOCAL";
  chartCover.innerHTML = iconSvg('i-clock',38);
  chartCover.style.background = "linear-gradient(135deg,#e8ded0,#cdbfa9)";
  songs = history.slice();
  renderSongs();
  chartTag.style.display = songs.length ? "" : "none";
}
clearBtn.addEventListener("click",()=>{
  if(listMode==='favs'){
    if(!favs.length) return;
    favs = []; favSet.clear(); store.set('yy_favs',favs);
    favCnt.textContent = 0;
    toast("已清空收藏");
  }else if(listMode==='history'){
    if(!history.length) return;
    history = []; store.set('yy_history',history);
    histCnt.textContent = 0;
    toast("已清空播放记录");
  }else{ return; }
  songs = [];
  renderSongs();
  chartDesc.textContent = listMode==='favs' ? "还没有收藏，点击歌曲右侧的红心试试" : "暂无播放记录";
  chartTag.style.display = "none";
});

/* ---------- Private FM ---------- */
const FM_ICONS = ["i-bolt","i-music","i-disc","i-sparkle","i-headphone","i-flame"];
function startFM(){
  fmMode = true; listMode = null; currentChart = null; currentIdx = -1;
  fmStarted = false;
  setActiveNav("fm");
  clearBtn.style.display = "none";
  chartTitle.textContent = "私人FM";
  chartDesc.textContent = "从全部榜单随机为你推歌，随心畅听";
  chartTag.textContent = "RANDOM";
  chartCover.innerHTML = iconSvg(FM_ICONS[Math.floor(Math.random()*FM_ICONS.length)],38);
  chartCover.style.background = "linear-gradient(135deg,#efe4d3,#d8b894)";
  // 合并所有榜单歌曲去重作为FM曲库
  fmPool = [];
  const seen = new Set();
  const loadFmChart = async (pid)=>{
    const list = await fetchPlaylist(pid);
    if(Array.isArray(list)){
      list.forEach(x=>{
        const k = x.id || (x.name+"::"+x.artist);
        if(!seen.has(k)){ seen.add(k); fmPool.push(x); }
      });
    }
    songs = fmPool.slice();
    if(fmMode){
      if(!fmStarted && songs.length){ fmStarted = true; nextSong(); renderSongs(); }
      else renderSongs();
    }
  };
  CHARTS.forEach(c=>loadFmChart(c.id).catch(()=>{}));
  songs = [];
  songListEl.innerHTML = `<div class="loader"><div class="spinner"></div><p>正在准备FM曲库...</p></div>`;
  toast("私人FM已开启，随机为你播放");
}

/* ---------- Playlist wall ---------- */
function renderWall(){
  const custom = store.get('yy_custom', null);
  let html = PLAYLISTS.map((p,i)=>`
    <div class="pl-tile" style="background:${p.g}" data-pl="${i}" title="加载 ${p.name} 歌单（${p.count}首）">
      <span class="em">${iconSvg(p.icon,23)}</span>
      <span>${p.name}</span>
      <span class="pc">${p.count}首</span>
    </div>
  `).join("");
  if(custom && custom.id) html += `
    <div class="pl-tile" style="background:linear-gradient(135deg,#a78bfa,#7c3aed)" data-custom="1" title="加载我导入的歌单">
      <span class="em">${iconSvg('i-disc',23)}</span>
      <span>${escHtml(custom.name)||"我的歌单"}</span>
      <span class="pc">CUSTOM</span>
    </div>`;
  html += `
    <div class="pl-tile" style="background:linear-gradient(135deg,#3f3f46,#27272a)" data-import="1" title="粘贴网易云歌单链接或ID导入">
      <span class="em">${iconSvg('i-plus',23)}</span>
      <span>导入歌单</span>
      <span class="pc">IMPORT</span>
    </div>`;
  plWall.innerHTML = html;
  plWall.querySelectorAll(".pl-tile").forEach(el=>{
    if(el.dataset.pl!==undefined) el.addEventListener("click",()=>loadPlaylist(+el.dataset.pl));
    else if(el.dataset.custom) el.addEventListener("click",()=>{
      const c = store.get('yy_custom', null);
      if(c && c.id) loadCustomPlaylist(c.id, c.name);
    });
    else if(el.dataset.import) el.addEventListener("click", importPlaylistDialog);
  });
}
function importPlaylistDialog(){
  const input = prompt("粘贴网易云歌单链接或歌单ID\n例如：https://music.163.com/playlist?id=2301490995");
  if(input===null) return;
  const m = String(input).match(/(\d{5,})/);
  if(!m){ toast("没有识别到歌单ID"); return; }
  loadCustomPlaylist(m[1], "", true);
}
async function loadCustomPlaylist(pid, name, fromImport){
  listMode = null; fmMode = false; currentIdx = -1; currentChart = null;
  setActiveNav(null);
  clearBtn.style.display = "none";
  chartTitle.textContent = name || "我的歌单";
  chartDesc.textContent = "自定义导入的网易云歌单";
  chartTag.textContent = "PLAYLIST";
  chartCover.innerHTML = iconSvg('i-disc',38);
  chartCover.style.background = "linear-gradient(135deg,#f7e2d5,#e0a07a)";
  songListEl.innerHTML = `<div class="loader"><div class="spinner"></div><p>加载歌单中...</p></div>`;
  try{
    const list = await fetchPlaylist(pid);
    if(!list || !list.length) throw new Error("empty");
    songs = list;
    store.set('yy_custom', {id:pid, name:name||"我的歌单"});
    renderWall(); // 刷新出「我的歌单」卡片
    renderSongs();
    if(fromImport){ toast(`导入成功，共 ${songs.length} 首，已保存到歌单墙`); }
    else { toast(`已加载「${name||"我的歌单"}」，共 ${songs.length} 首`); playSong(0); }
  }catch(e){
    songListEl.innerHTML = `<div class="empty"><p>歌单加载失败，请确认ID是否正确（仅支持公开歌单）</p></div>`;
    toast("歌单加载失败");
  }
}
async function loadPlaylist(idx){
  const p = PLAYLISTS[idx];
  listMode = null; fmMode = false; currentIdx = -1; currentChart = null;
  setActiveNav(null);
  clearBtn.style.display = "none";
  chartTitle.textContent = p.name;
  chartDesc.textContent = `精选歌单 · ${p.name}`;
  chartTag.textContent = "PLAYLIST";
  chartCover.innerHTML = p.icon;
  chartCover.style.background = p.g;
  songListEl.innerHTML = `<div class="loader"><div class="spinner"></div><p>加载歌单中...</p></div>`;
  try{
    const list = await fetchPlaylist(p.id);
    if(!list || !list.length) throw new Error("empty");
    songs = list;
    renderSongs();
    toast(`已加载歌单「${p.name}」，共 ${songs.length} 首`);
    playSong(0);
  }catch(e){
    songListEl.innerHTML = `<div class="empty"><p>网络加载失败，请稍后重试</p></div>`;
  }
}

/* ---------- Nav active ---------- */
function setActiveNav(type, idx){
  document.querySelectorAll(".chart-item").forEach(e=>e.classList.remove("active"));
  if(type==="chart"){
    const el = chartsEl.querySelector(`.chart-item[data-idx="${idx}"]`);
    if(el) el.classList.add("active");
  }else if(type==="favs"){ navFavs.classList.add("active"); }
  else if(type==="history"){ navHistory.classList.add("active"); }
  else if(type==="fm"){ navFM.classList.add("active"); }
  else if(type==="daily"){ navDaily.classList.add("active"); }
}
navFavs.addEventListener("click",showFavs);
navHistory.addEventListener("click",showHistory);
navFM.addEventListener("click",startFM);

/* ---------- Queue panel ---------- */
function renderQueue(){
  qCount.textContent = songs.length ? "· 共 " + songs.length + " 首" : "";
  if(!songs.length){
    qList.innerHTML = `<div class="lrc-empty" style="text-align:center">队列为空</div>`;
    return;
  }
  qList.innerHTML = songs.map((s,i)=>`
    <div class="q-row ${i===currentIdx?'playing':''}" data-qi="${i}">
      <span class="qi">${i===currentIdx?'<span class="playing-anim"><span></span><span></span><span></span></span>':i+1}</span>
      <div class="q-cover">${s.pic?`<img src="${thumbUrl(s.pic,64)}" alt="" loading="lazy" decoding="async"/>`:""}</div>
      <div class="qt">
        <div class="qn">${escHtml(s.name)}</div>
        <div class="qa">${escHtml(s.artist)}</div>
      </div>
      <div class="qbtns">
        <button class="q-next" data-qnext="${i}" title="下一首播放"><svg class="i i-14"><use href="#i-chevron-up"/></svg></button>
        <button class="qx" data-qx="${i}" title="移除"><svg class="i i-14"><use href="#i-close"/></svg></button>
      </div>
    </div>
  `).join("");
  qList.querySelectorAll(".q-row").forEach(el=>{
    el.addEventListener("click",(e)=>{
      if(e.target.closest(".qx,.q-next")) return;
      playSong(+el.dataset.qi);
      closeQueuePanel();
    });
  });
  qList.querySelectorAll(".q-next").forEach(el=>{
    el.addEventListener("click",(e)=>{
      e.stopPropagation();
      queueMoveNext(+el.dataset.qnext);
    });
  });
  qList.querySelectorAll(".qx").forEach(el=>{
    el.addEventListener("click",(e)=>{
      e.stopPropagation();
      queueRemove(+el.dataset.qx);
    });
  });
}
queueToggle.addEventListener("click",()=>{
  currentQueueOpen = !currentQueueOpen;
  queuePanel.classList.toggle("open",currentQueueOpen);
  if(currentQueueOpen) renderQueue();
});
qClose.addEventListener("click",()=>{
  currentQueueOpen = false;
  queuePanel.classList.remove("open");
});
qClear.addEventListener("click",()=>{
  songs = []; currentIdx = -1;
  try{ audio.pause(); }catch(e){}
  try{ audio.removeAttribute("src"); audio.load(); }catch(e){}
  renderQueue();
  if(typeof renderSongs==="function") renderSongs();
  toast("队列已清空");
});

/* ---------- Play page: vinyl + lyrics + comments ---------- */
const playPage = document.getElementById("playPage");
const ppBgImg = document.getElementById("ppBgImg");
const ppTitle = document.getElementById("ppTitle");
const ppArtist = document.getElementById("ppArtist");
const ppCover = document.getElementById("ppCover");
const ppLrcTrack = document.getElementById("ppLrcTrack");
const ppTabLrc = document.getElementById("ppTabLrc");
const ppTabCmt = document.getElementById("ppTabCmt");
const ppCmtCount = document.getElementById("ppCmtCount");
const ppPaneLrc = document.getElementById("ppPaneLrc");
const ppPaneCmt = document.getElementById("ppPaneCmt");
const ppCmtList = document.getElementById("ppCmtList");
const ppClose = document.getElementById("ppClose");
const ppOpenBtn = document.getElementById("ppOpenBtn");
const ppFlip = document.getElementById("ppFlip");
const ppDanmaku = document.getElementById("ppDanmaku");
const pbName = document.getElementById("pbName");
const pbArtist2 = document.getElementById("pbArtist2");
const pbAlbum = document.getElementById("pbAlbum");
const pbDur = document.getElementById("pbDur");
const pbCmt = document.getElementById("pbCmt");
const pbFav = document.getElementById("pbFav");
let ppTab = "lrc";
let cmtSongId = null;
let cmtAutoRetries = 0;
const cmtCache = new Map();
/* 评论持久缓存（localStorage，30 分钟 TTL，最多保留 24 首）：重听秒开 + 代理限流时仍可显示 */
const CMT_TTL = 30*60*1000;
function cmtPersistGet(id){
  const m = store.get('yy_cmt_cache', null);
  const e = m && m[String(id)];
  if(!e || !e.d || Date.now()-e.t > CMT_TTL) return null;
  return e.d;
}
function cmtPersistSet(id, payload){
  try{
    const m = store.get('yy_cmt_cache', {}) || {};
    m[String(id)] = {t:Date.now(), d:payload};
    const ks = Object.keys(m);
    if(ks.length > 24){
      ks.sort((a,b)=>m[a].t-m[b].t);
      ks.slice(0, ks.length-24).forEach(k=>delete m[k]);
    }
    store.set('yy_cmt_cache', m);
  }catch(e){} // 容量超限等异常静默降级为仅内存缓存
}
// 弥散光晕色板（按歌曲 hash 取色，避免跨域取色失败）
const GLOWS = [
  ["167,139,250","124,58,237"],  // 紫罗兰
  ["96,165,250","37,99,235"],    // 天蓝
  ["45,212,191","13,148,136"],   // 青绿
  ["251,113,133","225,29,72"],   // 玫红
  ["251,191,36","180,83,9"],     // 暖金
  ["129,140,248","79,70,229"],   // 靛蓝
  ["244,114,182","192,38,211"],  // 粉紫
  ["134,239,172","22,163,74"],   // 薄荷绿
];
function hashSong(id){ let h=0; for(const ch of String(id)) h=(h*31+ch.charCodeAt(0))>>>0; return h; }

/* ---------- Diorama 粒子引擎（Folia 风格：云团聚类+双层辉光+节拍脉动+溶解转场） ---------- */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function makeParticles(canvas){
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, raf = null, active = false, mx = .5, my = .5;
  let parts = [], clusters = [], pal = [[253,92,71],[106,72,255]];
  let bpm = 112, beatPhase = 0, lastBeatIdx = -1, kick = 0, kx = 0, ky = 0;
  let mode = "in", modeT = 0, pendingRebuild = false; // in: 淡入成形 / out: 溶解飞散
  function setPalette(){
    const s = songs[currentIdx];
    if(s){
      pal = GLOWS[hashSong(s.id)%GLOWS.length].map(c=>c.split(",").map(Number));
      const h = hashSong(s.id);
      bpm = 92 + h%46;               // 每首歌一个稳定"心跳"
      beatPhase = (h%97)/97*6.28;
    }
  }
  function sprite(col){
    const s = document.createElement("canvas"); s.width = s.height = 64;
    const g = s.getContext("2d");
    const grd = g.createRadialGradient(32,32,2,32,32,30);
    grd.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},.9)`);
    grd.addColorStop(.35, `rgba(${col[0]},${col[1]},${col[2]},.30)`);
    grd.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
    g.fillStyle = grd; g.fillRect(0,0,64,64);
    return s;
  }
  function build(){
    // 云团聚类（源码 clouds 模式）：3-6 个簇锚点，粒子高斯散布在簇周围
    clusters = [];
    const n = Math.max(3, Math.min(6, Math.round(W*H/240000)+2));
    for(let i=0;i<n;i++){
      clusters.push({
        x:(0.12+Math.random()*.76)*W, y:(0.12+Math.random()*.76)*H,
        r:Math.min(W,H)*(.10+Math.random()*.15),
        ph:Math.random()*6.28, bx:(Math.random()-.5)*16, by:(Math.random()-.5)*12,
      });
    }
    parts = [];
    const total = Math.max(26, Math.min(64, Math.round(W*H/14000)));
    for(let i=0;i<total;i++){
      const c = clusters[i%clusters.length];
      const a = Math.random()*6.283, d = c.r*Math.sqrt(Math.random());
      const t = Math.random();
      const col = pal[0].map((v,k)=>Math.round(v+(pal[1][k]-v)*t));
      parts.push({
        hx:c.x+Math.cos(a)*d, hy:c.y+Math.sin(a)*d, x:0, y:0,
        r:.9+Math.random()*2.4, al:.42+Math.random()*.5,
        ph:Math.random()*6.28, sw:.2+Math.random()*.5,
        c, cl:c, sp:sprite(col), dx:0, dy:0,
      });
    }
  }
  function frame(now){
    if(!active){ raf = null; return; }
    raf = requestAnimationFrame(frame);
    if(document.hidden) return;
    const dt = Math.min(.05, (now-(frame.__t||now))/1000); frame.__t = now;
    // 节拍时钟：到拍踢一脚，粒子群外扩回弹（源码 ripple/beat 的 2D 神似）
    const beat = (now/1000)*(bpm/60) + beatPhase;
    const bi = Math.floor(beat);
    if(bi !== lastBeatIdx){
      lastBeatIdx = bi;
      kick = bi%4===0 ? 1 : .45; // 每小节头一拍更重
      const c = clusters[bi%Math.max(1,clusters.length)];
      if(c){ kx=c.x; ky=c.y; }
    }
    kick *= Math.exp(-dt*2.8);
    // 溶解/成形转场状态机
    if(mode==="out"){
      modeT += dt;
      if(modeT>=.42){ setPalette(); build(); mode="in"; modeT=0; }
    }else if(mode==="in"){
      modeT = Math.min(1, modeT+dt/.7);
    }
    const fOut = mode==="out" ? Math.min(1, modeT/.42) : 0;
    const fIn  = mode==="in"  ? modeT : 1;
    // 绘制
    ctx.clearRect(0,0,W,H);
    ctx.globalCompositeOperation = "lighter";
    const breath = .24 + .13*Math.sin(now/1000*.5 + beatPhase);
    const swell = breath + kick*.7; // 整体膨胀系数
    for(const p of parts){
      const sway = Math.sin(now*.00045*p.sw + p.ph);
      const cx = p.cl.x + Math.sin(now*.0002 + p.cl.ph)*p.cl.bx;
      const cy = p.cl.y + Math.cos(now*.00016 + p.cl.ph)*p.cl.by;
      // 节拍波纹：从拍点向外的高斯波包
      const kd = Math.hypot(p.hx-kx, p.hy-ky);
      const wave = kick * 34 * Math.exp(-kd/170) * Math.sin(kd*.045 - now*.006);
      // 膨胀：沿簇心向外推
      const ddx = p.hx-cx, ddy = p.hy-cy, dl = Math.hypot(ddx,ddy)||1;
      const push = swell * 26 * (p.r/3);
      let px = cx + ddx/dl*(dl+push) + sway*13 + (mx-.5)*22*p.r + wave*ddx/dl;
      let py = cy + ddy/dl*(dl+push) + Math.cos(now*.00038*p.sw + p.ph*1.7)*10 + (my-.5)*14*p.r + wave*ddy/dl;
      // 溶解：沿"簇心→粒子"方向加速飞散 + 淡出
      let a = p.al * (.55+.45*Math.sin(p.ph + now*.0012)) * fIn;
      if(fOut>0){
        px += (ddx/dl)*fOut*130; py += (ddy/dl)*fOut*130;
        a *= (1-fOut);
      }
      if(a<=0.01) continue;
      const R = p.r * (1 + kick*.5);
      // 双层：大辉光晕 + 小亮核（源码 glow pass + contrast points）
      ctx.globalAlpha = a*.5;
      ctx.drawImage(p.sp, px-R*5, py-R*5, R*10, R*10);
      ctx.globalAlpha = Math.min(1, a*1.15);
      ctx.fillStyle = `rgb(${p.c[0]},${p.c[1]},${p.c[2]})`;
      ctx.beginPath(); ctx.arc(px, py, R*.55, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  function resize(){
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.max(1, W*dpr); canvas.height = Math.max(1, H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    setPalette(); build();
    if(reducedMotion){ /* 静态一帧 */ active=true; frame(performance.now()); active=false; }
  }
  function start(){
    if(reducedMotion) return;
    if(active) return;
    active = true;
    frame.__t = 0;
    if(!raf) raf = requestAnimationFrame(frame);
  }
  function stop(){ active = false; }
  function dissolve(){ // 换歌：溶解飞散 → 新色板重组
    if(reducedMotion || mode==="out" || !parts.length) return;
    mode = "out"; modeT = 0;
  }
  canvas.parentElement.addEventListener("pointermove",(e)=>{
    const rc = canvas.getBoundingClientRect();
    mx = (e.clientX-rc.left)/Math.max(1,rc.width);
    my = (e.clientY-rc.top)/Math.max(1,rc.height);
  });
  window.addEventListener("resize", ()=>{ clearTimeout(canvas.__rz); canvas.__rz = setTimeout(resize,200); });
  resize();
  return {start, stop, resize, recolor:dissolve};
}
const listFx = makeParticles(document.getElementById("listParticles"));
const ppFx = makeParticles(document.getElementById("ppParticles"));
function syncParticles(){
  const folia = document.body.classList.contains("folia");
  listFx.stop(); // 海报墙全屏覆盖，列表粒子不必再空转
  playPage.classList.contains("open") ? ppFx.start() : ppFx.stop();
}

// 评论多通道：injahow 评论接口（有额度时最快约200ms）+ 直连 + 多个公共代理并行竞速，6秒超时快速失败
const CMT_PROXIES = [
  {u:(t)=>t, p:(d)=>d},
  {u:(t)=>`https://api.allorigins.win/raw?url=${encodeURIComponent(t)}`, p:(d)=>d},
  {u:(t)=>`https://cors.eu.org/${t}`, p:(d)=>d},
  {u:(t)=>`https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(t)}`, p:(d)=>d},
  {u:(t)=>`https://api.allorigins.win/get?url=${encodeURIComponent(t)}`, p:(d)=>JSON.parse((typeof d==="string"?JSON.parse(d):d).contents)},
  {u:(t)=>`https://api.cors.lol/?url=${encodeURIComponent(t)}`, p:(d)=>d},
  {u:(t)=>`https://test.cors.workers.dev/?${t}`, p:(d)=>d},
];
async function fetchTimeout(url, ms){
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), ms||8000);
  try{ return await fetch(url,{cache:"no-store",signal:ctl.signal}); }
  finally{ clearTimeout(timer); }
}

function openPlayPage(){
  playPage.classList.add("open");
  startSpectrum();
  const s = songs[currentIdx];
  if(s) updatePlayPage(s);
  syncPlayPageState();
  syncParticles();
  if(s) loadComments(s);   // 自动加载评论：弹幕、评论数、评论区共用
  // 汽水式手势一次性提示
  if(!store.get('yy_swhint',false)){
    store.set('yy_swhint',true);
    setTimeout(()=>toast("上滑唱片切下一首 · 长按 2 倍速"),900);
  }
}
function closePlayPage(){ playPage.classList.remove("open"); stopSpectrum(); syncParticles(); }
function syncPlayPageState(){
  playPage.classList.toggle("playing", currentIdx>=0 && !audio.paused);
}
ppClose.addEventListener("click",closePlayPage);
ppOpenBtn.addEventListener("click",openPlayPage);
vinyl.addEventListener("click",openPlayPage);
// 网易云式大点击区：手机上点歌名/歌手区域也能打开播放页（唱片按钮太小难点中）
const pInfoEl = document.querySelector(".p-info");
if(pInfoEl){
  pInfoEl.style.cursor = "pointer";
  pInfoEl.addEventListener("click",openPlayPage);
}
bindLrcClick(ppLrcTrack);

function updatePlayPage(s){
  ppTitle.textContent = s.name;
  ppArtist.textContent = s.artist;
  ppCover.src = s.pic || "";
  // 背景用小尺寸图再模糊（90px 高斯模糊下无损画质差异），显著降低低端机 GPU 负担
  ppBgImg.src = s.pic ? s.pic.replace(/\?.*$/,"") + "?param=350y350" : "";
  // 弥散光晕按歌曲换色
  const g = GLOWS[hashSong(s.id) % GLOWS.length];
  playPage.style.setProperty("--glow1", g[0]);
  playPage.style.setProperty("--glow2", g[1]);
  // 背面信息卡
  pbName.textContent = s.name;
  pbArtist2.textContent = s.artist;
  pbAlbum.textContent = s.album || "—";
  pbDur.textContent = s.dur ? fmt(s.dur/1000) : "—";
  pbFav.textContent = favs.some(f=>f.id===s.id) ? "已收藏" : "未收藏";
  pbCmt.textContent = cmtCache.has(s.id) ? cmtLike(cmtCache.get(s.id).total||0)+" 条" : "加载中…";
  if(cmtSongId !== s.id){
    ppCmtList.dataset.done = "0";
    ppCmtCount.textContent = "";
  }
}
// 弹幕评论
function buildDanmaku(songId, hot){
  if(ppDanmaku.dataset.sid === String(songId)) return;
  ppDanmaku.dataset.sid = String(songId);
  ppDanmaku.innerHTML = "";
  const list = (hot||[]).slice(0,8);
  list.forEach((c,i)=>{
    const el = document.createElement("span");
    el.className = "dm";
    let txt = String(c.content||"");
    if(txt.length>42) txt = txt.slice(0,42)+"…";
    el.textContent = txt;
    el.style.top = (4 + (i%4)*24) + "%";
    el.style.animationDuration = (13+Math.random()*7).toFixed(1)+"s";
    el.style.animationDelay = (-Math.random()*15).toFixed(1)+"s";
    ppDanmaku.appendChild(el);
  });
}
/* ---------- 汽水式交互：长按唱片 2 倍速 / 上下滑切歌 ---------- */
const discWrap = document.querySelector(".pp-disc-wrap");
let lpTimer = null, lpActive = false;
function startLongPress(){
  if(playPage.classList.contains("flipped")) return; // 背面信息卡不触发
  lpTimer = setTimeout(()=>{
    lpActive = true;
    audio.playbackRate = 2;
    toast("2 倍速播放中，松开恢复");
  }, 420);
}
function endLongPress(){
  clearTimeout(lpTimer);
  if(lpActive){ lpActive = false; audio.playbackRate = 1; }
}
if(discWrap){
  // 触屏
  discWrap.addEventListener("touchstart",startLongPress,{passive:true});
  discWrap.addEventListener("touchend",endLongPress);
  discWrap.addEventListener("touchcancel",endLongPress);
  discWrap.addEventListener("touchmove",()=>clearTimeout(lpTimer),{passive:true});
  // 鼠标（桌面长按同理）
  discWrap.addEventListener("mousedown",startLongPress);
  discWrap.addEventListener("mouseup",endLongPress);
  discWrap.addEventListener("mouseleave",endLongPress);
  // 上下滑切歌（唱片区）：上滑下一首、下滑上一首，桌面滚轮同样生效
  let sy = 0, sx = 0;
  discWrap.addEventListener("touchstart",(e)=>{ const t=e.touches[0]; sy=t.clientY; sx=t.clientX; },{passive:true});
  discWrap.addEventListener("touchend",(e)=>{
    const t = e.changedTouches[0];
    const dy = t.clientY - sy, dx = t.clientX - sx;
    if(Math.abs(dy)>55 && Math.abs(dx)<60){
      if(lpActive) endLongPress();
      dy<0 ? nextSong() : prevSong();
    }
  },{passive:true});
  let wheelLock = 0;
  discWrap.addEventListener("wheel",(e)=>{
    const now = Date.now();
    if(now - wheelLock < 700) return;
    if(Math.abs(e.deltaY)<20) return;
    wheelLock = now;
    e.deltaY>0 ? nextSong() : prevSong();
  },{passive:true});
}
// 长按后松开不再触发翻面
ppFlip.addEventListener("click",()=>{
  if(window.__lpGuard){ window.__lpGuard=false; return; }
  playPage.classList.toggle("flipped");
  const s = songs[currentIdx];
  if(s && playPage.classList.contains("flipped")) loadComments(s);
});
document.addEventListener("pointerup",()=>{ if(lpActive) window.__lpGuard=true; });
function switchPpTab(t){
  ppTab = t;
  ppTabLrc.classList.toggle("active",t==="lrc");
  ppTabCmt.classList.toggle("active",t==="cmt");
  ppPaneLrc.classList.toggle("hidden",t!=="lrc");
  ppPaneCmt.classList.toggle("hidden",t!=="cmt");
  if(t==="cmt"){
    const s = songs[currentIdx];
    if(s) loadComments(s);
  }else{
    // 切回歌词时重新定位当前行
    lastLrcIdx = -1;
    updateLyrics(audio.currentTime);
  }
}
ppTabLrc.addEventListener("click",()=>switchPpTab("lrc"));
ppTabCmt.addEventListener("click",()=>switchPpTab("cmt"));

/* ---------- Comments (NetEase) ---------- */
function escHtml(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function cmtLike(n){
  n = +n || 0;
  if(n>=100000) return (n/10000).toFixed(0)+"w";
  if(n>=10000) return (n/10000).toFixed(1)+"w";
  return String(n);
}
function cmtTime(t){
  const d = new Date(t);
  const diff = Date.now() - t;
  if(diff < 60e3) return "刚刚";
  if(diff < 3600e3) return Math.floor(diff/60e3)+"分钟前";
  if(diff < 86400e3) return Math.floor(diff/3600e3)+"小时前";
  const p = n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function cmtItem(c){
  const u = c.user || {};
  const ava = (u.avatarUrl||"").replace(/^http:/,"https:");
  return `<div class="pp-cmt">
    <img class="ava" src="${ava}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
    <div class="cbody">
      <div class="nm">${escHtml(u.nickname||"网易用户")}</div>
      <div class="ct">${escHtml(c.content)}</div>
      <div class="ft">
        <span>${cmtTime(c.time||Date.now())}</span>
        <span class="like">${iconSvg('i-like',12)} ${cmtLike(c.likedCount)}</span>
      </div>
    </div>
  </div>`;
}
function buildCmtHtml(payload){
  let html = "";
  if(payload.hot.length) html += `<div class="pp-cmt-sec">精彩评论</div>` + payload.hot.slice(0,10).map(cmtItem).join("");
  if(payload.list.length) html += `<div class="pp-cmt-sec">最新评论<span class="sec-cnt">共${cmtLike(payload.total)}条</span></div>` + payload.list.slice(0,20).map(cmtItem).join("");
  return html || '<div class="lrc-empty">还没有评论，快来抢沙发</div>';
}
async function loadComments(song){
  if(!song || !song.id){
    ppCmtList.innerHTML = '<div class="lrc-empty">暂无评论</div>';
    return;
  }
  // 同一首歌且已渲染过，直接返回
  if(cmtSongId === song.id && ppCmtList.dataset.done==="1") return;
  const render = (payload)=>{
    cmtCache.set(song.id, payload);
    cmtPersistSet(song.id, payload);
    if(cmtSongId !== song.id) return; // 响应回来时已切歌：只入缓存，不覆盖界面
    ppCmtList.innerHTML = buildCmtHtml(payload);
    ppCmtCount.textContent = payload.total ? cmtLike(payload.total) : "";
    ppCmtList.dataset.done = "1";
    cmtSongId = song.id;
    if(pbCmt) pbCmt.textContent = cmtLike(payload.total||0)+" 条";
    buildDanmaku(song.id, payload.hot);
  };
  if(cmtCache.has(song.id)){ render(cmtCache.get(song.id)); return; }
  // 持久缓存：30 分钟内重听同一首歌秒开
  const persisted = cmtPersistGet(song.id);
  if(persisted){ cmtCache.set(song.id, persisted); render(persisted); return; }
  cmtSongId = song.id;
  ppCmtList.dataset.done = "0";
  ppCmtList.innerHTML = '<div class="lrc-empty">评论加载中...</div>';
  const target = `https://music.163.com/api/v1/resource/comments/R_SO_4_${song.id}?limit=30`;
  // 并行竞速：所有通道同时发起，取最先成功的一个（单通道超时6秒）
  const tryProxy = async (px)=>{
    const res = await fetchTimeout(px.u(target), 6000);
    if(!res.ok) throw new Error("http "+res.status);
    const raw = await res.json();
    const data = px.p ? px.p(raw) : raw;
    const hot = data && Array.isArray(data.hotComments) ? data.hotComments : [];
    const list = data && Array.isArray(data.comments) ? data.comments : [];
    if(!hot.length && !list.length) throw new Error("empty");
    return {hot,list,total: (data && typeof data.total==="number") ? data.total : (hot.length+list.length)};
  };
  // injahow meting 评论通道：自带 CORS，额度未耗尽时远快于公共代理
  const tryMeting = async ()=>{
    const res = await fetchTimeout(`${API}?type=comment&id=${song.id}&server=netease`, 5000);
    if(!res.ok) throw new Error("http "+res.status);
    const d = await res.json();
    if(d && d.message && /上限|limit/i.test(String(d.message))) throw new Error("quota");
    const hot = d && (d.hotComments || d.hot) || [];
    const list = (d && d.comments) || [];
    if(!hot.length && !list.length) throw new Error("empty");
    return {hot:Array.isArray(hot)?hot:[], list:Array.isArray(list)?list:[],
      total:(d && typeof d.total==="number") ? d.total : (hot.length+list.length)};
  };
  try{
    const payload = await Promise.any([tryMeting()].concat(CMT_PROXIES.map(tryProxy)));
    cmtAutoRetries = 0;
    render(payload);
    return;
  }catch(e){}
  if(cmtSongId===song.id && ppCmtList.dataset.done!=="1"){
    ppCmtList.innerHTML = '<div class="lrc-empty" id="ppCmtRetry" style="cursor:pointer;text-decoration:underline dotted">评论加载失败，点击重试</div>';
    const btn = document.getElementById("ppCmtRetry");
    if(btn) btn.addEventListener("click",()=>loadComments(song));
    if(pbCmt) pbCmt.textContent = "暂不可用";
    // 播放页打开时自动重试（最多3次），代理恢复后评论自动出现
    if(playPage.classList.contains("open") && cmtAutoRetries < 3){
      cmtAutoRetries++;
      setTimeout(()=>{
        if(cmtSongId===song.id && ppCmtList.dataset.done!=="1") loadComments(song);
      }, 15000);
    }
  }
}

/* ---------- Drawer tools: quality / sleep / backup ---------- */
const qBr = document.getElementById("qBr");
const qSleep = document.getElementById("qSleep");
const qFavExport = document.getElementById("qFavExport");
const qFavImport = document.getElementById("qFavImport");
const qFavFile = document.getElementById("qFavFile");
// 音质
qBr.value = store.get('yy_br',"320") || "320";
qBr.addEventListener("change", async ()=>{
  store.set('yy_br', qBr.value);
  songs.forEach(x=>{ if(x!==songs[currentIdx]) x.url=""; }); // 清空预载链接（音质已变）
  const label = qBr.selectedOptions[0].text;
  const s = songs[currentIdx];
  if(!s || !audio.src){ toast("音质已设为 "+label); return; }
  const pos = audio.currentTime;
  const wasPlaying = !audio.paused;
  s.url = "";
  toast("正在切换至 "+label+"…");
  try{
    const u = await ensurePlayUrl(s);
    if(songs[currentIdx]===s){
      audio.src = u; audio.currentTime = pos;
      if(wasPlaying) audio.play();
      toast("已切换 "+label);
    }
  }catch(e){ toast("音质切换失败"); }
});
// 定时关闭
let sleepTimer = null;
qSleep.addEventListener("change", ()=>{
  if(sleepTimer){ clearTimeout(sleepTimer); sleepTimer = null; }
  const m = parseInt(qSleep.value,10);
  if(!m){ toast("定时关闭已取消"); return; }
  sleepTimer = setTimeout(()=>{
    audio.pause();
    toast("定时时间到，已暂停");
    qSleep.value = "0";
  }, m*60000);
  toast(`将在 ${m} 分钟后暂停播放`);
});
// 收藏备份
qFavExport.addEventListener("click", ()=>{
  if(!favs.length){ toast("收藏为空，先去标记红心吧"); return; }
  const fname = "yunyin-favs-"+new Date().toISOString().slice(0,10)+".json";
  const file = new File([JSON.stringify(favs,null,2)], fname, {type:"application/json"});
  const isTouch = window.matchMedia("(pointer:coarse)").matches;
  // 手机（含 iOS PWA）：a.download 不可靠，走系统分享面板（可选「存储到文件」）
  if(isTouch && navigator.canShare && navigator.canShare({files:[file]})){
    navigator.share({files:[file], title:"云音收藏备份"}).then(
      ()=>toast("已调出分享面板，可选「存储到文件」"),
      ()=>{} // 用户取消
    );
    return;
  }
  // 桌面：标准下载
  try{
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 3000);
    toast(`已导出 ${favs.length} 首收藏，请查看浏览器下载`);
  }catch(e){
    // 极端环境兜底：新标签打开，手动另存
    const w = window.open();
    if(w){ w.document.body.innerHTML = '<pre style="white-space:pre-wrap">'+escHtml(JSON.stringify(favs,null,2))+'</pre>'; }
    toast("已在新标签打开，请手动另存为 .json");
  }
});
qFavImport.addEventListener("click", ()=>qFavFile.click());
qFavFile.addEventListener("change", ()=>{
  const f = qFavFile.files[0];
  qFavFile.value = "";
  if(!f) return;
  const r = new FileReader();
  r.onload = ()=>{
    try{
      const arr = JSON.parse(r.result);
      if(!Array.isArray(arr)) throw new Error("format");
      let added = 0;
      arr.forEach(it=>{
        if(it && it.id && !favs.some(x=>x.id===String(it.id))){
          favs.push({ id:String(it.id), name:it.name||"未知歌曲", artist:it.artist||"未知歌手", pic:it.pic||"", album:it.album||"", dur:it.dur||0, url:"", lrc:"" });
          added++;
        }
      });
      store.set('yy_favs', favs);
      favCnt && (favCnt.textContent = favs.length);
      if(listMode==='favs') showFavs();
      renderSongs();
      toast(`导入完成，新增 ${added} 首收藏`);
    }catch(e){ toast("文件格式错误，请选择导出的 JSON 文件"); }
  };
  r.readAsText(f);
});

/* ---------- Mobile drawer nav ---------- */
const mMenuBtn = document.getElementById("mMenuBtn");
const mSearchBtn = document.getElementById("mSearchBtn");
const mMask = document.getElementById("mMask");
const sideEl = document.querySelector(".sidebar");
const isMobile = ()=>window.matchMedia("(max-width:900px)").matches;
const closeMobileNav = ()=>{
  if(!isMobile()) return;
  sideEl.classList.remove("open");
  mMask.classList.remove("show");
};
if(mMenuBtn){
  mMenuBtn.addEventListener("click",()=>{
    const open = !sideEl.classList.contains("open");
    sideEl.classList.toggle("open", open);
    mMask.classList.toggle("show", open);
  });
  mSearchBtn.addEventListener("click",()=>{
    sideEl.classList.add("open");
    mMask.classList.add("show");
    setTimeout(()=>searchInput && searchInput.focus(), 380);
  });
  mMask.addEventListener("click", closeMobileNav);
  // 手机上从侧栏选中任意入口（榜单/收藏/历史/FM/歌单墙）后自动收起抽屉
  sideEl.addEventListener("click",(e)=>{
    if(e.target.closest(".chart-item") || e.target.closest(".pl-tile")) setTimeout(closeMobileNav, 120);
  });
  // 搜索提交后收起
  searchInput && searchInput.addEventListener("keydown",(e)=>{ if(e.key==="Enter") closeMobileNav(); });
}

/* ---------- Folia 沉浸视图切换 ---------- */
const viewToggle = document.getElementById("viewToggle");
let foliaView = !!store.get('yy_folia', false);

/* ================= Folia 海报墙引擎 =================
   对齐 Folia 源码结构（PosterWall.tsx / wall.css）：
   · 镜头缩放 0.52 / 0.64 / 0.76（<640 / <1100 / 其余），指针拖拽平移、滚轮缩放
   · 密铺的封面网格（CELL 96 / GAP 4 / 19 列），每张卡拉近才看清的小字标题
   · 正在播放/点选的卡就地放大成 5x5 方形播放卡：细白描边 + 左下大标题 + 底部控制行
   · 入场时整面墙从模糊放大拉回清晰（对齐视频开头的过渡） */
var WALL = (function(){
  const CELL=96, GAP=4, OVERSCAN=400;
  /* 手机屏窄：必须把列数降下来，卡片视觉尺寸才够大
     （同样是 96 世界px 的卡，19 列在 390px 屏上只有 50px，5 列约 78px） */
  const colsFor=()=>innerWidth<640?5:(innerWidth<1100?13:19);
  const growFor=()=>innerWidth<640?4:5;
  // 密铺模板（对齐视频）：大量 1x1 小卡，少量 2x1 宽幅与 2x2/1x2 大卡
  const SPANS=[[1,1],[1,1],[2,1],[1,1],[2,2],[1,1],[1,1],[1,2],[1,1],[2,1],[1,1],[1,1],[2,2],[1,1],[1,2],[1,1],[2,1],[1,1],[1,1],[1,1],[2,1],[1,1],[1,2],[1,1]];
  const ICON_PLAY='<svg class="i"><use href="#i-play"/></svg>';
  const ICON_PAUSE='<svg class="i"><use href="#i-pause"/></svg>';
  const ICON_EXPAND='<svg class="i"><use href="#i-expand"/></svg>';
  const ICON_PREV='<svg class="i"><use href="#i-prev"/></svg>';
  const ICON_NEXT='<svg class="i"><use href="#i-next"/></svg>';

  const root=document.getElementById("foliaWall");
  const field=document.getElementById("wallField");
  const world=document.getElementById("wallWorld");
  const backBtn=document.getElementById("wallBack");
  const zoom=document.getElementById("wallZoom");
  const zoomBg=document.getElementById("wallZoomBg");
  const zoomImg=document.getElementById("wallZoomImg");
  const zoomTitle=document.getElementById("wallZoomTitle");
  const zoomArtist=document.getElementById("wallZoomArtist");
  const zoomClose=document.getElementById("wallZoomClose");
  const zoomGlow=document.getElementById("wallZoomGlow");
  const zoomBar=document.getElementById("wallZoomBar");
  const zoomProg=document.getElementById("wallZoomProg");
  const zoomTime=document.getElementById("wallZoomTime");
  const zoomPrev=document.getElementById("wallZoomPrev");
  const zoomPlay=document.getElementById("wallZoomPlay");
  const zoomNext=document.getElementById("wallZoomNext");
  if(zoomPrev) zoomPrev.innerHTML=ICON_PREV;
  if(zoomNext) zoomNext.innerHTML=ICON_NEXT;
  if(zoomPlay) zoomPlay.innerHTML=ICON_PLAY;
  const api={onSongs(){},onSong(){},sync(){},open(){},close(){}};
  if(!root||!field||!world||!backBtn) return api;

  let cam={x:34,y:80,scale:0.76};
  let colsNow=colsFor();
  let layout=[], nodes=[], expanded=-1, prevExpanded=-1, morphTimer=0;
  let dragging=false, didDrag=false, pt=null, cam0=null;
  let cullRaf=0, tickTimer=0;

  const fmt=s=>{s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")};
  const scaleFor=()=>{const w=innerWidth;return w<640?0.52:(w<1100?0.64:0.76)};
  const titleSize=w=>Math.max(10,Math.min(30,Math.round(w*0.135)));
  const artistSize=w=>Math.max(8,Math.min(14,Math.round(w*0.105)));

  /* —— 贪心拼贴：先按列表顺序铺一遍；放大时用基础位置作锚点预留 4x4，其余重新流动 —— */
  function pack(count, growIdx){
    const C=colsFor(), GW=growFor(), GH=growFor();
    const occ=new Set(), kk=(r,c)=>r*160+c;
    const free=(r,c,w,h)=>{
      if(c<0||c+w>C) return false;
      for(let y=r;y<r+h;y++) for(let x=c;x<c+w;x++) if(occ.has(kk(y,x))) return false;
      return true;
    };
    const mark=(r,c,w,h)=>{for(let y=r;y<r+h;y++) for(let x=c;x<c+w;x++) occ.add(kk(y,x))};
    const rectOf=(r,c,w,h)=>({x:c*(CELL+GAP),y:r*(CELL+GAP),w:w*(CELL+GAP)-GAP,h:h*(CELL+GAP)-GAP});
    const out=new Array(count);

    if(growIdx>=0 && growIdx<count){
      // 基础流锚点（不含放大）
      const o2=new Set();
      const f2=(r,c,w,h)=>{
        if(c<0||c+w>C) return false;
        for(let y=r;y<r+h;y++) for(let x=c;x<c+w;x++) if(o2.has(kk(y,x))) return false;
        return true;
      };
      const m2=(r,c,w,h)=>{for(let y=r;y<r+h;y++) for(let x=c;x<c+w;x++) o2.add(kk(y,x))};
      let ar=0, ac=0;
      for(let i=0;i<=growIdx;i++){
        const sp=SPANS[i%SPANS.length];
        let done=false;
        for(let r=0;!done;r++) for(let c=0;c<=C-sp[0];c++){
          if(f2(r,c,sp[0],sp[1])){
            m2(r,c,sp[0],sp[1]);
            if(i===growIdx){ar=r;ac=Math.max(0,Math.min(C-GW,c));}
            done=true;break;
          }
        }
      }
      // 放大卡至少下移 3 行，保证它上方也有满墙内容（视频里放大卡四周都是铺满的）
      ar=Math.max(3, ar);
      mark(ar,ac,GW,GH);
      out[growIdx]=rectOf(ar,ac,GW,GH);
    }

    for(let i=0;i<count;i++){
      if(i===growIdx) continue;
      const sp=SPANS[i%SPANS.length];
      let done=false;
      for(let r=0;!done;r++) for(let c=0;c<=C-sp[0];c++){
        if(free(r,c,sp[0],sp[1])){ mark(r,c,sp[0],sp[1]); out[i]=rectOf(r,c,sp[0],sp[1]); done=true; break; }
      }
    }
    return out;
  }

  function makeNode(i){
    const s=songs[i];
    const el=document.createElement("article");
    el.className="wall-card";
    el.dataset.idx=i;
    el.innerHTML=
      '<span class="wall-shade"></span><span class="wall-tint"></span>'+
      '<span class="wall-badge">正在播放</span>'+
      '<button class="wall-full" aria-label="全屏播放">'+ICON_EXPAND+'</button>'+
      '<span class="wall-copy"><strong></strong><small></small></span>'+
      '<div class="wall-ctrl">'+
        '<button class="wall-pn wall-prev" aria-label="上一首">'+ICON_PREV+'</button>'+
        '<button class="wall-playbtn" aria-label="播放或暂停">'+ICON_PLAY+'</button>'+
        '<button class="wall-pn wall-next" aria-label="下一首">'+ICON_NEXT+'</button>'+
        '<span class="wall-time">0:00 / 0:00</span>'+
      '</div>'+
      '<span class="wall-bar"><i></i></span>';
    if(!s){ el.classList.add("is-skel"); return {el,url:"",hidden:false}; }
    el.querySelector(".wall-copy strong").textContent=s.name||"";
    el.querySelector(".wall-copy small").textContent=s.artist||"";
    return {el,url:"",hidden:false};
  }

  const SKEL_N=88;   // 骨架墙的卡片数量（够铺满一屏半，接口回来后再换成真实数量）
  function build(){
    const skel = !songs.length;
    const n = skel ? SKEL_N : songs.length;
    if(!n){ world.innerHTML=""; nodes=[]; layout=[]; prevExpanded=-1; return; }
    layout=pack(n, skel ? -1 : expanded);
    let rebuilt=false;
    if(nodes.length!==n){
      rebuilt=true;
      world.innerHTML="";
      nodes=[];
      for(let i=0;i<n;i++){ const nd=makeNode(i); world.appendChild(nd.el); nodes.push(nd); }
    }else{
      for(let i=0;i<n;i++){
        const s=songs[i], nd=nodes[i];
        if(!s) continue;
        nd.el.querySelector(".wall-copy strong").textContent=s.name||"";
        nd.el.querySelector(".wall-copy small").textContent=s.artist||"";
        nd.el.querySelector(".wall-badge").textContent="正在播放 · "+(i+1)+"/"+n;
        if(nd.url!==(s.pic||"")){ nd.url=""; nd.el.style.backgroundImage=""; }
      }
    }
    // 只让「刚放大」和「刚缩回」的两张卡做尺寸过渡，其余瞬间归位，避免 200 张同时重排
    const morphing = !rebuilt && prevExpanded!==expanded;
    if(morphing){
      [prevExpanded, expanded].forEach(k=>{
        if(k<0 || !nodes[k]) return;
        nodes[k].el.classList.add("morph");
        // 放大卡换高清图，缩回卡换小图（省带宽也省解码）
        nodes[k].url=""; nodes[k].el.style.backgroundImage="";
      });
    }else{
      for(let i=0;i<n;i++) nodes[i].el.classList.remove("morph");
    }
    for(let i=0;i<n;i++){
      const el=nodes[i].el, r=layout[i];
      el.style.left=r.x+"px"; el.style.top=r.y+"px";
      el.style.width=r.w+"px"; el.style.height=r.h+"px";
      el.classList.toggle("is-expanded", i===expanded);
      el.classList.toggle("is-current", i===currentIdx);
      el.classList.toggle("is-skel", skel);
      const tEl=el.querySelector(".wall-copy strong");
      const aEl=el.querySelector(".wall-copy small");
      tEl.style.fontSize = i===expanded ? "" : titleSize(r.w)+"px";
      aEl.style.fontSize = i===expanded ? "" : artistSize(r.w)+"px";
    }
    prevExpanded=expanded;
    if(morphing){
      clearTimeout(morphTimer);
      morphTimer=setTimeout(()=>{
        for(let i=0;i<nodes.length;i++) nodes[i].el.classList.remove("morph");
      },480);
    }
    cull();
  }

  /* 只画视口附近的卡，出圈的清掉封面图（对应源码的 near(bounds, OVERSCAN)） */
  function cull(){
    if(!nodes.length) return;
    const vw=innerWidth, vh=innerHeight;
    const l=(-cam.x)/cam.scale-OVERSCAN, t=(-cam.y)/cam.scale-OVERSCAN;
    const r=(vw-cam.x)/cam.scale+OVERSCAN, b=(vh-cam.y)/cam.scale+OVERSCAN;
    for(let i=0;i<nodes.length;i++){
      const nd=nodes[i], rc=layout[i];
      if(!rc) continue;
      const vis = rc.x<r && rc.x+rc.w>l && rc.y<b && rc.y+rc.h>t;
      if(vis){
        if(nd.hidden){ nd.el.style.display=""; nd.hidden=false; }
        if(!nd.url && songs[i] && songs[i].pic){
          nd.url=songs[i].pic;
          nd.el.style.backgroundImage='url("'+thumbUrl(songs[i].pic, i===expanded?640:200)+'")';
        }
      }else if(!nd.hidden){ nd.el.style.display="none"; nd.hidden=true; }
    }
  }

  function gridSize(){
    let maxB=0;
    for(let i=0;i<layout.length;i++){ const r=layout[i]; if(r) maxB=Math.max(maxB, r.y+r.h); }
    return {w:colsFor()*(CELL+GAP)-GAP, h:maxB};
  }
  /* 铺满视口所需的最小缩放：保证任何窗口尺寸下墙面都不露出空白 */
  function fillScale(){
    const g=gridSize();
    if(!g.w||!g.h) return scaleFor();
    return Math.max(innerWidth/g.w, innerHeight/g.h);
  }
  /* 铺满视口所需的最小缩放，并留 4% 余量，保证边缘平移时任何方向都不会露出空白 */
  const fitScale=()=>Math.max(scaleFor(), fillScale()*1.04);
  /* 镜头边界：整面墙必须始终铺满视口（视频里没有露出空白） */
  function clampCam(){
    const g=gridSize();
    const gw=g.w*cam.scale, gh=g.h*cam.scale;
    const vw=innerWidth, vh=innerHeight;
    cam.x = gw<=vw ? (vw-gw)/2 : Math.min(0, Math.max(vw-gw, cam.x));
    cam.y = gh<=vh ? (vh-gh)/2 : Math.min(0, Math.max(vh-gh, cam.y));
  }

  function applyCam(animate){
    clampCam();
    if(animate){
      world.classList.add("animating");
      setTimeout(()=>world.classList.remove("animating"),620);
    }
    world.style.transform="translate3d("+cam.x+"px,"+cam.y+"px,0) scale("+cam.scale+")";
    if(!cullRaf) cullRaf=requestAnimationFrame(()=>{cullRaf=0;cull();});
  }

  function panTo(idx, animate){
    const r=layout[idx];
    if(!r) return;
    const vw=innerWidth, vh=innerHeight;
    const need=Math.min((vw*0.92)/r.w, (vh*0.86)/r.h);
    // 不允许缩到露出空白：最小缩放永远是「铺满视口」
    cam.scale=Math.max(fitScale(), Math.min(cam.scale, need));
    cam.x=vw/2-(r.x+r.w/2)*cam.scale;
    cam.y=vh/2-(r.y+r.h/2)*cam.scale;
    applyCam(animate!==false);
  }

  function tick(){
    if(!document.body.classList.contains("folia")) return;
    const zDur=isFinite(audio.duration)?audio.duration:0;
    if(zoomOpen){
      const zp=zDur>0?Math.min(100,(audio.currentTime||0)/zDur*100):0;
      if(zoomProg) zoomProg.style.width=zp+"%";
      if(zoomTime) zoomTime.textContent=fmt(audio.currentTime)+" / "+fmt(zDur);
      if(zoomPlay) zoomPlay.innerHTML = audio.paused?ICON_PLAY:ICON_PAUSE;
    }
    const nd=nodes[expanded];
    if(!nd) return;
    const el=nd.el;
    const dur=zDur;
    const bar=el.querySelector(".wall-bar i");
    if(bar) bar.style.width=(dur>0?Math.min(100,(audio.currentTime||0)/dur*100):0)+"%";
    const tm=el.querySelector(".wall-time");
    if(tm) tm.textContent=fmt(audio.currentTime)+" / "+fmt(dur);
    const pb=el.querySelector(".wall-playbtn");
    if(pb){
      const paused=!!audio.paused, key=String(paused);
      if(pb.dataset.p!==key){ pb.dataset.p=key; pb.innerHTML=paused?ICON_PLAY:ICON_PAUSE; }
    }
  }
  function startTick(){ if(!tickTimer) tickTimer=setInterval(tick,240); }
  function stopTick(){ if(tickTimer){ clearInterval(tickTimer); tickTimer=0; } }

  function sync(){
    for(const nd of nodes){
      nd.el.classList.toggle("is-current", +nd.el.dataset.idx===currentIdx);
    }
  }

  function togglePlayback(){
    if(audio.paused) audio.play().catch(()=>{});
    else audio.pause();
  }

  /* —— 全屏播放卡：模糊底 + 居中清晰封面 ——
     先上 640 缩略图保证秒开，再预载网易原图（上限 1417px）替换；
     清晰图最大只画到 620 CSS px，Retina 下也不会被拉伸。 */
  let zoomOpen=false, zoomTok=0, glowTok=0;

  /* 从封面取主色（按饱和度加权平均），全屏光晕与整墙氛围共用 */
  function coverColor(url, cb){
    if(!url) return;
    const im=new Image();
    im.crossOrigin="anonymous";
    im.onload=()=>{
      try{
        const c=document.createElement("canvas");
        c.width=c.height=16;
        const g=c.getContext("2d",{willReadFrequently:true});
        g.drawImage(im,0,0,16,16);
        const d=g.getImageData(0,0,16,16).data;
        let r=0,gg=0,b=0,w=0;
        for(let p=0;p<d.length;p+=4){
          if(d[p+3]<128) continue;
          const R=d[p],G=d[p+1],B=d[p+2];
          const mx=Math.max(R,G,B), mn=Math.min(R,G,B);
          if(mx<28||mn>234) continue;           // 剔除近黑/近白，避免取到一片灰
          const sat=mx?(mx-mn)/mx:0;
          const wt=0.4+sat;                     // 越鲜艳权重越高
          r+=R*wt; gg+=G*wt; b+=B*wt; w+=wt;
        }
        if(w<1) return;
        cb([Math.round(r/w),Math.round(gg/w),Math.round(b/w)]);
      }catch(_){ /* 封面 CDN 未开 CORS 时静默降级 */ }
    };
    im.src=url;
  }

  /* 全屏光晕颜色 */
  function setGlow(url){
    if(!url||!zoom) return;
    const tok=++glowTok;
    coverColor(url, rgb=>{
      if(tok!==glowTok) return;
      zoom.style.setProperty("--zoom-glow","rgb("+rgb.join(",")+")");
    });
  }

  /* 整墙氛围：当前歌的封面主色写进 --wall-rgb，驱动 .wall-ambient 的两处光晕 */
  let toneTok=0;
  function setWallTone(url){
    if(!root) return;
    if(!url){ toneTok++; root.style.removeProperty("--wall-rgb"); return; }
    const tok=++toneTok;
    coverColor(url, rgb=>{
      if(tok!==toneTok) return;
      root.style.setProperty("--wall-rgb", rgb.join(","));
    });
  }

  function openZoom(i){
    const s=songs[i];
    if(!s||!zoom) return;
    const tok=++zoomTok;
    const small=s.pic?thumbUrl(s.pic,640):"";
    const big=s.pic?thumbUrl(s.pic,1600):"";
    if(zoomBg) zoomBg.style.backgroundImage = small?'url("'+small+'")':"none";
    zoomImg.style.backgroundImage = small?'url("'+small+'")':"none";
    zoom.style.setProperty("--zoom-glow","rgb(120,96,255)");
    setGlow(small);
    if(big){
      const im=new Image();
      im.onload=()=>{
        if(tok!==zoomTok||!zoomOpen) return;
        if(zoomBg) zoomBg.style.backgroundImage='url("'+big+'")';
        zoomImg.style.backgroundImage='url("'+big+'")';
        setGlow(big);
      };
      im.src=big;
    }
    zoomTitle.textContent=s.name||"";
    zoomArtist.textContent=s.artist||"";
    if(zoomPlay) zoomPlay.innerHTML = audio.paused?ICON_PLAY:ICON_PAUSE;
    zoomOpen=true;
    edgeX=0; edgeY=0;
    zoom.classList.add("on");
    zoom.setAttribute("aria-hidden","false");
    requestAnimationFrame(()=>zoom.classList.add("show"));
    tick();
  }
  function closeZoom(instant){
    if(!zoom||!zoomOpen) return;
    zoomOpen=false;
    zoom.classList.remove("show");
    zoom.setAttribute("aria-hidden","true");
    if(instant) zoom.classList.remove("on");
    else setTimeout(()=>{ if(!zoomOpen) zoom.classList.remove("on"); },320);
  }
  zoomClose&&zoomClose.addEventListener("click",e=>{ e.stopPropagation(); closeZoom(); });
  zoomPrev&&zoomPrev.addEventListener("click",e=>{
    e.stopPropagation();
    if(typeof playSong==="function" && songs.length) playSong((currentIdx-1+songs.length)%songs.length);
  });
  zoomNext&&zoomNext.addEventListener("click",e=>{
    e.stopPropagation();
    if(typeof playSong==="function" && songs.length) playSong((currentIdx+1)%songs.length);
  });
  zoomPlay&&zoomPlay.addEventListener("click",e=>{ e.stopPropagation(); togglePlayback(); });
  zoomBar&&zoomBar.addEventListener("click",e=>{
    const rc=zoomBar.getBoundingClientRect();
    const p=Math.max(0,Math.min(1,(e.clientX-rc.left)/Math.max(1,rc.width)));
    if(isFinite(audio.duration)&&audio.duration>0){ audio.currentTime=p*audio.duration; tick(); }
  });

  /* —— 交互：拖拽平移 / 滚轮缩放 / 点卡放大 —— */
  field.addEventListener("pointerdown",e=>{
    if(e.button) return;
    didDrag=false; // 每次按下都重置，避免上一次拖拽把后续点击吞掉
    if(e.target.closest(".wall-ctrl,.wall-full,.wall-bar")) return;
    dragging=true; pt={x:e.clientX,y:e.clientY}; cam0={x:cam.x,y:cam.y};
    // 注意：这里不能立刻 setPointerCapture —— 指针捕获会把 pointerup 的目标改成 field，
    // 导致 click 目标变成 field，卡片和按钮的 click 永远不会命中。只有确认是拖拽后才捕获。
  });
  field.addEventListener("pointermove",e=>{
    if(!dragging) return;
    const dx=e.clientX-pt.x, dy=e.clientY-pt.y;
    if(!didDrag){
      if(dx*dx+dy*dy<=64) return; // 小于 8px 视为手指/鼠标抖动，仍是点击
      didDrag=true;
      world.classList.add("dragging");
      try{ field.setPointerCapture(e.pointerId); }catch(_){}
    }
    cam.x=cam0.x+dx; cam.y=cam0.y+dy;
    applyCam();
  });
  const endDrag=()=>{ dragging=false; world.classList.remove("dragging"); };

  /* 卡片统一的激活逻辑：小卡点一下 → 就地放大 + 播放；按钮各走各的分支 */
  function activate(card, target, clientX){
    const i=+card.dataset.idx;
    if(i<0 || !songs[i]){ if(typeof toast==="function") toast("歌曲加载中…"); return; }
    if(target.closest(".wall-playbtn")){ togglePlayback(); return; }
    if(target.closest(".wall-full")){
      // 全屏：封面铺满整屏并开始播放当前卡片的歌
      if(i!==currentIdx && typeof playSong==="function") playSong(i);
      else if(audio.paused) audio.play().catch(()=>{});
      openZoom(i);
      return;
    }
    if(target.closest(".wall-prev")){ if(typeof playSong==="function") playSong((currentIdx-1+songs.length)%songs.length); return; }
    if(target.closest(".wall-next")){ if(typeof playSong==="function") playSong((currentIdx+1)%songs.length); return; }
    if(target.closest(".wall-bar")){
      const sk=card.querySelector(".wall-bar");
      const rc=sk.getBoundingClientRect();
      const p=Math.max(0,Math.min(1,(clientX-rc.left)/Math.max(1,rc.width)));
      if(isFinite(audio.duration)&&audio.duration>0){ audio.currentTime=p*audio.duration; tick(); }
      return;
    }
    if(i===currentIdx && i===expanded){ togglePlayback(); return; }
    // 任意卡：点一下就直接播（同时就地放大成播放卡）
    if(i!==expanded){
      expanded=i;
      build();
      panTo(i);
      if(i!==currentIdx && typeof playSong==="function") playSong(i);
      else sync();
      return;
    }
    if(i!==currentIdx && typeof playSong==="function") playSong(i);
  }

  /* 点击判定放在 pointerup：不依赖原生 click，避免指针捕获/手势取消把 click 吞掉（真机上就是这个坑） */
  let tapStamp=0;
  field.addEventListener("pointerup",e=>{
    const tap = dragging && !didDrag;
    endDrag();
    if(!tap) return;
    const card=e.target.closest(".wall-card");
    if(!card) return;
    tapStamp=performance.now();
    activate(card, e.target, e.clientX);
  });
  field.addEventListener("pointercancel",endDrag);
  window.addEventListener("pointerup",e=>{
    if(dragging) endDrag();
    // 触摸/手写笔没有「悬停」，抬手后不要留下漂移速度
    if(e.pointerType && e.pointerType!=="mouse"){ edgeX=0; edgeY=0; }
  });
  window.addEventListener("blur",endDrag);

  /* 键盘/程序触发的 click（展开卡里的按钮仍靠它） */
  field.addEventListener("click",e=>{
    if(performance.now()-tapStamp<400) return; // 已由 pointerup 处理过
    const card=e.target.closest(".wall-card");
    if(!card) return;
    if(didDrag){ didDrag=false; return; }
    activate(card, e.target, e.clientX);
  });

  /* —— 边缘自动平移：鼠标靠近屏幕边缘时，视角朝那个方向移动（沉浸式不提供手动缩放） —— */
  const EDGE_ZONE=110, EDGE_SPEED=1200;
  let edgeX=0, edgeY=0, edgeRaf=0, edgeT=0;
  function edgeFrom(e){
    if(zoomOpen || dragging){ edgeX=0; edgeY=0; return; }
    const vw=innerWidth, vh=innerHeight;
    edgeX=0; edgeY=0;
    if(e.clientX<EDGE_ZONE) edgeX=EDGE_SPEED*Math.pow((EDGE_ZONE-e.clientX)/EDGE_ZONE,2);
    else if(e.clientX>vw-EDGE_ZONE) edgeX=-EDGE_SPEED*Math.pow((e.clientX-(vw-EDGE_ZONE))/EDGE_ZONE,2);
    if(e.clientY<EDGE_ZONE) edgeY=EDGE_SPEED*Math.pow((EDGE_ZONE-e.clientY)/EDGE_ZONE,2);
    else if(e.clientY>vh-EDGE_ZONE) edgeY=-EDGE_SPEED*Math.pow((e.clientY-(vh-EDGE_ZONE))/EDGE_ZONE,2);
  }
  function edgeLoop(ts){
    if(!document.body.classList.contains("folia")){ edgeRaf=0; return; }
    edgeRaf=requestAnimationFrame(edgeLoop);
    if(!edgeT){ edgeT=ts; return; }
    const dt=Math.min(0.06,(ts-edgeT)/1000); edgeT=ts;
    if((edgeX||edgeY) && !dragging && !zoomOpen){
      cam.x+=edgeX*dt; cam.y+=edgeY*dt;
      applyCam(false);
    }
  }
  field.addEventListener("pointermove",edgeFrom);
  field.addEventListener("pointerleave",()=>{ edgeX=0; edgeY=0; });

  backBtn.addEventListener("click",()=>{ if(typeof setFolia==="function") setFolia(false); });
  window.addEventListener("keydown",e=>{
    if(e.key!=="Escape") return;
    if(zoomOpen){ closeZoom(); return; }
    if(document.body.classList.contains("folia") && typeof setFolia==="function") setFolia(false);
  });

  window.addEventListener("resize",()=>{
    if(!document.body.classList.contains("folia")) return;
    // 列数随视口宽度变化（手机 5 列 / 平板 13 列 / 桌面 19 列），跨断点时重新铺一遍
    const cc=colsFor();
    if(cc!==colsNow){ colsNow=cc; build(); }
    cam.scale=fitScale();
    if(expanded>=0) panTo(expanded,false); else applyCam();
  });

  /* —— 对外接口 —— */
  api.open=()=>{
    if(expanded<0 && currentIdx>=0) expanded=currentIdx;
    build();
    // 入场：整面墙从「模糊 + 放大 + 透明」拉回清晰（对齐视频开头那段过渡）
    world.classList.remove("animating");
    world.style.transition="none";
    world.style.filter="blur(18px)";
    world.style.opacity="0";
    const s0=fitScale();
    cam={x:34,y:80,scale:s0*1.08};
    applyCam(false);
    requestAnimationFrame(()=>{
      world.style.transition="filter .75s ease, opacity .6s ease, transform .85s cubic-bezier(.22,.68,0,1)";
      world.style.filter="none";
      world.style.opacity="1";
      cam.scale=s0;
      if(expanded>=0) panTo(expanded,false); else applyCam(false);
      setTimeout(()=>{ world.style.transition=""; },950);
    });
    edgeT=0;
    if(!edgeRaf) edgeRaf=requestAnimationFrame(edgeLoop);
    setWallTone(currentIdx>=0 && songs[currentIdx] ? songs[currentIdx].pic : "");
    startTick();
  };
  api.close=()=>{
    stopTick(); closeZoom(true);
    if(edgeRaf){ cancelAnimationFrame(edgeRaf); edgeRaf=0; }
    edgeX=0; edgeY=0;
  };
  /* 接口还没回来：先把整墙用骨架卡铺满，不留空白 */
  api.pending=()=>{
    if(songs.length) return;
    expanded=-1; prevExpanded=-1;
    build();
    cam.scale=fitScale(); cam.x=0; cam.y=0;
    clampCam(); applyCam(false);
  };
  api.onSongs=()=>{
    if(!document.body.classList.contains("folia")) return;
    build();
    // 榜单切换后墙面高度会变，重新保证铺满
    cam.scale=fitScale();
    if(expanded>=0) panTo(expanded,false); else applyCam(false);
    setWallTone(currentIdx>=0 && songs[currentIdx] ? songs[currentIdx].pic : "");
  };
  api.onSong=()=>{
    if(!document.body.classList.contains("folia")) return;
    if(expanded<0 || expanded!==currentIdx){ expanded=currentIdx; build(); panTo(expanded); }
    setWallTone(songs[currentIdx] ? songs[currentIdx].pic : "");
    if(zoomOpen) openZoom(currentIdx);
    sync();
  };
  api.sync=sync;
  return api;
})();

function applyView(){
  document.body.classList.toggle("folia", foliaView);
  viewToggle.innerHTML = foliaView ? iconSvg('i-menu',16)+" 列表" : iconSvg('i-expand',16)+" 沉浸式";
  syncParticles();
  if(foliaView) WALL.open(); else WALL.close();
}
function setFolia(v){
  foliaView=!!v;
  store.set('yy_folia', foliaView);
  applyView();
}
viewToggle.addEventListener("click",()=>setFolia(!foliaView));

/* ---------- State memory ---------- */
function saveState(s, pos){
  store.set('yy_state',{
    id:s.id, name:s.name, artist:s.artist, pic:s.pic||"", url:s.url||"", lrc:s.lrc||"",
    pos: pos||0, vol: audio.volume, mode: playMode, t: Date.now()
  });
}
function tryRestore(){
  if(pendingRestore) return;
  const st = store.get('yy_state',null);
  if(!st || !st.id || !st.name) return;
  pendingRestore = st;
  // 恢复音量和模式
  if(typeof st.vol === "number") applyVolume(st.vol);
  if(typeof st.mode === "number" && st.mode!==playMode){
    playMode = st.mode;
    modeBtn.innerHTML = modeIcons[playMode];
    modeBtn.classList.toggle("active",playMode!==0);
  }
  // 在当前列表里找这首歌
  const idx = songs.findIndex(x=>key(x)===key(st));
  if(idx>=0){
    toast(`继续播放：${st.name}`);
    pendingSeek = st.pos || 0;
    restoring = true;
    playSong(idx);
  }
  pendingRestore = null;
}

/* ---------- Media Session ---------- */
function setMediaSession(s){
  if(!('mediaSession' in navigator)) return;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.name,
      artist: s.artist,
      album: "云音播放器",
      artwork: s.pic ? [{src:s.pic, sizes:"512x512", type:"image/jpeg"}] : []
    });
    navigator.mediaSession.setActionHandler("play",()=>audio.play());
    navigator.mediaSession.setActionHandler("pause",()=>audio.pause());
    navigator.mediaSession.setActionHandler("previoustrack",()=>prevSong());
    navigator.mediaSession.setActionHandler("nexttrack",()=>nextSong());
    navigator.mediaSession.setActionHandler("seekbackward",()=>{audio.currentTime=Math.max(0,audio.currentTime-10)});
    navigator.mediaSession.setActionHandler("seekforward",()=>{audio.currentTime=Math.min(audio.duration||0,audio.currentTime+10)});
    try{ navigator.mediaSession.setActionHandler("seekto",(d)=>{ if(d && d.seekTime!=null && isFinite(d.seekTime)) audio.currentTime = d.seekTime; }); }catch(e){}
  }catch(e){}
}

/* ================= 播放页增强：频谱/EQ · 桌面悬浮歌词 · 歌词分享海报 · 手机端体验 ================= */

/* ---------- 1) 频谱 + EQ（WebAudio） ----------
   音频直链是跨域的：若不支持 CORS，接入 WebAudio 会变静音。
   所以先用 Range 请求探测，探测失败则优雅降级：频谱显示呼吸动画、EQ 提示不可用。 */
const ppSpectrum=document.getElementById("ppSpectrum");
const ppEqBtn=document.getElementById("ppEq");
let AC=null, srcNode=null, eqLow=null, eqMid=null, eqHigh=null, analyser=null, freqData=null;
let graphOK=false, graphBusy=false, specRaf=0;
const EQ_PRESETS=[
  {name:"标准", g:[0,0,0]},
  {name:"流行", g:[2,3,4]},
  {name:"摇滚", g:[5,1,4]},
  {name:"舞曲", g:[7,1,5]},
  {name:"人声", g:[-3,4,2]}
];
let eqIdx=parseInt(store.get("yy_eq","0"),10)||0;
if(!(eqIdx>=0&&eqIdx<EQ_PRESETS.length)) eqIdx=0;

async function tryBuildGraph(){
  if(graphOK||graphBusy) return graphOK;
  if(!audio.src) return false;
  graphBusy=true;
  try{
    const r=await fetch(audio.src,{method:"GET",headers:{Range:"bytes=0-1"},mode:"cors",cache:"no-store"});
    if(!r.ok && r.status!==206) throw new Error("cors");
  }catch(_){ graphBusy=false; return false; }
  try{
    AC=new (window.AudioContext||window.webkitAudioContext)();
    srcNode=AC.createMediaElementSource(audio);
    eqLow=AC.createBiquadFilter();  eqLow.type="lowshelf";   eqLow.frequency.value=140;
    eqMid=AC.createBiquadFilter();  eqMid.type="peaking";    eqMid.frequency.value=1400; eqMid.Q.value=0.8;
    eqHigh=AC.createBiquadFilter(); eqHigh.type="highshelf"; eqHigh.frequency.value=6000;
    analyser=AC.createAnalyser(); analyser.fftSize=128; analyser.smoothingTimeConstant=.82;
    srcNode.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
    eqHigh.connect(analyser); analyser.connect(AC.destination);
    freqData=new Uint8Array(analyser.frequencyBinCount);
    graphOK=true; applyEq();
  }catch(_){ graphOK=false; }
  graphBusy=false;
  return graphOK;
}
function applyEq(){
  if(!graphOK) return;
  const g=EQ_PRESETS[eqIdx].g;
  eqLow.gain.value=g[0]; eqMid.gain.value=g[1]; eqHigh.gain.value=g[2];
  ppEqBtn.textContent = eqIdx ? EQ_PRESETS[eqIdx].name : "EQ";
  ppEqBtn.classList.toggle("on", eqIdx!==0);
}
audio.addEventListener("play",()=>{ if(AC && AC.state==="suspended") AC.resume(); });
ppEqBtn.addEventListener("click",async()=>{
  if(!audio.src){ toast("先播放一首歌"); return; }
  const ok=await tryBuildGraph();
  if(!ok){ toast("当前音源不支持音效/频谱"); return; }
  eqIdx=(eqIdx+1)%EQ_PRESETS.length;
  store.set("yy_eq",String(eqIdx));
  applyEq();
  toast("音效："+EQ_PRESETS[eqIdx].name);
});
let wavePrev=null;
function drawSpectrum(ts){
  specRaf=requestAnimationFrame(drawSpectrum);
  if(!playPage.classList.contains("open")) return;
  const w=ppSpectrum.clientWidth, h=ppSpectrum.clientHeight;
  if(!w||!h) return;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  if(ppSpectrum.width!==Math.round(w*dpr)){ ppSpectrum.width=Math.round(w*dpr); ppSpectrum.height=Math.round(h*dpr); }
  const g=ppSpectrum.getContext("2d");
  g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,w,h);
  const N=48, mid=h/2, maxA=mid-4;
  let vals;
  if(graphOK && analyser && !audio.paused){
    analyser.getByteFrequencyData(freqData);
    vals=new Array(N+1);
    for(let i=0;i<=N;i++){
      const a=Math.floor(Math.pow(i/N,1.7)*(freqData.length-1));
      const b=Math.max(a+1,Math.floor(Math.pow((i+1)/N,1.7)*(freqData.length-1)));
      let m=0; for(let k=a;k<b;k++) m=Math.max(m,freqData[k]);
      vals[i]=m/255;
    }
  }else{
    vals=new Array(N+1);
    const t=(ts||0)/850, amp=audio.paused?.12:.5;
    for(let i=0;i<=N;i++)
      vals[i]=Math.abs(amp*(.25+.2*Math.sin(t+i*.5)+.12*Math.sin(t*2.1+i*1.7)));
  }
  /* 时域平滑 + 两端收口：让波形像透镜一样在两侧闭合 */
  if(!wavePrev||wavePrev.length!==N+1) wavePrev=vals.slice();
  const env=Math.PI/N;
  for(let i=0;i<=N;i++){
    wavePrev[i]=wavePrev[i]*.55+vals[i]*.45;
    vals[i]=wavePrev[i]*Math.pow(Math.sin(i*env),.5);
  }
  const px=i=>i*(w/N);
  /* 上下镜像的平滑闭合曲线 */
  g.beginPath();
  g.moveTo(0,mid);
  for(let i=0;i<N;i++){
    const x0=px(i), a0=vals[i], x1=px(i+1), a1=vals[i+1];
    g.quadraticCurveTo(x0,mid-a0,(x0+x1)/2,mid-(a0+a1)/2);
  }
  g.quadraticCurveTo(px(N),mid-vals[N],w,mid);
  for(let i=N;i>0;i--){
    const x0=px(i), a0=vals[i], x1=px(i-1), a1=vals[i-1];
    g.quadraticCurveTo(x0,mid+a0,(x0+x1)/2,mid+(a0+a1)/2);
  }
  g.quadraticCurveTo(0,mid+vals[0],0,mid);
  g.closePath();
  const grad=g.createLinearGradient(0,mid-maxA,0,mid+maxA);
  grad.addColorStop(0,"rgba(196,181,253,.95)");
  grad.addColorStop(.5,"rgba(167,139,250,.6)");
  grad.addColorStop(1,"rgba(196,181,253,.95)");
  g.save();
  g.shadowColor="rgba(167,139,250,.45)"; g.shadowBlur=10;
  g.fillStyle=grad; g.fill();
  g.restore();
  /* 中线高光：增加精致感 */
  g.strokeStyle="rgba(233,226,255,.35)"; g.lineWidth=1;
  g.beginPath(); g.moveTo(2,mid); g.lineTo(w-2,mid); g.stroke();
}
function startSpectrum(){ ppSpectrum.classList.add("live"); if(!specRaf) specRaf=requestAnimationFrame(drawSpectrum); }
function stopSpectrum(){ if(specRaf){ cancelAnimationFrame(specRaf); specRaf=0; } ppSpectrum.classList.remove("live"); }

/* ---------- 2) 桌面悬浮歌词（Document Picture-in-Picture，Chrome/Edge） ---------- */
const ppPipBtn=document.getElementById("ppPip");
let pipWin=null;
/* 汽水风格：桌面 PiP 窗全透明，只留带阴影描边的歌词文字；普通小窗无法透明，保留深色底 */
function pipHtml(transparent){
  return '<head><title>悬浮歌词</title><style>'+
  'html,body{margin:0;height:100%;background:'+(transparent?"transparent":"#0b0b0d")+
  ';color:#f4f4f5;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}'+
  'body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:'+(transparent?"5px":"8px")+';padding:12px}'+
  '.sub{font-size:11px;letter-spacing:.5px;max-width:95%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:'+
  (transparent?"rgba(255,255,255,.72)":"#a1a1aa")+';text-shadow:0 1px 6px rgba(0,0,0,.85)}'+
  '.line{font-size:20px;font-weight:800;color:#fff;text-align:center;line-height:1.4;max-width:95%;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;'+
  (transparent?"text-shadow:0 0 3px rgba(0,0,0,.9),0 2px 14px rgba(0,0,0,.85)":"color:#c4b5fd")+'}'+
  '</style></head>'+
  '<body><div class="sub" id="psub"></div><div class="line" id="pline">♪ 云音</div></body>';
}
function pipSetup(w, transparent){
  pipWin=w;
  w.document.documentElement.innerHTML=pipHtml(transparent);
  w.addEventListener("pagehide",()=>{ pipWin=null; ppPipBtn.classList.remove("on"); });
  ppPipBtn.classList.add("on");
  pipSync(lastLrcIdx);
}
ppPipBtn.addEventListener("click",async()=>{
  if(pipWin){ try{pipWin.close()}catch(_){} pipWin=null; ppPipBtn.classList.remove("on"); return; }
  if(currentIdx<0){ toast("先播放一首歌"); return; }
  const dpi=window.documentPictureInPicture;
  if(dpi && typeof dpi.open==="function"){
    try{ pipSetup(await dpi.open({width:430,height:150}), true); return; }
    catch(e){ console.warn("DocPiP fail:",e); toast("桌面悬浮窗失败（"+((e&&e.name)||e)+"），改用普通小窗"); }
  }
  /* 兜底：普通弹出小窗，所有桌面浏览器可用，歌词同样实时同步 */
  const fine=window.matchMedia && window.matchMedia("(pointer:fine)").matches;
  if(!fine){ toast("悬浮歌词需桌面 Chrome/Edge/Firefox"); return; }
  const w=window.open("","yy_pip","width=430,height=170,left=90,top=90");
  if(!w){ toast("小窗被浏览器拦截，请允许本站弹出窗口后重试"); return; }
  pipSetup(w, false);
});
function pipSync(idx){
  if(!pipWin) return;
  let d=null;
  try{ d=pipWin.document; }catch(_){ return; }
  if(!d||!d.getElementById) return;
  const s=songs[currentIdx];
  const sub=d.getElementById("psub"), line=d.getElementById("pline");
  if(sub) sub.textContent = s ? (s.name+" · "+s.artist) : "";
  if(line) line.textContent = (idx>=0&&lyrics[idx]) ? lyrics[idx].content : (s? "♪ "+s.name : "♪ 云音");
}

/* ---------- 3) 歌词分享海报（汽水同款：封面+当前歌词段，系统分享或下载） ---------- */
const ppPosterBtn=document.getElementById("ppPoster");
function loadImgCors(url){
  return new Promise((res,rej)=>{
    const im=new Image(); im.crossOrigin="anonymous";
    im.onload=()=>res(im); im.onerror=rej; im.src=url;
  });
}
function rrPath(g,x,y,w,h,r){
  g.beginPath();
  if(g.roundRect){ g.roundRect(x,y,w,h,r); return; }
  g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r);
  g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath();
}
function clipTxt(t,n){ t=t||""; return t.length>n? t.slice(0,n-1)+"…" : t; }
async function makePoster(){
  if(currentIdx<0){ toast("先播放一首歌"); return; }
  const s=songs[currentIdx];
  toast("正在生成海报…");
  let cover=null;
  if(s.pic){ try{ cover=await loadImgCors(thumbUrl(s.pic,640)); }catch(_){} }
  const W=750,H=1000,dpr=2;
  const c=document.createElement("canvas"); c.width=W*dpr; c.height=H*dpr;
  const g=c.getContext("2d"); g.scale(dpr,dpr);
  const FF="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
  /* 背景：封面模糊放大，取不到封面就纯渐变 */
  g.fillStyle="#0b0b0d"; g.fillRect(0,0,W,H);
  if(cover){
    try{ g.filter="blur(46px) brightness(.45) saturate(1.3)"; }catch(_){}
    const cw=Math.max(W,H*.9);
    g.drawImage(cover,(W-cw)/2,(H-cw)/2-60,cw,cw);
    g.filter="none";
    g.fillStyle="rgba(11,11,13,.62)"; g.fillRect(0,0,W,H);
  }else{
    const gr=g.createLinearGradient(0,0,W,H);
    gr.addColorStop(0,"#1c1533"); gr.addColorStop(1,"#0b0b0d");
    g.fillStyle=gr; g.fillRect(0,0,W,H);
  }
  /* 封面卡：大圆角 + 悬浮阴影 */
  const CS=360,CX=(W-CS)/2,CY=90;
  if(cover){
    g.save();
    g.shadowColor="rgba(0,0,0,.55)"; g.shadowBlur=48; g.shadowOffsetY=20;
    rrPath(g,CX,CY,CS,CS,32); g.fillStyle="#0b0b0d"; g.fill();
    g.restore();
    g.save(); rrPath(g,CX,CY,CS,CS,32); g.clip();
    g.drawImage(cover,CX,CY,CS,CS); g.restore();
    g.strokeStyle="rgba(255,255,255,.16)"; g.lineWidth=1.5; rrPath(g,CX,CY,CS,CS,32); g.stroke();
  }
  /* 歌名/歌手 */
  g.textAlign="center";
  g.fillStyle="#f4f4f5"; g.font="800 40px "+FF;
  g.fillText(clipTxt(s.name,16),W/2,CY+CS+64,W-100);
  g.fillStyle="rgba(244,244,245,.6)"; g.font="400 24px "+FF;
  g.fillText(clipTxt(s.artist,20),W/2,CY+CS+102,W-120);
  /* 播放进度条：还原真实播放状态 */
  const PW=460,PX=(W-PW)/2,PY=CY+CS+148;
  const dur=audio.duration>0?audio.duration:(s.dur/1000||0);
  const cur=Math.min(audio.currentTime||0,dur);
  const ratio=dur>0?Math.min(1,cur/dur):0;
  g.fillStyle="rgba(244,244,245,.16)"; rrPath(g,PX,PY,PW,8,4); g.fill();
  if(ratio>0){
    const pg=g.createLinearGradient(PX,0,PX+PW,0);
    pg.addColorStop(0,"#a78bfa"); pg.addColorStop(1,"#c4b5fd");
    g.fillStyle=pg; rrPath(g,PX,PY,Math.max(16,PW*ratio),8,4); g.fill();
  }
  g.beginPath(); g.arc(PX+PW*ratio,PY+4,9,0,Math.PI*2);
  g.fillStyle="#e9e2ff"; g.fill();
  g.fillStyle="rgba(244,244,245,.55)"; g.font="400 20px "+FF;
  g.textAlign="left";  g.fillText(fmt(cur),PX,PY+42);
  g.textAlign="right"; g.fillText(fmt(dur),PX+PW,PY+42);
  g.textAlign="center";
  /* 歌词：当前行上下各两行，当前行高亮 */
  let yy=CY+CS+236;
  if(lyrics.length){
    const ci=Math.max(0,lastLrcIdx);
    for(let i=ci-2;i<=ci+2;i++){
      if(!lyrics[i]) continue;
      const cur=i===ci;
      g.fillStyle=cur?"#c4b5fd":"rgba(244,244,245,.42)";
      g.font=(cur?"700 31px ":"400 27px ")+FF;
      g.fillText(clipTxt(lyrics[i].content,18),W/2,yy,W-120);
      yy+=cur?58:50;
    }
  }else{
    g.fillStyle="rgba(244,244,245,.5)"; g.font="400 27px "+FF;
    g.fillText("♪ 好音乐，值得被听见",W/2,yy);
  }
  /* 页脚 */
  g.fillStyle="rgba(244,244,245,.38)"; g.font="400 20px "+FF;
  g.fillText("云音 · yunyin-music.github.io",W/2,H-46);
  /* 输出：优先系统分享（手机可直接存图/发微信），否则下载 */
  c.toBlob(blob=>{
    if(!blob){ toast("海报生成失败"); return; }
    const file=new File([blob],(s.name||"云音海报")+".png",{type:"image/png"});
    if(navigator.canShare && navigator.canShare({files:[file]})){
      navigator.share({files:[file],title:s.name}).catch(()=>{});
      return;
    }
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download="云音-歌词海报.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
    toast("海报已保存，可在下载/相册中分享");
  },"image/png");
}
ppPosterBtn.addEventListener("click",makePoster);
/* 长按播放页歌词区直接出海报（汽水交互） */
let lrcHold=0;
ppLrcTrack.addEventListener("touchstart",()=>{ clearTimeout(lrcHold); lrcHold=setTimeout(()=>{lrcHold=0; makePoster();},650); },{passive:true});
ppLrcTrack.addEventListener("touchmove",()=>clearTimeout(lrcHold),{passive:true});
ppLrcTrack.addEventListener("touchend",()=>clearTimeout(lrcHold));

/* ---------- 4) 手机端体验：耳机拔出暂停 · 播放页下滑关闭（切歌震动在 playSong 里） ---------- */
document.addEventListener("headphonejackinterrupted",()=>{
  if(!audio.paused){ audio.pause(); toast("耳机已拔出，自动暂停"); }
});
(function(){
  const head=document.querySelector(".pp-head");
  if(!head) return;
  let sy=0,dy=0,on=false;
  head.addEventListener("touchstart",e=>{
    if(e.target.closest(".pp-act")) return;
    sy=e.touches[0].clientY; dy=0; on=true;
    playPage.classList.add("dragging");
  },{passive:true});
  head.addEventListener("touchmove",e=>{
    if(!on) return;
    dy=Math.max(0,e.touches[0].clientY-sy);
    if(dy>0) playPage.style.transform="translateY("+dy+"px)";
  },{passive:true});
  const end=()=>{
    if(!on) return; on=false;
    playPage.classList.remove("dragging");
    if(dy>110){
      closePlayPage();
      setTimeout(()=>{ playPage.style.transform=""; },560);
    }else playPage.style.transform="";
  };
  head.addEventListener("touchend",end);
  head.addEventListener("touchcancel",end);
})();

/* ---------- 每日推荐 ---------- */
async function openDaily(){
  const today = new Date().toISOString().slice(0,10);
  const cached = store.get('yy_daily', null);
  let daily = null;
  if(cached && cached.date===today && Array.isArray(cached.songs) && cached.songs.length>=20){
    daily = cached.songs;
  }
  if(!daily){
    try{
      // 候选池：收藏 + 历史（按 id 去重）
      const pool = new Map();
      const add = (s, rank)=>{
        if(!s || !s.name) return;
        const k = key(s);
        const old = pool.get(k);
        if(old){
          if(rank!=null && (old.rank==null || rank<old.rank)) old.rank = rank;
        }else{
          pool.set(k,{s,rank:rank==null?null:rank});
        }
      };
      favs.concat(history).forEach(s=>add(s,null));
      // 并行取前 3 个榜单，每榜前 60 首
      await Promise.all(CHARTS.slice(0,3).map(async c=>{
        try{
          const list = await fetchPlaylist(c.id);
          if(Array.isArray(list)) list.slice(0,60).forEach((s,i)=>add(s,i+1));
        }catch(e){}
      }));
      if(!pool.size){ toast("每日推荐生成失败，稍后再试"); return; }
      // 歌手偏好集合（"A / B" 拆开匹配）
      const favArtists = new Set(), histArtists = new Set();
      const collect = (set,arr)=>arr.forEach(x=>String(x.artist||"").split(/\s*[/、]\s*/).forEach(a=>{ if(a) set.add(a); }));
      collect(favArtists,favs); collect(histArtists,history);
      const hit = (set,artist)=>String(artist||"").split(/\s*[/、]\s*/).some(a=>a && set.has(a));
      // 当天日期做种子的 LCG + 歌曲 key 哈希，保证同一天多次生成结果一致（与请求返回顺序无关）
      let seed = parseInt(today.replace(/-/g,""),10) || 1;
      const jitter = (k)=>{
        let h = seed;
        for(let c=0;c<k.length;c++) h = (h*31 + k.charCodeAt(c)) % 2147483647;
        h = (h*48271) % 2147483647;
        return h/2147483647*3 - 1.5;   // 确定性伪随机扰动 ±1.5
      };
      const ranked = [...pool.entries()].map(([k,e])=>{
        let sc = 0;
        if(hit(favArtists,e.s.artist)) sc += 3;
        if(hit(histArtists,e.s.artist)) sc += 2;
        if(e.rank!=null) sc += (60-e.rank)/20;
        sc += jitter(k);
        return {s:e.s, sc};
      }).sort((a,b)=>b.sc-a.sc);
      daily = ranked.slice(0,30).map(x=>x.s); // 候选不足 30 时自然取全部
      store.set('yy_daily',{date:today, songs:daily});
    }catch(e){
      toast("每日推荐生成失败，稍后再试");
      return;
    }
  }
  // 渲染：复用榜单列表渲染路径
  listMode = 'daily'; fmMode = false; currentChart = null; currentIdx = -1;
  setActiveNav("daily");
  clearBtn.style.display = "none";
  chartTitle.textContent = "每日推荐";
  chartDesc.textContent = "为你精选 · 每天更新";
  chartTag.textContent = "DAILY";
  chartTag.style.display = "";
  chartCover.innerHTML = iconSvg('i-sparkle',38);
  chartCover.style.background = "linear-gradient(135deg,#f7e2d5,#e0a07a)";
  songs = daily.slice();
  renderSongs();
}
navDaily.addEventListener("click",()=>openDaily());

/* ---------- 播放队列：关闭 / 下一首播放 / 移除 ---------- */
function closeQueuePanel(){
  currentQueueOpen = false;
  queuePanel.classList.remove("open");
  qMask.classList.remove("show");
}
function queueMoveNext(i){
  if(i<0 || i>=songs.length) return;
  if(currentIdx>=0 && (i===currentIdx || i===currentIdx+1)){ toast("已是下一首"); return; }
  const item = songs.splice(i,1)[0];
  if(i<currentIdx) currentIdx--;
  const at = Math.min(currentIdx+1, songs.length);
  songs.splice(at,0,item);
  renderQueue();
  renderSongs();
}
function queueRemove(i){
  if(i<0 || i>=songs.length) return;
  const wasCur = i===currentIdx;
  songs.splice(i,1);
  if(i<currentIdx) currentIdx--;
  if(wasCur){
    if(!songs.length){
      // 队列已空：停止播放并复位
      try{ audio.pause(); }catch(e){}
      try{ audio.removeAttribute("src"); audio.load(); }catch(e){}
      currentIdx = -1;
      setPlaying(false);
      renderQueue();
      renderSongs();
      toast("队列已清空");
      return;
    }
    if(currentIdx>=songs.length) currentIdx = songs.length-1;
    playSong(currentIdx); // 仅在移除当前项时续播，避免其它操作卡顿
  }else{
    renderQueue();
    renderSongs();
  }
}
// 打开时同步遮罩，并把当前行滚到可视中间
queueToggle.addEventListener("click",()=>{
  qMask.classList.toggle("show", currentQueueOpen);
  if(currentQueueOpen){
    requestAnimationFrame(()=>{
      const cur = qList.querySelector(".q-row.playing");
      if(cur) cur.scrollIntoView({block:"center"});
    });
  }
});
qClose.addEventListener("click",()=>qMask.classList.remove("show"));
qMask.addEventListener("click",closeQueuePanel);
// Esc 关闭队列时一并收起遮罩（播放页优先，避免误关）
document.addEventListener("keydown",(e)=>{
  if(e.code==="Escape" && !playPage.classList.contains("open") && qMask.classList.contains("show")) closeQueuePanel();
});

/* ---------- 手机手势：左右切歌 / 上下切歌词-评论 ---------- */
(function(){
  let sx=0, sy=0, active=false, fired=false;
  playPage.addEventListener("touchstart",(e)=>{
    if(!playPage.classList.contains("open")) return;
    if(e.touches.length!==1) return;
    // 头部下滑关闭、按钮、歌词/评论列表不参与，避免手势冲突
    if(e.target.closest(".pp-head, .pp-acts, .pp-btns, button, input, .q-list")) return;
    sx=e.touches[0].clientX; sy=e.touches[0].clientY;
    active=true; fired=false;
  },{passive:true});
  playPage.addEventListener("touchend",(e)=>{
    if(!active) return;
    active=false;
    if(fired) return;
    if(!playPage.classList.contains("open")) return;
    const t=(e.changedTouches && e.changedTouches[0]) || null;
    if(!t) return;
    const dx=t.clientX-sx, dy=t.clientY-sy;
    if(Math.abs(dx)>70 && Math.abs(dx)>Math.abs(dy)*1.5){
      fired=true;
      if(dx<0) nextSong(); else prevSong();
      try{ navigator.vibrate && navigator.vibrate(10); }catch(_){}
      toast(dx<0 ? "下一首" : "上一首");
    }else if(Math.abs(dy)>70 && Math.abs(dy)>Math.abs(dx)*1.5){
      fired=true;
      switchPpTab(dy<0 ? "cmt" : "lrc");
    }
  },{passive:true});
  playPage.addEventListener("touchcancel",()=>{ active=false; fired=false; },{passive:true});
})();

/* ---------- PWA ---------- */
if('serviceWorker' in navigator && location.protocol==='https:'){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
  // 新 SW 接管后自动刷新一次，避免手机端一直停留在旧版本（修复"唱片打不开播放页"等版本滞后问题）
  // 仅在已有旧 SW 控制的会话才监听：首次访问内容由网络直接返回，无需重载
  if(navigator.serviceWorker.controller){
    let __yyReloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", ()=>{
      if(__yyReloaded) return;
      __yyReloaded = true;
      location.reload();
    });
  }
}

/* ---------- Init ---------- */
renderCharts();
renderWall();
// 启动：恢复上次的视图模式（列表/沉浸），再加载默认榜单
applyView();
loadChart(0);

/* ---------- 网络自检诊断 ----------
   在播放队列面板中一键检测各音源通道可用性，定位"加载失败"是接口限流还是网络问题 */
const diagBtn = document.getElementById("qDiag");
const diagBox = document.getElementById("diagBox");
/* 单项探测：统一计时 + 异常兜底，>2.5s 视为慢 */
async function diagProbe(name, fn){
  const t0 = performance.now();
  try{
    const r = await fn();
    const ms = Math.round(performance.now()-t0);
    return { name, ok:!!r.ok, slow: r.ok && ms>2500, msg: r.msg||"", ms };
  }catch(e){
    return { name, ok:false, slow:false, msg:(e&&e.message)||"请求失败", ms:Math.round(performance.now()-t0) };
  }
}
/* 官方接口经单个代理探测：轻量搜索请求 */
async function diagProxy(px){
  const target = NET + "/api/search/get?s=" + encodeURIComponent("周杰伦") + "&type=1&limit=1";
  const r = await fetchTimeout(px(target), 8000);
  if(!r || !r.ok) return { ok:false, msg:"HTTP "+((r&&r.status)||"无响应") };
  const d = await r.json().catch(()=>null);
  const n = d && d.result && Array.isArray(d.result.songs) && d.result.songs.length;
  return n ? { ok:true, msg:"可用" } : { ok:false, msg:"返回数据异常" };
}
async function runDiag(){
  diagBox.hidden = false;
  diagBox.innerHTML = '<div class="dg-row dg-run">检测中，请稍候…</div>';
  const s = songs[currentIdx] || songs[0] || {};
  const id = String(s.id || metingId(s.url) || "");
  const rs = await Promise.all([
    diagProbe("vkeys 直链接口", async()=>{
      if(!id) return { ok:false, msg:"队列为空，跳过" };
      const r = await fetchTimeout(`https://api.vkeys.cn/v2/music/netease?id=${id}`, 6000);
      if(!r || !r.ok) return { ok:false, msg:"HTTP "+((r&&r.status)||"无响应") };
      const d = await r.json().catch(()=>null);
      const u = d && d.data && d.data.url;
      return (u && neteaseOnly(u)) ? { ok:true, msg:"可解析直链" } : { ok:false, msg:"未返回有效音源" };
    }),
    diagProbe("injahow 中转", async()=>{
      if(!id) return { ok:false, msg:"队列为空，跳过" };
      const r = await fetchTimeout(`${API}?type=url&id=${id}&server=netease`, 6000);
      if(!r) return { ok:false, msg:"无响应" };
      const t = await r.text();
      let m = "";
      try{ m = String((JSON.parse(t)||{}).message||""); }
      catch(e){ return { ok:r.ok, msg: r.ok ? "返回非 JSON" : "HTTP "+r.status }; }
      if(/上限|limit/i.test(m)) return { ok:false, msg:"当日额度已用完" };
      return { ok:!m, msg: m || "正常" };
    }),
    diagProbe("官方接口 · allorigins", ()=>diagProxy(NET_PROXIES[0])),
    diagProbe("官方接口 · cors.eu.org", ()=>diagProxy(NET_PROXIES[1])),
    diagProbe("官方接口 · codetabs", ()=>diagProxy(NET_PROXIES[2])),
    diagProbe("静态兜底数据", async()=>{
      const r = await fetchTimeout("./chart-fallback.json?v=1", 6000);
      if(!r || !r.ok) return { ok:false, msg:"HTTP "+((r&&r.status)||"无响应") };
      const d = await r.json().catch(()=>null);
      return (d && Object.keys(d).length) ? { ok:true, msg:"可用" } : { ok:false, msg:"数据为空" };
    }),
    diagProbe("音频直链连通", async()=>{
      if(!id) return { ok:false, msg:"队列为空，跳过" };
      const u = await ensurePlayUrl(s);
      if(!u) return { ok:false, msg:"无法解析播放地址" };
      try{
        const r = await fetch(u, { method:"GET", headers:{Range:"bytes=0-1"}, cache:"no-store" });
        if(r && (r.status===200 || r.status===206)) return { ok:true, msg:"可连接" };
        return { ok:false, msg:"HTTP "+((r&&r.status)||"异常") };
      }catch(e){
        // CORS 读取被拒时降级 no-cors 探测，仅验证网络可达
        try{ await fetch(u, { mode:"no-cors", cache:"no-store" }); return { ok:true, msg:"可连接" }; }
        catch(e2){ return { ok:false, msg:"无法连接" }; }
      }
    }),
  ]);
  diagBox.innerHTML = rs.map(r=>{
    const cls = r.ok ? (r.slow?"dg-slow":"dg-ok") : "dg-bad";
    const icon = r.ok ? (r.slow?"!":"✓") : "✗";
    return `<div class="dg-row"><span class="dg-dot ${cls}">${icon}</span>`+
      `<span class="dg-name">${escHtml(r.name)}</span>`+
      `<span class="dg-msg">${escHtml(r.msg)}</span>`+
      `<span class="dg-ms">${r.ms}ms</span></div>`;
  }).join("") + `<div class="dg-foot">检测时间 ${new Date().toLocaleTimeString()}</div>`;
}
diagBtn.addEventListener("click",()=>{
  if(!diagBox.hidden){ diagBox.hidden = true; return; }
  runDiag();
});
