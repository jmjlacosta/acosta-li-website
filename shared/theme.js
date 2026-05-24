// Shared theming for both trackers. Accent (4 hues) + mode (auto/light/dark).
// Values live in theme.css, keyed off <html data-accent> / <html data-mode>;
// this module only flips those attributes, persists, and syncs via Supabase.
//
// Accent is chosen inside the baby setup modal (mountAccentSwatches); the
// light/dark toggle lives in the header. Both sync across devices in realtime.

const ACCENTS = ["pink", "green", "blue", "purple"];
const MODES = ["auto", "light", "dark"];
const ACCENT_LS = "gennyTheme_v1";   // reuse existing key (was theme name)
const MODE_LS = "gennyMode_v1";
const SETTINGS_TABLE = "tracker_settings";

const mql = window.matchMedia("(prefers-color-scheme: dark)");
function resolveMode(mode) {
  return (mode === "dark" || (mode === "auto" && mql.matches)) ? "dark" : "light";
}

const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.1 5.1l1.5 1.5M17.4 17.4l1.5 1.5M18.9 5.1l-1.5 1.5M6.6 17.4l-1.5 1.5"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.9A8.6 8.6 0 1 1 11.1 3a6.7 6.7 0 0 0 9.9 9.9z"/></svg>';

// Read persisted choices (used both here and by the page's anti-flash script).
export function readStored() {
  return {
    accent: localStorage.getItem(ACCENT_LS) || "pink",
    mode: localStorage.getItem(MODE_LS) || "auto",
  };
}

export function applyAttrs(accent, mode) {
  const root = document.documentElement;
  root.dataset.accent = ACCENTS.includes(accent) ? accent : "pink";
  root.dataset.mode = resolveMode(mode);
}

export function initTheme({ sb, trackerKey, toggleButton }) {
  let { accent, mode } = readStored();
  const swatchSyncs = new Set();

  function persistLocal() {
    localStorage.setItem(ACCENT_LS, accent);
    localStorage.setItem(MODE_LS, mode);
  }
  function updateThemeColor() {
    const c = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.appendChild(meta); }
    if (c) meta.content = c;
  }
  function renderToggle() {
    if (!toggleButton) return;
    const dark = resolveMode(mode) === "dark";
    toggleButton.innerHTML = dark ? ICON_SUN : ICON_MOON; // show the destination
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    toggleButton.setAttribute("aria-label", label);
    toggleButton.title = label;
  }
  function apply() {
    applyAttrs(accent, mode);
    renderToggle();
    updateThemeColor();
    swatchSyncs.forEach(fn => fn(accent));
  }

  apply();

  async function save() {
    persistLocal();
    try {
      await sb.from(SETTINGS_TABLE).upsert(
        { tracker_key: trackerKey, theme: accent, mode },
        { onConflict: "tracker_key" });
    } catch (e) { console.warn("theme save failed:", e.message); }
  }

  function setAccent(name) {
    if (!ACCENTS.includes(name)) return;
    accent = name; apply(); save();
  }
  function setMode(name) {
    if (!MODES.includes(name)) return;
    mode = name; apply(); save();
  }
  function toggle() { setMode(resolveMode(mode) === "dark" ? "light" : "dark"); }

  if (toggleButton) toggleButton.addEventListener("click", toggle);

  // Re-resolve when the system flips and we're on auto.
  const onSystem = () => { if (mode === "auto") apply(); };
  if (mql.addEventListener) mql.addEventListener("change", onSystem);
  else if (mql.addListener) mql.addListener(onSystem);

  // Load remote settings (authoritative if present).
  (async () => {
    try {
      const { data, error } = await sb.from(SETTINGS_TABLE)
        .select("theme,mode").eq("tracker_key", trackerKey).maybeSingle();
      if (error) throw error;
      if (data) {
        if (data.theme && ACCENTS.includes(data.theme)) accent = data.theme;
        if (data.mode && MODES.includes(data.mode)) mode = data.mode;
        persistLocal(); apply();
      }
    } catch (e) { console.warn("theme load failed:", e.message); }
  })();

  // Realtime: another device changing the look updates us live.
  sb.channel("settings:" + trackerKey)
    .on("postgres_changes",
      { event: "*", schema: "public", table: SETTINGS_TABLE, filter: "tracker_key=eq." + trackerKey },
      (payload) => {
        const n = payload.new || {};
        let changed = false;
        if (n.theme && n.theme !== accent && ACCENTS.includes(n.theme)) { accent = n.theme; changed = true; }
        if (n.mode && n.mode !== mode && MODES.includes(n.mode)) { mode = n.mode; changed = true; }
        if (changed) { persistLocal(); apply(); }
      })
    .subscribe();

  // Renders the accent picker into a container (used by the baby modal).
  function mountAccentSwatches(container) {
    if (!container) return;
    container.innerHTML = "";
    const row = document.createElement("div");
    row.className = "accent-swatches";
    ACCENTS.forEach(name => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "accent-swatch";
      b.dataset.accent = name;
      b.setAttribute("aria-label", name + " theme");
      b.addEventListener("click", () => setAccent(name));
      row.appendChild(b);
    });
    container.appendChild(row);
    const sync = (cur) => row.querySelectorAll(".accent-swatch")
      .forEach(s => s.classList.toggle("selected", s.dataset.accent === cur));
    sync(accent);
    swatchSyncs.add(sync);
  }

  return {
    setAccent, setMode, toggle,
    getAccent: () => accent,
    getMode: () => mode,
    mountAccentSwatches,
  };
}
