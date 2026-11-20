// app.js — interface do Baby Pocket.
import * as P from "./protocol.js";
import { CubeLink, LiveWriter } from "./midi.js";
import { detectPitch } from "./pitch.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- armazenamento (localStorage pode falhar: sempre com try/catch) ----------
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento: segue sem salvar */ } },
};

// ---------- estado ----------
const defaultBank = () => {
  const b = new Uint8Array(P.BANK_BYTES);
  for (let s = 0; s < P.SLOT_COUNT; s++) {
    P.setSlotValue(b, s, "volume", 100);
    P.setSlotValue(b, s, "modulation", P.MOD_OFF);
    for (const id of ["irSection", "delaySection", "toneSection"]) P.setSlotValue(b, s, id, 1);
  }
  return b;
};
const state = {
  link: new CubeLink(),
  bank: defaultBank(),
  saved: defaultBank(),
  slot: 0,
  undo: [], redo: [],
  comparing: false, stash: null,
  selected: null,
  busy: false,
};
state.writer = new LiveWriter(state.link, (e) => toast(e.message));
window.__bp = state; // útil para testes

const LABELS = { volume: "Volume", cabinet: "IR Cab", reverb: "Reverb", mix: "Mix", feedback: "FB", time: "Time", modulation: "Mod", tone: "Tone", gain: "Gain", type: "Type" };
const fmt = (id, v) => {
  if (id === "modulation") return v === 7 || v === 8 ? "OFF" : v < 7 ? `C${v}` : `P${v - 8}`;
  if (id === "gain") return v === 0 ? "OFF" : String(v);
  return String(v);
};

// nomes dos slots (só neste aparelho)
let names = store.get("bp.names", ["", "", ""]);
if (!Array.isArray(names) || names.length !== 3) names = ["", "", ""];

// tempo do delay (mapeamento observado no CubeControl: 31 passos × ~32,26 ms)
const NOTE_MULT = { "1/4": 1, "1/8": 0.5, "1/8d": 0.75, "1/16": 0.25 };
const clampBpm = (f) => (Number.isFinite(f) ? Math.min(240, Math.max(40, Math.round(f))) : 120);
const noteMs = (bpm, note) => (60000 / clampBpm(bpm)) * NOTE_MULT[note];
const stepMs = (t) => Math.min(31, Math.max(0, t)) * (1000 / 31);
const msToStep = (ms) => {
  const n = Math.min(1000, Math.max(0, ms));
  let best = 0, d = Infinity;
  for (let r = 0; r <= 31; r++) { const u = Math.abs(stepMs(r) - n); if (u < d - 0.05 || (Math.abs(u - d) <= 0.05 && r > best)) { best = r; d = u; } }
  return best;
};
const tempo = { bpm: store.get("bp.bpm", 120), note: store.get("bp.note", "1/8d"), taps: [] };
if (!(tempo.note in NOTE_MULT)) tempo.note = "1/8d";
tempo.bpm = clampBpm(tempo.bpm);
function tapBpm(taps) {
  const iv = [];
  for (let i = 1; i < taps.length; i++) { const d = taps[i] - taps[i - 1]; if (d >= 250 && d <= 1500) iv.push(d); }
  if (!iv.length) return null;
  iv.sort((x, y) => x - y);
  const m = iv.length % 2 ? iv[(iv.length - 1) / 2] : (iv[iv.length / 2 - 1] + iv[iv.length / 2]) / 2;
  return clampBpm(60000 / m);
}
function applyTempo() {
  store.set("bp.bpm", tempo.bpm); store.set("bp.note", tempo.note);
  const step = msToStep(noteMs(tempo.bpm, tempo.note));
  if (val("time") !== step) { pushUndo(); setParam("time", step); } else render();
}
function tap() {
  if (state.comparing) return;
  const now = performance.now();
  if (tempo.taps.length && now - tempo.taps[tempo.taps.length - 1] > 2000) tempo.taps = [];
  tempo.taps.push(now); tempo.taps = tempo.taps.slice(-6);
  const b = tapBpm(tempo.taps);
  if (b) { tempo.bpm = b; applyTempo(); } else render();
  if (navigator.vibrate) navigator.vibrate(8);
}

const val = (id, slot = state.slot) => state.bank[slot * P.SLOT_BYTES + P.PARAM[id].offset];

// ---------- avisos e diálogos ----------
let toastTimer;
function toast(msg, ok = false) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false; el.classList.toggle("ok", ok);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}
function openDialog(title, bodyHtml, buttons) {
  const dlg = $("#dlg");
  $("#dlgTitle").textContent = title;
  $("#dlgBody").innerHTML = bodyHtml;
  const actions = $("#dlgActions");
  actions.innerHTML = "";
  for (const b of buttons) {
    const el = document.createElement("button");
    el.type = "button"; el.textContent = b.label;
    el.className = "chip" + (b.primary ? " chip-main" : "");
    el.addEventListener("click", async () => { const keep = b.onClick ? await b.onClick() === false : false; if (!keep) dlg.close(); });
    actions.append(el);
  }
  if (!dlg.open) dlg.showModal();
}
const confirmDialog = (title, text, okLabel) => new Promise((resolve) => {
  openDialog(title, text, [
    { label: "Cancelar", onClick: () => resolve(false) },
    { label: okLabel, primary: true, onClick: () => resolve(true) },
  ]);
});

// ---------- knobs ----------
const NS = "http://www.w3.org/2000/svg";
const polar = (deg, r = 38) => { const a = (deg * Math.PI) / 180; return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]; };
const arc = (frac) => {
  if (frac <= 0) return "";
  const end = 135 + 270 * Math.min(frac, 0.9999);
  const [x0, y0] = polar(135), [x1, y1] = polar(end);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A38 38 0 ${270 * frac > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

function buildKnobs() {
  for (const holder of $$(".knobs")) {
    for (const id of holder.dataset.params.split(",")) {
      const knob = document.createElement("button");
      knob.type = "button"; knob.className = "knob"; knob.dataset.id = id;
      knob.setAttribute("role", "slider");
      knob.setAttribute("aria-label", LABELS[id]);
      knob.setAttribute("aria-valuemin", "0"); knob.setAttribute("aria-valuemax", String(P.PARAM[id].max));
      knob.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><path class="track" d="${arc(1)}" fill="none" stroke-width="7" stroke-linecap="round"/><path class="arc" fill="none" stroke-width="7" stroke-linecap="round"/><circle class="dot" r="4.2"/></svg><span class="val"></span><span class="lab">${LABELS[id]}</span>`;
      attachKnobGestures(knob, id);
      holder.append(knob);
    }
  }
}

let drag = null;
function attachKnobGestures(knob, id) {
  knob.addEventListener("pointerdown", (e) => {
    if (state.comparing) return;
    knob.setPointerCapture(e.pointerId);
    drag = { id, y: e.clientY, start: val(id), moved: false };
    select(id);
  });
  knob.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== id) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 5) return;
    if (!drag.moved) { drag.moved = true; pushUndo(); }
    setParam(id, drag.start + (dy / 200) * P.PARAM[id].max);
  });
  const end = () => { if (drag && drag.id === id) drag = null; };
  knob.addEventListener("pointerup", end);
  knob.addEventListener("pointercancel", end);
  knob.addEventListener("keydown", (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step && !state.comparing) { e.preventDefault(); pushUndo(); setParam(id, val(id) + step); }
  });
}

// ---------- edição ----------
const snapshot = () => state.bank.slice();
function pushUndo() { state.undo.push(snapshot()); if (state.undo.length > 100) state.undo.shift(); state.redo = []; }

// ---------- cenas ----------
// Cada banco (A/B/C) tem 3 cenas. Uma cena guarda só os valores dos efeitos/ajustes:
// NÃO guarda Type (amplificador) nem Cab (IR), que continuam os do banco.
const SCENE_IDS = ["volume", "reverb", "mix", "feedback", "time", "modulation", "tone", "gain", "irSection", "delaySection", "toneSection"];
const SCENE_COUNT = 3;
const emptyScenes = () => [0, 1, 2].map(() => Array(SCENE_COUNT).fill(null));
let scenes = store.get("bp.scenes", null);
if (!Array.isArray(scenes) || scenes.length !== 3 || !scenes.every((r) => Array.isArray(r) && r.length === SCENE_COUNT)) scenes = emptyScenes();
let activeScene = store.get("bp.activeScene", [null, null, null]);
if (!Array.isArray(activeScene) || activeScene.length !== 3) activeScene = [null, null, null];
let persistTimer;
const persistScenes = () => { clearTimeout(persistTimer); persistTimer = setTimeout(() => { store.set("bp.scenes", scenes); store.set("bp.activeScene", activeScene); }, 300); };
const sceneValues = (slot) => Object.fromEntries(SCENE_IDS.map((id) => [id, val(id, slot)]));

/** Mantém a cena ativa do slot igual ao que está na tela (chamada após edições). */
function captureScene(slot = state.slot) {
  const n = activeScene[slot];
  if (n === null || state.comparing) return;
  scenes[slot][n] = sceneValues(slot);
  persistScenes();
}

function selectScene(n) {
  if (state.comparing) return;
  const s = state.slot;
  if (activeScene[s] === n) return;
  state.undo = []; state.redo = []; // trocar de cena é navegação: não entra no desfazer
  if (scenes[s][n]) {
    const next = state.bank.slice();
    for (const id of SCENE_IDS) P.setSlotValue(next, s, id, scenes[s][n][id]);
    activeScene[s] = n; applyBank(next);
  } else {
    scenes[s][n] = sceneValues(s); // cena nova começa igual ao som atual
    activeScene[s] = n; render();
  }
  persistScenes();
  toast(`Cena ${n + 1} do slot ${P.SLOT_NAMES[s]}. Type e IR não mudam; o que você ajustar fica guardado nela.`, true);
}

function clearScene() {
  const s = state.slot, n = activeScene[s];
  if (n === null) return toast("Nenhuma cena ativa neste slot.");
  scenes[s][n] = null; activeScene[s] = null; persistScenes(); render();
  toast(`Cena ${n + 1} apagada. O som atual continua como está.`, true);
}

function setParam(id, value, slot = state.slot) {
  const v = P.clampParam(id, value);
  if (val(id, slot) === v) return;
  P.setSlotValue(state.bank, slot, id, v);
  if (state.link.connected) state.writer.set(slot, P.PARAM[id].offset, v);
  if (SCENE_IDS.includes(id)) captureScene(slot);
  render();
}

/** Troca o banco de trabalho e manda para o pedal só os bytes que mudaram. */
function applyBank(next) {
  for (let s = 0; s < P.SLOT_COUNT; s++) {
    for (let off = 0; off < P.FIELD_COUNT; off++) {
      const i = s * P.SLOT_BYTES + off;
      if (state.bank[i] !== next[i] && state.link.connected) state.writer.set(s, off, next[i]);
    }
  }
  state.bank = next.slice();
  render();
}

function undo() { if (!state.undo.length || state.comparing) return; state.redo.push(snapshot()); applyBank(state.undo.pop()); captureScene(); }
function redo() { if (!state.redo.length || state.comparing) return; state.undo.push(snapshot()); applyBank(state.redo.pop()); captureScene(); }

function toggleSection(id) { pushUndo(); setParam(id, 1 - val(id)); }

function compare() {
  const s = state.slot, from = s * P.SLOT_BYTES;
  const next = state.bank.slice();
  if (!state.comparing) {
    state.stash = state.bank.slice();
    next.set(state.saved.slice(from, from + P.FIELD_COUNT), from);
    state.comparing = true;
  } else {
    next.set(state.stash.slice(from, from + P.FIELD_COUNT), from);
    state.comparing = false; state.stash = null;
  }
  applyBank(next);
}

async function copyTo() {
  const others = [0, 1, 2].filter((s) => s !== state.slot);
  openDialog(`Copiar ${P.SLOT_NAMES[state.slot]} para…`, "Os valores vão para o slot escolhido (ainda sem gravar no pedal).",
    [{ label: "Cancelar" }, ...others.map((t) => ({ label: `Slot ${P.SLOT_NAMES[t]}`, primary: true, onClick: () => {
      pushUndo();
      const next = state.bank.slice();
      next.set(state.bank.slice(state.slot * 16, state.slot * 16 + P.FIELD_COUNT), t * 16);
      applyBank(next);
      toast(`Copiado para o slot ${P.SLOT_NAMES[t]}`, true);
    } }))]);
}

// ---------- seleção / barra fina ----------
function select(id) { state.selected = id; render(); }
function renderFine() {
  const bar = $("#fineBar");
  const show = state.selected && $("#tab-editor").classList.contains("active");
  bar.hidden = !show; document.body.classList.toggle("has-fine", Boolean(show));
  if (!show) return;
  const p = P.PARAM[state.selected];
  $("#fineName").textContent = LABELS[state.selected];
  const r = $("#fineRange"); r.max = String(p.max); r.value = String(val(state.selected)); r.disabled = state.comparing;
  $("#fineVal").textContent = fmt(state.selected, val(state.selected));
}

// ---------- render ----------
function render() {
  const s = state.slot;
  for (const knob of $$(".knob")) {
    const id = knob.dataset.id, v = val(id), max = P.PARAM[id].max, frac = v / max;
    $(".arc", knob).setAttribute("d", arc(frac));
    const [dx, dy] = polar(135 + 270 * frac, 38);
    const dot = $(".dot", knob); dot.setAttribute("cx", dx.toFixed(2)); dot.setAttribute("cy", dy.toFixed(2));
    $(".val", knob).textContent = fmt(id, v);
    knob.setAttribute("aria-valuenow", String(v)); knob.setAttribute("aria-valuetext", fmt(id, v));
    knob.classList.toggle("sel", state.selected === id);
  }
  for (const g of $$(".group[data-section]")) {
    const on = val(g.dataset.section) === 1;
    g.classList.toggle("off", !on);
    const t = $(".toggle", g); t.setAttribute("aria-pressed", String(on)); t.textContent = on ? "ON" : "OFF";
  }
  for (const b of $$(".slot")) {
    const i = Number(b.dataset.slot);
    b.classList.toggle("active", i === s);
    const a = i * P.SLOT_BYTES;
    let dirty = false;
    for (let k = 0; k < P.FIELD_COUNT; k++) if (state.bank[a + k] !== state.saved[a + k]) dirty = true;
    $(".dirty", b).hidden = !(dirty && !state.comparing);
  }
  $$(".slot .nm, .stage-slot .nm").forEach((el) => { el.textContent = names[Number(el.parentElement.dataset.slot)]; });
  for (const b of $$(".stage-slot")) b.classList.toggle("active", Number(b.dataset.slot) === s);
  $("#stageName").textContent = names[s] ? `${P.SLOT_NAMES[s]} · ${names[s]}` : `Cena ${P.SLOT_NAMES[s]}`;
  $$(".bpm").forEach((el) => { el.textContent = String(tempo.bpm); });
  $("#bpmVal").textContent = String(tempo.bpm);
  $$("#noteSeg button").forEach((b) => b.classList.toggle("on", b.dataset.note === tempo.note));
  $("#tempoMs").textContent = `${Math.round(noteMs(tempo.bpm, tempo.note))} ms → time ${msToStep(noteMs(tempo.bpm, tempo.note))}`;
  $$(".scene-btn").forEach((b) => {
    const n = Number(b.dataset.scene);
    b.classList.toggle("active", activeScene[s] === n);
    b.classList.toggle("filled", Boolean(scenes[s][n]));
  });
  $$(".scene-clear").forEach((b) => { b.disabled = activeScene[s] === null; });
  $("#saveBtn").textContent = `Salvar ${P.SLOT_NAMES[s]}`;
  $("#libSave").textContent = `Salvar timbre do slot ${P.SLOT_NAMES[s]}`;
  $("#undoBtn").disabled = !state.undo.length || state.comparing;
  $("#redoBtn").disabled = !state.redo.length || state.comparing;
  $("#compareBtn").classList.toggle("active", state.comparing);
  $("#compareBtn").textContent = state.comparing ? "Comparando (salvo)" : "Comparar";
  $("#tab-editor").classList.toggle("locked", state.comparing);
  renderFine();
}

// ---------- conexão ----------
function setStatus(text, ok) { const el = $("#status"); el.textContent = text; el.classList.toggle("ok", Boolean(ok)); }

async function afterConnect() {
  try {
    const name = await state.link.identify();
    if (!/cube|sinco|vave/i.test(name)) { await state.link.disconnect(); throw new Error(`Dispositivo "${name}" não é um Cube Baby. Desconectado.`); }
    const bank = await state.link.readBank();
    state.bank = bank.slice(); state.saved = bank.slice();
    state.undo = []; state.redo = []; state.comparing = false; activeScene = [null, null, null]; persistScenes();
    setStatus(`${name} · banco lido`, true);
    $("#connectBtn").textContent = "Desconectar";
    toast("Pedal conectado. Banco A/B/C carregado.", true);
  } catch (e) {
    toast(e.message);
    setStatus("Conectado, mas sem resposta do pedal");
  }
  render(); renderBackups();
}

state.link.addEventListener("state", (ev) => {
  if (!ev.detail.connected) { setStatus("Desconectado"); $("#connectBtn").textContent = "Conectar pedal"; }
});

$("#connectBtn").addEventListener("click", async () => {
  if (state.link.connected) { await state.link.disconnect(); return; }
  try { await state.link.connectUsb(); await afterConnect(); } catch (e) { toast(e.message); }
});
const APP_VERSION = "v10";
$("#verInfo").textContent = `Versão do app: ${APP_VERSION}`;
$("#updBtn").addEventListener("click", async () => {
  try {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    await Promise.all(["index.html", "app.js", "midi.js", "blemidi.js", "protocol.js", "pitch.js", "style.css", "sw.js"].map((f) => fetch(f, { cache: "reload" })));
  } catch { /* segue para recarregar */ }
  location.reload();
});
$("#diagBtn").addEventListener("click", async () => {
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  let body = `Navegador: ${esc(navigator.userAgent)}<br>Web MIDI: ${"requestMIDIAccess" in navigator ? "sim" : "NÃO"} · Web Bluetooth: ${"bluetooth" in navigator ? "sim" : "NÃO"}<br><br>`;
  try {
    const acc = await navigator.requestMIDIAccess({ sysex: true });
    const fmt = (m) => [...m.values()].map((p) => `• ${esc(p.name)} (${esc(p.manufacturer || "?")}, ${p.state})`).join("<br>") || "nenhuma";
    body += `<b>Entradas MIDI:</b><br>${fmt(acc.inputs)}<br><br><b>Saídas MIDI:</b><br>${fmt(acc.outputs)}`;
  } catch (e) { body += `<b>Falha ao pedir MIDI:</b> ${esc(e.name)} – ${esc(e.message)}`; }
  openDialog("Diagnóstico MIDI", body, [{ label: "Fechar", primary: true }]);
});
$("#bleBtn").addEventListener("click", async () => {
  if (state.link.connected) return toast("Desconecte primeiro (botão no topo).");
  try { await state.link.connectBle(); await afterConnect(); } catch (e) { if (e.name !== "NotFoundError") toast(e.message); }
});
$("#demoBtn").addEventListener("click", async () => { await state.link.connectDemo(); await afterConnect(); toast("Modo demonstração: nada é enviado a um pedal real.", true); });

// ---------- gravar no pedal ----------
const backups = () => store.get("bp.backups", []);
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
function addBackup(bank, note) {
  const list = backups(); list.unshift({ t: new Date().toISOString(), note, hex: toHex(bank) });
  store.set("bp.backups", list.slice(0, 10));
  renderBackups();
}

async function writeToPedal(slots, label) {
  if (!state.link.connected) return toast("Conecte o pedal primeiro.");
  if (state.busy) return;
  state.busy = true;
  try {
    const before = await state.link.readBank();
    addBackup(before, `antes de salvar ${label}`);
    const next = before.slice();
    for (const s of slots) next.set(state.bank.slice(s * 16, s * 16 + P.FIELD_COUNT), s * 16);
    const { verified, after } = await state.link.writeBank(next);
    state.saved = after.slice();
    render();
    toast(verified ? `${label} salvo e conferido no pedal.` : `${label} gravado, mas a conferência falhou. Releia o banco.`, verified);
  } catch (e) { toast(e.message); } finally { state.busy = false; }
}

$("#saveBtn").addEventListener("click", async () => {
  const name = P.SLOT_NAMES[state.slot];
  if (await confirmDialog(`Salvar slot ${name}?`, `Isso <b>sobrescreve o preset ${name}</b> no pedal. Um backup do banco atual é guardado antes.`, "Salvar")) writeToPedal([state.slot], `slot ${name}`);
});
$("#saveAllBtn").addEventListener("click", async () => {
  if (await confirmDialog("Salvar A, B e C?", "Isso <b>sobrescreve os três presets</b> do pedal. Um backup é guardado antes.", "Salvar tudo")) writeToPedal([0, 1, 2], "banco A+B+C");
});
$("#reloadBtn").addEventListener("click", async () => {
  if (!state.link.connected) return toast("Conecte o pedal primeiro.");
  try { const b = await state.link.readBank(); state.undo.push(snapshot()); state.saved = b.slice(); applyBank(b); toast("Banco relido do pedal.", true); } catch (e) { toast(e.message); }
});

// ---------- exportar / importar / backups ----------
$("#exportBtn").addEventListener("click", () => {
  const slots = Object.fromEntries([0, 1, 2].map((s) => [P.SLOT_NAMES[s], P.slotToObject(state.bank, s)]));
  const data = { app: "baby-pocket", version: 1, exportedAt: new Date().toISOString(), bank: toHex(state.bank), slots };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `cube-baby-bank-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Banco exportado.", true);
});
$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (typeof data.bank !== "string" || !/^[0-9a-f]{96}$/i.test(data.bank)) throw new Error("Arquivo inválido: falta o banco de 48 bytes.");
    const bank = fromHex(data.bank);
    for (let s = 0; s < 3; s++) for (const p of P.PARAMS) if (bank[s * 16 + p.offset] > p.max) throw new Error(`Valor fora do limite em ${P.SLOT_NAMES[s]}/${p.id}.`);
    pushUndo(); applyBank(bank);
    toast("Importado no editor. Use “Salvar tudo no pedal” para gravar.", true);
  } catch (err) { toast(err.message); }
});
function renderBackups() {
  const ul = $("#backupList"); ul.innerHTML = "";
  const list = backups();
  if (!list.length) { ul.innerHTML = '<li class="empty">Nenhum backup ainda.</li>'; return; }
  list.forEach((b) => {
    const li = document.createElement("li");
    li.innerHTML = `<div><span class="name"></span><small></small></div><div class="acts"><button class="mini" type="button">Carregar</button></div>`;
    $(".name", li).textContent = b.note;
    $("small", li).textContent = new Date(b.t).toLocaleString("pt-BR");
    $("button", li).addEventListener("click", () => { pushUndo(); applyBank(fromHex(b.hex)); toast("Backup carregado no editor (ainda não gravado).", true); });
    ul.append(li);
  });
}

// ---------- biblioteca ----------
const TAGS = ["ensaio", "ao vivo", "estúdio", "outro"];
let libTag = "Todos";
const tones = () => store.get("bp.tones", []);
function renderLibrary() {
  const tags = $("#libTags"); tags.innerHTML = "";
  for (const t of ["Todos", "Favoritos", ...TAGS]) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip" + (t === libTag ? " active" : ""); b.textContent = t;
    b.addEventListener("click", () => { libTag = t; renderLibrary(); }); tags.append(b);
  }
  const q = $("#libSearch").value.trim().toLowerCase();
  const list = tones().filter((t) => (libTag === "Todos" || (libTag === "Favoritos" ? t.fav : t.tag === libTag)) && t.name.toLowerCase().includes(q));
  const ul = $("#libList"); ul.innerHTML = "";
  if (!list.length) { ul.innerHTML = '<li class="empty">Nenhum timbre. Ajuste o pedal e toque em “Salvar timbre”.</li>'; return; }
  for (const t of list) {
    const li = document.createElement("li");
    li.innerHTML = `<div><span class="name"></span><small></small></div><div class="acts"><button class="mini fav" type="button" aria-label="Favorito"></button><button class="mini sh" type="button" aria-label="Compartilhar">Enviar</button><button class="mini ap" type="button">Aplicar</button><button class="mini del" type="button" aria-label="Apagar">✕</button></div>`;
    $(".name", li).textContent = t.name; $("small", li).textContent = t.tag;
    $(".fav", li).textContent = t.fav ? "★" : "☆";
    $(".fav", li).addEventListener("click", () => { t.fav = !t.fav; store.set("bp.tones", tones().map((x) => (x.id === t.id ? t : x))); renderLibrary(); });
    $(".sh", li).addEventListener("click", () => shareTone(t));
    $(".ap", li).addEventListener("click", () => {
      pushUndo(); const next = state.bank.slice(); next.set(Uint8Array.from(t.values), state.slot * 16); applyBank(next);
      toast(`“${t.name}” aplicado no slot ${P.SLOT_NAMES[state.slot]} (sem gravar).`, true);
    });
    $(".del", li).addEventListener("click", async () => { if (await confirmDialog("Apagar timbre?", `“${t.name}” será removido da biblioteca.`, "Apagar")) { store.set("bp.tones", tones().filter((x) => x.id !== t.id)); renderLibrary(); } });
    ul.append(li);
  }
}
$("#libSearch").addEventListener("input", renderLibrary);
$("#libSave").addEventListener("click", () => {
  openDialog("Salvar timbre", `Nome do timbre<input id="toneName" type="text" maxlength="40" placeholder="Ex.: Limpo com reverb"><br><br>Categoria<select id="toneTag">${TAGS.map((t) => `<option>${t}</option>`).join("")}</select>`,
    [{ label: "Cancelar" }, { label: "Salvar", primary: true, onClick: () => {
      const name = $("#toneName").value.trim();
      if (!name) { $("#toneName").focus(); return false; }
      const s = state.slot, values = [...state.bank.slice(s * 16, s * 16 + P.FIELD_COUNT)];
      store.set("bp.tones", [...tones(), { id: crypto.randomUUID?.() || String(Date.now()), name, tag: $("#toneTag").value, fav: false, values }]);
      renderLibrary(); toast("Timbre salvo na biblioteca.", true);
    } }]);
});

// ---------- afinador ----------
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const GUITAR = [["E", 82.41], ["A", 110], ["D", 146.83], ["G", 196], ["B", 246.94], ["E", 329.63]];
const tuner = { on: false, mode: "chromatic", ctx: null, stream: null, analyser: null, buf: null, raf: 0, cents: 0 };

function tunerFrame() {
  if (!tuner.on) return;
  tuner.analyser.getFloatTimeDomainData(tuner.buf);
  const ref = Number($("#tRef").value) || 440;
  const f = detectPitch(tuner.buf, tuner.ctx.sampleRate);
  if (f) {
    let note, cents, hitIdx = -1;
    if (tuner.mode === "guitar") {
      let best = Infinity;
      GUITAR.forEach(([, hz], i) => { const dist = Math.abs(Math.log2(f / hz)); if (dist < best) { best = dist; hitIdx = i; } });
      note = GUITAR[hitIdx][0]; cents = 1200 * Math.log2(f / GUITAR[hitIdx][1]);
    } else {
      const midi = 69 + 12 * Math.log2(f / ref), near = Math.round(midi);
      note = NOTES[((near % 12) + 12) % 12]; cents = (midi - near) * 100;
    }
    tuner.cents = tuner.cents * 0.6 + cents * 0.4;
    const c = Math.max(-50, Math.min(50, tuner.cents));
    $("#tNote").classList.remove("idle"); $("#tNote").textContent = note; $("#tHz").textContent = `${f.toFixed(1)} Hz`;
    $("#tNeedle").style.left = `calc(${50 + c * 0.9}% - 4px)`;
    const tuned = Math.abs(tuner.cents) < 5;
    $(".meter").classList.toggle("tuned", tuned);
    $("#tCents").textContent = tuned ? "Afinado" : `${tuner.cents > 0 ? "+" : ""}${Math.round(tuner.cents)} cents · ${tuner.cents > 0 ? "agudo, afrouxe" : "grave, aperte"}`;
    $$("#tStrings span").forEach((el, i) => el.classList.toggle("hit", i === hitIdx));
  }
  tuner.raf = requestAnimationFrame(tunerFrame);
}

async function startTuner() {
  try {
    const deviceId = $("#tInput").value;
    tuner.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    tuner.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = tuner.ctx.createMediaStreamSource(tuner.stream);
    tuner.analyser = tuner.ctx.createAnalyser(); tuner.analyser.fftSize = 4096;
    src.connect(tuner.analyser); tuner.buf = new Float32Array(tuner.analyser.fftSize);
    tuner.on = true; $("#tToggle").textContent = "Desligar microfone"; $("#tCents").textContent = "Toque uma corda…";
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    const sel = $("#tInput"), cur = sel.value;
    sel.innerHTML = '<option value="">Microfone padrão</option>' + devices.map((d) => `<option value="${d.deviceId}">${d.label || "Entrada de áudio"}</option>`).join("");
    sel.value = cur;
    tunerFrame();
  } catch (e) { toast(e.name === "NotAllowedError" ? "Permita o microfone para usar o afinador." : `Afinador: ${e.message}`); }
}
function stopTuner() {
  tuner.on = false; cancelAnimationFrame(tuner.raf);
  tuner.stream?.getTracks().forEach((t) => t.stop()); tuner.ctx?.close().catch(() => {});
  tuner.stream = tuner.ctx = null;
  $("#tToggle").textContent = "Ligar microfone"; $("#tNote").classList.add("idle"); $("#tNote").textContent = "—"; $("#tHz").textContent = "— Hz";
}
$("#tToggle").addEventListener("click", () => (tuner.on ? stopTuner() : startTuner()));
$("#tInput").addEventListener("change", () => { if (tuner.on) { stopTuner(); startTuner(); } });
$("#tunerMode").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  tuner.mode = b.dataset.mode;
  $$("#tunerMode button").forEach((x) => x.classList.toggle("on", x === b));
  const strings = $("#tStrings"); strings.hidden = tuner.mode !== "guitar";
  strings.innerHTML = GUITAR.map(([n]) => `<span>${n}</span>`).join("");
});

// ---------- navegação ----------
$(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab !== "tuner" && tuner.on) stopTuner();
  if (b.dataset.tab === "library") renderLibrary();
  document.body.classList.toggle("with-dock", b.dataset.tab === "editor");
  setWake(b.dataset.tab === "stage");
  renderFine();
});
$$(".slot, .stage-slot").forEach((b) => b.addEventListener("click", () => {
  if (state.comparing) compare();
  state.slot = Number(b.dataset.slot); render();
}));
$$("[data-toggle]").forEach((b) => b.addEventListener("click", () => { if (!state.comparing) toggleSection(b.dataset.toggle); }));
$("#undoBtn").addEventListener("click", undo);
$("#redoBtn").addEventListener("click", redo);
$("#compareBtn").addEventListener("click", compare);
$("#copyBtn").addEventListener("click", copyTo);

// barra fina
let fineOpen = false;
const fine = $("#fineRange");
fine.addEventListener("pointerdown", () => { if (!fineOpen) { fineOpen = true; pushUndo(); } });
fine.addEventListener("input", () => setParam(state.selected, Number(fine.value)));
["pointerup", "change", "blur"].forEach((ev) => fine.addEventListener(ev, () => { fineOpen = false; }));
$("#fineMinus").addEventListener("click", () => { pushUndo(); setParam(state.selected, val(state.selected) - 1); });
$("#finePlus").addEventListener("click", () => { pushUndo(); setParam(state.selected, val(state.selected) + 1); });

$$(".scene-btn").forEach((b) => b.addEventListener("click", () => selectScene(Number(b.dataset.scene))));
$$(".scene-clear").forEach((b) => b.addEventListener("click", clearScene));

// ---------- tempo / TAP ----------
$("#tapBtn").addEventListener("click", tap);
$("#stageTap").addEventListener("click", tap);
$("#noteSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b || state.comparing) return;
  tempo.note = b.dataset.note; applyTempo();
});

// ---------- nomes dos slots ----------
$("#renameBtn").addEventListener("click", () => {
  const s = state.slot;
  openDialog(`Nome do slot ${P.SLOT_NAMES[s]}`, `Só aparece neste aparelho; o pedal não guarda nomes.<input id="slotName" type="text" maxlength="14" value="">`,
    [{ label: "Cancelar" }, { label: "Salvar nome", primary: true, onClick: () => {
      names[s] = $("#slotName").value.trim().slice(0, 14); store.set("bp.names", names); render();
    } }]);
  $("#slotName").value = names[s];
});

// ---------- palco: tela sempre acesa ----------
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
  $("#wakeInfo").textContent = on && wakeLock ? "Tela mantida acesa neste modo." : on ? "Este navegador não permite manter a tela acesa." : "";
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && $("#tab-stage").classList.contains("active")) setWake(true); });

// ---------- presets como arquivo ----------
function parseTone(data) {
  if (!data || data.app !== "baby-pocket" || data.kind !== "tone") throw new Error("Arquivo não é um preset do Baby Pocket.");
  if (!Array.isArray(data.values) || data.values.length !== P.FIELD_COUNT) throw new Error("Preset inválido: esperados 13 valores.");
  P.PARAMS.forEach((p, i) => { const v = data.values[i]; if (!Number.isInteger(v) || v < 0 || v > p.max) throw new Error(`Valor fora do limite em ${p.id}.`); });
  const name = String(data.name || "Importado").slice(0, 40);
  return { id: crypto.randomUUID?.() || String(Date.now()), name, tag: TAGS.includes(data.tag) ? data.tag : "outro", fav: false, values: data.values.slice() };
}
async function shareTone(t) {
  const payload = { app: "baby-pocket", kind: "tone", version: 1, name: t.name, tag: t.tag, values: t.values };
  const file = new File([JSON.stringify(payload, null, 2)], `${t.name.replace(/[^\w-]+/g, "_") || "preset"}.bpreset.json`, { type: "application/json" });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: t.name }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Preset salvo como arquivo.", true);
}
$("#libImport").addEventListener("click", () => $("#libFile").click());
$("#libFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try { const t = parseTone(JSON.parse(await file.text())); store.set("bp.tones", [...tones(), t]); renderLibrary(); toast(`“${t.name}” importado.`, true); } catch (err) { toast(err.message); }
});

// ---------- início ----------
document.body.classList.add("with-dock");
buildKnobs(); render(); renderBackups();
if (!CubeLink.supported()) setStatus("Web MIDI indisponível: abra no Chrome do Android");
if (!store.get("bp.accepted", false)) {
  openDialog("Antes de começar", "Baby Pocket é <b>não oficial</b>, sem garantia. Knobs ao vivo e afinador são seguros. <b>Salvar</b> sobrescreve presets do pedal (um backup é guardado antes). Esta versão não grava IR na flash.",
    [{ label: "Entendi", primary: true, onClick: () => store.set("bp.accepted", true) }]);
}
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
