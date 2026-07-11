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
全域變數
=========================================================================
*/
let skip = false,
  typing = false;
let sessionId = null;
let currentNode = null;
const $ = (id) => document.getElementById(id);

/*
=========================================================================
helper function
=========================================================================
*/
// 音效控制
document.addEventListener("DOMContentLoaded", () => {
  $("bgm")
    .play()
    .catch((error) => {
      console.log("瀏覽器已封鎖自動播放，需要使用者互動。");
      $("bgmBtn").textContent = $("bgm").paused ? "♪̸" : "♪";
    });
});

// 切換播放與暫停
$("bgmBtn").addEventListener("click", () => {
  if ($("bgm").paused) {
    $("bgm").play();
  } else {
    $("bgm").pause();
  }
  $("bgmBtn").textContent = $("bgm").paused ? "♪̸" : "♪";
});

// 打字機：回傳 Promise；點擊可跳過
function typewriter(el, text, speed = 55) {
  return new Promise((res) => {
    typing = true;
    skip = false;
    el.innerHTML = "";
    let i = 0;
    const cur = document.createElement("span");
    cur.className = "cursor";
    el.appendChild(cur);
    const step = () => {
      if (skip) {
        el.textContent = text;
        el.appendChild(cur);
        finish();
        return;
      }
      if (i < text.length) {
        const ch = text[i++];
        cur.insertAdjacentText("beforebegin", ch);
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
const screens = ["cover", "intro", "ending", "gallery"];

function show(name) {
  screens.forEach((s) => $("sc-" + s).classList.remove("on"));
  $("sc-" + name).classList.add("on");
  $("restartBtn").style.display = name === "cover" ? "none" : "flex";
}

// 開始新的一局
async function beginGame() {
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
    $("introText").textContent = "（連線失敗，請稍後再試）";
    return;
  }
  currentNode = node;

  await typewriter($("introText"), node.text);

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
    btn.onclick = () => loadNode(c.next);
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
