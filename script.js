const api = () => window.pywebview && window.pywebview.api;

function setMaxIcon(isMax) {
  document.getElementById("ico-max").style.display = isMax ? "none" : "";
  document.getElementById("ico-restore").style.display = isMax ? "" : "none";
  document.getElementById("max").title = isMax ? "Відновити" : "Розгорнути";
}

const toggleMax = async () => {
  if (api()) setMaxIcon(await api().toggle_maximize());
};

document.getElementById("min").onclick = () => api() && api().minimize();
document.getElementById("max").onclick = toggleMax;
document.getElementById("close").onclick = async () => {
  if (!api()) return;
  if (await edGuardExit()) api().close();
};
document.getElementById("titlebar").ondblclick = (e) => {
  if (!e.target.closest("button")) toggleMax();
};

const tabsEl = document.getElementById("tabs");
let tabs = [];
let activeId = null;
let counter = 0;
let ready = false;

const QUICK_ID = 0;
const QUICK_TITLE = "Швидкий доступ";
const isQuick = (tab) => !!tab && tab.id === QUICK_ID;

const PLACE_ICONS = {
  quick: "star",
  desktop: "desktop",
  downloads: "download",
  documents: "file-lines",
  images: "image",
  music: "music",
  videos: "film",
  pc: "computer",
  removable: "usb",
  trash: "trash-can",
};

function validLoc(l) {
  return !!l && (typeof l.place === "string" || typeof l.path === "string");
}

function iconForLoc(loc) {
  return loc && loc.place ? PLACE_ICONS[loc.place] || "folder" : "folder";
}

function titleForLoc(loc, data) {
  if (loc.place === "quick") return QUICK_TITLE;
  if (loc.place) {
    const node = document.querySelector(`.place[data-place="${loc.place}"] .place-name`);
    return node ? node.textContent : (data && data.address) || "";
  }
  if (loc.path.startsWith("::")) {
    const tail = ((data && data.address) || "").split("\\").filter(Boolean).pop();
    return tail || "Телефон";
  }
  const parts = loc.path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : loc.path;
}

function activeTab() {
  return tabs.find((t) => t.id === activeId);
}

function stashTab() {
  const tab = activeTab();
  if (!tab) return;
  tab.history = navHistory;
  tab.index = navIndex;
  tab.loc = navHistory[navIndex] || tab.loc;
}

function activateTab(id, stash = true) {
  if (previewOpen) suspendPreview();
  suspendMedia();
  if (stash) stashTab();
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeId = id;
  navHistory = tab.history;
  navIndex = tab.index;
  currentLoc = null;
  renderTabs();
  keepEditor = true;
  load(tab.loc);
}

function addTab() {
  stashTab();
  counter++;
  const loc = { place: "desktop" };
  const tab = {
    id: counter,
    title: titleForLoc(loc),
    icon: iconForLoc(loc),
    loc,
    history: [loc],
    index: 0,
  };
  tabs.push(tab);
  activateTab(tab.id, false);
}

function openInNewTab(loc) {
  stashTab();
  counter++;
  const tab = {
    id: counter,
    title: titleForLoc(loc),
    icon: iconForLoc(loc),
    loc,
    history: [loc],
    index: 0,
  };
  tabs.push(tab);
  activateTab(tab.id, false);
}

let keepEditor = false;

const regularCount = () => tabs.filter((t) => !isQuick(t)).length;

function closeTab(id) {
  if (id === QUICK_ID || regularCount() <= 1) return;
  const i = tabs.findIndex((t) => t.id === id);
  const wasActive = id === activeId;
  const closing = tabs[i];
  if (closing && closing.media && closing.media.live) {
    if (closing.media.kind === "player") stopDetachedPlayer();
    else if (closing.media.kind === "audio") stopDetachedAudio();
  }
  tabs.splice(i, 1);
  if (wasActive) {
    const prev = tabs[i - 1];
    const next = prev && !isQuick(prev) ? prev : tabs[i] || prev;
    activateTab(next.id, false);
  }
  else renderTabs();
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  activateTab(tabs[(i + step + tabs.length) % tabs.length].id);
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    const quick = isQuick(t);
    el.className = "tab" + (t.id === activeId ? " active" : "") + (quick ? " quick" : "");
    el.title = quick ? QUICK_TITLE : t.title;
    el.innerHTML =
      `<i class="${iconCls(quick ? "star" : t.icon || "desktop")}"></i>` +
      (quick
        ? ""
        : '<button class="tab-close" title="Закрити вкладку"><svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg></button>');
    el.onclick = () => {
      closeKeys();
      if (t.id !== activeId) activateTab(t.id);
    };
    el.onmousedown = (e) => {
      if (e.button === 1) e.preventDefault();
    };
    el.onauxclick = (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      closeTab(t.id);
    };
    const closeBtn = el.querySelector(".tab-close");
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        closeTab(t.id);
      };
    }
    tabsEl.appendChild(el);
    if (t.id === activeId) el.scrollIntoView({ block: "nearest" });
  }
  document
    .querySelectorAll(".tab-close")
    .forEach((b) => (b.style.display = regularCount() > 1 ? "" : "none"));
  saveSession();
}

function saveSession() {
  if (!api() || !ready) return;
  stashTab();
  api().save_tabs(tabs, activeId, counter);
}

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.code === "Tab") {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if (e.code === "KeyW") {
    e.preventDefault();
    if (!editorOpen) closeTab(activeId);
  } else if (e.code === "KeyT") {
    e.preventDefault();
    addTab();
  } else if (e.code === "KeyH" && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    closeKeys();
    if (activeId !== QUICK_ID) activateTab(QUICK_ID);
  } else if (e.code === "KeyJ" && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (keysOpen) closeKeys();
    else openKeys();
  }
});

document.getElementById("tab-add").onclick = addTab;

function setView(view) {
  currentView = view;
  document
    .querySelectorAll("#view-switch .view-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
}

document.querySelectorAll("#view-switch .view-btn").forEach((btn) => {
  btn.onclick = () => {
    setView(btn.dataset.view);
    render();
    if (api()) api().save_view(currentView);
  };
});

const filesEl = document.getElementById("files");
const addressEl = document.getElementById("address");
const crumbsEl = document.getElementById("crumbs");
const searchEl = document.getElementById("search");
const searchWrapEl = document.getElementById("search-wrap");
const searchIcoEl = document.getElementById("search-ico");
const searchScopeEl = document.getElementById("search-scope");
let searchScope = "here";
let searchSeq = 0;
let searchTimer = null;
let searchSorted = false;
let currentView = "details";
let currentData = null;
let loadToken = 0;
let navHistory = [];
let navIndex = -1;
let currentLoc = null;
let selected = new Set();
let anchor = -1;
let nodeList = [];
let drag = null;
let itemDrag = null;

const EXT_ICONS = {
  "file-image": ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff"],
  "file-audio": ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"],
  "file-video": ["mp4", "mkv", "avi", "mov", "wmv", "webm", "flv"],
  "file-zipper": ["zip", "rar", "7z", "tar", "gz", "bz2"],
  "file-pdf": ["pdf"],
  "file-word": ["doc", "docx", "odt", "rtf"],
  "file-excel": ["xls", "xlsx", "ods", "csv"],
  "file-powerpoint": ["ppt", "pptx", "odp"],
  "file-lines": ["txt", "md", "log"],
  "file-code": ["py", "js", "ts", "html", "css", "json", "xml", "c", "cpp", "h", "java", "cs", "go", "rs", "sh", "bat", "ps1"],
};

function iconFor(item) {
  if (item.kind === "folder") return "folder";
  if (item.kind === "device") return "mobile-screen";
  if (item.kind === "drive") return item.removable ? "usb" : "hard-drive";
  for (const [icon, exts] of Object.entries(EXT_ICONS)) {
    if (exts.includes(item.ext)) return icon;
  }
  return "file";
}

function formatSize(n) {
  if (n == null) return "";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} Б` : `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts) {
  if (ts == null) return "";
  return new Date(ts * 1000).toLocaleString("uk-UA", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function typeLabel(item) {
  if (item.kind === "folder") return "Папка";
  if (item.kind === "drive" || item.kind === "device") return item.dtype;
  return item.ext ? `${item.ext.toUpperCase()}-файл` : "Файл";
}

function isInactive(item) {
  return item.kind === "device" && !item.active;
}

function statusLabel(item) {
  if (item.kind === "drive") return "Активний";
  if (item.kind === "device") return item.active ? "Активний" : "Неактивний";
  return "";
}

function sizeLabel(item) {
  if (item.kind === "folder") {
    if (item.size != null) return formatSize(item.size);
    return item.sizing ? "…" : "";
  }
  if (item.kind === "drive") {
    return item.size == null
      ? ""
      : `${formatSize(item.free)} вільно з ${formatSize(item.size)}`;
  }
  return formatSize(item.size);
}

function iconCls(name) {
  return name === "usb" ? "fa-brands fa-usb" : `fa-solid fa-${name}`;
}

function make(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const APP_ICON_EXTS = new Set(["exe", "lnk"]);
const appIconCache = new Map();
const appIconQueue = [];
let appIconActive = 0;
let appIconEpoch = 0;
let appIconObserver = null;

function wantsAppIcon(item) {
  return (
    item.kind === "file" &&
    APP_ICON_EXTS.has(item.ext) &&
    typeof item.path === "string" &&
    !item.tpath &&
    !item.path.startsWith("::")
  );
}

function appIconKey(item) {
  return `${item.path}|${item.modified || 0}`;
}

function resetAppIcons() {
  if (appIconObserver) appIconObserver.disconnect();
  appIconObserver = null;
  appIconQueue.length = 0;
  appIconEpoch++;
}

function applyAppIcon(wrap, url) {
  const img = make("img", "app-img");
  img.alt = "";
  img.draggable = false;
  img.onload = () => wrap.classList.add("has-img");
  img.src = url;
  wrap.appendChild(img);
}

function pumpAppIcons() {
  while (appIconActive < 4 && appIconQueue.length) {
    const job = appIconQueue.shift();
    if (job.epoch !== appIconEpoch) continue;
    appIconActive++;
    loadAppIcon(job).finally(() => {
      appIconActive--;
      pumpAppIcons();
    });
  }
}

async function loadAppIcon(job) {
  const { item, wrap } = job;
  const key = appIconKey(item);
  let url = appIconCache.get(key);
  if (url === undefined) {
    let res = null;
    try {
      res = api() ? await api().read_app_icon(item.path) : null;
    } catch (err) {
      res = null;
    }
    url = res && res.url ? res.url : "";
    appIconCache.set(key, url);
    if (appIconCache.size > 1500) appIconCache.delete(appIconCache.keys().next().value);
  }
  if (!url || job.epoch !== appIconEpoch || !wrap.isConnected) return;
  applyAppIcon(wrap, url);
}

function queueAppIcon(wrap, item) {
  if (!appIconObserver) {
    appIconObserver = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          appIconObserver.unobserve(en.target);
          if (en.target._appIcon) appIconQueue.push(en.target._appIcon);
        }
        pumpAppIcons();
      },
      { root: filesEl, rootMargin: "200px 0px" }
    );
  }
  wrap._appIcon = { item, wrap, epoch: appIconEpoch };
  appIconObserver.observe(wrap);
}

function iconNode(item) {
  const wrap = make("span", "f-ico" + (item.kind === "file" ? "" : " accent"));
  const i = make("i", iconCls(iconFor(item)));
  wrap.appendChild(i);
  if (wantsAppIcon(item)) {
    wrap.classList.add("app");
    const cached = appIconCache.get(appIconKey(item));
    if (cached) applyAppIcon(wrap, cached);
    else if (cached === undefined) queueAppIcon(wrap, item);
  }
  return wrap;
}

function nameNode(item) {
  const box = make("div", "f-name");
  box.appendChild(iconNode(item));
  box.appendChild(make("span", "", item.name));
  return box;
}

function render() {
  resetAppIcons();
  filesEl.innerHTML = "";
  nodeList = [];
  if (!currentData) {
    updateStatus();
    return;
  }

  if (currentData.error) {
    filesEl.appendChild(make("div", "f-empty", `Не вдалося відкрити: ${currentData.error}`));
    updateStatus();
    return;
  }
  if (!currentData.items.length) {
    filesEl.appendChild(
      make("div", "f-empty", searchEl.value.trim() ? emptySearchText() : "Тут порожньо")
    );
    updateStatus();
    return;
  }

  let holder;
  const quick = inQuickLoc();
  const trash = !!currentLoc && currentLoc.place === "trash";
  if (currentView === "details") {
    const removableView = !!currentLoc && currentLoc.place === "removable";
    holder = make(
      "div",
      "f-details" + (trash ? " trash" : "") + (removableView ? " removable" : "") + (isSearchResults() ? " searching" : "")
    );
    const head = make("div", "f-head");
    const cols = detailCols(trash);
    const sk = activeSortKey();
    cols.forEach(([key, title]) => {
      const th = make("span", "sortable" + (key === sk ? " sorted" : ""));
      th.dataset.sort = key;
      th.appendChild(make("span", "th-text", title));
      if (key === sk) {
        th.appendChild(make("i", "fa-solid fa-angle-" + (sortDir > 0 ? "up" : "down") + " th-arrow"));
      }
      head.appendChild(th);
    });
    holder.appendChild(head);
    currentData.items.forEach((item, idx) => {
      const row = make("div", "f-row");
      row.dataset.i = idx;
      nodeList[idx] = row;
      row.title = tipFor(item);
      if (isInactive(item)) row.classList.add("inactive");
      row.appendChild(nameNode(item));
      if (trash) {
        row.appendChild(make("span", "f-cell", item.origin || ""));
        row.appendChild(make("span", "f-cell", item.deleted || ""));
        row.appendChild(make("span", "f-cell", formatSize(item.size)));
        row.appendChild(make("span", "f-cell", item.ttype || typeLabel(item)));
        row.appendChild(make("span", "f-cell", formatDate(item.modified)));
      } else {
        if (isSearchResults()) row.appendChild(make("span", "f-cell f-where", item.where || ""));
        row.appendChild(make("span", "f-cell", formatDate(item.modified)));
        row.appendChild(make("span", "f-cell", typeLabel(item)));
        row.appendChild(make("span", "f-cell", sizeLabel(item)));
        if (removableView) row.appendChild(make("span", "f-cell", statusLabel(item)));
      }
      if (quick) row.appendChild(removeButton(item));
      holder.appendChild(row);
    });
  } else if (currentView === "list") {
    holder = make("div", "f-list");
    currentData.items.forEach((item, idx) => {
      const row = make("div", "f-row");
      row.dataset.i = idx;
      nodeList[idx] = row;
      row.title = tipFor(item);
      row.appendChild(nameNode(item));
      if (quick) row.appendChild(removeButton(item));
      holder.appendChild(row);
    });
  } else {
    holder = make("div", "f-grid");
    currentData.items.forEach((item, idx) => {
      const tile = make("div", "f-tile");
      tile.dataset.i = idx;
      nodeList[idx] = tile;
      tile.title = tipFor(item);
      tile.appendChild(iconNode(item));
      tile.appendChild(make("span", "f-label", item.name));
      if (quick) tile.appendChild(removeButton(item));
      holder.appendChild(tile);
    });
  }
  filesEl.appendChild(holder);

  if (isSearchResults()) {
    const fi = currentData.foundInfo || {};
    if (fi.truncated) {
      filesEl.appendChild(
        make("div", "f-note", `Показано перші ${currentData.items.length} із ${fi.total}. Уточніть запит, щоб звузити результати`)
      );
    }
    if (fi.live) {
      filesEl.appendChild(
        make(
          "div",
          "f-note",
          fi.indexing
            ? "Індекс файлової системи ще будується, тому пошук триває напряму і може бути неповним"
            : "Пошук напряму по папках" + (fi.partial ? " (результати неповні, уточніть запит)" : "")
        )
      );
    }
  } else if (currentData.truncated) {
    filesEl.appendChild(make("div", "f-note", "Показано лише перші 5000 елементів"));
  }
  applySelection();
  applyCut();
}

function applyFilter() {
  if (!currentData || currentData.error || !currentData.all) return;
  const q = searchEl.value.trim().toLowerCase();
  if (q && currentData.found) {
    const list = currentData.found.slice();
    currentData.items = searchSorted ? sortItems(list) : list;
    return;
  }
  const list = q
    ? currentData.all.filter((it) => it.name.toLowerCase().includes(q))
    : currentData.all.slice();
  currentData.items = sortItems(list);
}

function isSearchResults() {
  return !!currentData && !!currentData.found && !!searchEl.value.trim();
}

function activeSortKey() {
  return isSearchResults() && !searchSorted ? null : effectiveSortKey();
}

function tipFor(item) {
  return isSearchResults() && item.path ? item.path : item.name;
}

function emptySearchText() {
  const fi = currentData && currentData.foundInfo;
  if (fi && (fi.indexing || fi.live)) return "Нічого не знайдено. Індекс файлової системи ще будується, спробуйте за хвилину";
  return "Нічого не знайдено";
}

let sortKey = "name";
let sortDir = 1;
const collator = new Intl.Collator("uk", { numeric: true, sensitivity: "base" });

function detailCols() {
  const place = currentLoc && currentLoc.place;
  const trash = place === "trash";
  if (place === "removable") {
    return [
      ["name", "Назва"],
      ["modified", "Змінено"],
      ["type", "Тип"],
      ["size", "Розмір"],
      ["status", "Статус"],
    ];
  }
  if (!trash && isSearchResults()) {
    return [
      ["name", "Назва"],
      ["where", "Розташування"],
      ["modified", "Змінено"],
      ["type", "Тип"],
      ["size", "Розмір"],
    ];
  }
  return trash
    ? [
        ["name", "Назва"],
        ["origin", "Вихідне розташування"],
        ["deleted", "Дата видалення"],
        ["size", "Розмір"],
        ["ttype", "Тип елемента"],
        ["modified", "Дата змінення"],
      ]
    : [
        ["name", "Назва"],
        ["modified", "Змінено"],
        ["type", "Тип"],
        ["size", "Розмір"],
      ];
}

function effectiveSortKey() {
  const trash = !!currentLoc && currentLoc.place === "trash";
  return detailCols(trash).some(([k]) => k === sortKey) ? sortKey : "name";
}

const SORT_VALUE = {
  name: (it) => it.name,
  modified: (it) => it.modified,
  type: (it) => typeLabel(it),
  size: (it) => (it.kind === "drive" ? it.size : it.size),
  status: (it) => statusLabel(it),
  origin: (it) => it.origin || "",
  where: (it) => it.where || "",
  deleted: (it) => it.deleted || "",
  ttype: (it) => it.ttype || typeLabel(it),
};

function sortItems(list) {
  const key = effectiveSortKey();
  const get = SORT_VALUE[key];
  const byName = (a, b) => collator.compare(a.name, b.name);
  return list.sort((a, b) => {
    const ga = a.kind === "file" ? 1 : 0;
    const gb = b.kind === "file" ? 1 : 0;
    if (ga !== gb) return ga - gb;
    const va = get(a);
    const vb = get(b);
    const na = va == null || va === "";
    const nb = vb == null || vb === "";
    if (na && nb) return byName(a, b);
    if (na) return 1;
    if (nb) return -1;
    const c = typeof va === "number" && typeof vb === "number"
      ? va - vb
      : collator.compare(String(va), String(vb));
    return c ? c * sortDir : byName(a, b);
  });
}

function sortBy(key) {
  if (!currentData || currentData.error || !currentData.all) return;
  if (isSearchResults() && !searchSorted) {
    searchSorted = true;
    sortKey = key;
    sortDir = 1;
    resort();
    return;
  }
  if (effectiveSortKey() === key) sortDir = -sortDir;
  else {
    sortKey = key;
    sortDir = 1;
  }
  resort();
}

function resort() {
  if (!currentData || currentData.error || !currentData.all) return;
  const keep = [...selected].map((i) => currentData.items[i]).filter(Boolean);
  const cur = cursor >= 0 ? currentData.items[cursor] : null;
  applyFilter();
  render();
  const pos = new Map(currentData.items.map((it, i) => [it, i]));
  const sel = new Set(keep.map((it) => pos.get(it)).filter((i) => i != null));
  cursor = cur && pos.has(cur) ? pos.get(cur) : -1;
  setSelection(sel, cursor);
  updateStatus();
}

filesEl.addEventListener("click", (e) => {
  const th = e.target.closest(".f-head .sortable");
  if (th) sortBy(th.dataset.sort);
});

function searchScopePath() {
  if (searchScope !== "here" || !currentData) return null;
  const p = currentData.path;
  return p && !p.startsWith("::") ? p : null;
}

function setSearchBusy(busy) {
  searchIcoEl.className = busy ? "fa-solid fa-spinner fa-spin" : "fa-solid fa-magnifying-glass";
}

function updateScopeUi() {
  const all = searchScope === "all";
  searchScopeEl.classList.toggle("active", all);
  searchScopeEl.querySelector("i").className = all ? "fa-solid fa-globe" : "fa-solid fa-folder-tree";
  searchScopeEl.title = all
    ? "Шукати по всьому комп'ютеру. Натисніть, щоб шукати лише в поточній папці"
    : "Шукати в поточній папці та підпапках. Натисніть, щоб шукати по всьому комп'ютеру";
  searchEl.placeholder = all ? "Пошук усюди" : "Пошук";
}

function scheduleSearch(delay = 120) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, delay);
}

async function runSearch() {
  const q = searchEl.value.trim();
  if (!q || !api() || !currentData || currentData.error) return;
  const seq = ++searchSeq;
  const data = currentData;
  setSearchBusy(true);
  let res;
  try {
    res = await api().search_files(q, searchScopePath(), seq);
  } catch (e) {
    res = { error: String(e) };
  }
  if (seq !== searchSeq || data !== currentData) return;
  setSearchBusy(false);
  if (!res || res.cancelled) return;
  if (res.error) {
    data.found = [];
    data.foundInfo = { total: 0 };
  } else {
    data.found = res.items || [];
    data.foundInfo = res;
  }
  selected = new Set();
  anchor = -1;
  cursor = -1;
  applyFilter();
  render();
}

searchEl.addEventListener("input", () => {
  if (!currentData) return;
  if (!searchEl.value.trim()) {
    clearTimeout(searchTimer);
    searchSeq++;
    setSearchBusy(false);
    searchSorted = false;
    currentData.found = null;
    currentData.foundInfo = null;
  }
  selected = new Set();
  anchor = -1;
  cursor = -1;
  applyFilter();
  if (!currentData.found || !searchEl.value.trim()) render();
  if (searchEl.value.trim()) scheduleSearch();
});

searchScopeEl.addEventListener("click", () => {
  searchScope = searchScope === "here" ? "all" : "here";
  updateScopeUi();
  if (currentData && searchEl.value.trim()) scheduleSearch(0);
  searchEl.focus();
});
updateScopeUi();

searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    if (searchEl.value) {
      searchEl.value = "";
      searchEl.dispatchEvent(new Event("input"));
    } else {
      searchEl.blur();
    }
  } else if (e.key === "ArrowDown" || e.key === "Enter") {
    e.preventDefault();
    searchEl.blur();
    if (currentData && !currentData.error && currentData.items.length) moveCursor(1, false);
  }
});

function updateStatus() {
  const filtering = !!searchEl.value.trim();
  document.getElementById("item-count").textContent =
    currentData && !currentData.error
      ? filtering
        ? currentData.items.length
        : currentData.total
      : "—";

  let files = 0;
  let bytes = 0;
  if (currentData) {
    for (const i of selected) {
      const item = currentData.items[i];
      if (item && (item.kind === "file" || (item.kind === "folder" && item.size != null))) {
        files++;
        bytes += item.size || 0;
      }
    }
  }
  document.getElementById("sel-part").hidden = selected.size === 0;
  document.getElementById("sel-count").textContent = selected.size;
  document.getElementById("size-part").hidden = files === 0;
  document.getElementById("sel-size").textContent = formatSize(bytes);
}

function applySelection() {
  nodeList.forEach((node, i) => node.classList.toggle("selected", selected.has(i)));
  updateStatus();
  previewUpdate();
}

let previewEl = null;
let previewOpen = false;
let previewToken = 0;
let previewTimer = null;
let previewPath = null;
let previewLoc = null;
const IMG_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "avif"]);

function previewItem() {
  if (!currentData || currentData.error) return null;
  const idx = currentIndex();
  return idx >= 0 ? currentData.items[idx] || null : null;
}

function isImageItem(it) {
  return !!it && it.kind === "file" && !!it.path && IMG_EXTS.has(it.ext);
}

function previewList() {
  if (!currentData || currentData.error) return [];
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => currentData.items[i])
    .filter(isImageItem);
}

function buildPreview() {
  const el = make("div", "preview");
  const head = make("div", "pv-head");
  const name = make("span", "pv-name", "");
  const close = make("button", "pv-close");
  close.type = "button";
  close.appendChild(make("i", iconCls("xmark")));
  close.onclick = closePreview;
  head.append(make("i", iconCls("image")), name, close);
  const body = make("div", "pv-body");
  const img = make("img", "pv-img");
  img.draggable = false;
  img.hidden = true;
  const msg = make("span", "pv-msg", "");
  const prev = make("button", "pv-nav prev");
  prev.type = "button";
  prev.appendChild(make("i", iconCls("angle-left")));
  prev.onclick = () => previewStep(-1);
  const next = make("button", "pv-nav next");
  next.type = "button";
  next.appendChild(make("i", iconCls("angle-right")));
  next.onclick = () => previewStep(1);
  body.append(img, msg, prev, next);
  const foot = make("div", "pv-foot", "");
  el.append(head, body, foot);
  document.body.appendChild(el);
  previewEl = { el, name, img, msg, foot, prev, next, moved: false };
  enablePreviewDrag(head);
}

function clampPreview() {
  const p = previewEl;
  if (!p || !p.moved) return;
  const w = p.el.offsetWidth;
  const h = p.el.offsetHeight;
  const left = Math.min(Math.max(0, p.el.offsetLeft), Math.max(0, window.innerWidth - w));
  const top = Math.min(Math.max(0, p.el.offsetTop), Math.max(0, window.innerHeight - h));
  p.el.style.left = left + "px";
  p.el.style.top = top + "px";
}

function enablePreviewDrag(head) {
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target.closest && e.target.closest(".pv-close"))) return;
    const p = previewEl;
    const rect = p.el.getBoundingClientRect();
    p.el.style.left = rect.left + "px";
    p.el.style.top = rect.top + "px";
    p.el.style.right = "auto";
    p.el.style.bottom = "auto";
    p.moved = true;
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    head.setPointerCapture(e.pointerId);
    head.classList.add("dragging");
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = previewEl;
    const left = Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, window.innerWidth - p.el.offsetWidth));
    const top = Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, window.innerHeight - p.el.offsetHeight));
    p.el.style.left = left + "px";
    p.el.style.top = top + "px";
  });
  const stop = (e) => {
    if (!drag) return;
    drag = null;
    head.classList.remove("dragging");
    if (head.hasPointerCapture(e.pointerId)) head.releasePointerCapture(e.pointerId);
  };
  head.addEventListener("pointerup", stop);
  head.addEventListener("pointercancel", stop);
}

window.addEventListener("resize", clampPreview);

function previewMessage(text, tag) {
  const p = previewEl;
  p.img.hidden = true;
  p.img.removeAttribute("src");
  p.msg.textContent = text;
  p.msg.hidden = false;
  p.foot.textContent = tag || "";
}

function previewStep(dir) {
  const list = previewList();
  if (!previewOpen || list.length < 2) return;
  const cur = list.findIndex((it) => it.path === previewPath);
  const next = (cur + dir + list.length) % list.length;
  previewPath = list[next].path;
  previewUpdate();
}

function previewUpdate() {
  if (!previewOpen || !previewEl) return;
  const p = previewEl;
  const list = previewList();
  const multi = list.length > 1;
  let it;
  let tag = "";
  if (multi) {
    const cursorItem = currentData.items[currentIndex()];
    it = list.find((x) => x.path === previewPath) || (list.includes(cursorItem) ? cursorItem : list[0]);
    tag = `${list.indexOf(it) + 1} / ${list.length}`;
  } else {
    it = previewItem();
  }
  previewPath = it ? it.path || null : null;
  p.prev.hidden = !multi;
  p.next.hidden = !multi;
  clearTimeout(previewTimer);
  p.name.textContent = it ? it.name : "";
  if (!isImageItem(it)) {
    previewToken++;
    previewMessage(it ? "Перегляд недоступний" : "Виберіть зображення", tag);
    return;
  }
  const token = ++previewToken;
  previewTimer = setTimeout(async () => {
    let res = null;
    try {
      res = await api().read_image(it.path);
    } catch (err) {
      res = null;
    }
    if (token !== previewToken || !previewOpen) return;
    if (!res || !res.url) {
      previewMessage((res && res.error) || "Не вдалося показати", tag);
      return;
    }
    p.img.onload = () => {
      if (token !== previewToken) return;
      const dims = `${p.img.naturalWidth}×${p.img.naturalHeight}`;
      const size = typeof it.size === "number" ? formatSize(it.size) : "";
      p.foot.textContent = [tag, dims, size].filter(Boolean).join(" • ");
    };
    p.img.onerror = () => {
      if (token === previewToken) previewMessage("Не вдалося показати", tag);
    };
    p.img.src = res.url;
    p.img.hidden = false;
    p.msg.hidden = true;
  }, 60);
}

function suspendPreview() {
  const tab = activeTab();
  const p = previewEl;
  if (tab && p) {
    const items = currentData && currentData.items ? currentData.items : [];
    tab.preview = {
      loc: previewLoc,
      path: previewPath,
      sel: [...selected].map((i) => items[i] && items[i].path).filter(Boolean),
      pos: p.moved ? { left: p.el.offsetLeft, top: p.el.offsetTop } : null,
    };
  }
  previewOpen = false;
  previewToken++;
  clearTimeout(previewTimer);
  if (p) p.el.hidden = true;
}

function restorePreviewForTab() {
  const tab = activeTab();
  if (previewOpen || !tab || !tab.preview || !currentData || currentData.error) return;
  const saved = tab.preview;
  if (!sameLocation(currentLoc, saved.loc)) {
    tab.preview = null;
    return;
  }
  if (!previewEl) buildPreview();
  const items = currentData.items;
  const idxs = new Set();
  (saved.sel || []).forEach((path) => {
    const i = items.findIndex((it) => it.path === path);
    if (i >= 0) idxs.add(i);
  });
  const cur = items.findIndex((it) => it.path && it.path === saved.path);
  previewOpen = true;
  previewLoc = currentLoc;
  previewPath = saved.path;
  previewEl.el.hidden = false;
  if (saved.pos) {
    previewEl.el.style.left = saved.pos.left + "px";
    previewEl.el.style.top = saved.pos.top + "px";
    previewEl.el.style.right = "auto";
    previewEl.el.style.bottom = "auto";
    previewEl.moved = true;
    clampPreview();
  }
  if (idxs.size || cur >= 0) {
    if (cur >= 0) idxs.add(cur);
    const focus = cur >= 0 ? cur : Math.min(...idxs);
    cursor = focus;
    setSelection(idxs, focus);
    scrollToItem(focus);
  } else {
    previewUpdate();
  }
}

function closePreview() {
  const owner = activeTab();
  if (owner) owner.preview = null;
  previewOpen = false;
  previewToken++;
  previewPath = null;
  clearTimeout(previewTimer);
  if (previewEl) {
    previewEl.el.hidden = true;
    previewEl.img.removeAttribute("src");
    previewEl.el.style.left = "";
    previewEl.el.style.top = "";
    previewEl.el.style.right = "";
    previewEl.el.style.bottom = "";
    previewEl.moved = false;
  }
}

function togglePreview() {
  if (previewOpen) {
    closePreview();
    return;
  }
  if (!api() || !(previewList().length || isImageItem(previewItem()))) {
    showNote("image", ["Виберіть зображення для перегляду"]);
    return;
  }
  if (!previewEl) buildPreview();
  previewOpen = true;
  previewLoc = currentLoc;
  previewEl.el.hidden = false;
  previewUpdate();
}

document.addEventListener(
  "keydown",
  (e) => {
    if (!previewOpen || confirmState) return;
    if (e.target.closest && e.target.closest("input")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePreview();
      return;
    }
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
      previewList().length > 1
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      previewStep(e.key === "ArrowLeft" ? -1 : 1);
    }
  },
  true
);

function setSelection(set, newAnchor) {
  selected = set;
  if (newAnchor !== undefined) anchor = newAnchor;
  applySelection();
}

function itemIndexFromEvent(e) {
  const node = e.target.closest("[data-i]");
  return node ? Number(node.dataset.i) : -1;
}

function inQuickLoc() {
  return !!currentLoc && currentLoc.place === "quick";
}

async function openExternal(path) {
  if (!api() || typeof path !== "string" || path.startsWith("::")) return;
  let ok = false;
  try {
    ok = await api().open_path(path);
  } catch (err) {
    ok = false;
  }
  if (!ok) showNote("triangle-exclamation", ["Не вдалося відкрити: ", path], true);
}

function openItem(item) {
  if (!item || !item.path || isInactive(item)) return;
  if (item.kind === "folder" || item.kind === "drive" || item.kind === "device") navigate({ path: item.path });
  else if (isImageItem(item)) openGallery(item);
  else if (isVideoItem(item)) openPlayer(item);
  else if (isAudioItem(item)) openAudio(item);
  else if (isTextItem(item)) openEditor(editorTargets(item));
  else openExternal(item.path);
}

function removeButton(item) {
  const b = make("button", "f-remove");
  b.title = "Прибрати зі швидкого доступу";
  b.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
  b.onmousedown = (e) => e.stopPropagation();
  b.ondblclick = (e) => e.stopPropagation();
  b.onclick = async (e) => {
    e.stopPropagation();
    if (!api()) return;
    try {
      await api().remove_quick([item.path]);
    } catch (err) {
      return;
    }
    if (currentLoc) load(currentLoc);
  };
  return b;
}

function sameLocation(a, b) {
  return !!a && !!b && a.place === b.place && a.path === b.path;
}

function highlightPlace() {
  if (typeof clearPlaceCursor === "function") clearPlaceCursor();
  document
    .querySelectorAll(".place")
    .forEach((p) =>
      p.classList.toggle("active", !!currentLoc && p.dataset.place === currentLoc.place)
    );
}

function splitPath(p) {
  let segs = [];
  let rest = "";
  let sep = "\\";
  const unc = p.match(/^(\\\\[^\\]+\\[^\\]+)\\?(.*)$/);
  if (unc) {
    segs.push({ label: unc[1], path: unc[1] + "\\" });
    rest = unc[2];
  } else if (/^[A-Za-z]:/.test(p)) {
    segs.push({ label: p.slice(0, 2), path: p.slice(0, 2) + "\\" });
    rest = p.slice(2);
  } else if (p.startsWith("/")) {
    segs.push({ label: "/", path: "/" });
    rest = p.slice(1);
    sep = "/";
  } else {
    return null;
  }
  let cur = segs[0].path;
  for (const name of rest.split(/[\\/]+/).filter(Boolean)) {
    cur = cur.endsWith(sep) ? cur + name : cur + sep + name;
    segs.push({ label: name, path: cur });
  }
  return segs;
}

let crumbMenu = null;

function closeCrumbMenu() {
  if (!crumbMenu) return;
  crumbMenu.el.remove();
  crumbMenu.chev.classList.remove("open");
  crumbMenu = null;
}

async function openCrumbMenu(chev, seg, next) {
  if (crumbMenu && crumbMenu.chev === chev) {
    closeCrumbMenu();
    return;
  }
  closeCrumbMenu();
  if (!api()) return;
  const el = make("div", "crumb-menu");
  el.appendChild(make("div", "crumb-menu-empty", "…"));
  document.body.appendChild(el);
  chev.classList.add("open");
  const r = chev.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 200)) + "px";
  el.style.top = r.bottom + 2 + "px";
  const st = { el, chev };
  crumbMenu = st;
  let res = null;
  try {
    res = await api().list_path(seg.path);
  } catch (e) {}
  if (crumbMenu !== st) return;
  el.innerHTML = "";
  const folders = res && !res.error ? res.items.filter((i) => i.kind === "folder") : [];
  if (!folders.length) {
    el.appendChild(make("div", "crumb-menu-empty", "Немає вкладених папок"));
    return;
  }
  folders.forEach((f) => {
    const b = make("button", "crumb-menu-item" + (f.name === next ? " current" : ""));
    b.appendChild(make("i", "fa-solid fa-folder"));
    b.appendChild(make("span", "", f.name));
    b.onclick = () => {
      closeCrumbMenu();
      navigate({ path: f.path });
    };
    el.appendChild(b);
  });
  const cur = el.querySelector(".current");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function renderCrumbs(data) {
  closeCrumbMenu();
  crumbsEl.innerHTML = "";
  const home = make("button", "crumb home");
  home.title = "Цей ПК";
  home.appendChild(make("i", "fa-solid fa-computer"));
  home.onclick = () => navigate({ place: "pc" });
  crumbsEl.appendChild(home);
  const p = data && data.path && !data.path.startsWith("::") ? data.path : null;
  const segs = p ? splitPath(p) : null;
  if (!segs) {
    crumbsEl.appendChild(make("span", "crumb label", (data && data.address) || ""));
    return;
  }
  segs.forEach((seg, i) => {
    const b = make("button", "crumb", seg.label);
    b.title = seg.path;
    b.onclick = () => navigate({ path: seg.path });
    crumbsEl.appendChild(b);
    const chev = make("button", "crumb-chev");
    chev.appendChild(make("i", "fa-solid fa-angle-right"));
    chev.onclick = () => openCrumbMenu(chev, seg, segs[i + 1] && segs[i + 1].label);
    crumbsEl.appendChild(chev);
  });
  crumbsEl.scrollLeft = crumbsEl.scrollWidth;
}

function startAddressEdit() {
  if (!currentData || (currentData.path && currentData.path.startsWith("::"))) return;
  closeCrumbMenu();
  crumbsEl.hidden = true;
  addressEl.hidden = false;
  addressEl.value = currentData.address || "";
  addressEl.focus();
  addressEl.select();
}

function endAddressEdit() {
  if (addressEl.hidden) return;
  addressEl.hidden = true;
  crumbsEl.hidden = false;
}

crumbsEl.addEventListener("click", (e) => {
  if (e.target === crumbsEl || e.target.classList.contains("label")) startAddressEdit();
});
crumbsEl.addEventListener("wheel", (e) => {
  crumbsEl.scrollLeft += e.deltaY || e.deltaX;
});
addressEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    let v = addressEl.value.trim().replace(/^"(.*)"$/, "$1");
    endAddressEdit();
    if (!v || (currentData && v === currentData.address)) return;
    if (/^[A-Za-z]:$/.test(v)) v += "\\";
    navigate({ path: v });
  } else if (e.key === "Escape") {
    e.preventDefault();
    endAddressEdit();
  }
});
addressEl.addEventListener("blur", () => endAddressEdit());
document.addEventListener("mousedown", (e) => {
  if (crumbMenu && !crumbMenu.el.contains(e.target) && !crumbMenu.chev.contains(e.target)) closeCrumbMenu();
});
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && crumbMenu) {
      e.preventDefault();
      e.stopPropagation();
      closeCrumbMenu();
    }
  },
  true
);
window.addEventListener("blur", closeCrumbMenu);

function updateNav() {
  document.getElementById("nav-back").disabled = navIndex <= 0;
  document.getElementById("nav-forward").disabled = navIndex >= navHistory.length - 1;
  document.getElementById("nav-up").disabled = !currentData || !currentData.path;
}

async function load(loc) {
  if (!api()) return;
  closeKeys();
  closeGallery(true);
  closePlayer(true);
  closeAudio(true);
  if (!keepEditor) hideEditor(true);
  keepEditor = false;
  dismissConfirm();
  cancelRename();
  cancelBulk();
  const token = ++loadToken;
  let data;
  try {
    data = loc.place
      ? await api().list_place(loc.place)
      : await api().list_path(loc.path);
  } catch (e) {
    data = { address: "", path: null, items: [], total: 0, error: String(e) };
  }
  if (token !== loadToken) return;
  if (previewOpen && !sameLocation(loc, previewLoc)) closePreview();
  const keepQuery = sameLocation(loc, currentLoc);
  currentLoc = loc;
  currentData = data;
  if (!keepQuery) searchEl.value = "";
  clearTimeout(searchTimer);
  searchSeq++;
  setSearchBusy(false);
  if (!keepQuery) searchSorted = false;
  data.all = data.items;
  applyFilter();
  if (keepQuery && searchEl.value.trim()) scheduleSearch(0);
  const tab = activeTab();
  if (tab) {
    tab.loc = loc;
    tab.icon = isQuick(tab) ? "star" : iconForLoc(loc);
    tab.title = isQuick(tab) ? QUICK_TITLE : titleForLoc(loc, data);
  }
  selected = new Set();
  anchor = -1;
  cursor = -1;
  addressEl.value = data.address || "";
  endAddressEdit();
  renderCrumbs(data);
  highlightPlace();
  startFolderSizes(token);
  render();
  updateNav();
  renderTabs();
  restorePreviewForTab();
  restoreMediaForTab();
}

function updateSizeCell(item) {
  updateStatus();
  if (currentView !== "details" || !currentData) return;
  const row = nodeList[currentData.items.indexOf(item)];
  const cell = row && row.children[3];
  if (cell) cell.textContent = sizeLabel(item);
}

async function startFolderSizes(token) {
  const data = currentData;
  const trash = !!currentLoc && currentLoc.place === "trash";
  if (!api() || !data || data.error || trash) return;
  if (data.path && data.path.startsWith("::")) return;
  const queue = data.all.filter((it) => it.kind === "folder" && it.path && it.size == null);
  queue.forEach((it) => (it.sizing = true));
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      let size = null;
      try {
        size = await api().folder_size(it.path, token);
      } catch (e) {}
      if (token !== loadToken) return;
      it.sizing = false;
      if (typeof size === "number") it.size = size;
      updateSizeCell(it);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (token === loadToken && effectiveSortKey() === "size") resort();
}

async function navigate(loc) {
  if (isQuick(activeTab()) && loc.place !== "quick") {
    openInNewTab(loc);
    return;
  }
  if (sameLocation(loc, currentLoc)) {
    await load(loc);
    return;
  }
  navHistory = navHistory.slice(0, navIndex + 1);
  navHistory.push(loc);
  navIndex = navHistory.length - 1;
  await load(loc);
}

function goBack() {
  if (navIndex <= 0) return;
  navIndex--;
  load(navHistory[navIndex]);
}

function goForward() {
  if (navIndex >= navHistory.length - 1) return;
  navIndex++;
  load(navHistory[navIndex]);
}

async function goUp() {
  if (!api() || !currentData || !currentData.path) return;
  const parent = await api().parent_of(currentData.path);
  const mtp = currentData.path.startsWith("::");
  navigate(parent ? { path: parent } : { place: mtp ? "removable" : "pc" });
}

function refresh() {
  if (!currentLoc) return;
  load(currentLoc);
  loadCounts();
}

function loadCounts() {
  if (!api()) return;
  document.querySelectorAll(".place").forEach((p) => {
    const key = p.dataset.place;
    api()
      .count_place(key)
      .then((res) => {
        for (const [name, value] of Object.entries(res || {})) {
          const node = document.getElementById(`${key}-${name}`);
          if (node) node.textContent = value;
        }
      })
      .catch(() => {});
  });
}

document.querySelectorAll(".place").forEach((p) => {
  p.onclick = () => navigate({ place: p.dataset.place });
  p.onmousedown = (e) => {
    if (e.button === 1) e.preventDefault();
  };
  p.onauxclick = (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openInNewTab({ place: p.dataset.place });
  };
});

function overScrollbar(e) {
  const r = filesEl.getBoundingClientRect();
  return (
    e.clientX - r.left >= filesEl.clientWidth ||
    e.clientY - r.top >= filesEl.clientHeight
  );
}

filesEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !currentData || overScrollbar(e)) return;
  if (e.target.closest(".f-head") || e.target.closest(".rename-input")) return;
  const idx = itemIndexFromEvent(e);
  const additive = e.ctrlKey || e.metaKey;
  const base = additive ? new Set(selected) : new Set();

  if (e.shiftKey && idx >= 0) {
    const from = anchor >= 0 ? anchor : idx;
    for (let i = Math.min(from, idx); i <= Math.max(from, idx); i++) base.add(i);
    setSelection(base);
    return;
  }

  if (idx >= 0 && !additive) {
    const keep = selected.has(idx);
    if (!keep) {
      setSelection(new Set([idx]), idx);
      cursor = idx;
    }
    itemDrag = { x: e.clientX, y: e.clientY, idx, keep, active: false, ghost: null, target: null };
    return;
  }

  if (idx >= 0) {
    if (additive && base.has(idx)) base.delete(idx);
    else base.add(idx);
    anchor = idx;
  }
  setSelection(base);

  const r = filesEl.getBoundingClientRect();
  drag = {
    base,
    x: e.clientX - r.left + filesEl.scrollLeft,
    y: e.clientY - r.top + filesEl.scrollTop,
    active: false,
    band: null,
    rects: null,
  };
});

document.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const r = filesEl.getBoundingClientRect();

  if (!drag.active) {
    const dx = e.clientX - r.left + filesEl.scrollLeft - drag.x;
    const dy = e.clientY - r.top + filesEl.scrollTop - drag.y;
    if (Math.hypot(dx, dy) < 4) return;
    drag.active = true;
    drag.band = make("div", "band");
    filesEl.appendChild(drag.band);
    drag.rects = nodeList.map((n) => {
      const b = n.getBoundingClientRect();
      return {
        l: b.left - r.left + filesEl.scrollLeft,
        t: b.top - r.top + filesEl.scrollTop,
        r: b.right - r.left + filesEl.scrollLeft,
        b: b.bottom - r.top + filesEl.scrollTop,
      };
    });
  }

  if (e.clientY < r.top + 24) filesEl.scrollTop -= 20;
  else if (e.clientY > r.bottom - 24) filesEl.scrollTop += 20;

  const x = e.clientX - r.left + filesEl.scrollLeft;
  const y = e.clientY - r.top + filesEl.scrollTop;
  const left = Math.min(x, drag.x);
  const top = Math.min(y, drag.y);
  const right = Math.max(x, drag.x);
  const bottom = Math.max(y, drag.y);

  Object.assign(drag.band.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
  });

  const next = new Set(drag.base);
  drag.rects.forEach((q, i) => {
    if (q.l < right && q.r > left && q.t < bottom && q.b > top) next.add(i);
  });
  setSelection(next);
});

function quickTabAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el && el.closest ? el.closest(".tab.quick") : null;
}

function endItemDrag() {
  if (!itemDrag) return;
  if (itemDrag.ghost) itemDrag.ghost.remove();
  if (itemDrag.target) itemDrag.target.classList.remove("drop");
  document.body.classList.remove("dragging-items");
  itemDrag = null;
}

async function addSelectedToQuick() {
  if (!api() || !currentData) return;
  const items = [...selected]
    .sort((a, b) => a - b)
    .map((i) => currentData.items[i])
    .filter((it) => it && it.path)
    .map((it) => ({ path: it.path }));
  if (!items.length) return;
  let res;
  try {
    res = await api().add_quick(items);
  } catch (err) {
    return;
  }
  const tab = tabsEl.querySelector(".tab.quick");
  if (tab && res && res.added) {
    tab.classList.add("dropped");
    setTimeout(() => tab.classList.remove("dropped"), 700);
  }
}

document.addEventListener("mousemove", (e) => {
  if (!itemDrag) return;
  if (!itemDrag.active) {
    if (Math.hypot(e.clientX - itemDrag.x, e.clientY - itemDrag.y) < 4) return;
    itemDrag.active = true;
    const ghost = make("div", "drag-ghost");
    ghost.appendChild(make("i", "fa-solid fa-star"));
    const first = currentData && currentData.items[itemDrag.idx];
    ghost.appendChild(
      make("span", "", selected.size > 1 ? `Елементів: ${selected.size}` : first ? first.name : "")
    );
    document.body.appendChild(ghost);
    itemDrag.ghost = ghost;
    document.body.classList.add("dragging-items");
  }
  itemDrag.ghost.style.left = `${e.clientX + 14}px`;
  itemDrag.ghost.style.top = `${e.clientY + 14}px`;
  const target = quickTabAt(e);
  if (target !== itemDrag.target) {
    if (itemDrag.target) itemDrag.target.classList.remove("drop");
    if (target) target.classList.add("drop");
    itemDrag.target = target;
  }
});

document.addEventListener("mouseup", (e) => {
  if (!itemDrag) return;
  const d = itemDrag;
  const hit = d.active ? quickTabAt(e) : null;
  endItemDrag();
  if (!d.active) {
    if (d.keep && selected.size > 1) {
      setSelection(new Set([d.idx]), d.idx);
      cursor = d.idx;
    }
    return;
  }
  if (hit) addSelectedToQuick();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") endItemDrag();
});
window.addEventListener("blur", endItemDrag);

function endDrag() {
  if (drag && drag.band) drag.band.remove();
  drag = null;
}

document.addEventListener("mouseup", endDrag);
window.addEventListener("blur", endDrag);

filesEl.addEventListener("mousedown", (e) => {
  if (e.button === 1) e.preventDefault();
});

filesEl.addEventListener("auxclick", (e) => {
  if (e.button !== 1 || !currentData) return;
  e.preventDefault();
  const item = currentData.items[itemIndexFromEvent(e)];
  if (item && item.path && (item.kind === "folder" || item.kind === "drive")) {
    openInNewTab({ path: item.path });
  }
});

filesEl.addEventListener("dblclick", (e) => {
  if (e.target.closest(".rename-input")) return;
  const i = itemIndexFromEvent(e);
  if (i >= 0 && currentData) openItem(currentData.items[i]);
});

let clipboard = null;
let noteTimer = null;
const NOTE_MS = 3000;

let confirmState = null;
let bulkState = null;

function dismissConfirm() {
  if (!confirmState) return;
  confirmState = null;
  const el = document.getElementById("note");
  el.hidden = true;
  el.classList.remove("confirm", "danger");
}

function acceptConfirm() {
  const st = confirmState;
  if (!st) return;
  dismissConfirm();
  st.onYes();
}

function showConfirm(icon, parts, danger, onYes) {
  const el = document.getElementById("note");
  clearTimeout(noteTimer);
  el.innerHTML = "";
  el.classList.remove("error");
  el.classList.add("confirm");
  el.classList.toggle("danger", !!danger);
  el.appendChild(make("i", iconCls(icon)));
  const text = make("span");
  parts.forEach((p, i) => text.appendChild(make(i % 2 ? "b" : "span", "", p)));
  el.appendChild(text);
  const yes = make("button", "sb-btn" + (danger ? " danger" : ""), "Підтвердити");
  const no = make("button", "sb-btn", "Скасувати");
  yes.onclick = acceptConfirm;
  no.onclick = dismissConfirm;
  el.appendChild(yes);
  el.appendChild(no);
  confirmState = { onYes };
  el.hidden = false;
}

function trashSelected() {
  if (!currentData) return [];
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => currentData.items[i])
    .filter((it) => it && it.tpath);
}

function askDelete(permanent) {
  const inTrash = !!currentLoc && currentLoc.place === "trash";
  const items = inTrash ? trashSelected() : selectedItems();
  if (!items.length || !api()) return;
  if (inTrash || (currentData && currentData.path && currentData.path.startsWith("::"))) permanent = true;
  const one = items.length === 1;
  const what = one && items[0].kind === "folder" ? "папку" : "файл";
  const name = one ? items[0].name : "";
  const parts = permanent
    ? one
      ? [`Видалити ${what} `, name, " назавжди?"]
      : ["Видалити елементи: ", String(items.length), " назавжди?"]
    : one
      ? [`Відправити ${what} `, name, " в смітник?"]
      : ["Відправити елементи: ", String(items.length), " в смітник?"];
  showConfirm(permanent ? "xmark" : "trash-can", parts, permanent, () =>
    runDelete(items, permanent)
  );
}

async function runDelete(items, permanent) {
  const minIdx = selected.size ? Math.min(...selected) : 0;
  let res;
  try {
    res = await api().delete_items(items.map((it) => it.path || it.tpath), permanent);
  } catch (err) {
    showMsg(String(err));
    return;
  }
  if (currentLoc) await load(currentLoc);
  loadCounts();
  if (currentData && !currentData.error && currentData.items.length) {
    const idx = Math.min(minIdx, currentData.items.length - 1);
    cursor = idx;
    setSelection(new Set([idx]), idx);
    scrollToItem(idx);
  }
  const errors = res.errors || [];
  if (errors.length) {
    showMsg(errors[0] + (errors.length > 1 ? ` (ще ${errors.length - 1})` : ""));
  } else if (res.deleted) {
    const one = items.length === 1;
    const lead = one ? (items[0].kind === "folder" ? "Папка " : "Файл ") : "Елементів: ";
    const name = one ? items[0].name : String(res.deleted);
    showNote(permanent ? "xmark" : "trash-can", [
      lead,
      name,
      permanent ? " видалено назавжди" : " переміщено в смітник",
    ]);
  }
}

function showNote(icon, parts, error) {
  const el = document.getElementById("note");
  confirmState = null;
  bulkState = null;
  el.classList.remove("confirm", "danger", "progress", "bulk", "invalid");
  el.innerHTML = "";
  el.classList.toggle("error", !!error);
  el.appendChild(make("i", iconCls(icon)));
  const text = make("span");
  parts.forEach((p, i) => text.appendChild(make(i % 2 ? "b" : "span", "", p)));
  el.appendChild(text);
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (el.hidden = true), NOTE_MS);
}

let progressUI = null;
let progressPoll = null;
let progressDelay = null;
let progressMode = null;
let conflictId = null;
let conflictAnswered = null;

function buildProgress() {
  if (!progressMode) return;
  const verb = { cut: "Переміщення", zip: "Архівування", unzip: "Розпакування" }[progressMode] || "Копіювання";
  const el = document.getElementById("note");
  confirmState = null;
  clearTimeout(noteTimer);
  bulkState = null;
  el.classList.remove("confirm", "danger", "error", "bulk", "invalid");
  el.classList.add("progress");
  el.innerHTML = "";
  el.appendChild(make("i", iconCls({ cut: "arrows-up-down-left-right", zip: "file-zipper", unzip: "box-open" }[progressMode] || "copy")));
  const label = make("span", "pg-label", verb + "…");
  const bar = make("span", "pg-bar");
  const fill = make("span", "pg-fill indeterminate");
  bar.appendChild(fill);
  const pct = make("b", "pg-pct", "");
  const bytes = make("span", "pg-bytes", "");
  el.append(label, bar, pct, bytes);
  el.hidden = false;
  progressUI = { el, label, fill, pct, bytes, verb };
}

function showConflict(c) {
  const el = document.getElementById("note");
  clearTimeout(progressDelay);
  progressDelay = null;
  progressUI = null;
  conflictId = c.id;
  confirmState = null;
  clearTimeout(noteTimer);
  bulkState = null;
  el.classList.remove("progress", "error", "danger", "bulk", "invalid");
  el.classList.add("confirm");
  el.innerHTML = "";
  const dot = c.name.lastIndexOf(".");
  const ext = dot > 0 ? c.name.slice(dot + 1).toLowerCase() : "";
  el.appendChild(make("i", iconCls(iconFor({ kind: c.dir ? "folder" : "file", ext }))));
  const text = make("span");
  [c.dir ? "Папка " : "Файл ", c.name, " вже існує!"].forEach((p, i) =>
    text.appendChild(make(i % 2 ? "b" : "span", "", p))
  );
  el.appendChild(text);
  let applyAll = false;
  const check = make("button", "sb-check");
  check.appendChild(make("i", "fa-solid fa-check"));
  const checkLabel = make("span", "sb-check-label", "Для всіх");
  const toggle = () => {
    applyAll = !applyAll;
    check.classList.toggle("checked", applyAll);
  };
  check.onclick = toggle;
  checkLabel.onclick = toggle;
  const answer = (value) => () => {
    conflictAnswered = c.id;
    conflictId = null;
    if (api()) api().resolve_conflict(value, applyAll && value !== "cancel");
    if (value === "cancel") {
      el.classList.remove("confirm");
      el.hidden = true;
      el.innerHTML = "";
    } else {
      buildProgress();
    }
  };
  const replace = make("button", "sb-btn", "Замінити");
  const skip = make("button", "sb-btn", "Пропустити");
  const cancel = make("button", "sb-btn", "Скасувати");
  replace.onclick = answer("replace");
  skip.onclick = answer("skip");
  cancel.onclick = answer("cancel");
  el.append(check, checkLabel, replace, skip, cancel);
  el.hidden = false;
}

async function progressTick() {
  if (!progressMode || !api()) return;
  let p;
  try {
    p = await api().get_progress();
  } catch (e) {
    return;
  }
  if (!progressMode || !p) return;
  if (p.conflict) {
    if (p.conflict.id !== conflictAnswered && p.conflict.id !== conflictId) showConflict(p.conflict);
    return;
  }
  if (!progressUI) return;
  progressUI.label.textContent = p.name ? `${progressUI.verb}: ${p.name}` : progressUI.verb + "…";
  if (p.total > 0) {
    const f = Math.min(1, p.done / p.total);
    progressUI.fill.classList.remove("indeterminate");
    progressUI.fill.style.width = (f * 100).toFixed(1) + "%";
    progressUI.pct.textContent = Math.floor(f * 100) + "%";
    progressUI.bytes.textContent = `${formatSize(p.done)} / ${formatSize(p.total)}`;
  }
}

function beginProgress(mode) {
  endProgress();
  progressMode = mode;
  conflictId = null;
  conflictAnswered = null;
  progressDelay = setTimeout(buildProgress, 400);
  progressPoll = setInterval(progressTick, 250);
}

function endProgress() {
  clearTimeout(progressDelay);
  clearInterval(progressPoll);
  progressDelay = progressPoll = null;
  const had = progressUI || conflictId;
  progressMode = null;
  conflictId = null;
  if (had) {
    const el = document.getElementById("note");
    el.classList.remove("progress", "confirm");
    el.hidden = true;
    el.innerHTML = "";
    progressUI = null;
  }
}

function showMsg(text) {
  showNote("triangle-exclamation", ["", text], true);
}

function selectedItems() {
  if (!currentData) return [];
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => currentData.items[i])
    .filter((it) => it && it.path && (it.kind === "folder" || it.kind === "file"));
}

function applyCut() {
  const cut = clipboard && clipboard.mode === "cut" ? new Set(clipboard.paths) : null;
  nodeList.forEach((node, i) => {
    const it = currentData && currentData.items[i];
    node.classList.toggle("cut", !!(cut && it && cut.has(it.path)));
  });
}

function copyToClipboard(mode) {
  const items = selectedItems();
  if (!items.length) return;
  clipboard = { mode, items, paths: items.map((it) => it.path) };
  applyCut();
}

async function afterFileOp(created, errors, ok) {
  if (currentLoc) await load(currentLoc);
  loadCounts();
  if (errors && errors.length) {
    showMsg(errors[0] + (errors.length > 1 ? ` (ще ${errors.length - 1})` : ""));
  } else if (ok) {
    showNote(ok.icon, ok.parts, false);
  }
  if (created.length && currentData && !currentData.error) {
    const set = new Set(created);
    const sel = new Set();
    currentData.items.forEach((it, i) => {
      if (set.has(it.path)) sel.add(i);
    });
    if (sel.size) {
      cursor = Math.min(...sel);
      setSelection(sel, cursor);
      scrollToItem(cursor);
    }
  }
}

async function pasteClipboard() {
  if (!api() || !clipboard || !currentData || !currentData.path || currentData.error) return;
  const cb = clipboard;
  const dest = currentData.path;
  const destLabel = currentData.address || dest;
  let res;
  beginProgress(cb.mode);
  try {
    res = await api().paste_items(cb.paths, dest, cb.mode);
  } catch (err) {
    endProgress();
    showMsg(String(err));
    return;
  }
  endProgress();
  const created = res.created || [];
  if (cb.mode === "cut" && created.length && !res.cancelled) clipboard = null;

  const verb = cb.mode === "cut" ? "переміщено" : "скопійовано";
  let ok = null;
  if (created.length === 1 && cb.items.length === 1) {
    const it = cb.items[0];
    ok = {
      icon: iconFor(it),
      parts: [it.kind === "folder" ? "Папка " : "Файл ", it.name, ` ${verb} в: `, destLabel],
    };
  } else if (created.length) {
    ok = {
      icon: cb.mode === "cut" ? "arrows-up-down-left-right" : "copy",
      parts: ["Елементів: ", String(created.length), ` ${verb} в: `, destLabel],
    };
  }
  if (res.cancelled) {
    ok = { icon: "ban", parts: ["Операцію скасовано"] };
  } else if (!created.length && !(res.errors && res.errors.length)) {
    ok = { icon: "forward", parts: ["Усі елементи пропущено"] };
  }
  await afterFileOp(created, res.errors || [], ok);
}

function zipSelected() {
  if (!api() || !currentData || currentData.error) return;
  if (currentLoc && currentLoc.place === "trash") return;
  const items = selectedItems();
  if (!items.length) return;
  const el = document.getElementById("note");
  dismissConfirm();
  clearTimeout(noteTimer);
  confirmState = null;
  el.classList.remove("progress", "error", "danger", "invalid");
  el.classList.add("confirm", "bulk");
  el.innerHTML = "";
  el.appendChild(make("i", iconCls("file-zipper")));
  const input = make("input", "bulk-input");
  input.type = "text";
  input.placeholder = "Назва архіву";
  input.spellcheck = false;
  input.autocomplete = "off";
  const first = items[0];
  input.value = first.kind === "folder" ? first.name : first.name.replace(/\.[^.]*$/, "") || first.name;
  const hint = make("span", "sb-fmt wide", "");
  const save = make("button", "sb-btn", "Зберегти");
  const cancel = make("button", "sb-btn", "Скасувати");
  el.append(input, hint, save, cancel);
  const st = { el, input, hint, items };
  bulkState = st;
  const fail = (msg) => {
    el.classList.add("invalid");
    hint.classList.add("err");
    hint.textContent = msg;
  };
  const commit = () => {
    let name = input.value.trim();
    if (!/\.zip$/i.test(name)) name += ".zip";
    const bad = invalidName(name);
    if (bad) return fail(bad);
    if (!inQuickLoc()) {
      const pool = ((currentData && (currentData.all || currentData.items)) || []).map((it) => it.name.toLowerCase());
      if (pool.includes(name.toLowerCase())) return fail(`${name} вже існує`);
    }
    cancelBulk();
    runZip(items, name);
  };
  input.addEventListener("input", () => {
    el.classList.remove("invalid");
    hint.classList.remove("err");
    hint.textContent = "";
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelBulk();
    }
  });
  save.onclick = commit;
  cancel.onclick = cancelBulk;
  el.hidden = false;
  input.focus();
  input.select();
}

async function runZip(items, name) {
  let res;
  beginProgress("zip");
  try {
    res = await api().zip_items(items.map((it) => it.path), name);
  } catch (err) {
    endProgress();
    showMsg(String(err));
    return;
  }
  endProgress();
  const created = res.created || [];
  const ok = created.length
    ? { icon: "file-zipper", parts: ["Архів створено: ", created[0].split(/[\\/]/).pop()] }
    : null;
  await afterFileOp(created, res.errors || [], ok);
}

async function unzipSelected() {
  if (!api() || !currentData || currentData.error) return;
  if (currentLoc && currentLoc.place === "trash") return;
  const items = selectedItems().filter((it) => it.kind === "file" && it.ext === "zip");
  if (!items.length) {
    showMsg("Серед вибраного немає ZIP-архівів");
    return;
  }
  let res;
  beginProgress("unzip");
  try {
    res = await api().unzip_items(items.map((it) => it.path));
  } catch (err) {
    endProgress();
    showMsg(String(err));
    return;
  }
  endProgress();
  const created = res.created || [];
  let ok = null;
  if (created.length === 1) {
    ok = { icon: "box-open", parts: ["Архів ", items[0].name, " розпаковано в: ", created[0].split(/[\\/]/).pop()] };
  } else if (created.length) {
    ok = { icon: "box-open", parts: ["Розпаковано архівів: ", String(created.length)] };
  }
  await afterFileOp(created, res.errors || [], ok);
}

async function copyPaths() {
  if (!api() || !currentData) return;
  const real = (p) => p && !p.includes("\x01") && !p.startsWith("::");
  let paths = selectedItems().map((it) => it.path).filter(real);
  if (!paths.length && real(currentData.path)) paths = [currentData.path];
  if (!paths.length) return;
  let ok = false;
  try {
    ok = await api().copy_text(paths.join("\n"));
  } catch (err) {
    ok = false;
  }
  if (!ok) {
    showMsg("Не вдалося скопіювати шлях");
    return;
  }
  showNote("copy", paths.length === 1 ? ["Шлях скопійовано: ", paths[0]] : ["Шляхів скопійовано: ", String(paths.length)]);
}

function openFolderInNewWindow() {
  if (!api() || !currentData) return;
  const folders = selectedItems().filter((it) => it.kind === "folder");
  if (folders.length) api().new_window(folders.map((it) => it.path));
}

let renameState = null;

function invalidName(v) {
  if (!v) return "Назва не може бути порожньою";
  if (v === "." || v === "..") return "Недопустима назва";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(v)) return "Назва містить недопустимі символи";
  if (v.endsWith(".")) return "Назва не може закінчуватися крапкою";
  return null;
}

function finishRenameUI(st) {
  if (st.input.parentNode) st.input.remove();
  st.label.hidden = false;
  if (renameState === st) renameState = null;
}

function cancelRename() {
  const st = renameState;
  if (!st) return;
  st.done = true;
  finishRenameUI(st);
}

async function commitRename() {
  const st = renameState;
  if (!st || st.done) return;
  st.done = true;
  const value = st.input.value.trim();
  finishRenameUI(st);
  if (!value || value === st.item.name) return;
  const bad = invalidName(value);
  if (bad) {
    showMsg(bad);
    return;
  }
  const pool = currentData && (currentData.all || currentData.items) || [];
  if (pool.some((it) => it !== st.item && it.name.toLowerCase() === value.toLowerCase())) {
    showMsg("Елемент з такою назвою вже існує");
    return;
  }
  let res;
  try {
    res = await api().rename_item(st.item.path, value);
  } catch (err) {
    showMsg(String(err));
    return;
  }
  if (!res || res.error) {
    showMsg((res && res.error) || "Не вдалося перейменувати");
    return;
  }
  await afterFileOp([res.path], [], {
    icon: iconFor(st.item),
    parts: [st.item.kind === "folder" ? "Папку " : "Файл ", st.item.name, " перейменовано на ", value],
  });
}

function startRename() {
  if (!api() || !currentData || currentData.error || renameState) return;
  if (inQuickLoc() || (currentLoc && currentLoc.place === "trash")) return;
  const items = selectedItems();
  if (items.length > 1) {
    startBulkRename(items);
    return;
  }
  if (items.length !== 1) return;
  const item = items[0];
  const node = nodeList[currentData.items.indexOf(item)];
  if (!node) return;
  const label = node.querySelector(".f-label") || node.querySelector(".f-name > span:last-child");
  if (!label) return;
  scrollToItem(currentData.items.indexOf(item));
  const input = make("input", "rename-input");
  input.type = "text";
  input.value = item.name;
  input.spellcheck = false;
  input.autocomplete = "off";
  label.hidden = true;
  label.parentNode.insertBefore(input, label);
  const st = { item, input, label, done: false };
  renameState = st;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  });
  input.addEventListener("blur", () => commitRename());
  input.focus();
  const dot = item.kind === "file" ? item.name.lastIndexOf(".") : -1;
  if (dot > 0) input.setSelectionRange(0, dot);
  else input.select();
}

const BULK_FORMATS = [
  (n, i) => `${n} (${i})`,
  (n, i) => `${n} ${i}`,
  (n, i) => `${n}_${i}`,
  (n, i, w) => `${n} ${String(i).padStart(w, "0")}`,
];

function bulkNames(items, base, fmt) {
  const w = Math.max(2, String(items.length).length);
  return items.map((it, i) => {
    const dot = it.kind === "file" ? it.name.lastIndexOf(".") : -1;
    const ext = dot > 0 ? it.name.slice(dot) : "";
    return BULK_FORMATS[fmt](base, i + 1, w) + ext;
  });
}

function cancelBulk() {
  if (!bulkState) return;
  const el = bulkState.el;
  bulkState = null;
  if (el.classList.contains("bulk")) {
    el.classList.remove("bulk", "confirm", "invalid");
    el.hidden = true;
    el.innerHTML = "";
  }
}

async function commitBulk() {
  const st = bulkState;
  if (!st || !api()) return;
  const fail = (msg) => {
    st.el.classList.add("invalid");
    st.hint.classList.add("err");
    st.hint.textContent = msg;
  };
  const base = st.input.value.trim();
  const bad = invalidName(base);
  if (bad) return fail(bad);
  const names = bulkNames(st.items, base, st.fmt);
  const bad2 = names.map(invalidName).find(Boolean);
  if (bad2) return fail(bad2);
  const moving = new Set(st.items);
  const pool = ((currentData && (currentData.all || currentData.items)) || [])
    .filter((it) => !moving.has(it))
    .map((it) => it.name.toLowerCase());
  const clash = names.find((n) => pool.includes(n.toLowerCase()));
  if (clash) return fail(`${clash} вже існує`);
  const pairs = [];
  st.items.forEach((it, i) => {
    if (it.name !== names[i]) pairs.push({ path: it.path, name: names[i] });
  });
  cancelBulk();
  if (!pairs.length) return;
  let res;
  try {
    res = await api().rename_many(pairs);
  } catch (err) {
    showMsg(String(err));
    return;
  }
  await afterFileOp(res.paths || [], res.errors || [], {
    icon: "pen",
    parts: ["Перейменовано елементів: ", String(pairs.length)],
  });
}

function startBulkRename(items) {
  const el = document.getElementById("note");
  dismissConfirm();
  clearTimeout(noteTimer);
  confirmState = null;
  el.classList.remove("progress", "error", "danger", "invalid");
  el.classList.add("confirm", "bulk");
  el.innerHTML = "";
  el.appendChild(make("i", iconCls("pen")));
  const input = make("input", "bulk-input");
  input.type = "text";
  input.placeholder = "Нова назва";
  input.spellcheck = false;
  input.autocomplete = "off";
  const sw = make("div", "view-switch fmt-switch");
  const FMT_LABELS = ["(1)", "1", "_1", "01"];
  const fmtBtns = FMT_LABELS.map((label, i) => {
    const b = make("button", "view-btn fmt-btn" + (i === 0 ? " active" : ""), label);
    b.type = "button";
    b.addEventListener("click", () => {
      st.fmt = i;
      fmtBtns.forEach((x, j) => x.classList.toggle("active", j === i));
      refresh();
      input.focus();
    });
    sw.appendChild(b);
    return b;
  });
  const hint = make("span", "sb-fmt", "");
  const save = make("button", "sb-btn", "Зберегти");
  const cancel = make("button", "sb-btn", "Скасувати");
  el.append(input, sw, hint, save, cancel);
  const st = { items, input, fmt: 0, hint, el };
  bulkState = st;
  const refresh = () => {
    el.classList.remove("invalid");
    hint.classList.remove("err");
    hint.textContent = bulkNames(items, "Назва", st.fmt)[0];
  };
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitBulk();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelBulk();
    }
  });
  save.onclick = commitBulk;
  cancel.onclick = cancelBulk;
  el.hidden = false;
  refresh();
  input.focus();
}

function canCreateHere() {
  if (!api() || !currentData || currentData.error || !currentData.path) return false;
  if (currentData.path.startsWith("::")) return false;
  return !(currentLoc && currentLoc.place === "trash");
}

async function commitCreate() {
  const st = bulkState;
  if (!st || !st.create || !api() || st.busy) return;
  const fail = (msg) => {
    st.el.classList.add("invalid");
    st.hint.classList.add("err");
    st.hint.textContent = msg;
    st.input.focus();
  };
  const name = st.input.value.trim();
  const bad = invalidName(name);
  if (bad) return fail(bad);
  const pool = (currentData && (currentData.all || currentData.items)) || [];
  if (pool.some((it) => it.name.toLowerCase() === name.toLowerCase())) {
    return fail("Елемент з такою назвою вже існує");
  }
  st.busy = true;
  let res;
  try {
    res = await api().create_item(st.dir, name, st.kind);
  } catch (err) {
    st.busy = false;
    return fail(String(err));
  }
  st.busy = false;
  if (!res || res.error) return fail((res && res.error) || "Не вдалося створити");
  cancelBulk();
  await afterFileOp([res.path], [], {
    icon: st.kind === "folder" ? "folder-plus" : "file-circle-plus",
    parts: [st.kind === "folder" ? "Створено папку " : "Створено файл ", name],
  });
}

function startCreate(kind) {
  if (!canCreateHere()) {
    showMsg("Тут не можна створювати файли чи папки");
    return;
  }
  const isFolder = kind === "folder";
  dismissConfirm();
  cancelRename();
  cancelBulk();
  if (searchEl.value) {
    searchEl.value = "";
    searchEl.dispatchEvent(new Event("input"));
  }
  const el = document.getElementById("note");
  clearTimeout(noteTimer);
  confirmState = null;
  el.classList.remove("progress", "error", "danger", "invalid");
  el.classList.add("confirm", "bulk");
  el.innerHTML = "";
  el.appendChild(make("i", iconCls(isFolder ? "folder-plus" : "file-circle-plus")));
  const input = make("input", "bulk-input");
  input.type = "text";
  input.placeholder = isFolder ? "Назва папки" : "Назва файлу";
  input.value = isFolder ? "Нова папка" : "Новий файл.txt";
  input.spellcheck = false;
  input.autocomplete = "off";
  const hint = make("span", "sb-fmt wide", "");
  const save = make("button", "sb-btn", "Зберегти");
  const cancel = make("button", "sb-btn", "Скасувати");
  el.append(input, hint, save, cancel);
  const st = { create: true, kind, dir: currentData.path, input, hint, el, busy: false };
  bulkState = st;
  input.addEventListener("input", () => {
    el.classList.remove("invalid");
    hint.classList.remove("err");
    hint.textContent = "";
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelBulk();
    }
  });
  save.onclick = commitCreate;
  cancel.onclick = cancelBulk;
  el.hidden = false;
  input.focus();
  const dot = !isFolder ? input.value.lastIndexOf(".") : -1;
  if (dot > 0) input.setSelectionRange(0, dot);
  else input.select();
}

async function undoLast() {
  if (!api()) return;
  let res;
  try {
    res = await api().undo();
  } catch (err) {
    showMsg(String(err));
    return;
  }
  if (!res || !res.ok) {
    showMsg("Немає що скасовувати");
    return;
  }
  const what = res.mode === "cut" ? "переміщення" : "копіювання";
  await afterFileOp(res.paths || [], res.errors || [], {
    icon: "rotate-left",
    parts: [`Скасовано ${what}: `, String(res.count || 0)],
  });
}

let rCtrl = false;
let rShift = false;
let rAlt = false;
let cursor = -1;
let placeCursor = -1;
const placeEls = [...document.querySelectorAll(".place")];

document.addEventListener("keyup", (e) => {
  if (e.code === "ControlRight") rCtrl = false;
  if (e.code === "ShiftRight") rShift = false;
  if (e.code === "AltRight") rAlt = false;
});
window.addEventListener("blur", () => {
  rCtrl = false;
  rShift = false;
  rAlt = false;
});

function clearPlaceCursor() {
  placeCursor = -1;
  placeEls.forEach((p) => p.classList.remove("kb"));
}

function movePlace(step) {
  const n = placeEls.length;
  if (placeCursor < 0) {
    const active = placeEls.findIndex((p) => p.classList.contains("active"));
    placeCursor = active >= 0 ? (active + step + n) % n : step > 0 ? 0 : n - 1;
  } else {
    placeCursor = (placeCursor + step + n) % n;
  }
  placeEls.forEach((p, i) => p.classList.toggle("kb", i === placeCursor));
  placeEls[placeCursor].scrollIntoView({ block: "nearest" });
}

function enterPlace(newTab) {
  if (placeCursor < 0) return;
  const key = placeEls[placeCursor].dataset.place;
  clearPlaceCursor();
  if (newTab) openInNewTab({ place: key });
  else navigate({ place: key });
}

function gridColumns() {
  if (!nodeList.length) return 1;
  const top = nodeList[0].offsetTop;
  return Math.max(1, nodeList.filter((n) => n.offsetTop === top).length);
}

function currentIndex() {
  if (!selected.size) return -1;
  if (cursor >= 0 && selected.has(cursor)) return cursor;
  if (anchor >= 0 && selected.has(anchor)) return anchor;
  return Math.max(...selected);
}

function scrollToItem(i) {
  const node = nodeList[i];
  if (!node) return;
  const r = node.getBoundingClientRect();
  const c = filesEl.getBoundingClientRect();
  const top = c.top + (currentView === "details" ? 28 : 0);
  const bottom = c.top + filesEl.clientHeight;
  if (r.top < top) filesEl.scrollTop -= top - r.top;
  else if (r.bottom > bottom) filesEl.scrollTop += r.bottom - bottom;
}

function moveCursor(dir, extend) {
  const n = currentData.items.length;
  if (!n) return;
  const step = dir * (currentView === "grid" ? gridColumns() : 1);
  const cur = currentIndex();
  let next;
  if (cur < 0) next = dir > 0 ? 0 : n - 1;
  else next = Math.min(n - 1, Math.max(0, cur + step));

  cursor = next;
  if (extend) {
    const from = anchor >= 0 ? anchor : cur >= 0 ? cur : next;
    const range = new Set();
    for (let i = Math.min(from, next); i <= Math.max(from, next); i++) range.add(i);
    setSelection(range, from);
  } else {
    setSelection(new Set([next]), next);
  }
  scrollToItem(next);
}

document.addEventListener("keydown", (e) => {
  if (confirmState && !(e.target.closest && e.target.closest("input"))) {
    if (e.key === "Enter") {
      e.preventDefault();
      acceptConfirm();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissConfirm();
      return;
    }
    if (!["Shift", "Control", "Alt", "Meta", "Delete"].includes(e.key)) dismissConfirm();
  }

  if (e.code === "ControlRight") rCtrl = true;
  else if (!e.ctrlKey) rCtrl = false;
  if (e.code === "ShiftRight") rShift = true;
  else if (!e.shiftKey) rShift = false;
  if (e.code === "AltRight") rAlt = true;
  else if (!e.altKey) rAlt = false;

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyR") {
    e.preventDefault();
    if (!editorOpen) refresh();
    return;
  }

  if (editorOpen) return;

  if ((e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyD") || (e.code === "F4" && !e.altKey && !e.ctrlKey)) {
    e.preventDefault();
    startAddressEdit();
    return;
  }

  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goForward(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); goUp(); }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyF") {
    e.preventDefault();
    closeKeys();
    closeGallery(true);
    closePlayer(true);
    closeAudio(true);
    searchEl.focus();
    searchEl.select();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyN") {
    e.preventDefault();
    if (!api()) return;
    if (e.shiftKey) openFolderInNewWindow();
    else api().new_window(null);
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "KeyK" || e.code === "KeyL")) {
    e.preventDefault();
    startCreate(e.code === "KeyK" ? "file" : "folder");
    return;
  }

  if (rCtrl && e.ctrlKey && ["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "ArrowDown") movePlace(1);
    else if (e.key === "ArrowUp") movePlace(-1);
    else enterPlace(rShift);
    return;
  }

  if (audioOpen && !(e.target.closest && e.target.closest("input"))) {
    audioKeyDown(e);
    return;
  }

  if (playerOpen && !(e.target.closest && e.target.closest("input"))) {
    playerKeyDown(e);
    return;
  }

  if (galleryOpen && !(e.target.closest && e.target.closest("input"))) {
    if (e.key === "Escape") { e.preventDefault(); closeGallery(); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === "ArrowLeft") { e.preventDefault(); galleryStep(-1); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === "ArrowRight") { e.preventDefault(); galleryStep(1); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Home") { e.preventDefault(); galleryGo(0); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key === "End") { e.preventDefault(); galleryGo(galleryList.length - 1); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && ["ArrowUp", "ArrowDown", "Enter", "Delete", "F2"].includes(e.key)) e.preventDefault();
    return;
  }

  if (!currentData || keysOpen || (e.target.closest && e.target.closest("input"))) return;

  if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {
    e.preventDefault();
    setSelection(new Set(currentData.items.map((_, i) => i)), 0);
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && e.code === "KeyC") {
    e.preventDefault();
    copyPaths();
    return;
  }

  if (
    !e.repeat &&
    !e.shiftKey &&
    !e.metaKey &&
    ((e.code === "AltRight" && rCtrl) || (e.code === "ControlRight" && rAlt))
  ) {
    e.preventDefault();
    unzipSelected();
    return;
  }

  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) togglePreview();
    return;
  }

  const altGr = typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
  if (e.ctrlKey && (e.altKey || altGr) && !e.metaKey && !e.shiftKey && e.code === "Space") {
    e.preventDefault();
    if (!(rCtrl && rAlt)) zipSelected();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyG") {
    e.preventDefault();
    const views = ["details", "list", "grid"];
    setView(views[(views.indexOf(currentView) + 1) % views.length]);
    render();
    if (api()) api().save_view(currentView);
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    if (e.code === "KeyC") { e.preventDefault(); copyToClipboard("copy"); return; }
    if (e.code === "KeyX") { e.preventDefault(); copyToClipboard("cut"); return; }
    if (e.code === "KeyV") { e.preventDefault(); pasteClipboard(); return; }
    if (e.code === "KeyZ") { e.preventDefault(); undoLast(); return; }
  }

  if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    askDelete(e.shiftKey);
    return;
  }

  if (e.key === "F2" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    startRename();
    return;
  }

  if (!e.ctrlKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    if (!currentData.error) moveCursor(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
    return;
  }

  if (e.key === "Enter") {
    const target = [...selected]
      .sort((a, b) => a - b)
      .map((i) => currentData.items[i])
      .find((it) => it && it.path && !isInactive(it));
    if (target) openItem(target);
  }
});

let galleryEl = null;
let galleryOpen = false;
let galleryReady = false;
let galleryList = [];
let galleryIdx = 0;
let galleryToken = 0;
let galleryTimer = null;
let galleryEpoch = 0;
const galleryFull = new Map();
const thumbCache = new Map();
const thumbQueue = [];
let thumbActive = 0;
let thumbObserver = null;
const GALLERY_FLIP_MS = 180;

function buildGallery() {
  const el = make("div", "gallery");
  el.hidden = true;

  const head = make("div", "g-head");
  head.appendChild(make("span"));
  head.appendChild(make("span", "g-title", "Галерея"));
  const close = make("button", "g-btn g-close");
  close.title = "Закрити галерею";
  close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  close.onclick = () => closeGallery();
  head.appendChild(close);

  const row = make("div", "g-row");
  const prev = make("button", "g-nav");
  prev.title = "Попереднє";
  prev.innerHTML = '<i class="fa-solid fa-angle-left"></i>';
  prev.onclick = () => galleryStep(-1);
  const next = make("button", "g-nav");
  next.title = "Наступне";
  next.innerHTML = '<i class="fa-solid fa-angle-right"></i>';
  next.onclick = () => galleryStep(1);
  const stage = make("div", "g-stage");
  const img = make("img", "g-img");
  img.hidden = true;
  img.draggable = false;
  const msg = make("div", "g-msg");
  msg.hidden = true;
  stage.append(img, msg);
  row.append(prev, stage, next);

  const cap = make("div", "g-cap");
  const strip = make("div", "g-strip");
  strip.addEventListener(
    "wheel",
    (e) => {
      if (!e.deltaY || e.shiftKey) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false }
  );

  el.append(head, row, cap, strip);
  filesEl.parentElement.appendChild(el);
  galleryEl = { el, prev, next, stage, img, msg, cap, strip };
}

function galleryMessage(text) {
  const g = galleryEl;
  g.img.hidden = true;
  g.img.removeAttribute("src");
  g.msg.textContent = text;
  g.msg.hidden = false;
  g.stage.classList.remove("loading");
}

function galleryLoadFull(path) {
  if (galleryFull.has(path)) return galleryFull.get(path);
  const p = (async () => {
    try {
      return await api().read_image(path);
    } catch (err) {
      return null;
    }
  })();
  galleryFull.set(path, p);
  p.then((r) => {
    if (!r || !r.url) galleryFull.delete(path);
  });
  return p;
}

function galleryCenterThumb(smooth) {
  const g = galleryEl;
  const t = g.strip.children[galleryIdx];
  if (!t) return;
  g.strip.scrollTo({
    left: t.offsetLeft - (g.strip.clientWidth - t.offsetWidth) / 2,
    behavior: smooth ? "smooth" : "auto",
  });
}

async function galleryShow() {
  const g = galleryEl;
  const it = galleryList[galleryIdx];
  if (!it) return;
  const token = ++galleryToken;
  const total = galleryList.length;
  const tag = `${galleryIdx + 1} / ${total}`;

  [...g.strip.children].forEach((t, i) => t.classList.toggle("active", i === galleryIdx));
  galleryCenterThumb(true);
  g.prev.hidden = total < 2;
  g.next.hidden = total < 2;
  g.cap.textContent = [it.name, tag].join(" • ");
  g.stage.classList.add("loading");

  const keep = new Set([it.path]);
  const neighbours = [galleryList[(galleryIdx + 1) % total], galleryList[(galleryIdx - 1 + total) % total]];
  neighbours.forEach((n) => n && keep.add(n.path));
  for (const k of [...galleryFull.keys()]) if (!keep.has(k)) galleryFull.delete(k);

  const res = await galleryLoadFull(it.path);
  if (token !== galleryToken || !galleryOpen) return;
  if (!res || !res.url) {
    galleryMessage((res && res.error) || "Не вдалося показати");
    return;
  }
  g.img.onload = () => {
    if (token !== galleryToken) return;
    const dims = `${g.img.naturalWidth}×${g.img.naturalHeight}`;
    const size = typeof it.size === "number" ? formatSize(it.size) : "";
    g.cap.textContent = [it.name, tag, dims, size].filter(Boolean).join(" • ");
  };
  g.img.onerror = () => {
    if (token === galleryToken) galleryMessage("Не вдалося показати");
  };
  g.img.src = res.url;
  g.img.hidden = false;
  g.msg.hidden = true;
  g.stage.classList.remove("loading");

  neighbours.forEach((n) => {
    if (n && n.path !== it.path) galleryLoadFull(n.path);
  });
}

function galleryGo(i) {
  if (!galleryOpen || !galleryReady || !galleryList.length) return;
  if (i < 0 || i >= galleryList.length || i === galleryIdx) return;
  galleryIdx = i;
  galleryShow();
}

function galleryStep(dir) {
  if (!galleryOpen || !galleryReady || galleryList.length < 2) return;
  galleryIdx = (galleryIdx + dir + galleryList.length) % galleryList.length;
  galleryShow();
}

function pumpThumbs() {
  while (thumbActive < 3 && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (job.epoch !== galleryEpoch || !galleryOpen) continue;
    thumbActive++;
    loadThumb(job).finally(() => {
      thumbActive--;
      pumpThumbs();
    });
  }
}

async function loadThumb(job) {
  const { it, img } = job;
  let url = thumbCache.get(it.path);
  if (!url) {
    let res = null;
    try {
      res = await api().read_thumb(it.path, 128);
    } catch (err) {
      res = null;
    }
    if (!res || !res.url) return;
    url = res.url;
    thumbCache.set(it.path, url);
    if (thumbCache.size > 600) thumbCache.delete(thumbCache.keys().next().value);
  }
  if (job.epoch !== galleryEpoch) return;
  img.onload = () => img.classList.add("ok");
  img.src = url;
}

function buildStrip() {
  const g = galleryEl;
  if (thumbObserver) thumbObserver.disconnect();
  thumbQueue.length = 0;
  g.strip.innerHTML = "";
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        thumbObserver.unobserve(en.target);
        const i = Number(en.target.dataset.g);
        const it = galleryList[i];
        if (!it) continue;
        thumbQueue.push({ it, img: en.target.querySelector("img"), epoch: galleryEpoch });
      }
      pumpThumbs();
    },
    { root: g.strip, rootMargin: "0px 240px" }
  );
  galleryList.forEach((it, i) => {
    const t = make("div", "g-thumb");
    t.dataset.g = String(i);
    t.title = it.name;
    t.innerHTML = '<i class="fa-solid fa-image"></i>';
    const im = make("img");
    im.draggable = false;
    im.alt = "";
    t.appendChild(im);
    t.onclick = () => galleryGo(i);
    g.strip.appendChild(t);
    thumbObserver.observe(t);
  });
}

function openGallery(item, instant) {
  if (galleryOpen || !currentData || currentData.error) return;
  const list = currentData.items.filter(isImageItem);
  const idx = list.findIndex((x) => x.path === item.path);
  if (idx < 0) return;
  if (previewOpen) closePreview();
  closeKeys();
  if (!galleryEl) buildGallery();

  galleryList = list;
  galleryIdx = idx;
  galleryOpen = true;
  galleryReady = false;
  galleryEpoch++;
  endDrag();

  const enter = () => {
    galleryTimer = null;
    filesEl.classList.remove("flip-out");
    filesEl.hidden = true;
    const g = galleryEl;
    g.el.hidden = false;
    g.el.classList.remove("out");
    if (!instant) g.el.classList.add("in");
    g.img.hidden = true;
    g.msg.hidden = true;
    buildStrip();
    galleryReady = true;
    galleryCenterThumb(false);
    galleryShow();
  };
  clearTimeout(galleryTimer);
  if (instant) enter();
  else {
    filesEl.classList.add("flip-out");
    galleryTimer = setTimeout(enter, GALLERY_FLIP_MS);
  }
}

function closeGallery(instant) {
  if (!galleryOpen) return;
  const wasReady = galleryReady;
  const cur = galleryList[galleryIdx];
  galleryOpen = false;
  galleryReady = false;
  galleryToken++;
  galleryEpoch++;
  thumbQueue.length = 0;
  if (thumbObserver) thumbObserver.disconnect();
  clearTimeout(galleryTimer);
  galleryTimer = null;
  filesEl.classList.remove("flip-out");

  const finish = (animate) => {
    galleryEl.el.hidden = true;
    galleryEl.el.classList.remove("in", "out");
    galleryEl.img.removeAttribute("src");
    galleryEl.strip.innerHTML = "";
    galleryFull.clear();
    filesEl.hidden = false;
    if (animate) {
      filesEl.classList.add("flip-in");
      setTimeout(() => filesEl.classList.remove("flip-in"), GALLERY_FLIP_MS + 40);
    }
    if (animate && cur && currentData && !currentData.error) {
      const i = currentData.items.findIndex((x) => x.path === cur.path);
      if (i >= 0) {
        cursor = i;
        setSelection(new Set([i]), i);
        scrollToItem(i);
      }
    }
  };

  if (instant || !wasReady) {
    finish(false);
    return;
  }
  galleryEl.el.classList.remove("in");
  galleryEl.el.classList.add("out");
  galleryTimer = setTimeout(() => {
    galleryTimer = null;
    finish(true);
  }, GALLERY_FLIP_MS);
}


const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mkv", "avi", "mov", "wmv", "flv", "ogv", "mpg", "mpeg", "3gp"]);

function isVideoItem(it) {
  return !!it && it.kind === "file" && !!it.path && VIDEO_EXTS.has(it.ext);
}

let playerEl = null;
let playerOpen = false;
let playerReady = false;
let playerList = [];
let playerIdx = 0;
let playerToken = 0;
let playerTimer = null;
let playerEpoch = 0;
let playerFs = false;
let playerIdleTimer = null;
let playerSeeking = false;
let playerResumeAt = null;
let playerDetached = false;
let playerVolume = 1;
let playerMuted = false;
const playerUrls = new Map();
const vthumbCache = new Map();
const vthumbQueue = [];
let vthumbActive = 0;
let vthumbObserver = null;

let volumeSaveTimer = null;

function saveVolumeNow() {
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = null;
  if (!api()) return;
  try {
    api().save_volume(playerVolume);
  } catch (err) {}
}

function saveVolumeSoon() {
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(saveVolumeNow, 800);
}

function fmtClock(sec) {
  sec = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function pBtn(cls, icon, title, fn) {
  const b = make("button", cls);
  b.title = title;
  b.tabIndex = -1;
  b.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = fn;
  return b;
}

function dragTrack(track, onPct) {
  const calc = (e) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    onPct(calc(e), "start");
    const move = (ev) => onPct(calc(ev), "move");
    const up = (ev) => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", up);
      onPct(calc(ev), "end");
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", up);
  });
}

function buildPlayer() {
  const el = make("div", "gallery player");
  el.hidden = true;

  const head = make("div", "g-head");
  head.appendChild(make("span"));
  head.appendChild(make("span", "g-title", "Відеоплеєр"));
  head.appendChild(pBtn("g-btn g-close", "xmark", "Закрити відеоплеєр", () => closePlayer()));

  const row = make("div", "g-row");
  const prev = pBtn("g-nav", "angle-left", "Попереднє відео", () => playerStep(-1));
  const next = pBtn("g-nav", "angle-right", "Наступне відео", () => playerStep(1));
  const stage = make("div", "g-stage");
  const video = document.createElement("video");
  video.className = "g-img";
  video.preload = "metadata";
  video.playsInline = true;
  video.controls = false;
  video.hidden = true;
  video.disablePictureInPicture = true;
  const msg = make("div", "g-msg");
  msg.hidden = true;
  stage.append(video, msg);
  row.append(prev, stage, next);

  const cap = make("div", "g-cap");

  const bar = make("div", "p-bar");
  const playBtn = pBtn("g-btn", "play", "Грати", () => playerPlay());
  const pauseBtn = pBtn("g-btn", "pause", "Пауза", () => video.pause());
  const cur = make("span", "p-time", "00:00:00");
  const seek = make("div", "p-track");
  seek.innerHTML = '<div class="p-fill"></div><div class="p-knob"></div>';
  const dur = make("span", "p-time", "00:00:00");
  const volBtn = pBtn("g-btn", "volume-high", "Вимкнути звук", () => playerToggleMute());
  const vol = make("div", "p-track p-vol");
  vol.innerHTML = '<div class="p-fill"></div><div class="p-knob"></div>';
  const pct = make("span", "p-pct", "100%");
  const fsBtn = pBtn("g-btn", "expand", "На весь екран", () => playerToggleFs());
  bar.append(playBtn, pauseBtn, cur, seek, dur, volBtn, vol, pct, fsBtn);

  const strip = make("div", "g-strip");
  strip.addEventListener(
    "wheel",
    (e) => {
      if (!e.deltaY || e.shiftKey) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false }
  );

  el.append(head, row, cap, bar, strip);
  filesEl.parentElement.appendChild(el);

  playerEl = {
    el, prev, next, stage, video, msg, cap, bar, playBtn, pauseBtn, cur, dur,
    seek, seekFill: seek.children[0], seekKnob: seek.children[1],
    volBtn, vol, volFill: vol.children[0], volKnob: vol.children[1], pct, fsBtn, strip,
  };

  video.onclick = () => playerToggle();
  video.ondblclick = () => playerToggleFs();
  video.addEventListener("timeupdate", () => { if (!playerSeeking) playerSyncTime(); });
  video.addEventListener("durationchange", playerSyncTime);
  video.addEventListener("play", playerSyncPlay);
  video.addEventListener("pause", playerSyncPlay);
  video.addEventListener("ended", playerSyncPlay);
  el.addEventListener("pointermove", playerKickIdle);

  dragTrack(seek, (p, phase) => {
    const d = video.duration;
    if (!Number.isFinite(d) || !d) return;
    if (phase === "start") playerSeeking = true;
    video.currentTime = p * d;
    playerEl.seekFill.style.width = p * 100 + "%";
    playerEl.seekKnob.style.left = p * 100 + "%";
    playerEl.cur.textContent = fmtClock(p * d);
    if (phase === "end") {
      playerSeeking = false;
      playerSyncTime();
    }
  });
  dragTrack(vol, (p) => {
    playerVolume = p;
    playerMuted = p === 0;
    playerApplyVolume(true);
  });
  playerApplyVolume(false);
  playerSyncPlay();
}

function playerSyncTime() {
  if (!playerEl) return;
  const v = playerEl.video;
  const d = Number.isFinite(v.duration) ? v.duration : 0;
  const c = v.currentTime || 0;
  const pct = d ? Math.min(100, (c / d) * 100) : 0;
  playerEl.cur.textContent = fmtClock(c);
  playerEl.dur.textContent = fmtClock(d);
  playerEl.seekFill.style.width = pct + "%";
  playerEl.seekKnob.style.left = pct + "%";
}

function playerSyncPlay() {
  if (!playerEl) return;
  const v = playerEl.video;
  const playing = !v.paused && !v.ended;
  playerEl.playBtn.classList.toggle("on", playing);
  playerEl.pauseBtn.classList.toggle("on", !playing);
  playerKickIdle();
}

function playerApplyVolume(save) {
  const shown = playerMuted ? 0 : playerVolume;
  const icon = shown === 0 ? "volume-xmark" : shown < 0.5 ? "volume-low" : "volume-high";
  for (const p of [playerEl, audioEl]) {
    if (!p) continue;
    const media = p.video || p.media;
    media.volume = playerVolume;
    media.muted = playerMuted;
    p.volFill.style.width = shown * 100 + "%";
    p.volKnob.style.left = shown * 100 + "%";
    p.pct.textContent = Math.round(shown * 100) + "%";
    p.volBtn.firstChild.className = "fa-solid fa-" + icon;
    p.volBtn.title = shown === 0 ? "Увімкнути звук" : "Вимкнути звук";
  }
  if (save) saveVolumeSoon();
}

function playerToggleMute() {
  playerMuted = !playerMuted;
  if (!playerMuted && playerVolume === 0) playerVolume = 0.5;
  playerApplyVolume(true);
}

function playerVolumeStep(delta) {
  playerVolume = Math.max(0, Math.min(1, Math.round((playerVolume + delta) * 100) / 100));
  playerMuted = playerVolume === 0;
  playerApplyVolume(true);
}

function playerPlay() {
  if (!playerOpen || !playerReady) return;
  const p = playerEl.video.play();
  if (p && p.catch) p.catch(() => {});
}

function playerToggle() {
  if (!playerOpen || !playerReady) return;
  const v = playerEl.video;
  if (v.paused || v.ended) playerPlay();
  else v.pause();
}

function playerSeekBy(sec) {
  const v = playerEl.video;
  if (!Number.isFinite(v.duration)) return;
  v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
}

function playerKickIdle() {
  if (!playerEl) return;
  const el = playerEl.el;
  el.classList.remove("idle");
  clearTimeout(playerIdleTimer);
  if (playerFs && !playerEl.video.paused) {
    playerIdleTimer = setTimeout(() => el.classList.add("idle"), 2500);
  }
}

function playerEnterFs() {
  if (playerFs || !playerEl) return;
  playerFs = true;
  playerEl.el.classList.add("fs");
  playerEl.fsBtn.firstChild.className = "fa-solid fa-compress";
  playerEl.fsBtn.title = "Вийти з повного екрана";
  try {
    const r = playerEl.el.requestFullscreen && playerEl.el.requestFullscreen();
    if (r && r.catch) r.catch(() => {});
  } catch (err) {}
  playerKickIdle();
}

function playerExitFs() {
  if (!playerFs || !playerEl) return;
  playerFs = false;
  clearTimeout(playerIdleTimer);
  playerEl.el.classList.remove("fs", "idle");
  playerEl.fsBtn.firstChild.className = "fa-solid fa-expand";
  playerEl.fsBtn.title = "На весь екран";
  if (document.fullscreenElement) {
    try {
      const r = document.exitFullscreen();
      if (r && r.catch) r.catch(() => {});
    } catch (err) {}
  }
}

function playerToggleFs() {
  if (!playerOpen || !playerReady) return;
  if (playerFs) playerExitFs();
  else playerEnterFs();
}

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && playerFs) playerExitFs();
});

function playerMessage(text, path) {
  const p = playerEl;
  p.video.onerror = null;
  p.video.pause();
  p.video.hidden = true;
  p.video.removeAttribute("src");
  p.video.load();
  p.msg.innerHTML = "";
  p.msg.appendChild(make("span", "", text));
  if (path) {
    const b = make("button", "g-open", "Відкрити в системному плеєрі");
    b.onclick = () => {
      if (api()) api().open_path(path);
    };
    p.msg.appendChild(b);
  }
  p.msg.hidden = false;
  p.stage.classList.remove("loading");
  p.dur.textContent = "00:00:00";
  p.cur.textContent = "00:00:00";
  p.seekFill.style.width = "0%";
  p.seekKnob.style.left = "0%";
  playerSyncPlay();
}

function playerGetUrl(path) {
  if (playerUrls.has(path)) return playerUrls.get(path);
  const pr = (async () => {
    try {
      return await api().video_url(path);
    } catch (err) {
      return null;
    }
  })();
  playerUrls.set(path, pr);
  pr.then((r) => {
    if (!r || !r.url) playerUrls.delete(path);
  });
  return pr;
}

function playerCenterThumb(smooth) {
  const g = playerEl;
  const t = g.strip.children[playerIdx];
  if (!t) return;
  g.strip.scrollTo({
    left: t.offsetLeft - (g.strip.clientWidth - t.offsetWidth) / 2,
    behavior: smooth ? "smooth" : "auto",
  });
}

async function playerShow() {
  const p = playerEl;
  const it = playerList[playerIdx];
  if (!it) return;
  const token = ++playerToken;
  const total = playerList.length;
  const tag = `${playerIdx + 1} / ${total}`;

  [...p.strip.children].forEach((t, i) => t.classList.toggle("active", i === playerIdx));
  playerCenterThumb(true);
  p.prev.hidden = total < 2;
  p.next.hidden = total < 2;
  p.cap.textContent = [it.name, tag].join(" • ");
  p.stage.classList.add("loading");
  p.video.pause();
  p.video.onerror = null;
  p.msg.hidden = true;

  const res = await playerGetUrl(it.path);
  if (token !== playerToken || !playerOpen) return;
  if (!res || !res.url) {
    playerMessage((res && res.error) || "Не вдалося відтворити", it.path);
    return;
  }
  p.video.onloadedmetadata = () => {
    if (token !== playerToken) return;
    const dims = p.video.videoWidth ? `${p.video.videoWidth}×${p.video.videoHeight}` : "";
    const size = typeof it.size === "number" ? formatSize(it.size) : "";
    p.cap.textContent = [it.name, tag, dims, size].filter(Boolean).join(" • ");
    p.stage.classList.remove("loading");
    playerSyncTime();
    const at = playerResumeAt;
    playerResumeAt = null;
    try {
      p.video.currentTime = at > 0 ? at : 0.001;
    } catch (err) {}
  };
  p.video.onerror = () => {
    if (token === playerToken) playerMessage("Не вдалося відтворити — формат не підтримується вбудованим плеєром", it.path);
  };
  p.video.src = res.url;
  p.video.hidden = false;
  p.video.load();
  playerApplyVolume(false);
  playerSyncTime();
  playerSyncPlay();
}

function playerGo(i) {
  if (!playerOpen || !playerReady || !playerList.length) return;
  if (i < 0 || i >= playerList.length || i === playerIdx) return;
  playerIdx = i;
  playerShow();
}

function playerStep(dir) {
  if (!playerOpen || !playerReady || playerList.length < 2) return;
  playerIdx = (playerIdx + dir + playerList.length) % playerList.length;
  playerShow();
}

function captureFrame(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.playsInline = true;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.onerror = v.onloadedmetadata = v.onseeked = null;
      v.removeAttribute("src");
      v.load();
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 8000);
    v.onerror = () => finish(null);
    v.onloadedmetadata = () => {
      const d = v.duration;
      v.currentTime = Number.isFinite(d) && d > 0 ? Math.min(1, d * 0.1) || 0.1 : 0.1;
    };
    v.onseeked = () => {
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) return finish(null);
        const c = document.createElement("canvas");
        c.width = c.height = 128;
        const sc = Math.max(128 / w, 128 / h);
        c.getContext("2d").drawImage(v, (128 - w * sc) / 2, (128 - h * sc) / 2, w * sc, h * sc);
        finish(c.toDataURL("image/jpeg", 0.7));
      } catch (err) {
        finish(null);
      }
    };
    v.src = url;
  });
}

function pumpVthumbs() {
  while (vthumbActive < 2 && vthumbQueue.length) {
    const job = vthumbQueue.shift();
    if (job.epoch !== playerEpoch || !playerOpen) continue;
    vthumbActive++;
    loadVthumb(job).finally(() => {
      vthumbActive--;
      pumpVthumbs();
    });
  }
}

async function loadVthumb(job) {
  const { it, img } = job;
  let url = vthumbCache.get(it.path);
  if (!url) {
    const res = await playerGetUrl(it.path);
    if (job.epoch !== playerEpoch || !res || !res.url) return;
    url = await captureFrame(res.url);
    if (!url) return;
    vthumbCache.set(it.path, url);
    if (vthumbCache.size > 300) vthumbCache.delete(vthumbCache.keys().next().value);
  }
  if (job.epoch !== playerEpoch) return;
  img.onload = () => img.classList.add("ok");
  img.src = url;
}

function buildPlayerStrip() {
  const g = playerEl;
  if (vthumbObserver) vthumbObserver.disconnect();
  vthumbQueue.length = 0;
  g.strip.innerHTML = "";
  vthumbObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        vthumbObserver.unobserve(en.target);
        const it = playerList[Number(en.target.dataset.g)];
        if (it) vthumbQueue.push({ it, img: en.target.querySelector("img"), epoch: playerEpoch });
      }
      pumpVthumbs();
    },
    { root: g.strip, rootMargin: "0px 240px" }
  );
  playerList.forEach((it, i) => {
    const t = make("div", "g-thumb");
    t.dataset.g = String(i);
    t.title = it.name;
    t.innerHTML = '<i class="fa-solid fa-film"></i>';
    const im = make("img");
    im.draggable = false;
    im.alt = "";
    t.appendChild(im);
    t.onclick = () => playerGo(i);
    g.strip.appendChild(t);
    vthumbObserver.observe(t);
  });
}

function openPlayer(item, instant, resumeAt) {
  if (playerOpen || galleryOpen || !currentData || currentData.error) return;
  const list = currentData.items.filter(isVideoItem);
  const idx = list.findIndex((x) => x.path === item.path);
  if (idx < 0) return;
  if (previewOpen) closePreview();
  closeKeys();
  stopDetachedPlayer();
  stopDetachedAudio();
  if (!playerEl) buildPlayer();

  playerResumeAt = resumeAt > 0 ? resumeAt : null;
  playerList = list;
  playerIdx = idx;
  playerOpen = true;
  playerReady = false;
  playerEpoch++;
  endDrag();

  const enter = () => {
    playerTimer = null;
    filesEl.classList.remove("flip-out");
    filesEl.hidden = true;
    const p = playerEl;
    p.el.hidden = false;
    p.el.classList.remove("out");
    if (!instant) p.el.classList.add("in");
    p.video.hidden = true;
    p.msg.hidden = true;
    buildPlayerStrip();
    playerReady = true;
    playerCenterThumb(false);
    playerShow();
  };
  clearTimeout(playerTimer);
  if (instant) enter();
  else {
    filesEl.classList.add("flip-out");
    playerTimer = setTimeout(enter, GALLERY_FLIP_MS);
  }
}

function closePlayer(instant) {
  if (!playerOpen) return;
  const wasReady = playerReady;
  const cur = playerList[playerIdx];
  saveVolumeNow();
  playerExitFs();
  playerOpen = false;
  playerReady = false;
  playerToken++;
  playerEpoch++;
  vthumbQueue.length = 0;
  if (vthumbObserver) vthumbObserver.disconnect();
  clearTimeout(playerTimer);
  playerTimer = null;
  filesEl.classList.remove("flip-out");
  if (playerEl) {
    playerEl.video.onerror = null;
    playerEl.video.pause();
  }

  const finish = (animate) => {
    const p = playerEl;
    p.el.hidden = true;
    p.el.classList.remove("in", "out");
    p.video.removeAttribute("src");
    p.video.load();
    p.strip.innerHTML = "";
    playerUrls.clear();
    filesEl.hidden = false;
    if (animate) {
      filesEl.classList.add("flip-in");
      setTimeout(() => filesEl.classList.remove("flip-in"), GALLERY_FLIP_MS + 40);
      if (cur && currentData && !currentData.error) {
        const i = currentData.items.findIndex((x) => x.path === cur.path);
        if (i >= 0) {
          cursor = i;
          setSelection(new Set([i]), i);
          scrollToItem(i);
        }
      }
    }
  };

  if (instant || !wasReady) {
    finish(false);
    return;
  }
  playerEl.el.classList.remove("in");
  playerEl.el.classList.add("out");
  playerTimer = setTimeout(() => {
    playerTimer = null;
    finish(true);
  }, GALLERY_FLIP_MS);
}

function playerKeyDown(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (e.code === "Space" || e.code === "KeyK") {
    e.preventDefault();
    playerToggle();
  } else if (k === "ArrowLeft") {
    e.preventDefault();
    if (playerReady) playerSeekBy(-5);
  } else if (k === "ArrowRight") {
    e.preventDefault();
    if (playerReady) playerSeekBy(5);
  } else if (k === "ArrowUp") {
    e.preventDefault();
    if (playerReady) playerVolumeStep(0.05);
  } else if (k === "ArrowDown") {
    e.preventDefault();
    if (playerReady) playerVolumeStep(-0.05);
  } else if (k === "PageUp") {
    e.preventDefault();
    playerStep(-1);
  } else if (k === "PageDown") {
    e.preventDefault();
    playerStep(1);
  } else if (e.code === "KeyM") {
    e.preventDefault();
    if (playerReady) playerToggleMute();
  } else if (e.code === "KeyF") {
    e.preventDefault();
    playerToggleFs();
  } else if (k === "Escape") {
    e.preventDefault();
    if (playerFs) playerExitFs();
    else closePlayer();
  } else if (["Enter", "Delete", "F2", "Home", "End"].includes(k)) {
    e.preventDefault();
  }
}


const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "weba"]);

function isAudioItem(it) {
  return !!it && it.kind === "file" && !!it.path && AUDIO_EXTS.has(it.ext);
}

let audioEl = null;
let audioOpen = false;
let audioReady = false;
let audioList = [];
let audioIdx = 0;
let audioToken = 0;
let audioTimer = null;
let audioEpoch = 0;
let audioSeeking = false;
let audioResumeAt = null;
let audioDetached = false;
const audioUrls = new Map();
const audioDurs = new Map();
const durQueue = [];
let durActive = 0;
let durObserver = null;

function fmtShort(sec) {
  sec = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function buildAudio() {
  const el = make("div", "gallery audio");
  el.hidden = true;

  const head = make("div", "g-head");
  head.appendChild(make("span"));
  head.appendChild(make("span", "g-title", "Аудіоплеєр"));
  head.appendChild(pBtn("g-btn g-close", "xmark", "Закрити аудіоплеєр", () => closeAudio()));

  const list = make("div", "a-list");
  const cap = make("div", "g-cap");

  const bar = make("div", "p-bar");
  const prevBtn = pBtn("g-btn", "backward-step", "Попередній трек", () => audioStep(-1));
  const playBtn = pBtn("g-btn", "play", "Грати", () => audioPlay());
  const pauseBtn = pBtn("g-btn", "pause", "Пауза", () => audioEl.media.pause());
  const nextBtn = pBtn("g-btn", "forward-step", "Наступний трек", () => audioStep(1));
  const cur = make("span", "p-time", "00:00:00");
  const seek = make("div", "p-track");
  seek.innerHTML = '<div class="p-fill"></div><div class="p-knob"></div>';
  const dur = make("span", "p-time", "00:00:00");
  const volBtn = pBtn("g-btn", "volume-high", "Вимкнути звук", () => playerToggleMute());
  const vol = make("div", "p-track p-vol");
  vol.innerHTML = '<div class="p-fill"></div><div class="p-knob"></div>';
  const pct = make("span", "p-pct", "100%");
  bar.append(prevBtn, playBtn, pauseBtn, nextBtn, cur, seek, dur, volBtn, vol, pct);

  el.append(head, list, cap, bar);
  filesEl.parentElement.appendChild(el);

  const media = new Audio();
  media.preload = "metadata";

  audioEl = {
    el, list, cap, bar, playBtn, pauseBtn, cur, dur, media,
    seek, seekFill: seek.children[0], seekKnob: seek.children[1],
    volBtn, vol, volFill: vol.children[0], volKnob: vol.children[1], pct,
  };

  media.addEventListener("timeupdate", () => { if (!audioSeeking) audioSyncTime(); });
  media.addEventListener("durationchange", audioSyncTime);
  media.addEventListener("play", audioSyncPlay);
  media.addEventListener("pause", audioSyncPlay);
  media.addEventListener("ended", () => {
    if (!audioOpen && !audioDetached) return;
    if (audioIdx + 1 < audioList.length) {
      audioIdx++;
      audioShow(true);
    } else {
      audioSyncPlay();
    }
  });

  dragTrack(seek, (p, phase) => {
    const d = media.duration;
    if (!Number.isFinite(d) || !d) return;
    if (phase === "start") audioSeeking = true;
    media.currentTime = p * d;
    audioEl.seekFill.style.width = p * 100 + "%";
    audioEl.seekKnob.style.left = p * 100 + "%";
    audioEl.cur.textContent = fmtClock(p * d);
    if (phase === "end") {
      audioSeeking = false;
      audioSyncTime();
    }
  });
  dragTrack(vol, (p) => {
    playerVolume = p;
    playerMuted = p === 0;
    playerApplyVolume(true);
  });
  playerApplyVolume(false);
  audioSyncPlay();
}

function audioSyncTime() {
  if (!audioEl) return;
  const m = audioEl.media;
  const d = Number.isFinite(m.duration) ? m.duration : 0;
  const c = m.currentTime || 0;
  const pct = d ? Math.min(100, (c / d) * 100) : 0;
  audioEl.cur.textContent = fmtClock(c);
  audioEl.dur.textContent = fmtClock(d);
  audioEl.seekFill.style.width = pct + "%";
  audioEl.seekKnob.style.left = pct + "%";
}

function audioRowMark() {
  if (!audioEl) return;
  const m = audioEl.media;
  const playing = !m.paused && !m.ended;
  [...audioEl.list.children].forEach((r, i) => {
    const num = r.firstChild;
    if (i === audioIdx) num.innerHTML = `<i class="fa-solid fa-${playing ? "volume-high" : "music"}"></i>`;
    else if (num.firstChild && num.firstChild.nodeType === 1) num.textContent = String(i + 1);
  });
}

function audioSyncPlay() {
  if (!audioEl) return;
  const m = audioEl.media;
  const playing = !m.paused && !m.ended;
  audioEl.playBtn.classList.toggle("on", playing);
  audioEl.pauseBtn.classList.toggle("on", !playing);
  audioRowMark();
}

function audioPlay() {
  if (!audioOpen || !audioReady) return;
  const p = audioEl.media.play();
  if (p && p.catch) p.catch(() => {});
}

function audioToggle() {
  if (!audioOpen || !audioReady) return;
  const m = audioEl.media;
  if (m.paused || m.ended) audioPlay();
  else m.pause();
}

function audioSeekBy(sec) {
  const m = audioEl.media;
  if (!Number.isFinite(m.duration)) return;
  m.currentTime = Math.max(0, Math.min(m.duration, m.currentTime + sec));
}

function audioGetUrl(path) {
  if (audioUrls.has(path)) return audioUrls.get(path);
  const pr = (async () => {
    try {
      return await api().audio_url(path);
    } catch (err) {
      return null;
    }
  })();
  audioUrls.set(path, pr);
  pr.then((r) => {
    if (!r || !r.url) audioUrls.delete(path);
  });
  return pr;
}

function audioScrollToRow() {
  const row = audioEl.list.children[audioIdx];
  if (!row) return;
  const l = audioEl.list;
  if (row.offsetTop < l.scrollTop) l.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > l.scrollTop + l.clientHeight) {
    l.scrollTop = row.offsetTop + row.offsetHeight - l.clientHeight;
  }
}

async function audioShow(play) {
  const a = audioEl;
  const it = audioList[audioIdx];
  if (!it) return;
  const token = ++audioToken;
  const total = audioList.length;
  const tag = `${audioIdx + 1} / ${total}`;
  const size = typeof it.size === "number" ? formatSize(it.size) : "";

  [...a.list.children].forEach((r, i) => {
    r.classList.toggle("active", i === audioIdx);
    r.classList.remove("bad");
  });
  audioScrollToRow();
  a.cap.textContent = [it.name, tag, size].filter(Boolean).join(" • ");
  a.media.pause();
  a.media.onerror = null;
  audioRowMark();

  const res = await audioGetUrl(it.path);
  if (token !== audioToken || !(audioOpen || audioDetached)) return;
  if (!res || !res.url) {
    audioFail((res && res.error) || "Не вдалося відтворити", it);
    return;
  }
  a.media.onloadedmetadata = () => {
    if (token !== audioToken) return;
    if (Number.isFinite(a.media.duration)) {
      audioDurs.set(it.path, a.media.duration);
      const d = a.list.children[audioIdx] && a.list.children[audioIdx].querySelector(".a-dur");
      if (d) d.textContent = fmtShort(a.media.duration);
    }
    const at = audioResumeAt;
    audioResumeAt = null;
    if (at > 0) {
      try {
        a.media.currentTime = at;
      } catch (err) {}
    }
    audioSyncTime();
  };
  a.media.onerror = () => {
    if (token === audioToken) audioFail("Не вдалося відтворити — формат не підтримується вбудованим плеєром", it);
  };
  a.media.src = res.url;
  a.media.load();
  playerApplyVolume(false);
  audioSyncTime();
  audioSyncPlay();
  if (play) {
    const pr = a.media.play();
    if (pr && pr.catch) pr.catch(() => {});
  }
}

function audioFail(text, it) {
  const a = audioEl;
  a.media.onerror = null;
  a.media.pause();
  a.media.removeAttribute("src");
  a.media.load();
  const row = a.list.children[audioIdx];
  if (row) row.classList.add("bad");
  a.cap.textContent = "";
  a.cap.appendChild(make("span", "", text));
  const b = make("button", "g-open", "Відкрити в системному плеєрі");
  b.onclick = () => {
    if (api()) api().open_path(it.path);
  };
  a.cap.appendChild(b);
  a.cur.textContent = "00:00:00";
  a.dur.textContent = "00:00:00";
  a.seekFill.style.width = "0%";
  a.seekKnob.style.left = "0%";
  audioSyncPlay();
}

function audioGo(i) {
  if (!audioOpen || !audioReady || i < 0 || i >= audioList.length) return;
  if (i === audioIdx) {
    audioToggle();
    return;
  }
  const m = audioEl.media;
  const wasPlaying = !m.paused && !m.ended;
  audioIdx = i;
  audioShow(wasPlaying);
}

function audioStep(dir) {
  if (!audioOpen || !audioReady || audioList.length < 2) return;
  const m = audioEl.media;
  const wasPlaying = !m.paused && !m.ended;
  audioIdx = (audioIdx + dir + audioList.length) % audioList.length;
  audioShow(wasPlaying);
}

function probeDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.onloadedmetadata = a.onerror = null;
      a.removeAttribute("src");
      a.load();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 6000);
    a.onloadedmetadata = () => finish(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => finish(null);
    a.src = url;
  });
}

function pumpDurs() {
  while (durActive < 3 && durQueue.length) {
    const job = durQueue.shift();
    if (job.epoch !== audioEpoch || !audioOpen) continue;
    durActive++;
    loadDur(job).finally(() => {
      durActive--;
      pumpDurs();
    });
  }
}

async function loadDur(job) {
  const { it, el } = job;
  let d = audioDurs.get(it.path);
  if (d == null) {
    const res = await audioGetUrl(it.path);
    if (job.epoch !== audioEpoch || !res || !res.url) return;
    d = await probeDuration(res.url);
    if (d == null) return;
    audioDurs.set(it.path, d);
  }
  if (job.epoch === audioEpoch) el.textContent = fmtShort(d);
}

function buildAudioList() {
  const a = audioEl;
  if (durObserver) durObserver.disconnect();
  durQueue.length = 0;
  a.list.innerHTML = "";
  durObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        durObserver.unobserve(en.target);
        const it = audioList[Number(en.target.dataset.a)];
        if (it) durQueue.push({ it, el: en.target.querySelector(".a-dur"), epoch: audioEpoch });
      }
      pumpDurs();
    },
    { root: a.list, rootMargin: "120px 0px" }
  );
  audioList.forEach((it, i) => {
    const r = make("div", "a-row");
    r.dataset.a = String(i);
    r.title = it.name;
    const known = audioDurs.get(it.path);
    r.append(
      make("span", "a-num", String(i + 1)),
      make("span", "a-name", it.name),
      make("span", "a-dur", known != null ? fmtShort(known) : "--:--"),
      make("span", "a-size", typeof it.size === "number" ? formatSize(it.size) : "")
    );
    r.onclick = () => audioGo(i);
    a.list.appendChild(r);
    durObserver.observe(r);
  });
}

function openAudio(item, instant, resumeAt) {
  if (audioOpen || playerOpen || galleryOpen || !currentData || currentData.error) return;
  const list = currentData.items.filter(isAudioItem);
  const idx = list.findIndex((x) => x.path === item.path);
  if (idx < 0) return;
  if (previewOpen) closePreview();
  closeKeys();
  stopDetachedPlayer();
  stopDetachedAudio();
  if (!audioEl) buildAudio();

  audioResumeAt = resumeAt > 0 ? resumeAt : null;
  audioList = list;
  audioIdx = idx;
  audioOpen = true;
  audioReady = false;
  audioEpoch++;
  endDrag();

  const enter = () => {
    audioTimer = null;
    filesEl.classList.remove("flip-out");
    filesEl.hidden = true;
    const a = audioEl;
    a.el.hidden = false;
    a.el.classList.remove("out");
    if (!instant) a.el.classList.add("in");
    buildAudioList();
    audioReady = true;
    audioShow(false);
  };
  clearTimeout(audioTimer);
  if (instant) enter();
  else {
    filesEl.classList.add("flip-out");
    audioTimer = setTimeout(enter, GALLERY_FLIP_MS);
  }
}

function closeAudio(instant) {
  if (!audioOpen) return;
  const wasReady = audioReady;
  const cur = audioList[audioIdx];
  saveVolumeNow();
  audioOpen = false;
  audioReady = false;
  audioToken++;
  audioEpoch++;
  durQueue.length = 0;
  if (durObserver) durObserver.disconnect();
  clearTimeout(audioTimer);
  audioTimer = null;
  filesEl.classList.remove("flip-out");
  if (audioEl) {
    audioEl.media.onerror = null;
    audioEl.media.pause();
  }

  const finish = (animate) => {
    const a = audioEl;
    a.el.hidden = true;
    a.el.classList.remove("in", "out");
    a.media.removeAttribute("src");
    a.media.load();
    a.list.innerHTML = "";
    audioUrls.clear();
    filesEl.hidden = false;
    if (animate) {
      filesEl.classList.add("flip-in");
      setTimeout(() => filesEl.classList.remove("flip-in"), GALLERY_FLIP_MS + 40);
      if (cur && currentData && !currentData.error) {
        const i = currentData.items.findIndex((x) => x.path === cur.path);
        if (i >= 0) {
          cursor = i;
          setSelection(new Set([i]), i);
          scrollToItem(i);
        }
      }
    }
  };

  if (instant || !wasReady) {
    finish(false);
    return;
  }
  audioEl.el.classList.remove("in");
  audioEl.el.classList.add("out");
  audioTimer = setTimeout(() => {
    audioTimer = null;
    finish(true);
  }, GALLERY_FLIP_MS);
}

function audioKeyDown(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (e.code === "Space" || e.code === "KeyK") {
    e.preventDefault();
    audioToggle();
  } else if (k === "ArrowLeft") {
    e.preventDefault();
    if (audioReady) audioSeekBy(-5);
  } else if (k === "ArrowRight") {
    e.preventDefault();
    if (audioReady) audioSeekBy(5);
  } else if (k === "ArrowUp") {
    e.preventDefault();
    if (audioReady) playerVolumeStep(0.05);
  } else if (k === "ArrowDown") {
    e.preventDefault();
    if (audioReady) playerVolumeStep(-0.05);
  } else if (k === "PageUp") {
    e.preventDefault();
    audioStep(-1);
  } else if (k === "PageDown") {
    e.preventDefault();
    audioStep(1);
  } else if (e.code === "KeyM") {
    e.preventDefault();
    if (audioReady) playerToggleMute();
  } else if (k === "Escape") {
    e.preventDefault();
    closeAudio();
  } else if (["Enter", "Delete", "F2", "Home", "End"].includes(k)) {
    e.preventDefault();
  }
}


const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "json", "jsonc", "json5", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "css", "scss", "less", "html", "htm", "xhtml", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "env", "properties", "csv", "tsv", "py", "pyw", "pyi", "java", "kt", "kts", "c", "h", "cpp", "cc",
  "cxx", "hpp", "hh", "cs", "go", "rs", "php", "rb", "lua", "pl", "sh", "bash", "zsh", "bat", "cmd",
  "ps1", "psm1", "sql", "diff", "patch", "gitignore", "gitattributes", "editorconfig", "dockerfile",
  "mk", "cmake", "gradle", "vue", "svelte", "tex", "srt", "vtt", "rst", "adoc", "lock", "reg", "inf",
  "service", "desktop", "gitkeep", "npmrc", "prettierrc", "eslintrc",
]);

function isTextItem(it) {
  return !!it && it.kind === "file" && !!it.path && (it.ext === "" || TEXT_EXTS.has(it.ext));
}

const ED_BASE = "vendor/codemirror/";
const ED_JS = ["mode/javascript/javascript.js"];
const ED_CSS = ["mode/css/css.js"];
const ED_XML = ["mode/xml/xml.js"];
const ED_HTML = ["mode/xml/xml.js", "mode/javascript/javascript.js", "mode/css/css.js", "mode/htmlmixed/htmlmixed.js"];
const ED_CLIKE = ["mode/clike/clike.js"];
const ED_SIMPLE = ["addon/mode/simple.js"];

const ED_LANGS = {
  text: { label: "Текст", spec: "text/plain", scripts: [] },
  makefile: { label: "Makefile", spec: "text/plain", scripts: [], tabs: true },
  javascript: { label: "JavaScript", spec: "text/javascript", scripts: ED_JS },
  jsx: { label: "JSX", spec: "text/jsx", scripts: ED_JS },
  typescript: { label: "TypeScript", spec: "text/typescript", scripts: ED_JS },
  tsx: { label: "TSX", spec: "text/typescript-jsx", scripts: ED_JS },
  json: { label: "JSON", spec: { name: "javascript", json: true }, scripts: ED_JS },
  css: { label: "CSS", spec: "text/css", scripts: ED_CSS },
  scss: { label: "SCSS", spec: "text/x-scss", scripts: ED_CSS },
  less: { label: "Less", spec: "text/x-less", scripts: ED_CSS },
  html: { label: "HTML", spec: "text/html", scripts: ED_HTML },
  xml: { label: "XML", spec: "application/xml", scripts: ED_XML },
  markdown: { label: "Markdown", spec: "text/x-markdown", scripts: ["mode/xml/xml.js", "mode/meta.js", "mode/markdown/markdown.js"] },
  python: { label: "Python", spec: "text/x-python", scripts: ["mode/python/python.js"] },
  c: { label: "C", spec: "text/x-csrc", scripts: ED_CLIKE },
  cpp: { label: "C++", spec: "text/x-c++src", scripts: ED_CLIKE },
  java: { label: "Java", spec: "text/x-java", scripts: ED_CLIKE },
  csharp: { label: "C#", spec: "text/x-csharp", scripts: ED_CLIKE },
  kotlin: { label: "Kotlin", spec: "text/x-kotlin", scripts: ED_CLIKE },
  go: { label: "Go", spec: "text/x-go", scripts: ["mode/go/go.js"], tabs: true },
  rust: { label: "Rust", spec: "text/x-rustsrc", scripts: [...ED_SIMPLE, "mode/rust/rust.js"] },
  php: { label: "PHP", spec: "application/x-httpd-php", scripts: [...ED_HTML, ...ED_CLIKE, "mode/php/php.js"] },
  ruby: { label: "Ruby", spec: "text/x-ruby", scripts: ["mode/ruby/ruby.js"] },
  lua: { label: "Lua", spec: "text/x-lua", scripts: ["mode/lua/lua.js"] },
  perl: { label: "Perl", spec: "text/x-perl", scripts: ["mode/perl/perl.js"] },
  shell: { label: "Shell", spec: "text/x-sh", scripts: ["mode/shell/shell.js"] },
  powershell: { label: "PowerShell", spec: "application/x-powershell", scripts: ["mode/powershell/powershell.js"] },
  sql: { label: "SQL", spec: "text/x-sql", scripts: ["mode/sql/sql.js"] },
  yaml: { label: "YAML", spec: "text/x-yaml", scripts: ["mode/yaml/yaml.js"] },
  toml: { label: "TOML", spec: "text/x-toml", scripts: ["mode/toml/toml.js"] },
  properties: { label: "INI / Properties", spec: "text/x-properties", scripts: ["mode/properties/properties.js"] },
  diff: { label: "Diff", spec: "text/x-diff", scripts: ["mode/diff/diff.js"] },
  dockerfile: { label: "Dockerfile", spec: "text/x-dockerfile", scripts: [...ED_SIMPLE, "mode/dockerfile/dockerfile.js"] },
  cmake: { label: "CMake", spec: "text/x-cmake", scripts: ["mode/cmake/cmake.js"] },
  tex: { label: "TeX", spec: "text/x-stex", scripts: ["mode/stex/stex.js"] },
};

const ED_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  json: "json", jsonc: "json", json5: "json", css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html", xml: "xml",
  md: "markdown", markdown: "markdown", py: "python", pyw: "python", pyi: "python",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", java: "java",
  cs: "csharp", kt: "kotlin", kts: "kotlin", go: "go", rs: "rust", php: "php", rb: "ruby",
  lua: "lua", pl: "perl", sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", psm1: "powershell",
  sql: "sql", yml: "yaml", yaml: "yaml", toml: "toml", ini: "properties", cfg: "properties",
  conf: "properties", env: "properties", properties: "properties", diff: "diff", patch: "diff",
  dockerfile: "dockerfile", cmake: "cmake", mk: "makefile", tex: "tex", gradle: "text",
};

const ED_NAMES = { dockerfile: "dockerfile", makefile: "makefile", "cmakelists.txt": "cmake", ".gitignore": "text" };
const ED_ENC = { "utf-8": "UTF-8", "utf-8-sig": "UTF-8 BOM", "utf-16": "UTF-16", cp1251: "Windows-1251", "latin-1": "Latin-1" };

let editorEl = null;
let editorOpen = false;
let editorReady = false;
let edTimer = null;
const edDocs = [];
let edActive = null;
let edSeq = 0;
let edModal = null;
let edBusy = false;
let edClosing = false;
const edScripts = new Map();

function edPathKey(p) {
  const k = String(p).replace(/\\/g, "/");
  return /^[a-z]:/i.test(k) ? k.toLowerCase() : k;
}

function edLangFor(it) {
  const byName = ED_NAMES[String(it.name || "").toLowerCase()];
  const key = byName || ED_EXT[it.ext] || "text";
  return ED_LANGS[key] || ED_LANGS.text;
}

function edLoadScript(src) {
  if (!edScripts.has(src)) {
    edScripts.set(
      src,
      new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = ED_BASE + src;
        s.onload = () => resolve(true);
        s.onerror = () => {
          edScripts.delete(src);
          resolve(false);
        };
        document.head.appendChild(s);
      })
    );
  }
  return edScripts.get(src);
}

async function edLoadLang(lang) {
  for (const f of lang.scripts) {
    if (!(await edLoadScript(f))) return false;
  }
  return true;
}

function edDetectIndent(text, lang) {
  let tabs = 0;
  let spaces = 0;
  let min = 0;
  for (const ln of text.slice(0, 30000).split(/\r\n|\r|\n/)) {
    if (!ln) continue;
    if (ln[0] === "\t") tabs++;
    else if (ln.startsWith("  ") && /\S/.test(ln)) {
      spaces++;
      const n = /^ +/.exec(ln)[0].length;
      if (!min || n < min) min = n;
    }
  }
  const useTabs = tabs + spaces ? tabs > spaces : !!lang.tabs;
  return { tabs: useTabs, indent: min === 2 || min === 4 || min === 8 ? min : 4 };
}

function buildEditor() {
  const el = make("div", "gallery editor");
  el.hidden = true;

  const head = make("div", "g-head");
  head.appendChild(make("span"));
  head.appendChild(make("span", "g-title", "Редактор"));
  const close = make("button", "g-btn g-close");
  close.title = "Закрити редактор";
  close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  close.onclick = () => closeEditor();
  head.appendChild(close);

  const tabsBox = make("div", "e-tabs");
  tabsBox.addEventListener(
    "wheel",
    (e) => {
      if (!e.deltaY || e.shiftKey) return;
      e.preventDefault();
      tabsBox.scrollLeft += e.deltaY;
    },
    { passive: false }
  );

  const wrap = make("div", "e-wrap");

  const status = make("div", "e-status");
  const sPath = make("span", "e-path");
  const sPos = make("span", "e-seg");
  const sLang = make("span", "e-seg");
  const sEnc = make("span", "e-seg");
  const sEol = make("button", "e-seg e-eol");
  sEol.title = "Змінити кінці рядків (LF / CRLF)";
  sEol.onclick = () => edToggleEol();
  const sState = make("span", "e-seg e-state");
  status.append(sPath, sPos, sLang, sEnc, sEol, sState);

  el.append(head, tabsBox, wrap, status);
  filesEl.parentElement.appendChild(el);

  const cm = CodeMirror(wrap, {
    value: "",
    lineNumbers: true,
    theme: "consolio",
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    styleActiveLine: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    lineWrapping: false,
    extraKeys: {
      Tab: (c) => {
        if (c.somethingSelected()) c.execCommand("indentMore");
        else c.execCommand(c.getOption("indentWithTabs") ? "insertTab" : "insertSoftTab");
      },
      "Shift-Tab": "indentLess",
      "Ctrl-/": "toggleComment",
      "Ctrl-H": "replace",
    },
  });
  cm.on("change", () => {
    if (edActive) edUpdateDirty(edActive);
  });
  cm.on("cursorActivity", edStatus);

  editorEl = { el, tabs: tabsBox, wrap, cm, sPath, sPos, sLang, sEnc, sEol, sState };
}

function edStatus() {
  const e = editorEl;
  if (!e) return;
  const d = edActive;
  if (!d) {
    for (const k of ["sPath", "sPos", "sLang", "sEnc", "sEol", "sState"]) e[k].textContent = "";
    return;
  }
  const c = e.cm.getCursor();
  const sel = e.cm.somethingSelected() ? e.cm.getSelection().length : 0;
  e.sPath.textContent = d.path;
  e.sPath.title = d.path;
  e.sPos.textContent = "Рядок " + (c.line + 1) + ", стовпець " + (c.ch + 1) + (sel ? " (вибрано " + sel + ")" : "");
  e.sLang.textContent = d.lang.label;
  e.sEnc.textContent = ED_ENC[d.enc] || d.enc;
  e.sEol.textContent = d.eol === "\r\n" ? "CRLF" : "LF";
  e.sState.textContent = d.dirty ? "● Не збережено" : "Збережено";
  e.sState.classList.toggle("dirty", d.dirty);
}

function edUpdateDirty(d) {
  const now = !d.doc.isClean(d.gen) || d.eol !== d.eolSaved;
  if (now !== d.dirty) {
    d.dirty = now;
    edRenderTabs();
  }
  if (d === edActive) edStatus();
}

function edToggleEol() {
  const d = edActive;
  if (!d || edModal) return;
  d.eol = d.eol === "\r\n" ? "\n" : "\r\n";
  edUpdateDirty(d);
  editorEl.cm.focus();
}

function edRenderTabs() {
  if (!editorEl) return;
  const box = editorEl.tabs;
  box.innerHTML = "";
  for (const d of edDocs) {
    const t = make("div", "e-tab" + (d === edActive ? " active" : "") + (d.dirty ? " dirty" : ""));
    t.title = d.path;
    const ic = make("i", iconCls(iconFor({ kind: "file", ext: d.ext })));
    const nm = make("span", "e-name", d.name);
    const dot = make("span", "e-dot");
    const x = make("button", "e-close");
    x.title = "Закрити вкладку";
    x.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
    t.append(ic, nm, dot, x);
    t.onmousedown = (e) => {
      if (e.button === 1) e.preventDefault();
    };
    t.onclick = () => {
      if (edModal) return;
      if (d !== edActive) edActivate(d);
      else editorEl.cm.focus();
    };
    t.onauxclick = (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      edCloseDoc(d);
    };
    x.onclick = (e) => {
      e.stopPropagation();
      edCloseDoc(d);
    };
    box.appendChild(t);
    if (d === edActive && editorOpen) t.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function edRememberView() {
  if (!edActive || !editorEl) return;
  const s = editorEl.cm.getScrollInfo();
  edActive.scroll = { left: s.left, top: s.top };
}

function edActivate(d) {
  if (!d || !editorEl) return;
  const cm = editorEl.cm;
  if (edActive && edActive !== d) edRememberView();
  edActive = d;
  if (cm.getDoc() !== d.doc) cm.swapDoc(d.doc);
  cm.setOption("indentWithTabs", d.tabs);
  cm.setOption("indentUnit", d.indent);
  cm.setOption("tabSize", d.tabs ? 4 : d.indent);
  cm.refresh();
  cm.scrollTo(d.scroll.left, d.scroll.top);
  edRenderTabs();
  edStatus();
  if (editorReady && !edModal) cm.focus();
}

function edCycle(step) {
  if (edDocs.length < 2) return;
  const i = edDocs.indexOf(edActive);
  edActivate(edDocs[(i + step + edDocs.length) % edDocs.length]);
}

function edAsk(title, text, buttons) {
  if (edModal || !editorEl) return Promise.resolve("cancel");
  const cm = editorEl.cm;
  return new Promise((resolve) => {
    const back = make("div", "e-modal");
    const box = make("div", "e-box");
    box.append(make("div", "e-box-title", title), make("div", "e-box-text", text));
    const row = make("div", "e-box-btns");
    let primary = null;
    const prevRO = cm.getOption("readOnly");
    const done = (id) => {
      if (edModal !== state) return;
      edModal = null;
      back.remove();
      cm.setOption("readOnly", prevRO);
      resolve(id);
      if (editorOpen) cm.focus();
    };
    const state = { done };
    for (const b of buttons) {
      const btn = make("button", "e-btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : ""), b.label);
      btn.onclick = () => done(b.id);
      if (b.primary) primary = btn;
      row.appendChild(btn);
    }
    box.appendChild(row);
    back.appendChild(box);
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) done("cancel");
    });
    edModal = state;
    cm.setOption("readOnly", "nocursor");
    editorEl.el.appendChild(back);
    (primary || row.firstChild).focus();
  });
}

async function edSave(d, force) {
  d = d || edActive;
  if (!d || d.saving || !api()) return false;
  d.saving = true;
  let result = null;
  try {
    const gen = d.doc.changeGeneration(true);
    const text = d.doc.getValue();
    const eol = d.eol;
    try {
      result = await api().write_text(d.path, text, d.enc, eol, force ? null : d.mtime);
    } catch (err) {
      result = { error: String(err) };
    }
    if (result && result.conflict) {
      d.saving = false;
      const a = await edAsk(
        "Файл змінено поза редактором",
        "«" + d.name + "» уже змінила інша програма. Перезаписати файл вашою версією?",
        [
          { id: "cancel", label: "Скасувати", primary: true },
          { id: "overwrite", label: "Перезаписати", danger: true },
        ]
      );
      if (a !== "overwrite") return false;
      return await edSave(d, true);
    }
    if (!result || result.error) {
      showNote("triangle-exclamation", ["Не вдалося зберегти ", d.name, " — " + ((result && result.error) || "невідома помилка")], true);
      return false;
    }
    d.mtime = result.mtime;
    if (result.enc && result.enc !== d.enc) {
      d.enc = result.enc;
      showNote("triangle-exclamation", ["", d.name, " збережено в UTF-8: символи не вміщалися в попереднє кодування"], true);
    } else {
      showNote("floppy-disk", ["Збережено ", d.name]);
    }
    d.eolSaved = eol;
    d.gen = gen;
    edUpdateDirty(d);
    return true;
  } finally {
    d.saving = false;
  }
}

async function edSaveAll() {
  for (const d of edDocs.filter((x) => x.dirty)) {
    if (!(await edSave(d))) {
      if (editorOpen) edActivate(d);
      return false;
    }
  }
  return true;
}

function edResetCm() {
  if (editorEl) editorEl.cm.swapDoc(new CodeMirror.Doc(""));
}

async function edCloseDoc(d) {
  if (edModal || !edDocs.includes(d)) return;
  if (d.dirty) {
    edActivate(d);
    const a = await edAsk("Зберегти зміни у «" + d.name + "»?", "Без збереження зміни буде втрачено.", [
      { id: "save", label: "Зберегти", primary: true },
      { id: "discard", label: "Не зберігати", danger: true },
      { id: "cancel", label: "Скасувати" },
    ]);
    if (a === "cancel") return;
    if (a === "save" && !(await edSave(d))) return;
  }
  const i = edDocs.indexOf(d);
  if (i < 0) return;
  edDocs.splice(i, 1);
  if (!edDocs.length) {
    edActive = null;
    edResetCm();
    hideEditor(false, d.path, true);
    return;
  }
  if (edActive === d) {
    edActive = null;
    edActivate(edDocs[Math.min(i, edDocs.length - 1)]);
  } else {
    edRenderTabs();
  }
}

async function closeEditor() {
  if (!editorOpen || edClosing) return;
  edClosing = true;
  try {
    const dirty = edDocs.filter((d) => d.dirty);
    if (dirty.length) {
      const one = dirty.length === 1;
      const a = await edAsk(
        one ? "Зберегти зміни у «" + dirty[0].name + "»?" : "Є незбережені зміни у файлах: " + dirty.length,
        "Без збереження зміни буде втрачено.",
        [
          { id: "save", label: one ? "Зберегти" : "Зберегти все", primary: true },
          { id: "discard", label: "Не зберігати", danger: true },
          { id: "cancel", label: "Скасувати" },
        ]
      );
      if (a === "cancel") return;
      if (a === "save" && !(await edSaveAll())) return;
    }
    if (!editorOpen) return;
    const cur = edActive;
    edDocs.length = 0;
    edActive = null;
    edResetCm();
    hideEditor(false, cur && cur.path, true);
  } finally {
    edClosing = false;
  }
}

async function edGuardExit() {
  if (!edDocs.some((d) => d.dirty)) return true;
  if (!editorOpen) showEditor(true);
  if (!editorOpen) return true;
  const n = edDocs.filter((d) => d.dirty).length;
  const a = await edAsk("Є незбережені зміни у файлах: " + n, "Зберегти їх перед виходом?", [
    { id: "save", label: "Зберегти все і вийти", primary: true },
    { id: "discard", label: "Вийти без збереження", danger: true },
    { id: "cancel", label: "Скасувати" },
  ]);
  if (a === "cancel") return false;
  if (a === "save") return await edSaveAll();
  return true;
}

function showEditor(instant) {
  if (editorOpen || !edDocs.length || !editorEl) return;
  if (previewOpen) closePreview();
  closeKeys();
  editorOpen = true;
  editorReady = false;
  endDrag();

  const enter = () => {
    edTimer = null;
    filesEl.classList.remove("flip-out");
    filesEl.hidden = true;
    editorEl.el.hidden = false;
    editorEl.el.classList.remove("out");
    if (!instant) editorEl.el.classList.add("in");
    editorReady = true;
    edActivate(edActive && edDocs.includes(edActive) ? edActive : edDocs[0]);
    if (!instant) {
      setTimeout(() => {
        if (editorOpen) editorEl.cm.refresh();
      }, GALLERY_FLIP_MS + 60);
    }
  };
  clearTimeout(edTimer);
  if (instant) enter();
  else {
    filesEl.classList.add("flip-out");
    edTimer = setTimeout(enter, GALLERY_FLIP_MS);
  }
}

function hideEditor(instant, selectPath, quiet) {
  if (!editorOpen) return;
  const wasReady = editorReady;
  edRememberView();
  if (edModal) edModal.done("cancel");
  editorOpen = false;
  editorReady = false;
  clearTimeout(edTimer);
  edTimer = null;
  filesEl.classList.remove("flip-out");
  const e = editorEl;

  const finish = (animate) => {
    e.el.hidden = true;
    e.el.classList.remove("in", "out");
    filesEl.hidden = false;
    if (animate) {
      filesEl.classList.add("flip-in");
      setTimeout(() => filesEl.classList.remove("flip-in"), GALLERY_FLIP_MS + 40);
      if (selectPath && currentData && !currentData.error) {
        const i = currentData.items.findIndex((x) => x.path === selectPath);
        if (i >= 0) {
          cursor = i;
          setSelection(new Set([i]), i);
          scrollToItem(i);
        }
      }
    }
  };

  if (!quiet && edDocs.some((d) => d.dirty)) {
    showNote("floppy-disk", ["Незбережені зміни лишилися в ", "Редакторі", " — відкрийте будь-який текстовий файл, щоб повернутися"]);
  }
  if (instant || !wasReady) {
    finish(false);
    return;
  }
  e.el.classList.remove("in");
  e.el.classList.add("out");
  edTimer = setTimeout(() => {
    edTimer = null;
    finish(true);
  }, GALLERY_FLIP_MS);
}

async function edLoadDoc(it) {
  let r;
  try {
    r = await api().read_text(it.path);
  } catch (err) {
    r = { error: String(err) };
  }
  if (!r || r.error) return { error: (r && r.error) || "Не вдалося прочитати файл" };
  let lang = edLangFor(it);
  if (!(await edLoadLang(lang))) lang = ED_LANGS.text;
  const ind = edDetectIndent(r.text, lang);
  const doc = new CodeMirror.Doc(r.text, lang.spec);
  return {
    d: {
      id: ++edSeq,
      path: it.path,
      name: it.name,
      ext: it.ext || "",
      lang,
      enc: r.enc,
      eol: r.eol,
      eolSaved: r.eol,
      mtime: r.mtime,
      doc,
      gen: doc.changeGeneration(true),
      dirty: false,
      saving: false,
      scroll: { left: 0, top: 0 },
      tabs: ind.tabs,
      indent: ind.indent,
    },
  };
}

async function openEditor(items) {
  items = (items || []).filter(isTextItem);
  if (!items.length || !api() || edBusy) return;
  if (typeof CodeMirror === "undefined") {
    showNote("triangle-exclamation", ["Редактор недоступний: ", "CodeMirror", " не завантажено (папка vendor/codemirror)"], true);
    return;
  }
  edBusy = true;
  try {
    let first = null;
    let failed = null;
    for (const it of items) {
      let d = edDocs.find((x) => edPathKey(x.path) === edPathKey(it.path));
      if (!d) {
        const r = await edLoadDoc(it);
        if (r.error) {
          if (!failed) failed = [it.name, r.error];
          continue;
        }
        d = r.d;
        edDocs.push(d);
      }
      if (!first) first = d;
    }
    if (failed) showNote("triangle-exclamation", ["Не вдалося відкрити ", failed[0], " — " + failed[1]], true);
    if (!first) return;
    if (!editorEl) buildEditor();
    if (editorOpen) {
      edActivate(first);
    } else {
      edActive = first;
      showEditor(false);
    }
  } finally {
    edBusy = false;
  }
}

function editorTargets(item) {
  const sel = [...selected]
    .sort((a, b) => a - b)
    .map((i) => currentData.items[i])
    .filter(isTextItem);
  return sel.length > 1 && sel.some((x) => x.path === item.path) ? sel : [item];
}

document.addEventListener("keydown", (e) => {
  if (!editorOpen) return;
  if (edModal) {
    if (e.key === "Escape") {
      e.preventDefault();
      edModal.done("cancel");
    }
    return;
  }
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  if (mod && e.code === "KeyS") {
    e.preventDefault();
    if (e.shiftKey) edSaveAll();
    else edSave();
  } else if (mod && !e.shiftKey && e.code === "KeyW") {
    e.preventDefault();
    if (edActive) edCloseDoc(edActive);
  } else if (mod && !e.shiftKey && (e.code === "PageDown" || e.code === "PageUp")) {
    e.preventDefault();
    edCycle(e.code === "PageDown" ? 1 : -1);
  } else if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    closeEditor();
  }
});


function detachPlayer() {
  const p = playerEl;
  playerExitFs();
  playerOpen = false;
  playerReady = false;
  playerDetached = true;
  clearTimeout(playerTimer);
  playerTimer = null;
  vthumbQueue.length = 0;
  filesEl.classList.remove("flip-out");
  p.el.hidden = true;
  p.el.classList.remove("in", "out");
  filesEl.hidden = false;
}

function detachAudio() {
  const a = audioEl;
  audioOpen = false;
  audioReady = false;
  audioDetached = true;
  clearTimeout(audioTimer);
  audioTimer = null;
  durQueue.length = 0;
  filesEl.classList.remove("flip-out");
  a.el.hidden = true;
  a.el.classList.remove("in", "out");
  filesEl.hidden = false;
}

function stopDetachedPlayer() {
  if (!playerDetached) return;
  playerDetached = false;
  playerToken++;
  playerEpoch++;
  vthumbQueue.length = 0;
  if (vthumbObserver) vthumbObserver.disconnect();
  const p = playerEl;
  p.video.onerror = null;
  p.video.pause();
  p.video.removeAttribute("src");
  p.video.load();
  p.strip.innerHTML = "";
  playerUrls.clear();
}

function stopDetachedAudio() {
  if (!audioDetached) return;
  audioDetached = false;
  audioToken++;
  audioEpoch++;
  durQueue.length = 0;
  if (durObserver) durObserver.disconnect();
  const a = audioEl;
  a.media.onerror = null;
  a.media.pause();
  a.media.removeAttribute("src");
  a.media.load();
  a.list.innerHTML = "";
  audioUrls.clear();
}

function reattachPlayer() {
  const p = playerEl;
  if (previewOpen) closePreview();
  endDrag();
  playerDetached = false;
  playerOpen = true;
  playerReady = true;
  playerEpoch++;
  filesEl.hidden = true;
  p.el.hidden = false;
  p.el.classList.remove("in", "out");
  buildPlayerStrip();
  [...p.strip.children].forEach((t, i) => t.classList.toggle("active", i === playerIdx));
  playerCenterThumb(false);
  playerApplyVolume(false);
  playerSyncTime();
  playerSyncPlay();
}

function reattachAudio() {
  const a = audioEl;
  if (previewOpen) closePreview();
  endDrag();
  audioDetached = false;
  audioOpen = true;
  audioReady = true;
  audioEpoch++;
  filesEl.hidden = true;
  a.el.hidden = false;
  a.el.classList.remove("in", "out");
  buildAudioList();
  [...a.list.children].forEach((r, i) => r.classList.toggle("active", i === audioIdx));
  audioScrollToRow();
  playerApplyVolume(false);
  audioSyncTime();
  audioSyncPlay();
}

function suspendMedia() {
  const tab = activeTab();
  if (galleryOpen && galleryReady) {
    const it = galleryList[galleryIdx];
    if (tab && it) tab.media = { kind: "gallery", loc: currentLoc, path: it.path };
  } else if (playerOpen && playerReady && playerEl) {
    const it = playerList[playerIdx];
    const v = playerEl.video;
    const playing = !v.paused && !v.ended;
    if (tab && it) {
      tab.media = { kind: "player", loc: currentLoc, path: it.path, time: v.currentTime || 0, live: playing };
      if (playing) detachPlayer();
    }
  } else if (audioOpen && audioReady && audioEl) {
    const it = audioList[audioIdx];
    const m = audioEl.media;
    const playing = !m.paused && !m.ended;
    if (tab && it) {
      tab.media = { kind: "audio", loc: currentLoc, path: it.path, time: m.currentTime || 0, live: playing };
      if (playing) detachAudio();
    }
  }
  closeGallery(true);
  closePlayer(true);
  closeAudio(true);
}

function restoreMediaForTab() {
  const tab = activeTab();
  if (!tab || !tab.media) return;
  const saved = tab.media;
  tab.media = null;
  if (!currentData || currentData.error || !sameLocation(currentLoc, saved.loc)) return;
  if (saved.live) {
    if (saved.kind === "player" && playerDetached && playerList[playerIdx] && playerList[playerIdx].path === saved.path) {
      reattachPlayer();
      return;
    }
    if (saved.kind === "audio" && audioDetached && audioList[audioIdx] && audioList[audioIdx].path === saved.path) {
      reattachAudio();
      return;
    }
  }
  if (saved.kind === "editor") {
    if (edDocs.length) showEditor(true);
    return;
  }
  const item = currentData.items.find((it) => it.path && it.path === saved.path);
  if (!item) return;
  if (saved.kind === "gallery") openGallery(item, true);
  else if (saved.kind === "player") openPlayer(item, true, saved.time);
  else if (saved.kind === "audio") openAudio(item, true, saved.time);
}

const SHORTCUTS = [
  {
    title: "Вкладки",
    rows: [
      ["Ctrl+Tab | Ctrl+Shift+Tab", "Наступна / попередня вкладка"],
      ["Ctrl+T", "Нова вкладка"],
      ["Ctrl+W", "Закрити вкладку (швидкий доступ і остання звичайна не закриваються)"],
      ["Ctrl+H", "Відкрити швидкий доступ"],
    ],
  },
  {
    title: "Вікно",
    rows: [
      ["Ctrl+N", "Нове вікно провідника"],
      ["Ctrl+K", "Створити файл у поточній папці"],
      ["Ctrl+L", "Створити папку в поточній папці"],
    ],
  },
  {
    title: "Навігація",
    rows: [
      ["Alt+←", "Назад"],
      ["Alt+→", "Вперед"],
      ["Alt+↑", "На рівень вгору"],
      ["Ctrl+R", "Оновити (те саме, що кнопка оновлення)"],
    ],
  },
  {
    title: "Файли й папки",
    rows: [
      ["↑ | ↓", "Попередній / наступний елемент (у плитках — рядок вгору / вниз)"],
      ["Shift+↑ | Shift+↓", "Розширити виділення"],
      ["Ctrl+A", "Виділити все"],
      ["Ctrl+G", "Змінити вигляд: таблиця → список → плитки"],
      ["Ctrl+Space", "Показати / сховати прев'ю вибраного зображення (↑ ↓ — інші файли, для кількох вибраних ← → — гортати їх, Esc — закрити)"],
      ["Ctrl+F", "Пошук по назві в поточній папці (↓ або Enter — перейти до списку)"],
      ["Enter", "Відкрити вибране (зображення — у галереї, відео й аудіо — у плеєрах, текстові файли — у Редакторі: кілька вибраних відкриваються по вкладках; у швидкому доступі — і інші файли)"],
      ["Ctrl+C", "Копіювати вибране"],
      ["Ctrl+X", "Вирізати вибране"],
      ["Ctrl+V", "Вставити в поточну папку"],
      ["Ctrl+Z", "Скасувати останню вставку чи архівування"],
      ["Ctrl+Shift+C", "Копіювати шлях вибраного (без вибору — шлях поточної папки)"],
      ["Ctrl+Alt+Space", "Стиснути вибране в ZIP-архів поруч (спершу питає назву)"],
      ["R.Ctrl+R.Alt", "Розпакувати вибрані ZIP-архіви поруч, кожен у папку з його назвою"],
      ["Ctrl+Shift+N", "Відкрити вибрану папку в новому вікні"],
      ["F2", "Перейменувати вибраний елемент; для кількох — групове перейменування з нумерацією (Enter — підтвердити, Esc — скасувати)"],
      ["Del", "Відправити вибране в смітник (з підтвердженням)"],
      ["Shift+Del", "Видалити вибране назавжди (з підтвердженням)"],
    ],
  },
  {
    title: "Галерея",
    rows: [
      ["← | →", "Попереднє / наступне зображення"],
      ["Home | End", "Перше / останнє зображення"],
      ["Esc", "Закрити галерею й повернутися до файлів"],
    ],
  },
  {
    title: "Відеоплеєр",
    rows: [
      ["Space | K", "Грати / пауза (відео не стартує саме — спершу натисніть ▶)"],
      ["← | →", "Перемотати на 5 секунд назад / вперед"],
      ["↑ | ↓", "Гучність +5% / −5%"],
      ["PageUp | PageDown", "Попереднє / наступне відео в папці"],
      ["M", "Вимкнути / увімкнути звук"],
      ["F", "Повноекранний режим (подвійний клік по відео — теж)"],
      ["Esc", "Вийти з повного екрана, потім закрити плеєр"],
    ],
  },
  {
    title: "Аудіоплеєр",
    rows: [
      ["Space | K", "Грати / пауза (трек не стартує сам — спершу натисніть ▶)"],
      ["← | →", "Перемотати на 5 секунд назад / вперед"],
      ["↑ | ↓", "Гучність +5% / −5%"],
      ["PageUp | PageDown", "Попередній / наступний трек"],
      ["M", "Вимкнути / увімкнути звук"],
      ["Esc", "Закрити плеєр"],
    ],
  },
  {
    title: "Редактор",
    rows: [
      ["Ctrl+S", "Зберегти поточний файл"],
      ["Ctrl+Shift+S", "Зберегти всі змінені файли"],
      ["Ctrl+W", "Закрити вкладку редактора (якщо є зміни — спитає)"],
      ["Ctrl+PageDown | Ctrl+PageUp", "Наступна / попередня вкладка редактора"],
      ["Ctrl+F", "Пошук у файлі"],
      ["Ctrl+G | Ctrl+Shift+G", "Знайти далі / назад"],
      ["Ctrl+H", "Заміна"],
      ["Alt+G", "Перейти до рядка"],
      ["Ctrl+/", "Закоментувати / розкоментувати"],
      ["Tab | Shift+Tab", "Додати / зменшити відступ"],
      ["Esc", "Закрити редактор (про незбережені зміни спитає)"],
    ],
  },
  {
    title: "Бічна панель",
    rows: [
      ["R.Ctrl+↑ | R.Ctrl+↓", "Гортати місця бічної панелі"],
      ["R.Ctrl+Enter", "Увійти в вибране місце"],
      ["R.Ctrl+R.Shift+Enter", "Відкрити вибране місце в новій вкладці"],
    ],
  },
  {
    title: "Миша",
    rows: [
      ["Клік", "Виділити елемент"],
      ["Ctrl+клік", "Додати до виділення / зняти"],
      ["Shift+клік", "Виділити діапазон"],
      ["Протяг", "Рамка виділення по порожньому місцю"],
      ["Подвійний клік", "Відкрити папку, зображення в галереї, відео чи музику в плеєрі або текстовий файл у Редакторі (у швидкому доступі — і інші файли)"],
      ["Перетягнути на ★", "Додати вибране у швидкий доступ"],
      ["СКМ по папці", "Відкрити в новій вкладці"],
      ["СКМ по вкладці", "Закрити вкладку"],
      ["СКМ по місцю", "Відкрити місце бічної панелі в новій вкладці"],
      ["Подвійний клік по заголовку", "Розгорнути / відновити вікно"],
      ["Клік по частині шляху", "Перейти в цю папку (стрілка поруч показує вкладені папки)"],
      ["Клік по вільному місцю адреси / Alt+D / F4", "Ввести шлях вручну, Enter — перейти"],
    ],
  },
  {
    title: "Інше",
    rows: [
      ["Ctrl+J", "Відкрити / закрити цю таблицю комбінацій клавіш"],
      ["Esc", "Скасувати перетягування чи видалення, очистити пошук, закрити цю таблицю"],
    ],
  },
  {
    title: "Пошук (Ctrl+F)",
    rows: [
      ["слова", "Усі слова мають бути в назві, порядок неважливий"],
      ["\"фраза\"", "Шукати точну послідовність символів"],
      ["*.py  звіт??.docx", "Маски: * — будь-які символи, ? — один символ"],
      ["ext:jpg,png", "Лише файли з такими розширеннями"],
      ["type:folder / type:file", "Лише папки / лише файли"],
      ["in:проєкти", "Шлях до файлу має містити цей фрагмент"],
      ["Кнопка біля пошуку", "Перемкнути: поточна папка з підпапками / увесь комп'ютер"],
    ],
  },
];

const keysEl = document.getElementById("keys");
const keysTabEl = document.getElementById("tab-keys");
let keysOpen = false;

function buildKeys() {
  keysEl.innerHTML = "";
  for (const sec of SHORTCUTS) {
    keysEl.appendChild(make("div", "k-title", sec.title.toUpperCase()));
    for (const [keys, desc] of sec.rows) {
      const row = make("div", "k-row");
      const box = make("div", "k-keys");
      for (const combo of keys.split(" | ")) {
        const c = make("span", "k-combo");
        combo.split("+").forEach((k, i) => {
          if (i) c.appendChild(make("i", "", "+"));
          c.appendChild(make("kbd", "", k));
        });
        box.appendChild(c);
      }
      row.appendChild(box);
      row.appendChild(make("span", "k-desc", desc));
      keysEl.appendChild(row);
    }
  }
}

function openKeys() {
  hideEditor(true);
  closeGallery(true);
  closePlayer(true);
  closeAudio(true);
  if (!keysEl.childElementCount) buildKeys();
  keysOpen = true;
  endDrag();
  keysEl.hidden = false;
  filesEl.hidden = true;
  keysTabEl.classList.add("active");
  document.body.classList.add("keys-open");
}

function closeKeys() {
  if (!keysOpen) return;
  keysOpen = false;
  keysEl.hidden = true;
  filesEl.hidden = false;
  keysTabEl.classList.remove("active");
  document.body.classList.remove("keys-open");
}

keysTabEl.onclick = () => (keysOpen ? closeKeys() : openKeys());

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeKeys();
});

document.getElementById("nav-back").onclick = goBack;
document.getElementById("nav-forward").onclick = goForward;
document.getElementById("nav-up").onclick = goUp;
document.getElementById("nav-refresh").onclick = refresh;

updateNav();

let removableSnap = null;
let removableSig = null;
const noteQueue = [];

function flushNotes() {
  if (confirmState || !noteQueue.length) return;
  showNote("usb", noteQueue.shift());
}

async function pollRemovable(force) {
  if (!api()) return;
  let list;
  try {
    list = await api().removable_devices(!!force);
  } catch (err) {
    return;
  }
  if (!Array.isArray(list)) return;
  const next = new Map(list.map((d) => [d.path, d.name]));
  if (removableSnap) {
    let changed = false;
    for (const [path, name] of next) {
      if (!removableSnap.has(path)) {
        noteQueue.push(["Змінний носій ", name, " підключено"]);
        changed = true;
      }
    }
    for (const [path, name] of removableSnap) {
      if (!next.has(path)) {
        noteQueue.push(["Змінний носій ", name, " вийнято"]);
        changed = true;
      }
    }
    if (changed) {
      loadCounts();
      if (
        currentLoc &&
        (currentLoc.place === "removable" || currentLoc.place === "pc") &&
        !keysOpen &&
        !galleryOpen &&
        !playerOpen &&
        !audioOpen &&
        !editorOpen &&
        !confirmState
      ) {
        load(currentLoc);
      }
    }
  }
  const sig = list.map((d) => d.path + ":" + (d.active === false ? 0 : 1)).sort().join("|");
  if (
    removableSig !== null &&
    sig !== removableSig &&
    currentLoc &&
    currentLoc.place === "removable" &&
    !keysOpen &&
    !galleryOpen &&
    !playerOpen &&
    !audioOpen &&
    !editorOpen &&
    !confirmState
  ) {
    load(currentLoc);
  }
  removableSig = sig;
  removableSnap = next;
  flushNotes();
}

let polling = false;

async function pollLoop(force) {
  if (polling) return;
  polling = true;
  try {
    await pollRemovable(force);
  } finally {
    polling = false;
  }
}

async function init() {
  if (!api()) {
    await new Promise((resolve) => {
      window.addEventListener("pywebviewready", resolve, { once: true });
      setTimeout(resolve, 1500);
    });
  }

  let session = null;
  if (api()) {
    try {
      session = await api().get_session();
    } catch (e) {
      session = null;
    }
  }

  if (session && ["details", "list", "grid"].includes(session.view)) {
    setView(session.view);
  }
  if (session && typeof session.volume === "number" && session.volume >= 0 && session.volume <= 1) {
    playerVolume = session.volume;
  }

  const saved = [];
  if (session && Array.isArray(session.tabs)) {
    for (const t of session.tabs) {
      if (!t || !Number.isInteger(t.id) || typeof t.title !== "string") continue;
      let hist = Array.isArray(t.history) ? t.history.filter(validLoc) : [];
      if (!hist.length) hist = [validLoc(t.loc) ? t.loc : { place: "desktop" }];
      const index = Math.min(
        Math.max(Number.isInteger(t.index) ? t.index : hist.length - 1, 0),
        hist.length - 1
      );
      saved.push({
        id: t.id,
        title: t.title,
        icon: iconForLoc(hist[index]),
        loc: hist[index],
        history: hist,
        index,
      });
    }
  }

  const quickLoc = { place: "quick" };
  const quickTab = () => ({
    id: QUICK_ID,
    title: QUICK_TITLE,
    icon: "star",
    loc: quickLoc,
    history: [quickLoc],
    index: 0,
  });
  const savedQuick = saved.find(isQuick);
  if (savedQuick) {
    savedQuick.title = QUICK_TITLE;
    savedQuick.icon = "star";
    savedQuick.loc = quickLoc;
    savedQuick.history = [quickLoc];
    savedQuick.index = 0;
    saved.splice(saved.indexOf(savedQuick), 1);
    saved.unshift(savedQuick);
  } else if (saved.length) {
    saved.unshift(quickTab());
  }

  if (saved.length) {
    tabs = saved;
    counter = Math.max(Number(session.counter) || 0, ...saved.map((t) => t.id));
    activeId = saved.some((t) => t.id === session.active)
      ? session.active
      : saved[0].id;
    const tab = activeTab();
    navHistory = tab.history;
    navIndex = tab.index;
    ready = true;
    renderTabs();
    load(tab.loc);
  } else {
    tabs = [quickTab()];
    ready = true;
    addTab();
  }
  loadCounts();
  pollLoop();
  setInterval(() => pollLoop(), 2000);
  window.addEventListener("focus", () => pollLoop(true));

  if (session && session.maximized && api()) {
    setMaxIcon(await api().toggle_maximize());
  }
}

init();
