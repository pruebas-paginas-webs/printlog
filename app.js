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
  getDatabase, ref, onValue, set, push, update, remove, get,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import {
  costoPorGramo, pesoRestante,
  balancePorSocio, stockValorizado, gastoDelMes,
  horasMaquina, statsPorSocio, estadisticasGlobales, gramosPorMes, horasDesdeUltimoMant,
  tiempoVirtualPorSocio, ordenarCola, conEspera,
} from "./calc.js";

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
  mantenimientos: {},
  wishlist: {},
  config: { ...CONFIG_DEFAULT },
  vista: "inicio",
  verArchivados: false,
  verImpresos: false,
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

const nfDec1 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });
const formatHoras = (horas) => nfDec1.format(Math.round(horas * 10) / 10) + " h";
const formatPct = (frac) => (frac == null ? "—" : Math.round(frac * 100) + "%");
const formatDesvio = (frac) => {
  if (frac == null) return "—";
  const p = Math.round(frac * 100);
  return (p > 0 ? "+" : "") + p + "%";
};
function formatEspera(min) {
  if (min <= 0) return "arranca ahora";
  if (min < 60) return `arranca en ~${Math.round(min)} min`;
  return `arranca en ~${nfDec1.format(Math.round(min / 30) / 2)} h`;
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
  reloj: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  llave: '<path d="M13.5 6.5a4 4 0 0 0-5.6 4.9L3 16.3V20h3.7l4.9-4.9a4 4 0 0 0 4.9-5.6L13 13l-2-2z"/>',
  stats: '<path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V6"/><path d="M17 20v-9"/>',
  estrella: '<path d="M12 3.6l2.5 5.1 5.6.8-4.05 3.95.95 5.55L12 16.9l-5 2.65.95-5.55L3.4 9.5l5.6-.8z"/>',
  camara: '<path d="M4.5 8.5A1.5 1.5 0 0 1 6 7h1.8L9 5h6l1.2 2H18a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18 19H6a1.5 1.5 0 0 1-1.5-1.5z"/><circle cx="12" cy="12.6" r="3.1"/>',
  descarga: '<path d="M12 4v10"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/>',
  enlace: '<path d="M9.5 14.5 14.5 9.5"/><path d="M12.6 7.4 14 6a3.4 3.4 0 0 1 4.8 4.8L17.4 12.2"/><path d="M11.4 16.6 10 18a3.4 3.4 0 0 1-4.8-4.8L6.6 11.8"/>',
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
  else if (estado.vista === "stats") renderStats();
  else if (estado.vista === "wishlist") renderWishlist();
}

function renderTodo() {
  aplicarAcento();
  renderChip();
  renderVistaActual();
}

function renderFab(nombre) {
  const fab = $("#fab");
  if (nombre === "cola") { fab.hidden = false; $("#fab-texto").textContent = "Impresión"; fab.onclick = () => nuevaImpresion(); }
  else if (nombre === "stock") { fab.hidden = false; $("#fab-texto").textContent = "Rollo"; fab.onclick = nuevoRollo; }
  else if (nombre === "wishlist") { fab.hidden = false; $("#fab-texto").textContent = "Idea"; fab.onclick = nuevaIdea; }
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

function cardImpresion(id, imp, { hero = false, esperaMin = null } = {}) {
  const rollo = imp.rolloId ? estado.rollos[imp.rolloId] : null;
  const card = el("article", "card imp" + (hero ? " encurso" : ""));
  const badges = [];
  if (imp.urgente && imp.estado === "cola") badges.push(`<span class="badge badge-urgente">Urgente</span>`);
  if (imp.estado === "terminada" || imp.estado === "fallida") badges.push(`<span class="badge badge-estado" data-estado="${imp.estado}">${imp.estado}</span>`);

  const espera = esperaMin != null
    ? `<p class="espera${esperaMin <= 0 ? " ya" : ""}">${svgIco("reloj")} ${esc(formatEspera(esperaMin))}</p>`
    : "";

  const thumb = imp.fotoBase64
    ? `<button class="imp-thumb" data-acc="foto" aria-label="Ver foto de ${esc(imp.nombre)}"><img src="${esc(imp.fotoBase64)}" alt=""></button>`
    : "";

  card.innerHTML = `
    ${hero ? `<div class="encurso-tag"><span class="pulso"></span> Imprimiendo ahora</div>` : ""}
    <div class="card-cab">
      ${thumb}
      <div class="imp-info">
        <div class="card-tit">${esc(imp.nombre)}</div>
        <div class="imp-meta">${metaImpresion(imp, rollo)}</div>
      </div>
      ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
    </div>
    ${espera}
    <div class="acciones">${accionesHtml(imp.estado)}</div>`;

  card.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => manejarAccion(b.dataset.acc, id)));
  return card;
}

function cardRollo(id, r, notasAbiertas = false) {
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
    ${r.notasPerfil ? `<details class="expand" data-rollo="${esc(id)}"${notasAbiertas ? " open" : ""}><summary>Notas de perfil ${svgIco("chev", "chev")}</summary><div class="rollo-notas"><div class="rollo-notas-lbl">perfil de impresión</div>${esc(r.notasPerfil)}</div></details>` : ""}
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
  const ahora = Date.now();

  // alerta de mantenimiento (§4.5): horas desde el último vs. límite
  const limite = estado.config.horasEntreMantenimiento ?? 200;
  const desdeMant = horasDesdeUltimoMant(estado.impresiones, estado.mantenimientos);
  if (desdeMant >= limite) {
    const alerta = el("div", "alerta-mant",
      `${svgIco("llave")}<div><b>Toca mantenimiento</b><span>${esc(formatHoras(desdeMant))} de uso desde el último — el límite es ${limite} h.</span></div>`);
    const bMant = boton("Registrar", "boton-sec");
    bMant.onclick = registrarMantenimiento;
    alerta.append(bMant);
    cont.append(alerta);
  }

  // impresiones en curso con su rollo (puede haber más de una: §4.2 no bloquea)
  const imprimiendo = Object.entries(estado.impresiones).filter(([, i]) => i.estado === "imprimiendo");
  if (imprimiendo.length) {
    const s = seccion("En curso");
    imprimiendo.forEach(([id, i]) => s.append(cardImpresion(id, i, { hero: true })));
    cont.append(s);
  } else {
    cont.append(vacio("printer", "Nada en la máquina", "Cuando pongas algo a imprimir, aparece acá y la app toma el color del filamento cargado."));
  }

  // mini-stats: horas totales, tasa de éxito, gasto del mes, en cola
  const glob = estadisticasGlobales(estado.impresiones);
  const enColaN = Object.values(estado.impresiones).filter((i) => i.estado === "cola").length;
  const grid = el("div", "mini-stats");
  const tile = (num, lbl, destino) => {
    const t = el("button", "mini-stat", `<span class="mini-stat-num mono">${num}</span><span class="mini-stat-lbl">${lbl}</span>`);
    if (destino) t.onclick = () => irA(destino);
    return t;
  };
  grid.append(
    tile(esc(formatHoras(horasMaquina(estado.impresiones))), "horas de máquina", "stats"),
    tile(esc(formatPct(glob.tasaExito)), "tasa de éxito", "stats"),
    tile(esc(formatMoneda(gastoDelMes(estado.rollos, estado.impresiones, ahora))), "gasto del mes", "stats"),
    tile(enColaN, "en cola", "cola"),
  );
  cont.append(grid);

  // próximos 3 en el orden justo (§4.7)
  const tv = tiempoVirtualPorSocio(estado.socios, estado.impresiones, estado.config, ahora);
  const cola = Object.entries(estado.impresiones)
    .filter(([, i]) => i.estado === "cola")
    .map(([id, i]) => ({ id, ...i }));
  if (cola.length) {
    const ordenadas = ordenarCola(cola, tv);
    const estPrevio = imprimiendo.reduce((a, [, i]) => a + (i.tiempoEstimadoMin ?? 0), 0);
    const esperas = conEspera(ordenadas, estPrevio).slice(0, 3);
    const s = seccion("Próximos en la cola", cola.length);
    esperas.forEach(({ imp, esperaMin }, i) => {
      const fila = el("button", "prox",
        `<span class="prox-n mono">${i + 1}</span>
         <span class="prox-info"><span class="prox-nombre">${esc(imp.nombre)}</span>
         <span class="prox-espera">${esc(formatEspera(esperaMin))}</span></span>
         ${imp.urgente ? '<span class="badge badge-urgente">Urgente</span>' : ""}
         ${puntosHtml(imp.participantes)}`);
      fila.onclick = () => irA("cola");
      s.append(fila);
    });
    cont.append(s);
  }

  // rollos activos: barra de restante + alerta de stock bajo
  const rollosAct = Object.entries(estado.rollos)
    .filter(([, r]) => !r.archivado)
    .sort(([, a], [, b]) => (b.fechaCompra || 0) - (a.fechaCompra || 0));
  if (rollosAct.length) {
    const s = seccion("Filamento", rollosAct.length);
    const umbral = estado.config.umbralStockBajoGramos ?? 150;
    rollosAct.forEach(([id, r]) => {
      const rest = pesoRestante(id, estado.rollos, estado.impresiones, estado.ajustes);
      const pct = r.pesoInicial > 0 ? Math.max(0, Math.min(100, (rest / r.pesoInicial) * 100)) : 0;
      const neg = rest < 0, bajo = !neg && rest < umbral;
      const fila = el("button", "rollo-mini",
        `<span class="swatch swatch-lg" style="background:${esc(r.colorHex || "#888")}"></span>
         <span class="rollo-mini-info">
           <span class="rollo-mini-nombre">${esc(r.colorFilamento || r.material)} <i>${esc(r.material)}</i>${neg ? '<em class="mini-alerta neg">sin stock</em>' : bajo ? '<em class="mini-alerta">stock bajo</em>' : ""}</span>
           <span class="rollo-mini-via"><span class="rollo-mini-fill${neg ? " neg" : ""}" style="width:${pct}%;${neg ? "" : `background:${esc(r.colorHex || "#888")}`}"></span></span>
         </span>
         <span class="rollo-mini-g mono${neg ? " txt-neg" : bajo ? " txt-bajo" : ""}">${esc(formatG(rest))}</span>`);
      fila.onclick = () => irA("stock");
      s.append(fila);
    });
    cont.append(s);
  }
}

function renderCola() {
  const cont = $("#cont-cola");
  // un update remoto no debe cerrarte el historial que estás leyendo
  const histAbierto = !!cont.querySelector("details.hist[open]");
  cont.replaceChildren();
  cont.append(h1("Cola"));
  const ahora = Date.now();

  const imps = Object.entries(estado.impresiones).map(([id, i]) => ({ id, ...i }));
  const imprimiendo = imps.filter((i) => i.estado === "imprimiendo");
  const historial = imps
    .filter((i) => i.estado === "terminada" || i.estado === "fallida")
    .sort((a, b) => (b.fechaFin || 0) - (a.fechaFin || 0));

  // transparencia del orden (§4.7): tiempo virtual por socio en la ventana
  const tv = tiempoVirtualPorSocio(estado.socios, estado.impresiones, estado.config, ahora);
  const dias = estado.config.ventanaEquidadDias ?? 30;
  const valores = Object.values(tv);
  const min = Math.min(...valores);
  // el badge solo tiene sentido con un mínimo único: en empate no hay "prioridad"
  const minUnico = valores.filter((v) => Math.abs(v - min) <= 1e-6).length === 1;
  const equidad = el("div", "equidad");
  equidad.innerHTML = `<span class="equidad-lbl">Últimos ${dias} días</span>` +
    Object.entries(estado.socios).map(([id, s]) => {
      const prioridad = minUnico && tv[id] === min;
      return `<span class="equidad-socio${prioridad ? " turno" : ""}" title="${prioridad ? "Si manda algo ahora, va primero" : ""}">
        <span class="punto" style="background:${esc(s.color)}"></span>${esc(s.nombre)} <b class="mono">${esc(formatHoras((tv[id] || 0) / 60))}</b>
      </span>`;
    }).join("");
  cont.append(equidad);

  if (imprimiendo.length) {
    const s = seccion("En curso");
    imprimiendo.forEach((i) => s.append(cardImpresion(i.id, i, { hero: true })));
    cont.append(s);
  }

  // orden justo (§4.7) + espera acumulada por card
  const enCola = ordenarCola(imps.filter((i) => i.estado === "cola"), tv);
  const estPrevio = imprimiendo.reduce((a, i) => a + (i.tiempoEstimadoMin ?? 0), 0);
  const esperas = conEspera(enCola, estPrevio);

  const sc = seccion("En cola", enCola.length);
  if (!enCola.length) sc.append(vacio("inbox", "La cola está vacía", "Cargá una impresión con el botón +."));
  else esperas.forEach(({ imp, esperaMin }) => sc.append(cardImpresion(imp.id, imp, { esperaMin })));
  cont.append(sc);

  if (historial.length) {
    const det = el("details", "hist");
    det.open = histAbierto;
    const sum = el("summary", "hist-sum", `<span class="seccion-tit">Historial <span class="cuenta">${historial.length}</span></span>${svgIco("chev", "chev")}`);
    const body = el("div", "hist-body seccion");
    historial.forEach((i) => body.append(cardImpresion(i.id, i)));
    det.append(sum, body);
    cont.append(det);
  }
}

function renderStock() {
  const cont = $("#cont-stock");
  // preservar qué notas de perfil están abiertas ante re-renders remotos
  const abiertas = new Set([...cont.querySelectorAll("details[data-rollo][open]")].map((d) => d.dataset.rollo));
  cont.replaceChildren();
  cont.append(h1("Stock"));

  const todos = Object.entries(estado.rollos).map(([id, r]) => ({ id, ...r }));
  const porFecha = (a, b) => (b.fechaCompra || 0) - (a.fechaCompra || 0);
  const activos = todos.filter((r) => !r.archivado).sort(porFecha);
  const archivados = todos.filter((r) => r.archivado).sort(porFecha);

  const s = seccion("Rollos activos", activos.length);
  if (!activos.length) s.append(vacio("spool", "Todavía no hay rollos", "Cargá tu primer filamento con el botón +."));
  else activos.forEach((r) => s.append(cardRollo(r.id, r, abiertas.has(r.id))));
  cont.append(s);

  if (archivados.length) {
    const toggle = el("button", "toggle-archivados", `${estado.verArchivados ? "Ocultar" : "Ver"} archivados (${archivados.length})`);
    toggle.onclick = () => { estado.verArchivados = !estado.verArchivados; renderStock(); };
    cont.append(toggle);
    if (estado.verArchivados) {
      const sa = seccion("Archivados", archivados.length);
      archivados.forEach((r) => sa.append(cardRollo(r.id, r, abiertas.has(r.id))));
      cont.append(sa);
    }
  }

  cont.append(gcode("; el stock se deriva de las impresiones y ajustes — cierra contra la balanza"));
}

function renderStats() {
  const cont = $("#cont-stats");
  cont.replaceChildren();
  cont.append(h1("Estadísticas"));
  const ahora = Date.now();

  const hayCerradas = Object.values(estado.impresiones).some((i) => i.estado === "terminada" || i.estado === "fallida");
  const hayRollos = Object.keys(estado.rollos).length > 0;
  if (!hayCerradas && !hayRollos) {
    cont.append(vacio("stats", "Todavía no hay datos", "Cargá rollos y terminá impresiones: acá aparecen las horas, el balance y la tasa de éxito."));
    return;
  }

  const stats = statsPorSocio(estado.socios, estado.impresiones);
  const bal = balancePorSocio(estado.socios, estado.rollos, estado.impresiones);
  const glob = estadisticasGlobales(estado.impresiones);

  // --- por socio: horas, gramos, impresiones + aportado/consumido/neto ---
  const s1 = seccion("Por socio");
  for (const [id, socio] of Object.entries(estado.socios)) {
    const st = stats[id], b = bal[id];
    const netoCls = b.neto > 0.5 ? "pos" : b.neto < -0.5 ? "neg" : "";
    const card = el("article", "card socio-card");
    card.innerHTML = `
      <div class="socio-cab">
        <span class="punto" style="background:${esc(socio.color)}"></span>
        <span class="socio-nombre">${esc(socio.nombre)}</span>
        <span class="socio-imps mono">${st.cantidad} imp${st.fallidas ? ` · ${st.fallidas} fallida${st.fallidas > 1 ? "s" : ""}` : ""}</span>
      </div>
      <div class="socio-cifras">
        <div class="rollo-cifra"><span class="v">${esc(formatHoras(st.horas))}</span><span class="k">horas</span></div>
        <div class="rollo-cifra"><span class="v">${esc(formatG(Math.round(st.gramos)))}</span><span class="k">filamento</span></div>
      </div>
      <div class="socio-balance">
        <div class="linea"><span class="k">Aportó</span><span class="mono">${esc(formatMoneda(b.aportado))}</span></div>
        <div class="linea"><span class="k">Consumió</span><span class="mono">${esc(formatMoneda(Math.round(b.consumido)))}</span></div>
        <div class="linea neto ${netoCls}"><span class="k">Neto</span><span class="mono">${b.neto > 0.5 ? "+" : ""}${esc(formatMoneda(Math.round(b.neto)))}</span></div>
      </div>`;
    s1.append(card);
  }
  // aclaración §4.4: los netos no suman cero mientras quede filamento
  const stockVal = stockValorizado(estado.rollos, estado.impresiones, estado.ajustes);
  const nota = el("div", "card nota-balance");
  nota.innerHTML = `
    <div class="linea-stock"><span>Filamento sin usar (valorizado)</span><b class="mono">${esc(formatMoneda(Math.round(stockVal)))}</b></div>
    <p class="nota">Los netos no suman cero mientras quede filamento sin usar: la diferencia es el valor del stock restante, que pertenece proporcionalmente a quienes tienen neto positivo. Se saldan cuentas cuando quieran — la app solo muestra los números.</p>`;
  s1.append(nota);
  cont.append(s1);

  // --- global ---
  const s2 = seccion("La máquina");
  const grid = el("div", "mini-stats");
  grid.innerHTML = `
    <div class="mini-stat"><span class="mini-stat-num mono">${esc(formatPct(glob.tasaExito))}</span><span class="mini-stat-lbl">tasa de éxito · ${glob.terminadas} ok, ${glob.fallidas} fallida${glob.fallidas === 1 ? "" : "s"}</span></div>
    <div class="mini-stat"><span class="mini-stat-num mono">${esc(formatHoras(horasMaquina(estado.impresiones)))}</span><span class="mini-stat-lbl">horas totales</span></div>
    <div class="mini-stat"><span class="mini-stat-num mono">${esc(formatDesvio(glob.desvioGramos))}</span><span class="mini-stat-lbl">desvío gramos est. vs. real</span></div>
    <div class="mini-stat"><span class="mini-stat-num mono">${esc(formatDesvio(glob.desvioTiempo))}</span><span class="mini-stat-lbl">desvío tiempo est. vs. real</span></div>`;
  s2.append(grid);

  // motivos de fallo
  const motivos = Object.entries(glob.motivos).sort((a, b) => b[1] - a[1]);
  if (motivos.length) {
    const maxM = motivos[0][1];
    const card = el("article", "card");
    card.innerHTML = `<p class="card-etiqueta">; motivos de fallo</p>` + motivos.map(([k, n]) => `
      <div class="motivo">
        <span class="motivo-lbl">${esc(MOTIVOS[k] || k)}</span>
        <span class="motivo-via"><span class="motivo-fill" style="width:${(n / maxM) * 100}%"></span></span>
        <span class="motivo-n mono">${n}</span>
      </div>`).join("");
    s2.append(card);
  }

  // último mantenimiento (§4.5)
  const mants = Object.values(estado.mantenimientos || {});
  if (mants.length) {
    const ult = mants.reduce((a, m) => (!a || (m.fecha || 0) > (a.fecha || 0) ? m : a), null);
    const desde = Math.max(0, horasDesdeUltimoMant(estado.impresiones, estado.mantenimientos));
    const card = el("article", "card mant-card",
      `${svgIco("llave")}<div class="mant-info">
        <span class="mant-tit">Último mantenimiento</span>
        <span class="mant-detalle"><b>${esc(ult.tipo)}</b> · hace ${esc(formatHoras(desde))} de uso · ${esc(formatFecha(ult.fecha))}</span>
        ${ult.notas ? `<span class="mant-notas">${esc(ult.notas)}</span>` : ""}
      </div>`);
    s2.append(card);
  }
  cont.append(s2);

  // --- gramos por mes: barras CSS simples (§5.4, sin librerías) ---
  const meses = gramosPorMes(estado.impresiones, 6, ahora);
  if (meses.some((m) => m.gramos > 0)) {
    const maxG = Math.max(...meses.map((m) => m.gramos));
    const s3 = seccion("Filamento por mes");
    const card = el("article", "card");
    card.innerHTML = `<div class="meses">` + meses.map((m) => {
      const label = new Date(m.anio, m.mes, 1).toLocaleDateString("es-AR", { month: "short" }).replace(".", "");
      return `<div class="mes">
        <span class="mes-g mono">${m.gramos ? esc(nfMiles.format(Math.round(m.gramos))) : ""}</span>
        <span class="mes-via"><span class="mes-fill" style="height:${maxG ? (m.gramos / maxG) * 100 : 0}%"></span></span>
        <span class="mes-lbl">${esc(label)}</span>
      </div>`;
    }).join("") + `</div><p class="nota" style="text-align:center">gramos consumidos por mes</p>`;
    s3.append(card);
    cont.append(s3);
  }
}

// --- Wishlist (§5.5): ideas con votos + galería de terminadas ---
function cardWishlist(id, it) {
  const votos = it.votos || {};
  const n = Object.keys(votos).length;
  const vote = !!votos[estado.socioId];
  const card = el("article", "card wish" + (it.impreso ? " impreso" : ""));
  card.innerHTML = `
    <div class="wish-cab">
      <div class="wish-info">
        <div class="card-tit">${esc(it.nombre)}</div>
        <div class="wish-meta">
          ${it.link ? `<a class="wish-link" href="${esc(it.link)}" target="_blank" rel="noopener">${svgIco("enlace")}<span>ver modelo</span></a>` : ""}
          <span class="wish-por">lo propuso ${esc(nombreSocio(it.propuestoPor))}</span>
        </div>
        <div class="wish-votos">${n ? `${puntosHtml(votos)}<span class="wish-votos-lbl">${n} voto${n === 1 ? "" : "s"}</span>` : `<span class="wish-sin">sin votos todavía</span>`}</div>
      </div>
      <button class="voto-btn${vote ? " activo" : ""}" data-acc="votar" aria-pressed="${vote}" aria-label="${vote ? "Quitar mi voto" : "Votar esta idea"}">
        ${svgIco("estrella")}<span class="voto-n mono">${n}</span>
      </button>
    </div>
    <div class="acciones">
      ${it.impreso
        ? `<button class="boton boton-sec boton-bloque" data-acc="reproponer">${svgIco("atras")}<span>Volver a proponer</span></button>`
        : `<button class="boton boton-primario" data-acc="mandar">${svgIco("printer")}<span>Mandar a la cola</span></button>`}
      <button class="boton boton-sec boton-mas" data-acc="mas-wish" aria-label="Más acciones">${svgIco("mas")}</button>
    </div>`;
  card.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => {
    const a = b.dataset.acc;
    if (a === "votar") toggleVoto(id);
    else if (a === "mandar") mandarACola(id);
    else if (a === "reproponer") reproponerIdea(id);
    else if (a === "mas-wish") accionesWishlist(id);
  }));
  return card;
}

function renderWishlist() {
  const cont = $("#cont-wishlist");
  cont.replaceChildren();
  cont.append(h1("Wishlist"));

  const items = Object.entries(estado.wishlist).map(([id, it]) => ({ id, ...it }));
  const nVotos = (it) => Object.keys(it.votos || {}).length;
  const pendientes = items.filter((it) => !it.impreso)
    .sort((a, b) => (nVotos(b) - nVotos(a)) || ((a.fecha || 0) - (b.fecha || 0)));
  const impresos = items.filter((it) => it.impreso).sort((a, b) => (b.fecha || 0) - (a.fecha || 0));

  const s = seccion("Ideas", pendientes.length || null);
  if (!pendientes.length) s.append(vacio("estrella", "Todavía no hay ideas", "Cargá algo que quieran imprimir con el botón +. Se vota entre los tres y sale la más votada."));
  else pendientes.forEach((it) => s.append(cardWishlist(it.id, it)));
  cont.append(s);

  if (impresos.length) {
    const toggle = el("button", "toggle-archivados", `${estado.verImpresos ? "Ocultar" : "Ver"} ya impresas (${impresos.length})`);
    toggle.onclick = () => { estado.verImpresos = !estado.verImpresos; renderWishlist(); };
    cont.append(toggle);
    if (estado.verImpresos) {
      const si = seccion("Ya impresas", impresos.length);
      impresos.forEach((it) => si.append(cardWishlist(it.id, it)));
      cont.append(si);
    }
  }

  // galería de fotos de terminadas (§5.5, al pie)
  const conFoto = Object.entries(estado.impresiones)
    .filter(([, i]) => i.estado === "terminada" && i.fotoBase64)
    .map(([id, i]) => ({ id, ...i }))
    .sort((a, b) => (b.fechaFin || 0) - (a.fechaFin || 0));
  if (conFoto.length) {
    const sg = seccion("Terminadas con foto", conFoto.length);
    const grid = el("div", "galeria");
    conFoto.forEach((i) => {
      const b = el("button", "galeria-item");
      b.innerHTML = `<img src="${esc(i.fotoBase64)}" alt="${esc(i.nombre)}" loading="lazy">`;
      b.setAttribute("aria-label", `Ver foto de ${i.nombre}`);
      b.onclick = () => verFoto(i.id);
      grid.append(b);
    });
    sg.append(grid);
    cont.append(sg);
  }
}

// Visor de foto grande (overlay centrado, patrón existente)
function verFoto(id) {
  const i = estado.impresiones[id];
  if (!i || !i.fotoBase64) return;
  const box = el("div", "foto-visor");
  box.innerHTML = `
    <button class="foto-cerrar" aria-label="Cerrar">${svgIco("x")}</button>
    <img class="foto-grande" src="${esc(i.fotoBase64)}" alt="${esc(i.nombre)}">
    <div class="foto-pie">
      <span class="foto-nombre">${esc(i.nombre)}</span>
      ${i.fechaFin ? `<span class="foto-fecha mono">${esc(formatFecha(i.fechaFin))}</span>` : ""}
    </div>`;
  box.querySelector(".foto-cerrar").onclick = overlayHide;
  overlayAbrir(box, { cerrable: true, centrar: true });
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

// Compresión client-side (§2): canvas, lado mayor ≤800px, JPEG q0.7 → dataURL.
// Si pesa > 100 KB reintenta con q0.5; si sigue > 150 KB (límite duro) devuelve null.
// Aproximamos los bytes con dataURL.length (§2, decisión de la spec).
async function comprimirFoto(file) {
  if (!file || !file.type?.startsWith("image/")) return null;
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  const MAX = 800;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > MAX || h > MAX) {
    if (w >= h) { h = Math.round((h * MAX) / w); w = MAX; }
    else { w = Math.round((w * MAX) / h); h = MAX; }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  let out = canvas.toDataURL("image/jpeg", 0.7);
  if (out.length > 100 * 1024) out = canvas.toDataURL("image/jpeg", 0.5);
  if (out.length > 150 * 1024) return null;
  return out;
}

// Campo de foto reutilizable (cierre de terminada + agregar/cambiar desde historial).
// Devuelve { el, get } — get() da el dataURL actual (o null). Comprime al elegir.
function campoFoto(inicial) {
  let fotoData = inicial || null;
  const wrap = el("div", "campo");
  wrap.innerHTML = `
    <label class="campo-lbl">Foto <span class="opt">· opcional</span></label>
    <div class="foto-campo">
      <div class="foto-prev" hidden><img alt=""><button type="button" class="foto-quitar" aria-label="Quitar foto">${svgIco("x")}</button></div>
      <label class="foto-boton"><input class="foto-input" type="file" accept="image/*" capture="environment" hidden>${svgIco("camara")}<span>Sacar o elegir foto</span></label>
    </div>
    <p class="campo-ayuda">Se comprime en el teléfono (máx. 800 px). Si pesa demasiado, usá el link de la impresión.</p>`;
  const prev = wrap.querySelector(".foto-prev");
  const imgEl = wrap.querySelector(".foto-prev img");
  const input = wrap.querySelector(".foto-input");
  const lblSpan = wrap.querySelector(".foto-boton span");
  const refrescar = () => {
    if (fotoData) { imgEl.src = fotoData; prev.hidden = false; lblSpan.textContent = "Cambiar foto"; }
    else { imgEl.removeAttribute("src"); prev.hidden = true; lblSpan.textContent = "Sacar o elegir foto"; }
  };
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    lblSpan.textContent = "Comprimiendo…";
    let data = null;
    try { data = await comprimirFoto(file); } catch { data = null; }
    input.value = "";
    if (!data) { toast("La foto es muy pesada. Usá el campo de link de la impresión.", true); refrescar(); return; }
    fotoData = data;
    refrescar();
  };
  wrap.querySelector(".foto-quitar").onclick = () => { fotoData = null; refrescar(); };
  refrescar();
  return { el: wrap, get: () => fotoData };
}

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

  // Foto opcional solo al terminar (§2, §5.5) — las fallidas no llevan foto.
  let foto = null;
  if (!conMotivo) { foto = campoFoto(imp.fotoBase64 || null); form.append(foto.el); }

  const leer = () => {
    const g = parseInt(form.querySelector("#c-gr").value, 10);
    if (Number.isNaN(g) || g < 0) return marcarError(form.querySelector("#c-gr"), "Cargá los gramos");
    const h = parseInt(form.querySelector("#c-h").value, 10) || 0;
    const m = parseInt(form.querySelector("#c-m").value, 10) || 0;
    const tiempoRealMin = h * 60 + m;
    if (!(tiempoRealMin > 0)) return marcarError(form.querySelector("#c-h"), "Cargá el tiempo");
    const out = { gramosReales: g, tiempoRealMin };
    if (conMotivo) out.motivoFallo = form.querySelector("#c-mot").value;
    else out.fotoBase64 = foto.get();
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

// preset: precarga campos (ej. desde la wishlist). alGuardar: callback tras crear.
function nuevaImpresion(preset, alGuardar) {
  if (!requiereConexion()) return;
  const f = formImpresion(preset);
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
      if (alGuardar) await alGuardar();
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
      const patch = { gramosReales: d.gramosReales, tiempoRealMin: d.tiempoRealMin, fotoBase64: d.fotoBase64 ?? null };
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

// Reorden de la sub-cola PROPIA (§4.7): `orden` decide cuál de TUS
// impresiones entra en cada turno tuyo — no la posición global.
// Fractional indexing: punto medio entre vecinas; frente = primera − 60000.
function subColaPropia() {
  const ordenDe = (i) => i.orden ?? i.fechaCreacion ?? 0;
  return Object.entries(estado.impresiones)
    .filter(([, i]) => i.estado === "cola" && !i.urgente && i.participantes?.[estado.socioId])
    .map(([id, i]) => ({ id, ...i }))
    .sort((a, b) => (ordenDe(a) - ordenDe(b)) || ((a.fechaCreacion || 0) - (b.fechaCreacion || 0)));
}
function moverFrente(id) {
  const lista = subColaPropia();
  if (!lista.length || lista[0].id === id) return;
  update(ref(db, `impresiones/${id}`), { orden: (lista[0].orden ?? lista[0].fechaCreacion) - 60000 });
  toast("Al frente de tu cola");
}
function moverArriba(id) {
  const lista = subColaPropia();
  const i = lista.findIndex((x) => x.id === id);
  if (i <= 0) return;
  const prev = lista[i - 1], prevPrev = lista[i - 2];
  const oPrev = prev.orden ?? prev.fechaCreacion;
  const nuevo = prevPrev ? ((prevPrev.orden ?? prevPrev.fechaCreacion) + oPrev) / 2 : oPrev - 60000;
  update(ref(db, `impresiones/${id}`), { orden: nuevo });
}
function moverAbajo(id) {
  const lista = subColaPropia();
  const i = lista.findIndex((x) => x.id === id);
  if (i < 0 || i >= lista.length - 1) return;
  const next = lista[i + 1], nextNext = lista[i + 2];
  const oNext = next.orden ?? next.fechaCreacion;
  const nuevo = nextNext ? (oNext + (nextNext.orden ?? nextNext.fechaCreacion)) / 2 : oNext + 60000;
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
  else if (acc === "foto") verFoto(id);
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
      items.push({ label: "Al frente de mis impresiones", icon: "frente", onClick: () => moverFrente(id) });
      items.push({ label: "Subir entre las mías", icon: "arriba", onClick: () => moverArriba(id) });
      items.push({ label: "Bajar entre las mías", icon: "abajo", onClick: () => moverAbajo(id) });
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
    if (imp.estado === "terminada") {
      items.push({ label: imp.fotoBase64 ? "Cambiar foto" : "Agregar foto", icon: "camara", onClick: () => cambiarFoto(id) });
      if (imp.fotoBase64) items.push({ label: "Quitar foto", icon: "borrar", onClick: () => quitarFoto(id) });
    }
    items.push("sep");
    items.push({ label: "Borrar", icon: "borrar", danger: true, onClick: () => borrarImpresion(id) });
  }
  abrirAcciones(imp.nombre, items);
}

// --- Foto de una terminada desde el historial (agregar/cambiar/quitar) ---
function cambiarFoto(id) {
  if (!requiereConexion()) return;
  const imp = estado.impresiones[id]; if (!imp) return;
  const foto = campoFoto(imp.fotoBase64 || null);
  const cuerpo = el("div", "form");
  cuerpo.append(foto.el);
  abrirHoja({
    titulo: imp.fotoBase64 ? "Cambiar foto" : "Agregar foto", cuerpoEl: cuerpo, textoGuardar: "Guardar",
    guardar: async () => {
      await update(ref(db, `impresiones/${id}`), { fotoBase64: foto.get() });
      overlayHide(); toast(foto.get() ? "Foto guardada" : "Foto quitada");
    },
  });
}
async function quitarFoto(id) {
  const imp = estado.impresiones[id]; if (!imp) return;
  const ok = await confirmar({ titulo: "Quitar foto", mensaje: `Se saca la foto de <b>${esc(imp.nombre)}</b>.`, ok: "Quitar", peligro: true });
  if (!ok) return;
  await update(ref(db, `impresiones/${id}`), { fotoBase64: null });
  toast("Foto quitada");
}

// =====================================================================
// 10.b · Wishlist — acciones (§5.5)
// =====================================================================
function toggleVoto(id) {
  if (!requiereConexion()) return;
  const it = estado.wishlist[id]; if (!it) return;
  const voto = !!it.votos?.[estado.socioId];
  if (voto) remove(ref(db, `wishlist/${id}/votos/${estado.socioId}`));
  else set(ref(db, `wishlist/${id}/votos/${estado.socioId}`), true);
}

function mandarACola(itemId) {
  const item = estado.wishlist[itemId]; if (!item) return;
  nuevaImpresion({ nombre: item.nombre, linkSTL: item.link || "" }, async () => {
    await update(ref(db, `wishlist/${itemId}`), { impreso: true });
    toast("Idea marcada como impresa");
  });
}

function reproponerIdea(id) {
  update(ref(db, `wishlist/${id}`), { impreso: false });
  toast("De vuelta en la wishlist");
}
function marcarImpresa(id) {
  update(ref(db, `wishlist/${id}`), { impreso: true });
  toast("Marcada como impresa");
}
async function borrarIdea(id) {
  const it = estado.wishlist[id]; if (!it) return;
  const ok = await confirmar({ titulo: "Borrar idea", mensaje: `Se elimina <b>${esc(it.nombre)}</b> de la wishlist.`, ok: "Borrar", peligro: true });
  if (!ok) return;
  await remove(ref(db, `wishlist/${id}`));
  toast("Idea borrada");
}

function formIdea(item) {
  const it = item || {};
  const form = el("form", "form");
  form.innerHTML = `
    <div class="campo">
      <label class="campo-lbl" for="w-nom">¿Qué querés imprimir?</label>
      <input id="w-nom" type="text" value="${esc(it.nombre || "")}" placeholder="Organizador de cables" autocomplete="off">
    </div>
    <div class="campo">
      <label class="campo-lbl" for="w-link">Link al modelo <span class="opt">· opcional</span></label>
      <input id="w-link" type="url" value="${esc(it.link || "")}" placeholder="https://www.printables.com/…" autocomplete="off">
    </div>`;
  const leer = () => {
    const nombre = form.querySelector("#w-nom").value.trim();
    if (!nombre) return marcarError(form.querySelector("#w-nom"), "Poné un nombre");
    return { nombre, link: form.querySelector("#w-link").value.trim() };
  };
  return { el: form, leer };
}
function nuevaIdea() {
  if (!requiereConexion()) return;
  const f = formIdea();
  abrirHoja({
    titulo: "Nueva idea", cuerpoEl: f.el, textoGuardar: "Proponer",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      // el que propone ya arranca con su voto puesto (§5.5)
      await push(ref(db, "wishlist"), {
        nombre: d.nombre, link: d.link, propuestoPor: estado.socioId,
        votos: { [estado.socioId]: true }, fecha: Date.now(), impreso: false,
      });
      overlayHide(); toast("Idea agregada a la wishlist");
    },
  });
}
function editarIdea(id) {
  const it = estado.wishlist[id]; if (!it) return;
  const f = formIdea(it);
  abrirHoja({
    titulo: "Editar idea", cuerpoEl: f.el, textoGuardar: "Guardar",
    guardar: async () => {
      const d = f.leer(); if (!d) return;
      await update(ref(db, `wishlist/${id}`), { nombre: d.nombre, link: d.link });
      overlayHide(); toast("Idea actualizada");
    },
  });
}
function accionesWishlist(id) {
  const it = estado.wishlist[id]; if (!it) return;
  const items = [{ label: "Editar idea", icon: "editar", onClick: () => editarIdea(id) }];
  if (it.impreso) items.push({ label: "Volver a proponer", icon: "atras", onClick: () => reproponerIdea(id) });
  else items.push({ label: "Marcar como impresa", icon: "check", onClick: () => marcarImpresa(id) });
  items.push("sep");
  items.push({ label: "Borrar idea", icon: "borrar", danger: true, onClick: () => borrarIdea(id) });
  abrirAcciones(it.nombre, items);
}

// =====================================================================
// 10.c · Mantenimiento, configuración y backup (§4.5, §5, §7-F4)
// =====================================================================
function registrarMantenimiento() {
  if (!requiereConexion()) return;
  const horas = Math.round(horasMaquina(estado.impresiones) * 10) / 10;
  const sugeridos = ["Lubricación de ejes", "Cambio de nozzle", "Nivelación de cama", "Ajuste de correas", "Limpieza general", "Cambio de tubo PTFE"];
  const form = el("form", "form");
  form.innerHTML = `
    <div class="ajuste-info">La máquina lleva <b>${esc(formatHoras(horas))}</b> de uso. Se guarda ese número como referencia de este mantenimiento.</div>
    <div class="campo">
      <label class="campo-lbl" for="m-tipo">¿Qué hiciste?</label>
      <input id="m-tipo" type="text" list="mants" value="" placeholder="Lubricación de ejes" autocomplete="off">
      <datalist id="mants">${sugeridos.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="m-notas">Notas <span class="opt">· opcional</span></label>
      <textarea id="m-notas" placeholder="Qué cambiaste, qué observaste…"></textarea>
    </div>`;
  abrirHoja({
    titulo: "Registrar mantenimiento", cuerpoEl: form, textoGuardar: "Registrar",
    guardar: async () => {
      const tipo = form.querySelector("#m-tipo").value.trim();
      if (!tipo) return marcarError(form.querySelector("#m-tipo"), "Poné qué mantenimiento hiciste");
      await push(ref(db, "mantenimientos"), {
        tipo, fecha: Date.now(), horasMaquina: horas,
        hechoPor: estado.socioId, notas: form.querySelector("#m-notas").value.trim(),
      });
      overlayHide(); toast("Mantenimiento registrado");
    },
  });
}

function abrirConfig() {
  if (!requiereConexion()) return;
  const c = estado.config;
  const cuerpo = el("div", "form");
  cuerpo.innerHTML = `
    <div class="campo">
      <label class="campo-lbl" for="cf-mant">Horas entre mantenimientos</label>
      <div class="sufijo"><input id="cf-mant" class="num" type="number" inputmode="numeric" min="1" value="${c.horasEntreMantenimiento ?? 200}"><span class="u">h</span></div>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="cf-umbral">Umbral de stock bajo</label>
      <div class="sufijo"><input id="cf-umbral" class="num" type="number" inputmode="numeric" min="1" value="${c.umbralStockBajoGramos ?? 150}"><span class="u">g</span></div>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="cf-carrete">Peso del carrete vacío</label>
      <div class="sufijo"><input id="cf-carrete" class="num" type="number" inputmode="numeric" min="1" value="${c.pesoCarreteVacio ?? 200}"><span class="u">g</span></div>
    </div>
    <div class="campo">
      <label class="campo-lbl" for="cf-ventana">Ventana de equidad de la cola</label>
      <div class="sufijo"><input id="cf-ventana" class="num" type="number" inputmode="numeric" min="1" value="${c.ventanaEquidadDias ?? 30}"><span class="u">días</span></div>
      <p class="campo-ayuda">Sobre cuántos días de uso reciente se reparte la cola justa.</p>
    </div>`;

  const herr = el("div", "config-herr");
  herr.append(el("div", "config-herr-lbl", "Herramientas"));
  const bMant = boton("Registrar mantenimiento", "boton-sec", "llave"); bMant.classList.add("boton-bloque");
  bMant.onclick = () => { overlayHide(); registrarMantenimiento(); };
  const bBackup = boton("Descargar backup (JSON)", "boton-sec", "descarga"); bBackup.classList.add("boton-bloque");
  bBackup.onclick = descargarBackup;
  herr.append(bMant, bBackup);
  cuerpo.append(herr);

  abrirHoja({
    titulo: "Configuración", cuerpoEl: cuerpo, textoGuardar: "Guardar",
    guardar: async () => {
      const mant = intOrNull(cuerpo.querySelector("#cf-mant").value);
      const umbral = intOrNull(cuerpo.querySelector("#cf-umbral").value);
      const carrete = intOrNull(cuerpo.querySelector("#cf-carrete").value);
      const ventana = intOrNull(cuerpo.querySelector("#cf-ventana").value);
      if (!(mant > 0)) return marcarError(cuerpo.querySelector("#cf-mant"), "Horas entre mantenimientos: número mayor a 0");
      if (!(umbral > 0)) return marcarError(cuerpo.querySelector("#cf-umbral"), "Umbral de stock bajo: número mayor a 0");
      if (!(carrete > 0)) return marcarError(cuerpo.querySelector("#cf-carrete"), "Peso del carrete: número mayor a 0");
      if (!(ventana > 0)) return marcarError(cuerpo.querySelector("#cf-ventana"), "Ventana de equidad: número mayor a 0");
      await update(ref(db, "config"), {
        horasEntreMantenimiento: mant, umbralStockBajoGramos: umbral,
        pesoCarreteVacio: carrete, ventanaEquidadDias: ventana,
      });
      overlayHide(); toast("Configuración guardada");
    },
  });
}

// Export/backup (§7-F4): descarga el árbol completo de RTDB como JSON.
async function descargarBackup() {
  if (!db) { toast("Sin conexión con la base", true); return; }
  try {
    const snap = await get(ref(db, "/"));
    const json = JSON.stringify(snap.val() || {}, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const a = el("a");
    a.href = url; a.download = `printlog-backup-${stamp}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Backup descargado");
  } catch (e) {
    console.error("Backup falló:", e);
    toast("No se pudo descargar el backup", true);
  }
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
    if (estado.socioId && !estado.socios[estado.socioId]) {
      // el socio guardado ya no existe: limpiar y volver a preguntar
      estado.socioId = null;
      localStorage.removeItem("printlog_socio");
      abrirSelector();
    }
    renderSelector();
    renderTodo();
  });

  onValue(ref(db, "rollos"), (snap) => { estado.rollos = snap.val() || {}; renderTodo(); });
  onValue(ref(db, "impresiones"), (snap) => { estado.impresiones = snap.val() || {}; renderTodo(); });
  onValue(ref(db, "ajustes"), (snap) => { estado.ajustes = snap.val() || {}; renderTodo(); });
  onValue(ref(db, "mantenimientos"), (snap) => { estado.mantenimientos = snap.val() || {}; renderTodo(); });
  onValue(ref(db, "wishlist"), (snap) => { estado.wishlist = snap.val() || {}; renderTodo(); });

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
  if (estado.socioId && !estado.socios[estado.socioId]) {
    estado.socioId = null;
    localStorage.removeItem("printlog_socio");
  }

  $$(".tab").forEach((t) => (t.onclick = () => renderVista(t.dataset.vista)));
  $("#chip-socio").onclick = abrirSelector;
  $("#btn-config").onclick = abrirConfig;
  $("#selector").addEventListener("click", (e) => { if (e.target === $("#selector")) cerrarSelector(); });

  renderSelector();
  renderVista("inicio");
  renderChip();
  if (!estado.socioId) abrirSelector();

  if (HAY_CONFIG) conectarFirebase();
  else renderEstadoConexion("pendiente", "sin config");
}

iniciar();
