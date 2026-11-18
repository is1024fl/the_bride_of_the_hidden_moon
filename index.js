/*
=========================================================================
設定：Supabase Edge Function 網址
=========================================================================
*/
const STORY_API = "https://voldosiyprpqirsvlnmx.functions.supabase.co/story";
const START_NODE_ID = "start";
const ENDINGS_KEY = "vn_endings_v1"; // localStorage key

/*
=========================================================================
素材設定：★ 請依照你實際的資料夾 / 檔名修改這一區 ★
資料庫只會寫代號（例如 "fog"、"walking_at_night"），實際檔案路徑都在這裡
=========================================================================
*/
// 圖片、音效都放在 Supabase Storage 的 public bucket「img」
// （compress_images.py 輸出的 assets/img 裡的內容，整包上傳到這個 bucket）
const STORAGE =
  "https://voldosiyprpqirsvlnmx.supabase.co/storage/v1/object/public/img/";
const IMG_DIR = STORAGE;
const SFX_DIR = STORAGE + "sfx/";

// 產生一組連號檔名：seq("fog", 4) → fog/1.webp、fog/2.webp、fog/3.webp、fog/4.webp
const seq = (folder, count) =>
  Array.from({ length: count }, (_, i) => `${folder}/${i + 1}.webp`);

// 場景圖：每個代號對應一組圖（照順序）
const SCENES = {
  fog: seq("fog", 4), // 霧 1~4
  lantern: seq("lantern", 6), // 燈籠 共 6 張
  squid: seq("squid", 8), // 魷魚人 共 8 張
  footprint: seq("footprint", 3), // 腳印 共 3 張
  handprint: ["handprint/1.webp"], // 手印1
  bloodprint: ["handprint/blood.webp"], // 手印資料夾中的血印
  smile: ["kim/1.webp"], // 金率音笑的畫面（合併.jpg）
  door: seq("door", 3), // 門 共 3 張
  wine: seq("wine", 21), // 酒 共 21 張
  glass: seq("glass", 2), // 玻璃、玻璃2
};

// 音效：代號 → 檔名
const SOUNDS = {
  slap: "slap_in_the_face.mp3",
  walking_at_night: "walking_at_night.mp3",
  breath: "long_single_breath_trough_mouth.mp3",
  whoosh: "whoosh_clothing_drag.mp3",
  mountain_road: "mountain_road.mp3",
  splat: "splat_sounds.mp3",
  door_open: "door_open.mp3",
  drinking1: "drinking1.mp3",
  glass_break: "glass_breaking.mp3",
  white_noise: "white_noise2.mp3",
};
const SFX_VOLUME = 0.8;

/*
=========================================================================
全域變數
=========================================================================
*/
let skip = false,
  typing = false;
let sessionId = null;
let currentNode = null;
let loading = false;
let requestToken = 0;
let userMuted = false; // 玩家自己按了靜音（不是被瀏覽器擋掉自動播放）
const $ = (id) => document.getElementById(id);

// 每一格都重新套用的文字 / 畫面效果
const EFFECT_MAP = {
  dim: { target: "frame", className: "fx-dim" },
  "ghost-font": { target: "dialog", className: "fx-ghost-font" },
};

// 跟著場景走的效果：下一格沒有指定新場景時會保留
const SCENE_FX = {
  sway: { target: "bg-layer", className: "fx-sway" }, // 左右微微晃動
  "push-in": { target: "stage", className: "fx-push-in" }, // 畫面往前推
};

/*
=========================================================================
helper function
=========================================================================
*/
// 音效控制
function updateBgmIcon() {
  $("bgmBtn").textContent = $("bgm").paused ? "♪̸" : "♪";
}

// 分段預先下載場景圖：只下載「接下來可能用到」的圖，不浪費流量
// 頁面一打開先下載開場用的圖；玩家選了 B / C / D，才下載那條線的圖
const PRELOAD_GROUPS = {
  opening: ["fog", "lantern", "squid"],
  b: ["handprint", "footprint", "smile", "bloodprint"],
  c: ["door", "wine", "glass"],
  d: ["door"],
};
const preloadedGroups = new Set();

function preloadGroup(key) {
  const sets = PRELOAD_GROUPS[key];
  if (!sets || preloadedGroups.has(key)) return;
  preloadedGroups.add(key);
  const urls = [...new Set(sets.flatMap((s) => SCENES[s] || []))];
  let i = 0;
  const next = () => {
    if (i >= urls.length) return;
    const img = new Image();
    img.onload = img.onerror = next;
    img.src = IMG_DIR + urls[i++];
  };
  for (let k = 0; k < 4; k++) next(); // 同時下載 4 張
}
window.addEventListener("load", () => preloadGroup("opening"));

document.addEventListener("DOMContentLoaded", () => {
  $("bgm")
    .play()
    .catch((error) => {
      console.log("瀏覽器已封鎖自動播放，需要使用者互動。");
      updateBgmIcon();
    });
});

// 切換播放與暫停
$("bgmBtn").addEventListener("click", () => {
  if ($("bgm").paused) {
    $("bgm").play();
    userMuted = false;
  } else {
    $("bgm").pause();
    userMuted = true;
    stopSounds(); // 靜音時音效也一起停
  }
  updateBgmIcon();
});

// 把 *粗體* 語法轉成「每個字要不要套粗體」的清單，星號本身不會被打出來
// 想顯示星號本身時寫成 \*
function parseInlineMarkup(text) {
  const tokens = [];
  let bold = false;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\\" && chars[i + 1] === "*") {
      tokens.push({ ch: "*", bold }); // 跳脫的星號：照原樣顯示
      i++;
      continue;
    }
    if (ch === "*") {
      bold = !bold; // 星號只用來切換狀態，不進入輸出內容
      continue;
    }
    tokens.push({ ch, bold });
  }
  return tokens;
}

// 打字機：回傳 Promise；點擊可跳過；支援 *文字* 顯示為粗體
// onProgress(n)：每打出一個字就回報目前打到第幾個字（給音效時間點用）
function typewriter(el, rawText, speed = 55, onProgress) {
  return new Promise((res) => {
    typing = true;
    skip = false;
    el.innerHTML = "";

    const tokens = parseInlineMarkup(rawText);
    let i = 0;
    let boldEl = null; // 目前正在輸出的粗體區塊（沒有就是 null，代表輸出到最外層）

    const cur = document.createElement("span");
    cur.className = "cursor";
    el.appendChild(cur);

    const appendChar = (ch, bold) => {
      if (bold) {
        if (!boldEl) {
          boldEl = document.createElement("strong");
          boldEl.className = "tw-bold";
          el.insertBefore(boldEl, cur);
        }
        boldEl.appendChild(document.createTextNode(ch));
      } else {
        boldEl = null;
        el.insertBefore(document.createTextNode(ch), cur);
      }
    };

    // 跳過動畫時，一次把全部文字（含粗體格式）畫出來，不是純文字
    const revealAll = () => {
      el.innerHTML = "";
      let wrap = null;
      tokens.forEach(({ ch, bold }) => {
        if (bold) {
          if (!wrap) {
            wrap = document.createElement("strong");
            wrap.className = "tw-bold";
            el.appendChild(wrap);
          }
          wrap.appendChild(document.createTextNode(ch));
        } else {
          wrap = null;
          el.appendChild(document.createTextNode(ch));
        }
      });
      el.appendChild(cur);
    };

    const step = () => {
      if (skip) {
        revealAll();
        if (onProgress) onProgress(tokens.length);
        finish();
        return;
      }
      if (i < tokens.length) {
        const { ch, bold } = tokens[i++];
        appendChar(ch, bold);
        if (onProgress) onProgress(i);
        setTimeout(
          step,
          ch === "，" || ch === "。" || ch === "——" ? speed * 6 : speed,
        );
      } else finish();
    };
    const finish = () => {
      typing = false;
      setTimeout(() => cur.remove(), 400);
      res();
    };
    step();
  });
}

/*
=========================================================================
引擎
=========================================================================
*/
const screens = ["cover", "intro", "ending", "gallery", "credits"];

function show(name) {
  screens.forEach((s) => $("sc-" + s).classList.remove("on"));
  $("sc-" + name).classList.add("on");
  $("restartBtn").style.display = name === "cover" ? "none" : "flex";
  if (name !== "intro") {
    // 離開遊戲畫面時清掉殘留效果
    applyEffects([]);
    resetNodeFx();
    clearScene();
  }
}

// 開始新的一局
async function beginGame() {
  // 自動播放被擋掉的話，趁玩家按「進入怪談」這次點擊把音樂補播
  if (!userMuted && $("bgm").paused) {
    $("bgm")
      .play()
      .then(updateBgmIcon)
      .catch(() => {});
  }
  clearScene();
  show("intro");
  $("choices").innerHTML = "";
  $("choices").classList.remove("show");
  $("introHint").classList.remove("show");
  try {
    const { session_id } = await callStoryApi({ action: "new_session" });
    sessionId = session_id;
  } catch (e) {
    sessionId = null; // API 掛掉也讓遊戲能玩，只是不記錄
  }
  loadNode(START_NODE_ID);
}

// 讀取單一節點並播放
async function loadNode(nodeId) {
  if (loading) return; // 上一格還在讀取中，忽略這次點擊，避免重複觸發
  loading = true;
  preloadGroup(nodeId[0]); // 進入 b001 / c001 / d001 時，開始下載那條線的圖
  const myToken = ++requestToken; // 這次請求的序號，用來辨識「是不是最新這次點擊」

  $("choices").innerHTML = "";
  $("choices").classList.remove("show");
  $("introHint").classList.remove("show");

  let node;
  try {
    node = await callStoryApi({
      action: "get_node",
      node_id: nodeId,
      session_id: sessionId,
    });
  } catch (e) {
    if (myToken === requestToken) {
      $("introText").textContent = "（連線失敗，請稍後再試）";
    }
    loading = false;
    return;
  }

  // 如果在等待期間，使用者又觸發了更新的請求，這次的結果就是過期的，直接丟棄
  if (myToken !== requestToken) return;

  currentNode = node;
  applyEffects(node.effect);
  const onProgress = runNodeFx(node.effect, node.text || "");

  await typewriter($("introText"), node.text || "", 55, onProgress);

  // 打字結束後也要再檢查一次，避免打字這段期間又有更新的請求蓋過來
  if (myToken !== requestToken) return;

  loading = false;

  if (node.isEnding) {
    const isNew = saveEnding(node.ending);
    if (isNew) showToast("解鎖新結局");
    renderEnding(node.ending);
    return;
  }

  if (node.choices && node.choices.length > 0) {
    renderChoices(node.choices);
  } else if (node.autoNext) {
    $("introHint").classList.add("show");
  }
}

function renderChoices(choices) {
  const box = $("choices");
  box.innerHTML = "";
  choices.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = c.label;
    if (c.disabled || !c.next) {
      btn.disabled = true; // 暫未開放的選項：顯示但不能點
    } else {
      btn.onclick = () => loadNode(c.next);
    }
    box.appendChild(btn);
  });
  requestAnimationFrame(() => box.classList.add("show"));
}

function renderEnding(ending) {
  $("endingTitle").textContent = ending.title || "";
  $("endingDesc").textContent = ending.desc || "";
  show("ending");
}

function renderGallery() {
  const grid = $("galleryGrid");
  const unlocked = getUnlockedEndings();
  const keys = Object.keys(unlocked);
  grid.innerHTML = "";

  $("galleryCount").textContent = keys.length
    ? `已發現 ${keys.length} 個結局`
    : "尚未發現任何結局";

  if (keys.length === 0) {
    const p = document.createElement("p");
    p.className = "gallery-count";
    p.textContent = "去遊戲裡找找看吧。";
    grid.appendChild(p);
    return;
  }

  keys.forEach((k) => {
    const e = unlocked[k];
    const card = document.createElement("div");
    card.className = "ending-card";
    card.innerHTML = `<div class="name">${e.title}</div><div class="desc">${e.desc}</div>`;
    grid.appendChild(card);
  });
}

/*
=========================================================================
互動綁定
=========================================================================
*/
$("restartBtn").onclick = () => location.reload();
$("startBtn").onclick = () => beginGame();
$("galleryBtn").onclick = () => {
  renderGallery();
  show("gallery");
};
$("galleryBackBtn").onclick = () => show("cover");
$("endingGalleryBtn").onclick = () => {
  renderGallery();
  show("gallery");
};
$("endingReplayBtn").onclick = () => show("cover");
$("creditsBtn").onclick = () => show("credits");
$("creditsBackBtn").onclick = () => show("cover");

// 點擊畫面：正在打字就跳過；沒有選項但有 autoNext 就繼續播下一格
$("sc-intro").addEventListener("click", (e) => {
  if (e.target.closest(".choices")) return; // 不要吃掉選項按鈕的點擊
  if (typing) {
    skip = true;
    return;
  }
  if (currentNode && currentNode.autoNext && !currentNode.isEnding) {
    loadNode(currentNode.autoNext);
  }
});

/*
=========================================================================
資料收集統計
=========================================================================
*/
// 呼叫後端唯一入口
async function callStoryApi(payload) {
  const res = await fetch(STORY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("story api error " + res.status);
  return res.json();
}

// 本機結局收藏
function getUnlockedEndings() {
  try {
    return JSON.parse(localStorage.getItem(ENDINGS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveEnding(ending) {
  const all = getUnlockedEndings();
  const isNew = !all[ending.key];
  all[ending.key] = { title: ending.title, desc: ending.desc };
  localStorage.setItem(ENDINGS_KEY, JSON.stringify(all));
  return isNew;
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

/*
=========================================================================
節點效果：文字效果（每格重設）
=========================================================================
*/
function applyEffects(effectList) {
  const frame = $("frame");
  const dialog = $("introText");

  // 先清掉上一格留下的效果，避免疊加殘留
  Object.values(EFFECT_MAP).forEach(({ target, className }) => {
    (target === "frame" ? frame : dialog).classList.remove(className);
  });

  (effectList || []).forEach((key) => {
    if (typeof key !== "string") return; // 場景、音效物件交給 runNodeFx 處理
    const conf = EFFECT_MAP[key];
    if (!conf) return; // 資料庫填了未知效果名稱時，安全忽略，不讓畫面壞掉
    (conf.target === "frame" ? frame : dialog).classList.add(conf.className);
  });
}

/*
=========================================================================
節點效果：場景圖、畫面特效、音效
-------------------------------------------------------------------------
effect 欄位是一個陣列，可以混用：
  字串  "sway"        左右微微晃動（跟著場景保留）
        "push-in"     畫面往前推（跟著場景保留）
        "flash"       閃一下白光
        "afterimage"  殘影（約 2.4 秒）
        "glitch"      亂碼全屏（到下一格為止）
  物件  {"type":"bg","set":"fog","pick":[0,1,2],"mode":"stack","interval":1200}
          set      SCENES 裡的代號
          pick     "first" / "last" / 數字 / 數字陣列，不填 = 全部
          mode     "stack" = 一張接一張淡入疊上；不填 = 同時出現
          interval stack 時每張間隔毫秒，預設 700
          opacity  透明度 0~1，預設 1
        {"type":"bg","color":"#000"}   純色畫面（黑畫面、白畫面）
        {"type":"sfx","name":"breath","at":"你喘了口氣","duration":900}
          at       打字打到這段文字時才播放；不填 = 一進來就播
          duration 只播前幾毫秒（例如「只用第一聲」）
同一格有任何 bg 或 sway / push-in → 換新場景；都沒有 → 沿用上一格的畫面
=========================================================================
*/
let fxTimers = []; // 這一格排程中的計時器，換格時全部取消
let fxSounds = []; // 這一格正在播的音效
let glitchTimer = null;

function later(fn, ms) {
  fxTimers.push(setTimeout(fn, ms));
}

function stopSounds() {
  fxSounds.forEach((a) => a.pause());
  fxSounds = [];
}

function playSfx(name, duration) {
  if (userMuted) return;
  const file = SOUNDS[name];
  if (!file) return; // 未知代號：安全忽略
  const a = new Audio(SFX_DIR + file);
  a.volume = SFX_VOLUME;
  a.play().catch(() => {});
  fxSounds.push(a);
  if (duration) later(() => a.pause(), duration);
}

// 換格時：停掉上一格的一次性效果（音效、亂碼、排程）
function resetNodeFx() {
  fxTimers.forEach(clearTimeout);
  fxTimers = [];
  stopSounds();
  stopGlitch();
}

// 清空整個場景（離開遊戲畫面、重新開始時）
function clearScene() {
  const layer = $("bg-layer");
  layer.innerHTML = "";
  Object.values(SCENE_FX).forEach(({ target, className }) =>
    $(target).classList.remove(className),
  );
  $("stage").classList.remove("has-bg");
}

function resolveFrames(set, pick) {
  const all = SCENES[set] || [];
  if (pick === undefined || pick === "all") return all;
  if (pick === "first") return all.slice(0, 1);
  if (pick === "last") return all.slice(-1);
  if (typeof pick === "number") return all[pick] ? [all[pick]] : [];
  if (Array.isArray(pick)) return pick.map((i) => all[i]).filter(Boolean);
  return all;
}

function addFrame(src, color, opacity, delay) {
  const el = document.createElement(src ? "img" : "div");
  el.className = "bg-frame";
  el.style.setProperty("--o", opacity);
  if (src) {
    el.alt = "";
    el.src = IMG_DIR + src;
  } else {
    el.style.background = color;
  }
  $("bg-layer").appendChild(el);

  const reveal = () => later(() => el.classList.add("in"), delay);
  if (src && !el.complete) el.addEventListener("load", reveal, { once: true });
  else reveal();
}

function setScene(bgList) {
  const layer = $("bg-layer");
  // 舊畫面淡出後移除
  Array.from(layer.children).forEach((el) => {
    el.classList.remove("in");
    setTimeout(() => el.remove(), 900);
  });

  let delay = 0;
  bgList.forEach((bg) => {
    const opacity = bg.opacity ?? 1;
    if (bg.color) {
      addFrame(null, bg.color, opacity, delay);
      return;
    }
    const frames = resolveFrames(bg.set, bg.pick);
    const interval = bg.interval ?? 700;
    const stack = bg.mode === "stack";
    frames.forEach((src, i) =>
      addFrame(src, null, opacity, stack ? delay + i * interval : delay),
    );
    if (stack) delay += frames.length * interval;
  });

  $("stage").classList.toggle("has-bg", bgList.length > 0);
}

function flash() {
  const el = $("fx-flash");
  el.classList.remove("on");
  void el.offsetWidth; // 重新觸發動畫
  el.classList.add("on");
}

function afterimage() {
  const layer = $("bg-layer");
  Array.from(layer.querySelectorAll(".bg-frame.in")).forEach((el) => {
    const ghost = el.cloneNode(true);
    ghost.classList.add("ghost");
    layer.appendChild(ghost);
    setTimeout(() => ghost.remove(), 2400);
  });
}

const GLITCH_CHARS = "@`,[;\">{(<^}/:*?-=+%)&.#|!$";
function startGlitch() {
  const el = $("fx-glitch");
  el.classList.add("on");
  const draw = () => {
    let s = "";
    for (let i = 0; i < 1200; i++) {
      s += GLITCH_CHARS[(Math.random() * GLITCH_CHARS.length) | 0];
    }
    el.textContent = s;
  };
  draw();
  glitchTimer = setInterval(draw, 80);
}
function stopGlitch() {
  clearInterval(glitchTimer);
  glitchTimer = null;
  $("fx-glitch").classList.remove("on");
  $("fx-glitch").textContent = "";
}

// 套用一格的場景 / 特效 / 音效；回傳給打字機用的進度回呼
function runNodeFx(effectList, rawText) {
  resetNodeFx();

  const list = Array.isArray(effectList) ? effectList : [];
  const bgs = list.filter((e) => e && e.type === "bg");
  const keys = list.filter((e) => typeof e === "string");
  const sceneKeys = keys.filter((k) => SCENE_FX[k]);

  // 有指定新場景 → 換場景；沒有 → 沿用上一格
  if (bgs.length || sceneKeys.length) {
    Object.values(SCENE_FX).forEach(({ target, className }) =>
      $(target).classList.remove(className),
    );
    if (bgs.length) setScene(bgs);
    sceneKeys.forEach((k) =>
      $(SCENE_FX[k].target).classList.add(SCENE_FX[k].className),
    );
  }

  // 一次性特效（等新圖片開始淡入再觸發）
  if (keys.includes("flash")) later(flash, 60);
  if (keys.includes("afterimage")) later(afterimage, 500);
  if (keys.includes("glitch")) startGlitch();

  // 音效：沒有 at 的直接播，有 at 的等打字打到那段文字
  const plain = parseInlineMarkup(rawText)
    .map((t) => t.ch)
    .join("");
  const cues = [];
  list
    .filter((e) => e && e.type === "sfx")
    .forEach((s) => {
      const idx = s.at ? plain.indexOf(s.at) : -1;
      if (idx < 0) playSfx(s.name, s.duration);
      else cues.push({ idx, s });
    });

  return (typedCount) => {
    for (let i = cues.length - 1; i >= 0; i--) {
      if (typedCount > cues[i].idx) {
        playSfx(cues[i].s.name, cues[i].s.duration);
        cues.splice(i, 1);
      }
    }
  };
}