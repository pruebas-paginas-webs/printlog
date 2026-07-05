// =====================================================================
// PRINTLOG · app.js — F0: identidad, esqueleto y nodo de prueba
// ---------------------------------------------------------------------
// Principios (CLAUDE.md §8): la verdad vive en RTDB, la UI la refleja.
// Estado global mínimo + funciones render. Sin frameworks.
// En F0 existen dos nodos: /socios (seed inicial) y /prueba (contador
// para validar la sincronización en los tres teléfonos).
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase,
  ref,
  onValue,
  set,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ---------------------------------------------------------------------
// 1 · Config de Firebase
// Pegar acá el objeto real: Firebase Console → ⚙ Configuración del
// proyecto → Tus apps → app web → "SDK setup and configuration".
// Es pública por diseño: la protección real son las reglas de RTDB (§2).
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
// 2 · Estado global mínimo
// ---------------------------------------------------------------------
const SOCIOS_DEFAULT = {
  s1: { nombre: "Agustín", color: "#e07a3f" },
  s2: { nombre: "Matías", color: "#4f8fe0" },
  s3: { nombre: "Joaquín", color: "#5fb87a" },
};

const estado = {
  socioId: localStorage.getItem("printlog_socio"),
  socios: SOCIOS_DEFAULT,
  prueba: null, // { count, por, fecha }
};

let db = null;

// ---------------------------------------------------------------------
// 3 · Helpers
// ---------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function formatMomento(ms) {
  const fecha = new Date(ms);
  const hora = fecha.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  if (fecha.toDateString() === new Date().toDateString()) return hora;
  const dia = fecha.toLocaleDateString("es-AR", { day: "numeric", month: "numeric" });
  return `${dia} · ${hora}`;
}

// ---------------------------------------------------------------------
// 4 · Render
// ---------------------------------------------------------------------
function renderVista(nombre) {
  $$(".vista").forEach((v) => (v.hidden = v.dataset.vista !== nombre));
  $$(".tab").forEach((t) => {
    const activo = t.dataset.vista === nombre;
    t.classList.toggle("activo", activo);
    if (activo) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
}

function renderEstadoConexion(clave, texto) {
  $("#estado-conexion").dataset.estado = clave;
  $("#estado-texto").textContent = texto;
}

function renderChip() {
  const chip = $("#chip-socio");
  const socio = estado.socios[estado.socioId];
  chip.hidden = !socio;
  if (!socio) return;
  $("#chip-color").style.background = socio.color;
  $("#chip-nombre").textContent = socio.nombre;
}

function renderSelector() {
  const lista = $("#selector-lista");
  lista.replaceChildren();
  for (const [id, socio] of Object.entries(estado.socios)) {
    const boton = document.createElement("button");
    boton.className = "selector-socio";
    boton.style.setProperty("--socio-color", socio.color);
    const punto = document.createElement("span");
    punto.className = "socio-punto";
    punto.setAttribute("aria-hidden", "true");
    boton.append(punto, document.createTextNode(socio.nombre));
    boton.addEventListener("click", () => elegirSocio(id));
    lista.append(boton);
  }
}

function renderPrueba() {
  $("#prueba-setup").hidden = HAY_CONFIG;
  $("#prueba-contador").hidden = !HAY_CONFIG;
  if (!HAY_CONFIG) return;

  const num = $("#prueba-num");
  const meta = $("#prueba-meta");
  if (!estado.prueba) {
    num.textContent = "0";
    meta.textContent = "Nadie tocó todavía.";
    return;
  }
  num.textContent = estado.prueba.count;
  const nombre = estado.socios[estado.prueba.por]?.nombre ?? "alguien";
  const negrita = document.createElement("b");
  negrita.textContent = nombre;
  meta.replaceChildren("Último toque: ", negrita, ` · ${formatMomento(estado.prueba.fecha)}`);
}

// ---------------------------------------------------------------------
// 5 · Selector de socio
// ---------------------------------------------------------------------
function abrirSelector() {
  $("#selector").hidden = false;
  $("#selector-lista button")?.focus();
}

function cerrarSelector() {
  if (!estado.socioId) return; // primera vez: elegir es obligatorio
  $("#selector").hidden = true;
}

function elegirSocio(id) {
  estado.socioId = id;
  localStorage.setItem("printlog_socio", id);
  $("#selector").hidden = true;
  renderChip();
}

// ---------------------------------------------------------------------
// 6 · Firebase
// ---------------------------------------------------------------------
let escuchando = false;

function conectarFirebase() {
  renderEstadoConexion("pendiente", "conectando…");
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  const auth = getAuth(app);

  onAuthStateChanged(auth, (user) => {
    if (user) escucharNodos();
  });

  signInAnonymously(auth).catch((error) => {
    console.error("Auth anónima falló:", error);
    renderEstadoConexion("desconectado", "error de auth");
  });
}

function escucharNodos() {
  if (escuchando) return;
  escuchando = true;

  onValue(ref(db, ".info/connected"), (snap) => {
    if (snap.val()) renderEstadoConexion("conectado", "en vivo");
    else renderEstadoConexion("desconectado", "sin conexión");
  });

  onValue(ref(db, "socios"), (snap) => {
    const socios = snap.val();
    if (!socios) {
      set(ref(db, "socios"), SOCIOS_DEFAULT); // seed inicial, idempotente
      return;
    }
    estado.socios = socios;
    renderSelector();
    renderChip();
    renderPrueba();
  });

  onValue(ref(db, "prueba"), (snap) => {
    estado.prueba = snap.val();
    renderPrueba();
  });
}

function sumarToque() {
  if (!db || !estado.socioId) return;
  runTransaction(ref(db, "prueba"), (actual) => ({
    count: (actual?.count ?? 0) + 1,
    por: estado.socioId,
    fecha: Date.now(),
  }));
}

// ---------------------------------------------------------------------
// 7 · Arranque
// ---------------------------------------------------------------------
function iniciar() {
  // socio guardado que ya no existe → volver a preguntar
  if (estado.socioId && !estado.socios[estado.socioId]) estado.socioId = null;

  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => renderVista(t.dataset.vista))
  );
  $("#btn-tocar").addEventListener("click", sumarToque);
  $("#chip-socio").addEventListener("click", abrirSelector);
  $("#selector").addEventListener("click", (e) => {
    if (e.target === $("#selector")) cerrarSelector();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cerrarSelector();
  });

  renderVista("inicio");
  renderSelector();
  renderChip();
  renderPrueba();

  if (!estado.socioId) abrirSelector();

  if (HAY_CONFIG) conectarFirebase();
  else renderEstadoConexion("pendiente", "sin config");
}

iniciar();
