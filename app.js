// =====================================================================
// PRINTLOG · app.js — F1: CRUD de rollos e impresiones + ciclo de estados
// ---------------------------------------------------------------------
// Principio (§8): la verdad vive en RTDB, la UI la refleja. Listeners
// onValue() → estado global mínimo → render por vista. Sin estado
// duplicado. Métricas derivadas: solo funciones puras de calc.js.
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, onValue, set, push, update, remove,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { costoPorGramo, ordenarColaProvisoria, pesoRestante } from "./calc.js";

// ---------------------------------------------------------------------
// 1 · Config de Firebase (pública por diseño; la protección son las reglas §2)
// ---------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyCUpXFLnHCa7GTotxkCr24IouTcI1kyZtg",
  authDomain: "mengueche-print.firebaseapp.com",
  databaseURL: "https://mengueche-print-default-rtdb.firebaseio.com",
  projectId: "mengueche-print",
  storageBucket: "mengueche-print.firebasestorage.app",
  messagingSenderId: "813861146740",
  appId: "1:813861146740:web:c800563597d40ebe7b4121",
};
const HAY_CONFIG = !firebaseConfig.apiKey.includes("PEGAR_ACA");

// ---------------------------------------------------------------------
// 2 · Constantes de dominio
// ---------------------------------------------------------------------
const SOCIOS_DEFAULT = {
  s1: { nombre: "Agustín", color: "#e07a3f" },
  s2: { nombre: "Matías", color: "#4f8fe0" },
  s3: { nombre: "Joaquín", color: "#5fb87a" },
};

const MATERIALES = ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "Nylon", "PC"];

const MOTIVOS = {
  warping: "Warping (se curvó)",
  adhesion: "Adhesión a la cama",
  atasco: "Atasco / clog",
  filamento: "Se acabó el filamento",
  corte_luz: "Corte de luz",
  otro: "Otro",
};

// Defaults de configuración (§3). Se seedean en RTDB si el nodo no existe.
const CONFIG_DEFAULT = {
  horasEntreMantenimiento: 200,
  umbralStockBajoGramos: 150,
  pesoCarreteVacio: 200,
  ventanaEquidadDias: 30,
  moneda: "ARS",
};

// ---------------------------------------------------------------------
// 3 · Estado global mínimo
// ---------------------------------------------------------------------
const estado = {
  socioId: localStorage.getItem("printlog_socio"),
  socios: SOCIOS_DEFAULT,
  rollos: {},
  impresiones: {},
  ajustes: {},
  config: { ...CONFIG_DEFAULT },
  vista: "inicio",
  verArchivados: false,
};

let db = null;

// ---------------------------------------------------------------------
// 4 · Helpers
// ---------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function boton(txt, cls, ico) {
  const b = document.createElement("button");
  b.className = "boton " + cls;
  b.innerHTML = (ico ? svgIco(ico) : "") + `<span>${esc(txt)}</span>`;
  return b;
}
function intOrNull(v) {
  const s = String(v).trim();
  if (s === "") return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

const nfMiles = new Intl.NumberFormat("es-AR");
const nfMoneda = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
const nfMonedaDec = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0, maximumFractionDigits: 1 });

const formatG = (n) => (n == null ? "—" : nfMiles.format(n) + " g");
const formatMoneda = (n) => (n == null ? "—" : nfMoneda.format(n));
const formatCostoGramo = (n) => nfMonedaDec.format(n) + "/g";
const formatFecha = (ms) => new Date(ms).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
function formatMin(min) {
  if (min == null) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const i = parseInt(n, 16);
  return { r: (i >> 16) & 255, g: (i >> 8) & 255, b: i & 255 };
}
function textoContraste(hex) {
  try {
    const { r, g, b } = hexToRgb(hex);
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.42 ? "#181310" : "#f5f2ee";
  } catch { return "#181310"; }
}

// --- iconos (stroke 24×24, currentColor) ---
const ICONOS = {
  play: '<path d="M7 5.4v13.2l11-6.6z" fill="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  fallo: '<path d="M12 4 2.8 19.2h18.4z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  editar: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/>',
  borrar: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6.5 7l1 13h9l1-13"/>',
  arriba: '<path d="M12 19V6"/><path d="m6 12 6-6 6 6"/>',
  abajo: '<path d="M12 5v13"/><path d="m6 12 6 6 6-6"/>',
  frente: '<path d="m6 15 6-6 6 6"/><path d="m6 9 6-6 6 6"/>',
  flame: '<path d="M12 3c2.8 2.6 4.2 4.8 4.2 7.6a4.2 4.2 0 0 1-8.4 0c0-1 .3-1.9 1-2.8.4 1.1 1.1 1.6 1.7 1.7C9.8 8.2 10.8 5.4 12 3z"/>',
  ajustes: '<path d="M4 8h9"/><circle cx="16" cy="8" r="2.2"/><path d="M18.5 8H20"/><path d="M4 16h4.5"/><circle cx="11" cy="16" r="2.2"/><path d="M14 16h6"/>',
  atras: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  inbox: '<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M5.5 6h13l2.5 7v5.5H3V13z"/>',
  spool: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6"/>',
  archivar: '<path d="M5 8.5V19h14V8.5"/><path d="M3.5 5h17v3.5h-17z"/><path d="M10 12h4"/>',
  printer: '<path d="M7 9V3h10v6"/><path d="M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M7 14h10v6H7z"/>',
  mas: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
};
function svgIco(name, cls) {
  return `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[name] || ""}</svg>`;
}

const nombreSocio = (id) => estado.socios[id]?.nombre || "?";
const nombresParticipantes = (part) => Object.keys(part || {}).map(nombreSocio).join(" · ");

// =====================================================================
// 5 · Overlay reutilizable: modales (hoja), action sheets, confirmaciones
// =====================================================================
const overlay = $("#overlay");
let overlayCerrar = null;

function overlayAbrir(child, { cerrable = true, centrar = false, alCerrar = null } = {}) {
  overlay.replaceChildren(child);
  overlay.classList.toggle("centrar", centrar);
  overlay.hidden = false;
  overlayCerrar = () => { overlayHide(); alCerrar?.(); };
  if (!cerrable) overlayCerrar = null;
}
function overlayHide() {
  overlay.hidden = true;
  overlay.replaceChildren();
  overlay.classList.remove("centrar");
  overlayCerrar = null;
}
overlay.addEventListener("click", (e) => { if (e.target === overlay && overlayCerrar) overlayCerrar(); });

// Modal con formulario
function abrirHoja({ titulo, cuerpoEl, guardar, textoGuardar = "Guardar" }) {
  const hoja = el("div", "hoja");
  const cab = el("div", "hoja-cab", `<span class="agarre"></span><span class="hoja-tit">${esc(titulo)}</span>`);
  const cerrar = el("button", "hoja-cerrar", svgIco("x"));
  cerrar.setAttribute("aria-label", "Cerrar");
  cerrar.onclick = overlayHide;
  cab.append(cerrar);

  const cuerpo = el("div", "hoja-cuerpo");
  cuerpo.append(cuerpoEl);

  const pie = el("div", "hoja-pie");
  const bCancel = boton("Cancelar", "boton-sec");
  bCancel.onclick = overlayHide;
  const bGuardar = boton(textoGuardar, "boton-primario");
  bGuardar.onclick = guardar;
  pie.append(bCancel, bGuardar);

  hoja.append(cab, cuerpo, pie);
  overlayAbrir(hoja, { cerrable: true });
}

// Action sheet: [{label, icon, danger, onClick} | "sep"]
function abrirAcciones(titulo, items) {
  const sheet = el("div", "acsheet");
  if (titulo) sheet.append(el("div", "acsheet-tit", esc(titulo)));
  for (const it of items) {
    if (it === "sep") { sheet.append(el("div", "acsheet-sep")); continue; }
    const b = el("button", "acsheet-item" + (it.danger ? " peligro" : ""), svgIco(it.icon) + `<span>${esc(it.label)}</span>`);
    b.onclick = () => { overlayHide(); it.onClick?.(); };
    sheet.append(b);
  }
  overlayAbrir(sheet, { cerrable: true });
}

// Confirmación → Promise<bool>
function confirmar({ titulo, mensaje, ok = "Confirmar", cancelar = "Cancelar", peligro = false }) {
  return new Promise((resolve) => {
    const box = el("div", "confirmar", `<p class="confirmar-tit">${esc(titulo)}</p><p class="confirmar-msg">${mensaje}</p>`);
    const acc = el("div", "confirmar-acc");
    const bCancel = boton(cancelar, "boton-sec");
    const bOk = boton(ok, peligro ? "boton-peligro" : "boton-primario");
    bCancel.onclick = () => { overlayHide(); resolve(false); };
    bOk.onclick = () => { overlayHide(); resolve(true); };
    acc.append(bCancel, bOk);
    box.append(acc);
    overlayAbrir(box, { cerrable: true, centrar: true, alCerrar: () => resolve(false) });
    bOk.focus();
  });
}

// Toast
function toast(msg, error = false) {
  const t = el("div", "toast" + (error ? " err" : ""), `<span class="pip"></span><span>${esc(msg)}</span>`);
  $("#toasts").append(t);
  setTimeout(() => { t.classList.add("saliendo"); setTimeout(() => t.remove(), 220); }, 2400);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (overlayCerrar) overlayCerrar();
  else if (!$("#selector").hidden) cerrarSelector();
});

// =====================================================================
// 6 · Render de estructura (vistas, tabs, chip, FAB, acento)
// =====================================================================
function renderVista(nombre) {
  estado.vista = nombre;
  $$(".vista").forEach((v) => (v.hidden = v.dataset.vista !== nombre));
  $$(".tab").forEach((t) => {
    const activo = t.dataset.vista === nombre;
    t.classList.toggle("activo", activo);
    activo ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current");
  });
  renderFab(nombre);
  renderVistaActual();
}
function irA(nombre) { renderVista(nombre); }

function renderVistaActual() {
  if (estado.vista === "inicio") renderInicio();
  else if (estado.vista === "cola") renderCola();
  else if (estado.vista === "stock") renderStock();
}

function renderTodo() {
  aplicarAcento();
  renderChip();
  renderVistaActual();
}

function renderFab(nombre) {
  const fab = $("#fab");
  if (nombre === "cola") { fab.hidden = false; $("#fab-texto").textContent = "Impresión"; fab.onclick = nuevaImpresion; }
  else if (nombre === "stock") { fab.hidden = false; $("#fab-texto").textContent = "Rollo"; fab.onclick = nuevoRollo; }
  else fab.hidden = true;
}

function renderChip() {
  const chip = $("#chip-socio");
  const socio = estado.socios[estado.socioId];
  chip.hidden = !socio;
  if (!socio) return;
  $("#chip-color").style.background = socio.color;
  $("#chip-nombre").textContent = socio.nombre;
}

// Elemento firma (§6): el acento sigue al colorHex del rollo cargado.
function aplicarAcento() {
  let hex = null;
  const enCurso = Object.values(estado.impresiones).find((i) => i.estado === "imprimiendo" && i.rolloId);
  if (enCurso) hex = estado.rollos[enCurso.rolloId]?.colorHex;
  if (!hex) {
    const ult = Object.values(estado.impresiones)
      .filter((i) => (i.estado === "terminada" || i.estado === "fallida") && i.rolloId && estado.rollos[i.rolloId])
      .sort((a, b) => (b.fechaFin || 0) - (a.fechaFin || 0))[0];
    if (ult) hex = estado.rollos[ult.rolloId]?.colorHex;
  }
  const root = document.documentElement;
  if (hex) {
    root.style.setProperty("--acento", hex);
    root.style.setProperty("--acento-tinta", textoContraste(hex));
  } else {
    root.style.removeProperty("--acento");
    root.style.removeProperty("--acento-tinta");
  }
}

// --- helpers de layout ---
const h1 = (t) => el("h1", "vista-titulo", esc(t));
const gcode = (t) => el("p", "gcode", esc(t));
function seccion(tit, cuenta) {
  const s = el("div", "seccion");
  s.append(el("div", "seccion-cab", `<span class="seccion-tit">${esc(tit)}${cuenta != null ? ` <span class="cuenta">${cuenta}</span>` : ""}</span>`));
  return s;
}
const vacio = (icono, tit, sub) => el("div", "vacio", `${svgIco(icono)}<p class="vacio-tit">${esc(tit)}</p><p class="vacio-sub">${esc(sub)}</p>`);

// =====================================================================
// 7 · Cards
// =====================================================================
function puntosHtml(part) {
  const ids = Object.keys(part || {});
  return `<span class="puntos">${ids.map((id) => `<span class="punto" style="background:${esc(estado.socios[id]?.color || "#888")}"></span>`).join("")}</span>`;
}

function metaImpresion(imp, rollo) {
  const p = [];
  p.push(`<span class="dato">${puntosHtml(imp.participantes)} ${esc(nombresParticipantes(imp.participantes))}</span>`);
  if (rollo) p.push(`<span class="dato"><span class="swatch" style="background:${esc(rollo.colorHex || "#888")}"></span> ${esc(rollo.colorFilamento || rollo.material || "rollo")}</span>`);
  else p.push(`<span class="dato">sin rollo</span>`);

  const hist = imp.estado === "terminada" || imp.estado === "fallida";
  const g = hist ? imp.gramosReales : imp.gramosEstimados;
  const t = hist ? imp.tiempoRealMin : imp.tiempoEstimadoMin;
  if (g != null) p.push(`<span class="dato"><b>${formatG(g)}</b></span>`);
  if (t != null) p.push(`<span class="dato">${formatMin(t)}</span>`);
  if (imp.estado === "fallida" && imp.motivoFallo) p.push(`<span class="dato">${esc(MOTIVOS[imp.motivoFallo] || imp.motivoFallo)}</span>`);
  if (hist && imp.fechaFin) p.push(`<span class="dato">${formatFecha(imp.fechaFin)}</span>`);
  return p.join("");
}

function accionesHtml(estadoImp) {
  if (estadoImp === "cola") {
    return `<button class="boton boton-primario" data-acc="empezar">${svgIco("play")}<span>Empezar</span></button>
            <button class="boton boton-sec boton-mas" data-acc="mas" aria-label="Más acciones">${svgIco("mas")}</button>`;
  }
  if (estadoImp === "imprimiendo") {
    return `<button class="boton boton-primario" data-acc="terminar">${svgIco("check")}<span>Terminada</span></button>
            <button class="boton boton-peligro" data-acc="fallar">${svgIco("fallo")}<span>Falló</span></button>
            <button class="boton boton-sec boton-mas" data-acc="mas" aria-label="Más acciones">${svgIco("mas")}</button>`;
  }
  return `<button class="boton boton-ghost boton-bloque" data-acc="mas">${svgIco("ajustes")}<span>Ver / editar</span></button>`;
}

function cardImpresion(id, imp, { hero = false } = {}) {
  const rollo = imp.rolloId ? estado.rollos[imp.rolloId] : null;
  const card = el("article", "card imp" + (hero ? " encurso" : ""));
  const badges = [];
  if (imp.urgente && imp.estado === "cola") badges.push(`<span class="badge badge-urgente">Urgente</span>`);
  if (imp.estado === "terminada" || imp.estado === "fallida") badges.push(`<span class="badge badge-estado" data-estado="${imp.estado}">${imp.estado}</span>`);

  card.innerHTML = `
    ${hero ? `<div class="encurso-tag"><span class="pulso"></span> Imprimiendo ahora</div>` : ""}
    <div class="card-cab">
      <div class="imp-info">
        <div class="card-tit">${esc(imp.nombre)}</div>
        <div class="imp-meta">${metaImpresion(imp, rollo)}</div>
      </div>
      ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
    </div>
    <div class="acciones">${accionesHtml(imp.estado)}</div>`;

  card.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => manejarAccion(b.dataset.acc, id)));
  return card;
}

function cardRollo(id, r) {
  const cpg = costoPorGramo(r);
  const restante = pesoRestante(id, estado.rollos, estado.impresiones, estado.ajustes);
  const umbral = estado.config.umbralStockBajoGramos ?? 150;
  const pct = r.pesoInicial > 0 ? Math.max(0, Math.min(100, (restante / r.pesoInicial) * 100)) : 0;
  const negativo = restante < 0;
  const bajo = !negativo && restante < umbral;
  const valorRestante = Math.max(0, restante) * cpg;

  let alerta = "";
  if (negativo) alerta = `<span class="stock-alerta neg">Sin stock — pesá y ajustá</span>`;
  else if (bajo) alerta = `<span class="stock-alerta bajo">Stock bajo</span>`;

  const card = el("article", "card rollo" + (r.archivado ? " archivado" : ""));
  card.innerHTML = `
    <div class="card-cab">
      <span class="rollo-color" style="background:${esc(r.colorHex || "#888")}"></span>
      <div style="flex:1;min-width:0">
        <div class="card-tit">${esc(r.colorFilamento || r.material)} <span class="card-sub" style="display:inline">${esc(r.material)}</span></div>
        <div class="card-sub">${esc(r.marca || "sin marca")} · lo compró ${esc(nombreSocio(r.compradoPor))}</div>
      </div>
      ${alerta}
    </div>
    <div class="rollo-barra">
      <div class="rollo-barra-via"><span class="rollo-barra-fill${negativo ? " neg" : ""}" style="width:${pct}%;${negativo ? "" : `background:${esc(r.colorHex || "#888")}`}"></span></div>
      <div class="rollo-barra-meta">
        <span><b class="${negativo ? "txt-neg" : ""}">${formatG(restante)}</b> de ${formatG(r.pesoInicial)}</span>
        <span class="mono">${r.pesoInicial > 0 ? Math.round(pct) : 0}%</span>
      </div>
    </div>
    <div class="rollo-cifras">
      <div class="rollo-cifra"><span class="v">${formatMoneda(r.costo)}</span><span class="k">costo</span></div>
      <div class="rollo-cifra"><span class="v">${formatCostoGramo(cpg)}</span><span class="k">$/gramo</span></div>
      <div class="rollo-cifra"><span class="v">${formatMoneda(valorRestante)}</span><span class="k">valor restante</span></div>
    </div>
    ${r.notasPerfil ? `<details class="expand"><summary>Notas de perfil ${svgIco("chev", "chev")}</summary><div class="rollo-notas"><div class="rollo-notas-lbl">perfil de impresión</div>${esc(r.notasPerfil)}</div></details>` : ""}
    <div class="acciones">${r.archivado
      ? `<button class="boton boton-sec boton-bloque" data-acc="desarchivar">${svgIco("atras")}<span>Desarchivar</span></button>`
      : `<button class="boton boton-sec" data-acc="ajustar">${svgIco("ajustes")}<span>Ajustar stock</span></button>
         <button class="boton boton-sec boton-mas" data-acc="mas-rollo" aria-label="Más acciones">${svgIco("mas")}</button>`
    }</div>`;

  card.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => {
    const a = b.dataset.acc;
    if (a === "ajustar") pedirAjuste(id);
    else if (a === "mas-rollo") accionesRollo(id);
    else if (a === "desarchivar") desarchivarRollo(id);
  }));
  return card;
}

// =====================================================================
// 8 · Render de vistas
// =====================================================================
function renderInicio() {
  const cont = $("#cont-inicio");
  cont.replaceChildren();
  cont.append(h1("Inicio"));

  const enCurso = Object.entries(estado.impresiones).find(([, i]) => i.estado === "imprimiendo");
  if (enCurso) {
    const s = seccion("En curso");
    s.append(cardImpresion(enCurso[0], enCurso[1], { hero: true }));
    cont.append(s);
  } else {
    cont.append(vacio("printer", "Nada en la máquina", "Cuando pongas algo a imprimir, aparece acá y la app toma el color del filamento cargado."));
  }

  const enCola = Object.values(estado.impresiones).filter((i) => i.estado === "cola").length;
  const rollosAct = Object.values(estado.rollos).filter((r) => !r.archivado).length;
  const grid = el("div", "mini-stats");
  const m1 = el("button", "mini-stat", `<span class="mini-stat-num mono">${enCola}</span><span class="mini-stat-lbl">en cola</span>`);
  m1.onclick = () => irA("cola");
  const m2 = el("button", "mini-stat", `<span class="mini-stat-num mono">${rollosAct}</span><span class="mini-stat-lbl">rollos activos</span>`);
  m2.onclick = () => irA("stock");
  grid.append(m1, m2);
  cont.append(grid);

  cont.append(gcode("; dashboard completo — horas, stock y gasto del mes — llega en F3"));
}

function renderCola() {
  const cont = $("#cont-cola");
  cont.replaceChildren();
  cont.append(h1("Cola"));

  const imps = Object.entries(estado.impresiones).map(([id, i]) => ({ id, ...i }));
  const imprimiendo = imps.filter((i) => i.estado === "imprimiendo");
  const enCola = ordenarColaProvisoria(imps.filter((i) => i.estado === "cola"));
  const historial = imps
    .filter((i) => i.estado === "terminada" || i.estado === "fallida")
    .sort((a, b) => (b.fechaFin || 0) - (a.fechaFin || 0));

  if (imprimiendo.length) {
    const s = seccion("En curso");
    imprimiendo.forEach((i) => s.append(cardImpresion(i.id, i, { hero: true })));
    cont.append(s);
  }

  const sc = seccion("En cola", enCola.length);
  if (!enCola.length) sc.append(vacio("inbox", "La cola está vacía", "Cargá una impresión con el botón +."));
  else enCola.forEach((i) => sc.append(cardImpresion(i.id, i)));
  cont.append(sc);

  if (historial.length) {
    const det = el("details", "hist");
    const sum = el("summary", "hist-sum", `<span class="seccion-tit">Historial <span class="cuenta">${historial.length}</span></span>${svgIco("chev", "chev")}`);
    const body = el("div", "hist-body seccion");
    historial.forEach((i) => body.append(cardImpresion(i.id, i)));
    det.append(sum, body);
    cont.append(det);
  }
}

function renderStock() {
  const cont = $("#cont-stock");
  cont.replaceChildren();
  cont.append(h1("Stock"));

  const todos = Object.entries(estado.rollos).map(([id, r]) => ({ id, ...r }));
  const porFecha = (a, b) => (b.fechaCompra || 0) - (a.fechaCompra || 0);
  const activos = todos.filter((r) => !r.archivado).sort(porFecha);
  const archivados = todos.filter((r) => r.archivado).sort(porFecha);

  const s = seccion("Rollos activos", activos.length);
  if (!activos.length) s.append(vacio("spool", "Todavía no hay rollos", "Cargá tu primer filamento con el botón +."));
  else activos.forEach((r) => s.append(cardRollo(r.id, r)));
  cont.append(s);

  if (archivados.length) {
    const toggle = el("button", "toggle-archivados", `${estado.verArchivados ? "Ocultar" : "Ver"} archivados (${archivados.length})`);
    toggle.onclick = () => { estado.verArchivados = !estado.verArchivados; renderStock(); };
    cont.append(toggle);
    if (estado.verArchivados) {
      const sa = seccion("Archivados", archivados.length);
      archivados.forEach((r) => sa.append(cardRollo(r.id, r)));
      cont.append(sa);
    }
  }

  cont.append(gcode("; el stock se deriva de las impresiones y ajustes — cierra contra la balanza"));
}

// =====================================================================
// 9 · Formularios (cada uno devuelve { el, leer })
// =====================================================================
function marcarError(input, msg) {
  toast(msg, true);
  input?.focus();
  return null;
}
const sociosOptions = (sel) =>
  Object.entries(estado.socios).map(([id, s]) => `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(s.nombre)}</option>`).join("");

function formRollo(rollo) {
  const r = rollo || {};
  const form = el("form", "form");
  form.innerHTML = `
    <div class="campo">
      <label class="campo-lbl" for="f-mat">Material</label>
      <input id="f-mat" type="text" list="mats" value="${esc(r.material || "PLA")}" placeholder="PLA" autocomplete="off">
      <datalist id="mats">${MATERIALES.map((m) => `<option value="${m}">`).join("")}</datalist>
    </div>
    <div class="campo">
      <label class="campo-lbl">Color del filamento</label>
      <div class="color-pick">
        <input id="f-hex" type="color" value="${esc(r.colorHex || "#e8823c")}" aria-label="Color del filamento">
        <input id="f-color" type="text" value="${esc(r.colorFilamento || "")}" placeholder="Negro, Rojo, Galaxy…" autocomplete="off">
      </div>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="f-marca">Marca <span class="opt">· opcional</span></label>
      <input id="f-marca" type="text" value="${esc(r.marca || "")}" placeholder="Grilon3, eSun…" autocomplete="off">
    </div>
    <div class="campo-row">
      <div class="campo">
        <label class="campo-lbl" for="f-peso">Peso actual</label>
        <div class="sufijo"><input id="f-peso" class="num" type="number" inputmode="numeric" min="1" value="${r.pesoInicial ?? ""}" placeholder="1000"><span class="u">g</span></div>
      </div>
      <div class="campo">
        <label class="campo-lbl" for="f-costo">Costo</label>
        <div class="sufijo"><input id="f-costo" class="num" type="number" inputmode="numeric" min="0" value="${r.costo ?? ""}" placeholder="28000"><span class="u">$</span></div>
      </div>
    </div>
    <p class="campo-ayuda">Peso actual = lo que pesa hoy el rollo, no el nominal del fabricante. Si ya lo venían usando, poné lo que queda.</p>
    <div class="campo">
      <label class="campo-lbl" for="f-comp">Lo compró</label>
      <select id="f-comp">${sociosOptions(r.compradoPor || estado.socioId)}</select>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="f-notas">Notas de perfil <span class="opt">· opcional</span></label>
      <textarea id="f-notas" placeholder="205° / cama 60° — retracción 0.8 mm. No pasar de 60 mm/s.">${esc(r.notasPerfil || "")}</textarea>
    </div>`;

  const leer = () => {
    const material = form.querySelector("#f-mat").value.trim();
    const pesoInicial = parseInt(form.querySelector("#f-peso").value, 10);
    const costo = parseInt(form.querySelector("#f-costo").value, 10);
    if (!material) return marcarError(form.querySelector("#f-mat"), "Poné el material");
    if (!(pesoInicial > 0)) return marcarError(form.querySelector("#f-peso"), "El peso tiene que ser mayor a 0");
    if (Number.isNaN(costo) || costo < 0) return marcarError(form.querySelector("#f-costo"), "Cargá el costo del rollo");
    return {
      material,
      colorFilamento: form.querySelector("#f-color").value.trim(),
      colorHex: form.querySelector("#f-hex").value,
      marca: form.querySelector("#f-marca").value.trim(),
      pesoInicial, costo,
      compradoPor: form.querySelector("#f-comp").value,
      notasPerfil: form.querySelector("#f-notas").value.trim(),
    };
  };
  return { el: form, leer };
}

function formImpresion(imp) {
  const i = imp || {};
  const partSel = i.participantes ? Object.keys(i.participantes) : [estado.socioId];
  const rollosOpc = Object.entries(estado.rollos).filter(([id, r]) => !r.archivado || id === i.rolloId);
  const form = el("form", "form");
  form.innerHTML = `
    <div class="campo">
      <label class="campo-lbl" for="i-nom">Nombre</label>
      <input id="i-nom" type="text" value="${esc(i.nombre || "")}" placeholder="Soporte auriculares" autocomplete="off">
    </div>
    <div class="campo">
      <label class="campo-lbl">¿Quiénes participan?</label>
      <div class="chips" id="i-part">
        ${Object.entries(estado.socios).map(([id, s]) => `
          <button type="button" class="chip ${partSel.includes(id) ? "activo" : ""}" data-socio="${id}" style="--chip-color:${esc(s.color)}">
            <span class="punto"></span>${esc(s.nombre)}
          </button>`).join("")}
      </div>
      <p class="campo-ayuda">Compartida = tiempo, gramos y costo se dividen en partes iguales.</p>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="i-rollo">Rollo / filamento</label>
      <select id="i-rollo">
        <option value="">— Sin rollo (material ajeno) —</option>
        ${rollosOpc.map(([id, r]) => `<option value="${id}" ${i.rolloId === id ? "selected" : ""}>${esc((r.colorFilamento ? r.colorFilamento + " " : "") + r.material)}${r.marca ? " · " + esc(r.marca) : ""}</option>`).join("")}
      </select>
    </div>
    <div class="campo-row">
      <div class="campo">
        <label class="campo-lbl" for="i-gr">Gramos est. <span class="opt">· opc</span></label>
        <div class="sufijo"><input id="i-gr" class="num" type="number" inputmode="numeric" min="0" value="${i.gramosEstimados ?? ""}" placeholder="45"><span class="u">g</span></div>
      </div>
      <div class="campo">
        <label class="campo-lbl">Tiempo est. <span class="opt">· opc</span></label>
        <div class="tiempo">
          <div class="campo"><div class="sufijo"><input id="i-h" class="num" type="number" inputmode="numeric" min="0" value="${i.tiempoEstimadoMin != null ? Math.floor(i.tiempoEstimadoMin / 60) : ""}" placeholder="3"><span class="u">h</span></div></div>
          <div class="campo"><div class="sufijo"><input id="i-m" class="num" type="number" inputmode="numeric" min="0" max="59" value="${i.tiempoEstimadoMin != null ? i.tiempoEstimadoMin % 60 : ""}" placeholder="0"><span class="u">m</span></div></div>
        </div>
      </div>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="i-link">Link al STL <span class="opt">· opcional</span></label>
      <input id="i-link" type="url" value="${esc(i.linkSTL || "")}" placeholder="https://www.printables.com/…" autocomplete="off">
    </div>
    <div class="campo">
      <label class="campo-lbl" for="i-notas">Notas <span class="opt">· opcional</span></label>
      <textarea id="i-notas" placeholder="0.2 mm, 15% infill, sin soportes">${esc(i.notas || "")}</textarea>
    </div>
    <div class="toggle-fila">
      <span class="txt"><span class="t">Urgente</span><span class="s">Salta al frente de toda la cola</span></span>
      <label class="switch"><input type="checkbox" id="i-urg" ${i.urgente ? "checked" : ""}><span class="via"></span></label>
    </div>`;

  form.querySelectorAll("[data-socio]").forEach((ch) => (ch.onclick = () => ch.classList.toggle("activo")));

  const leer = () => {
    const nombre = form.querySelector("#i-nom").value.trim();
    if (!nombre) return marcarError(form.querySelector("#i-nom"), "Poné un nombre");
    const participantes = {};
    form.querySelectorAll("[data-socio].activo").forEach((ch) => (participantes[ch.dataset.socio] = true));
    if (!Object.keys(participantes).length) { toast("Elegí al menos un participante", true); return null; }
    const h = parseInt(form.querySelector("#i-h").value, 10) || 0;
    const m = parseInt(form.querySelector("#i-m").value, 10) || 0;
    return {
      nombre, participantes,
      rolloId: form.querySelector("#i-rollo").value || null,
      gramosEstimados: intOrNull(form.querySelector("#i-gr").value),
      tiempoEstimadoMin: h || m ? h * 60 + m : null,
      linkSTL: form.querySelector("#i-link").value.trim(),
      notas: form.querySelector("#i-notas").value.trim(),
      urgente: form.querySelector("#i-urg").checked,
    };
  };
  return { el: form, leer };
}

// Cierre de impresión: terminada (sin motivo) o fallida (con motivo)
function formCierre(imp, { conMotivo, edicion }) {
  const g0 = (edicion ? imp.gramosReales : (imp.gramosReales ?? imp.gramosEstimados)) ?? "";
  const tSrc = edicion ? imp.tiempoRealMin : (imp.tiempoRealMin ?? imp.tiempoEstimadoMin);
  const h0 = tSrc != null ? Math.floor(tSrc / 60) : "";
  const m0 = tSrc != null ? tSrc % 60 : "";
  const form = el("form", "form");
  form.innerHTML = `
    <div class="campo">
      <label class="campo-lbl" for="c-gr">${conMotivo ? "Gramos consumidos hasta el fallo" : "Gramos reales"}</label>
      <div class="sufijo"><input id="c-gr" class="num" type="number" inputmode="numeric" min="0" value="${g0}" placeholder="45"><span class="u">g</span></div>
    </div>
    <div class="campo">
      <label class="campo-lbl">${conMotivo ? "Tiempo transcurrido" : "Tiempo real"}</label>
      <div class="tiempo">
        <div class="campo"><div class="sufijo"><input id="c-h" class="num" type="number" inputmode="numeric" min="0" value="${h0}" placeholder="3"><span class="u">h</span></div></div>
        <div class="campo"><div class="sufijo"><input id="c-m" class="num" type="number" inputmode="numeric" min="0" max="59" value="${m0}" placeholder="0"><span class="u">m</span></div></div>
      </div>
    </div>
    ${conMotivo ? `
    <div class="campo">
      <label class="campo-lbl" for="c-mot">¿Qué pasó?</label>
      <select id="c-mot">${Object.entries(MOTIVOS).map(([k, v]) => `<option value="${k}" ${imp.motivoFallo === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
    </div>` : ""}
    <p class="campo-ayuda">${conMotivo ? "Las fallidas igual consumen material y suman horas de máquina — solo no cuentan como éxito." : "Prefilleado con lo estimado. Corregí si el slicer le erró."}</p>`;

  const leer = () => {
    const g = parseInt(form.querySelector("#c-gr").value, 10);
    if (Number.isNaN(g) || g < 0) return marcarError(form.querySelector("#c-gr"), "Cargá los gramos");
    const h = parseInt(form.querySelector("#c-h").value, 10) || 0;
    const m = parseInt(form.querySelector("#c-m").value, 10) || 0;
    const tiempoRealMin = h * 60 + m;
    if (!(tiempoRealMin > 0)) return marcarError(form.querySelector("#c-h"), "Cargá el tiempo");
    const out = { gramosReales: g, tiempoRealMin };
    if (conMotivo) out.motivoFallo = form.querySelector("#c-mot").value;
    return out;
  };
  return { el: form, leer };
}

// =====================================================================
// 10 · Acciones (escritura a RTDB)
// =====================================================================
function requiereConexion() {
  if (!db) { toast("Sin conexión con la base", true); return false; }
  if (!estado.socioId) { abrirSelector(); return false; }
  return true;
}

function nuevoRollo() {
  if (!requiereConexion()) return;
  const f = formRollo();
  abrirHoja({
    titulo: "Nuevo rollo", cuerpoEl: f.el, textoGuardar: "Guardar rollo",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      await push(ref(db, "rollos"), { ...d, fechaCompra: Date.now(), archivado: false });
      overlayHide(); toast("Rollo cargado");
    },
  });
}
function editarRollo(id) {
  const r = estado.rollos[id]; if (!r) return;
  const f = formRollo(r);
  abrirHoja({
    titulo: "Editar rollo", cuerpoEl: f.el, textoGuardar: "Guardar",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      await update(ref(db, `rollos/${id}`), d);
      overlayHide(); toast("Rollo actualizado");
    },
  });
}

// Ajuste manual por pesada (§4.6): la balanza mide filamento + carrete;
// se resta el carrete y se corrige contra el restante derivado actual.
function formAjuste(id) {
  const restanteActual = pesoRestante(id, estado.rollos, estado.impresiones, estado.ajustes);
  const carrete0 = estado.config.pesoCarreteVacio ?? 200;
  const hoy = new Date().toLocaleDateString("es-AR", { day: "numeric", month: "numeric" });
  const form = el("form", "form");
  form.innerHTML = `
    <div class="ajuste-info">Ahora la app calcula <b>${formatG(restanteActual)}</b> de filamento en este rollo.</div>
    <div class="campo">
      <label class="campo-lbl" for="a-med">Peso medido con carrete</label>
      <div class="sufijo"><input id="a-med" class="num" type="number" inputmode="numeric" min="0" placeholder="ej. 640"><span class="u">g</span></div>
      <p class="campo-ayuda">Poné el rollo entero en la balanza de cocina.</p>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="a-car">Peso del carrete vacío</label>
      <div class="sufijo"><input id="a-car" class="num" type="number" inputmode="numeric" min="0" value="${carrete0}"><span class="u">g</span></div>
      <p class="campo-ayuda">El carrete solo, sin filamento. Queda guardado para la próxima.</p>
    </div>
    <div class="ajuste-preview">
      <div class="linea"><span class="k">Filamento medido</span><span id="a-fil">—</span></div>
      <div class="linea"><span class="k">La app tenía</span><span>${formatG(restanteActual)}</span></div>
      <div class="linea"><span class="k">Corrección</span><span class="delta cero" id="a-delta">—</span></div>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="a-mot">Motivo</label>
      <input id="a-mot" type="text" value="Pesada del ${hoy}" autocomplete="off">
    </div>`;

  const med = form.querySelector("#a-med");
  const car = form.querySelector("#a-car");
  const filEl = form.querySelector("#a-fil");
  const deltaEl = form.querySelector("#a-delta");
  const recalcular = () => {
    const m = parseInt(med.value, 10);
    const c = parseInt(car.value, 10) || 0;
    if (Number.isNaN(m)) { filEl.textContent = "—"; deltaEl.textContent = "—"; deltaEl.className = "delta cero"; return; }
    const fil = m - c;
    const delta = fil - restanteActual;
    filEl.textContent = formatG(fil);
    deltaEl.textContent = (delta > 0 ? "+" : "") + formatG(delta);
    deltaEl.className = "delta " + (delta > 0 ? "mas" : delta < 0 ? "menos" : "cero");
  };
  med.addEventListener("input", recalcular);
  car.addEventListener("input", recalcular);

  const leer = () => {
    const m = parseInt(med.value, 10);
    if (Number.isNaN(m) || m < 0) return marcarError(med, "Poné el peso medido");
    const c = parseInt(car.value, 10) || 0;
    return {
      deltaGramos: (m - c) - restanteActual,
      pesoCarreteVacio: c,
      motivo: form.querySelector("#a-mot").value.trim() || `Pesada del ${hoy}`,
    };
  };
  return { el: form, leer };
}

function pedirAjuste(id) {
  if (!requiereConexion()) return;
  const f = formAjuste(id);
  abrirHoja({
    titulo: "Ajustar stock", cuerpoEl: f.el, textoGuardar: "Guardar ajuste",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      await push(ref(db, "ajustes"), { rolloId: id, deltaGramos: d.deltaGramos, motivo: d.motivo, fecha: Date.now(), hechoPor: estado.socioId });
      if (d.pesoCarreteVacio !== estado.config.pesoCarreteVacio) await update(ref(db, "config"), { pesoCarreteVacio: d.pesoCarreteVacio });
      overlayHide(); toast("Stock ajustado");
    },
  });
}

function accionesRollo(id) {
  const r = estado.rollos[id]; if (!r) return;
  abrirAcciones(r.colorFilamento || r.material, [
    { label: "Editar rollo", icon: "editar", onClick: () => editarRollo(id) },
    { label: "Archivar rollo", icon: "archivar", onClick: () => archivarRollo(id) },
  ]);
}
async function archivarRollo(id) {
  const r = estado.rollos[id]; if (!r) return;
  const ok = await confirmar({
    titulo: "Archivar rollo",
    mensaje: `<b>${esc(r.colorFilamento || r.material)}</b> sale del stock activo, pero sigue contando en históricos y balances. Lo podés desarchivar cuando quieras.`,
    ok: "Archivar",
  });
  if (!ok) return;
  await update(ref(db, `rollos/${id}`), { archivado: true });
  toast("Rollo archivado");
}
function desarchivarRollo(id) {
  update(ref(db, `rollos/${id}`), { archivado: false });
  toast("Rollo desarchivado");
}

function nuevaImpresion() {
  if (!requiereConexion()) return;
  const f = formImpresion();
  abrirHoja({
    titulo: "Nueva impresión", cuerpoEl: f.el, textoGuardar: "A la cola",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      await push(ref(db, "impresiones"), {
        ...d, estado: "cola", orden: Date.now(),
        gramosReales: null, tiempoRealMin: null, motivoFallo: null, fotoBase64: null,
        creadoPor: estado.socioId, fechaCreacion: Date.now(), fechaFin: null,
      });
      overlayHide(); toast("Impresión en la cola");
    },
  });
}
function editarImpresion(id) {
  const imp = estado.impresiones[id]; if (!imp) return;
  const f = formImpresion(imp);
  abrirHoja({
    titulo: "Editar impresión", cuerpoEl: f.el, textoGuardar: "Guardar",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      await update(ref(db, `impresiones/${id}`), {
        nombre: d.nombre, participantes: d.participantes, rolloId: d.rolloId,
        gramosEstimados: d.gramosEstimados, tiempoEstimadoMin: d.tiempoEstimadoMin,
        linkSTL: d.linkSTL, notas: d.notas, urgente: d.urgente,
      });
      overlayHide(); toast("Impresión actualizada");
    },
  });
}

async function empezar(id) {
  const imp = estado.impresiones[id]; if (!imp) return;
  const avisos = [];

  const otra = Object.entries(estado.impresiones).find(([iid, i]) => iid !== id && i.estado === "imprimiendo");
  if (otra) avisos.push(`Ya hay algo imprimiendo: <b>${esc(otra[1].nombre)}</b>. Hay una sola máquina.`);

  // Warning por stock insuficiente (§4.2) — ahora sí, con el stock derivado (§4.1).
  if (imp.rolloId && imp.gramosEstimados != null) {
    const rest = pesoRestante(imp.rolloId, estado.rollos, estado.impresiones, estado.ajustes);
    if (imp.gramosEstimados > rest) {
      avisos.push(`Al rollo le quedan <b>${formatG(rest)}</b> y esta impresión estima <b>${formatG(imp.gramosEstimados)}</b>.`);
    }
  }

  if (avisos.length) {
    const ok = await confirmar({
      titulo: "Ojo antes de empezar",
      mensaje: avisos.join("<br>") + "<br><br>¿Empezar igual?",
      ok: "Empezar igual",
    });
    if (!ok) return;
  }
  await update(ref(db, `impresiones/${id}`), { estado: "imprimiendo" });
  toast("En marcha");
}

function pedirTerminar(id, edicion = false) {
  const imp = estado.impresiones[id]; if (!imp) return;
  const f = formCierre(imp, { conMotivo: false, edicion });
  abrirHoja({
    titulo: edicion ? "Corregir datos reales" : "Marcar terminada", cuerpoEl: f.el,
    textoGuardar: edicion ? "Guardar" : "Marcar terminada",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      const patch = { gramosReales: d.gramosReales, tiempoRealMin: d.tiempoRealMin };
      if (!edicion) { patch.estado = "terminada"; patch.fechaFin = Date.now(); }
      await update(ref(db, `impresiones/${id}`), patch);
      overlayHide(); toast(edicion ? "Datos actualizados" : "Impresión terminada 🎉");
    },
  });
}
function pedirFallar(id, edicion = false) {
  const imp = estado.impresiones[id]; if (!imp) return;
  const f = formCierre(imp, { conMotivo: true, edicion });
  abrirHoja({
    titulo: edicion ? "Corregir datos" : "Marcar fallida", cuerpoEl: f.el,
    textoGuardar: edicion ? "Guardar" : "Marcar fallida",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      const patch = { gramosReales: d.gramosReales, tiempoRealMin: d.tiempoRealMin, motivoFallo: d.motivoFallo };
      if (!edicion) { patch.estado = "fallida"; patch.fechaFin = Date.now(); }
      await update(ref(db, `impresiones/${id}`), patch);
      overlayHide(); toast(edicion ? "Datos actualizados" : "Marcada como fallida");
    },
  });
}

function toggleUrgente(id, val) {
  update(ref(db, `impresiones/${id}`), { urgente: val });
  toast(val ? "Marcada urgente" : "Urgente quitada");
}

// Reorden de la sub-cola propia (fractional indexing §4.7)
function colaNoUrgente() {
  return ordenarColaProvisoria(
    Object.entries(estado.impresiones)
      .filter(([, i]) => i.estado === "cola" && !i.urgente)
      .map(([id, i]) => ({ id, ...i }))
  );
}
function moverFrente(id) {
  const lista = colaNoUrgente();
  const min = lista.length ? lista[0].orden : Date.now();
  update(ref(db, `impresiones/${id}`), { orden: min - 60000 });
}
function moverArriba(id) {
  const lista = colaNoUrgente();
  const i = lista.findIndex((x) => x.id === id);
  if (i <= 0) return;
  const prev = lista[i - 1], prevPrev = lista[i - 2];
  const nuevo = prevPrev ? (prevPrev.orden + prev.orden) / 2 : prev.orden - 60000;
  update(ref(db, `impresiones/${id}`), { orden: nuevo });
}
function moverAbajo(id) {
  const lista = colaNoUrgente();
  const i = lista.findIndex((x) => x.id === id);
  if (i < 0 || i >= lista.length - 1) return;
  const next = lista[i + 1], nextNext = lista[i + 2];
  const nuevo = nextNext ? (next.orden + nextNext.orden) / 2 : next.orden + 60000;
  update(ref(db, `impresiones/${id}`), { orden: nuevo });
}

async function borrarImpresion(id) {
  const imp = estado.impresiones[id]; if (!imp) return;
  const ok = await confirmar({
    titulo: "Borrar impresión",
    mensaje: `Se elimina <b>${esc(imp.nombre)}</b> para siempre. Si ya estaba terminada, el stock se recalcula solo.`,
    ok: "Borrar", peligro: true,
  });
  if (!ok) return;
  await remove(ref(db, `impresiones/${id}`));
  toast("Impresión borrada");
}

// Dispatcher de acciones desde la card
function manejarAccion(acc, id) {
  if (acc === "empezar") empezar(id);
  else if (acc === "terminar") pedirTerminar(id);
  else if (acc === "fallar") pedirFallar(id);
  else if (acc === "mas") accionesImpresion(id);
}

function accionesImpresion(id) {
  const imp = estado.impresiones[id]; if (!imp) return;
  const esMio = !!imp.participantes?.[estado.socioId];
  const items = [];

  if (imp.estado === "cola") {
    items.push({ label: "Empezar a imprimir", icon: "play", onClick: () => empezar(id) });
    items.push({ label: imp.urgente ? "Quitar urgente" : "Marcar urgente", icon: "flame", onClick: () => toggleUrgente(id, !imp.urgente) });
    if (esMio && !imp.urgente) {
      items.push("sep");
      items.push({ label: "Mandar al frente", icon: "frente", onClick: () => moverFrente(id) });
      items.push({ label: "Subir", icon: "arriba", onClick: () => moverArriba(id) });
      items.push({ label: "Bajar", icon: "abajo", onClick: () => moverAbajo(id) });
    }
    items.push("sep");
    items.push({ label: "Editar", icon: "editar", onClick: () => editarImpresion(id) });
    items.push({ label: "Borrar", icon: "borrar", danger: true, onClick: () => borrarImpresion(id) });
  } else if (imp.estado === "imprimiendo") {
    items.push({ label: "Marcar terminada", icon: "check", onClick: () => pedirTerminar(id) });
    items.push({ label: "Marcar fallida", icon: "fallo", danger: true, onClick: () => pedirFallar(id) });
    items.push("sep");
    items.push({ label: "Editar", icon: "editar", onClick: () => editarImpresion(id) });
    items.push({ label: "Volver a la cola", icon: "atras", onClick: () => { update(ref(db, `impresiones/${id}`), { estado: "cola" }); toast("De vuelta en la cola"); } });
  } else {
    items.push({ label: "Corregir gramos y tiempo", icon: "editar", onClick: () => (imp.estado === "fallida" ? pedirFallar(id, true) : pedirTerminar(id, true)) });
    items.push({ label: "Editar impresión", icon: "ajustes", onClick: () => editarImpresion(id) });
    items.push("sep");
    items.push({ label: "Borrar", icon: "borrar", danger: true, onClick: () => borrarImpresion(id) });
  }
  abrirAcciones(imp.nombre, items);
}

// =====================================================================
// 11 · Selector de socio
// =====================================================================
function renderSelector() {
  const lista = $("#selector-lista");
  lista.replaceChildren();
  for (const [id, socio] of Object.entries(estado.socios)) {
    const boton = el("button", "selector-socio");
    boton.style.setProperty("--socio-color", socio.color);
    boton.innerHTML = `<span class="socio-punto" aria-hidden="true"></span>`;
    boton.append(document.createTextNode(socio.nombre));
    boton.onclick = () => elegirSocio(id);
    lista.append(boton);
  }
}
function abrirSelector() { $("#selector").hidden = false; $("#selector-lista button")?.focus(); }
function cerrarSelector() { if (estado.socioId) $("#selector").hidden = true; }
function elegirSocio(id) {
  estado.socioId = id;
  localStorage.setItem("printlog_socio", id);
  $("#selector").hidden = true;
  renderChip();
  renderVistaActual();
}

// =====================================================================
// 12 · Firebase
// =====================================================================
let escuchando = false;

function conectarFirebase() {
  renderEstadoConexion("pendiente", "conectando…");
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  const auth = getAuth(app);
  onAuthStateChanged(auth, (user) => { if (user) escucharNodos(); });
  signInAnonymously(auth).catch((error) => {
    console.error("Auth anónima falló:", error);
    renderEstadoConexion("desconectado", "error de auth");
  });
}

function escucharNodos() {
  if (escuchando) return;
  escuchando = true;

  onValue(ref(db, ".info/connected"), (snap) => {
    renderEstadoConexion(snap.val() ? "conectado" : "desconectado", snap.val() ? "en vivo" : "sin conexión");
  });

  onValue(ref(db, "socios"), (snap) => {
    const socios = snap.val();
    if (!socios) { set(ref(db, "socios"), SOCIOS_DEFAULT); return; }
    estado.socios = socios;
    if (estado.socioId && !estado.socios[estado.socioId]) estado.socioId = null;
    renderSelector();
    renderTodo();
  });

  onValue(ref(db, "rollos"), (snap) => { estado.rollos = snap.val() || {}; renderTodo(); });
  onValue(ref(db, "impresiones"), (snap) => { estado.impresiones = snap.val() || {}; renderTodo(); });
  onValue(ref(db, "ajustes"), (snap) => { estado.ajustes = snap.val() || {}; renderTodo(); });

  onValue(ref(db, "config"), (snap) => {
    const c = snap.val();
    if (!c) { set(ref(db, "config"), CONFIG_DEFAULT); return; } // seed idempotente
    estado.config = { ...CONFIG_DEFAULT, ...c };
    renderTodo();
  });
}

function renderEstadoConexion(clave, texto) {
  $("#estado-conexion").dataset.estado = clave;
  $("#estado-texto").textContent = texto;
}

// =====================================================================
// 13 · Arranque
// =====================================================================
function iniciar() {
  if (estado.socioId && !estado.socios[estado.socioId]) estado.socioId = null;

  $$(".tab").forEach((t) => (t.onclick = () => renderVista(t.dataset.vista)));
  $("#chip-socio").onclick = abrirSelector;
  $("#selector").addEventListener("click", (e) => { if (e.target === $("#selector")) cerrarSelector(); });

  renderSelector();
  renderVista("inicio");
  renderChip();
  if (!estado.socioId) abrirSelector();

  if (HAY_CONFIG) conectarFirebase();
  else renderEstadoConexion("pendiente", "sin config");
}

iniciar();
