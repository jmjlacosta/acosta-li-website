// Shared baby identity used by /contractions/ and /baby/.
// Each household (tracker_key) can have one or more babies; for now the UI
// shows the most recently created one as "current". Records in other tables
// get tagged via baby_id so siblings stay separable later.

const BABY_TABLE = "babies";

// ---------- formatting ----------
export function ageString(birthIso, nowMs = Date.now()) {
  if (!birthIso) return null;
  const birthMs = new Date(birthIso).getTime();
  const diff = nowMs - birthMs;
  if (diff < 0) {
    const days = Math.round(Math.abs(diff) / 86400000);
    if (days === 0) return "due today";
    return "due in " + days + "d";
  }
  const h = diff / 3600000;
  if (h < 1) return Math.max(1, Math.round(diff / 60000)) + "m old";
  if (h < 24) return Math.round(h) + "h old";
  const days  = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days < 7)  return hours > 0 ? days + "d " + hours + "h old" : days + "d old";
  if (days < 60) return days + "d old";
  const weeks = Math.floor(days / 7);
  if (weeks < 20) return weeks + "w old";
  return Math.floor(days / 30) + "mo old";
}

function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
       + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ---------- data ----------
export async function loadBabies(sb, trackerKey) {
  const { data, error } = await sb.from(BABY_TABLE)
    .select("*").eq("tracker_key", trackerKey)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createBaby(sb, trackerKey, { name, birth_at, notes }) {
  const row = {
    id: crypto.randomUUID(),
    tracker_key: trackerKey,
    name,
    birth_at: birth_at || null,
    notes: notes || null,
  };
  const { error } = await sb.from(BABY_TABLE).insert(row);
  if (error) throw error;
  return row;
}

export async function updateBaby(sb, id, patch) {
  const { error } = await sb.from(BABY_TABLE).update(patch).eq("id", id);
  if (error) throw error;
}

export function subscribeBabies(sb, trackerKey, onChange) {
  return sb.channel("babies:" + trackerKey)
    .on("postgres_changes",
      { event: "*", schema: "public", table: BABY_TABLE, filter: "tracker_key=eq." + trackerKey },
      onChange)
    .subscribe();
}

// ---------- shared styles (injected once per page) ----------
const STYLE_ID = "baby-shared-styles";
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .baby-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--accent-soft); color: var(--accent);
      border: 1px solid var(--accent);
      padding: 5px 12px; border-radius: 999px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      font-family: inherit;
      transition: filter 0.15s ease;
    }
    .baby-chip:hover { filter: brightness(0.95); }
    .baby-chip .meta { opacity: 0.75; font-weight: 400; margin-left: 4px; }
    .baby-chip.empty { background: transparent; }
  `;
  document.head.appendChild(s);
}

// ---------- mount ----------
// Options:
//   chipContainer: HTMLElement where the chip is appended
//   sb, trackerKey
//   onBabyChange: (baby|null) => void  — called when current baby changes
//   getUntaggedCount: optional async () => number — for backfill prompt
//   doBackfill:       optional async (babyId) => void — backfill action
//   backfillNoun:     string label used in the prompt (e.g. "contractions")
export function mountBabyUI({
  chipContainer, sb, trackerKey,
  onBabyChange,
  getUntaggedCount, doBackfill,
  backfillNoun = "records",
}) {
  ensureStyles();

  let babies = [];
  let currentBaby = null;
  const setCurrent = (b) => {
    currentBaby = b || null;
    if (onBabyChange) onBabyChange(currentBaby);
  };
  const recomputeCurrent = () => {
    // Most recently created baby is the "current" one until we have a switcher.
    const next = babies.length ? babies[babies.length - 1] : null;
    setCurrent(next);
  };

  // --- chip ---
  const chip = document.createElement("button");
  chip.className = "baby-chip empty";
  chip.type = "button";
  chip.textContent = "+ Set up baby";
  chipContainer.appendChild(chip);

  function renderChip() {
    if (!currentBaby) {
      chip.className = "baby-chip empty";
      chip.innerHTML = "+ Set up baby";
      return;
    }
    chip.className = "baby-chip";
    const age = ageString(currentBaby.birth_at);
    const meta = age ? '<span class="meta">· ' + escapeHtml(age) + '</span>'
                     : '<span class="meta">· awaiting arrival</span>';
    chip.innerHTML = '<span class="name">' + escapeHtml(currentBaby.name) + '</span>' + meta;
  }

  // --- modal (injected once) ---
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <h3 data-role="title">Set up baby</h3>
      <label>Name</label>
      <input data-role="name" placeholder="What's their name?" />
      <label>Birth date & time (optional)</label>
      <input data-role="birth" type="datetime-local" />
      <label>Notes (optional)</label>
      <textarea data-role="notes" rows="2" placeholder="Anything to remember"></textarea>
      <div class="form-error" data-role="err"></div>
      <div class="footer">
        <button class="secondary" data-role="cancel">Cancel</button>
        <button class="primary" data-role="save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const $r = (role) => modal.querySelector('[data-role="' + role + '"]');

  function openModal() {
    if (currentBaby) {
      $r("title").textContent = "Edit baby";
      $r("name").value  = currentBaby.name || "";
      $r("birth").value = currentBaby.birth_at ? toLocalInputValue(new Date(currentBaby.birth_at)) : "";
      $r("notes").value = currentBaby.notes || "";
    } else {
      $r("title").textContent = "Set up baby";
      $r("name").value = "";
      $r("birth").value = "";
      $r("notes").value = "";
    }
    $r("err").textContent = "";
    modal.classList.add("open");
    setTimeout(() => $r("name").focus(), 50);
  }
  function closeModal() { modal.classList.remove("open"); }
  $r("cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  $r("save").addEventListener("click", async () => {
    $r("err").textContent = "";
    const name = $r("name").value.trim();
    if (!name) { $r("err").textContent = "Name is required."; return; }
    const birthVal = $r("birth").value;
    const birthIso = birthVal ? new Date(birthVal).toISOString() : null;
    const notes = $r("notes").value.trim() || null;

    try {
      if (currentBaby) {
        const patch = { name, birth_at: birthIso, notes };
        await updateBaby(sb, currentBaby.id, patch);
        // Optimistic local update — realtime will confirm.
        Object.assign(currentBaby, patch);
        renderChip();
        if (onBabyChange) onBabyChange(currentBaby);
      } else {
        const wasFirst = babies.length === 0;
        const created = await createBaby(sb, trackerKey, { name, birth_at: birthIso, notes });
        babies.push(created);
        setCurrent(created);
        renderChip();
        closeModal();

        // Offer backfill on the first baby ever.
        if (wasFirst && getUntaggedCount && doBackfill) {
          let count = 0;
          try { count = await getUntaggedCount(); } catch (e) { console.warn("untagged count failed:", e.message); }
          if (count > 0) {
            const ok = confirm("Tag your " + count + " existing " + backfillNoun + " as " + name + "'s?");
            if (ok) {
              try { await doBackfill(created.id); }
              catch (e) { alert("Tagging failed: " + e.message); }
            }
          }
        }
        return;
      }
      closeModal();
    } catch (err) {
      $r("err").textContent = "Save failed: " + err.message;
    }
  });

  chip.addEventListener("click", openModal);

  // --- realtime sync from other devices ---
  subscribeBabies(sb, trackerKey, (payload) => {
    if (payload.eventType === "INSERT") {
      if (!babies.some(b => b.id === payload.new.id)) {
        babies.push(payload.new);
        recomputeCurrent();
        renderChip();
      }
    } else if (payload.eventType === "UPDATE") {
      const i = babies.findIndex(b => b.id === payload.new.id);
      if (i >= 0) {
        babies[i] = payload.new;
        if (currentBaby?.id === payload.new.id) setCurrent(payload.new);
        renderChip();
      }
    } else if (payload.eventType === "DELETE") {
      babies = babies.filter(b => b.id !== payload.old.id);
      recomputeCurrent();
      renderChip();
    }
  });

  // --- initial load ---
  (async () => {
    try {
      babies = await loadBabies(sb, trackerKey);
      recomputeCurrent();
      renderChip();
    } catch (err) {
      console.warn("Babies load failed:", err.message);
    }
  })();

  // --- periodic chip refresh so "Xh old" ticks up ---
  setInterval(renderChip, 60_000);

  return {
    getCurrentBaby: () => currentBaby,
    openModal,
  };
}
