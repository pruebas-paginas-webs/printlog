// =====================================================================
// PRINTLOG · seed.js — test de salida de F3 (§7, §11). Descartable.
// ---------------------------------------------------------------------
// Corre en Node, sin Firebase (calc.js es puro):  node seed.js
// (a) 2 rollos + 5 impresiones → balance igual a la cuenta a mano (§4.4)
// (b) test de equidad de la cola justa (§4.7) + propiedades del algoritmo
// =====================================================================

import {
  balancePorSocio, stockValorizado, gastoDelMes,
  horasMaquina, statsPorSocio, estadisticasGlobales,
  tiempoVirtualPorSocio, ordenarCola, conEspera,
  pesoRestante, costoPorGramo, horasDesdeUltimoMant,
} from "./calc.js";

let fallos = 0;
function check(nombre, actual, esperado) {
  const ok = typeof esperado === "number" && typeof actual === "number"
    ? Math.abs(actual - esperado) < 1e-9
    : JSON.stringify(actual) === JSON.stringify(esperado);
  console.log(`${ok ? "  ✓" : "  ✗ FALLO"} ${nombre}${ok ? "" : ` → actual: ${JSON.stringify(actual)} · esperado: ${JSON.stringify(esperado)}`}`);
  if (!ok) fallos += 1;
}

const SOCIOS = {
  s1: { nombre: "Agustín", color: "#e07a3f" },
  s2: { nombre: "Matías", color: "#4f8fe0" },
  s3: { nombre: "Joaquín", color: "#5fb87a" },
};
const AHORA = Date.UTC(2026, 6, 7, 15, 0, 0); // fecha fija: el test es reproducible
const DIA = 24 * 60 * 60 * 1000;

// =====================================================================
// (a) Balance — 2 rollos + 5 impresiones (individuales, compartidas, 1 fallida)
// =====================================================================
console.log("\n— (a) Balance §4.4 · cuenta a mano —");

const ROLLOS = {
  rA: { material: "PLA", colorFilamento: "Negro", pesoInicial: 1000, costo: 30000, compradoPor: "s1", archivado: false },
  rB: { material: "PETG", colorFilamento: "Azul", pesoInicial: 500, costo: 20000, compradoPor: "s2", archivado: false },
};
// cpg: rA = 30 $/g · rB = 40 $/g
const IMPS = {
  i1: { estado: "terminada", rolloId: "rA", participantes: { s1: true }, gramosReales: 100, tiempoRealMin: 300, gramosEstimados: 90, tiempoEstimadoMin: 270, fechaFin: AHORA - 5 * DIA },
  i2: { estado: "terminada", rolloId: "rA", participantes: { s1: true, s2: true }, gramosReales: 200, tiempoRealMin: 600, gramosEstimados: 200, tiempoEstimadoMin: 540, fechaFin: AHORA - 4 * DIA },
  i3: { estado: "fallida", rolloId: "rB", participantes: { s2: true }, gramosReales: 50, tiempoRealMin: 120, gramosEstimados: 120, tiempoEstimadoMin: 300, motivoFallo: "warping", fechaFin: AHORA - 3 * DIA },
  i4: { estado: "terminada", rolloId: "rB", participantes: { s1: true, s2: true, s3: true }, gramosReales: 150, tiempoRealMin: 360, gramosEstimados: 150, tiempoEstimadoMin: 360, fechaFin: AHORA - 2 * DIA },
  i5: { estado: "terminada", rolloId: null, participantes: { s3: true }, gramosReales: 80, tiempoRealMin: 240, gramosEstimados: 80, tiempoEstimadoMin: 240, fechaFin: AHORA - 1 * DIA },
};

// Cuenta a mano:
//   costos: i1=100×30=3000 · i2=200×30=6000 · i3=50×40=2000 · i4=150×40=6000 · i5=sin rollo=0
//   aportado: s1=30000 · s2=20000 · s3=0
//   consumido: s1=3000+3000+2000=8000 · s2=3000+2000+2000=7000 · s3=2000
//   neto: s1=22000 · s2=13000 · s3=−2000
const bal = balancePorSocio(SOCIOS, ROLLOS, IMPS);
check("aportado s1", bal.s1.aportado, 30000);
check("aportado s2", bal.s2.aportado, 20000);
check("aportado s3", bal.s3.aportado, 0);
check("consumido s1", bal.s1.consumido, 8000);
check("consumido s2", bal.s2.consumido, 7000);
check("consumido s3", bal.s3.consumido, 2000);
check("neto s1", bal.s1.neto, 22000);
check("neto s2", bal.s2.neto, 13000);
check("neto s3", bal.s3.neto, -2000);

//   stock: rA 1000−300=700 g × 30 = 21000 · rB 500−200=300 g × 40 = 12000 → 33000
check("pesoRestante rA", pesoRestante("rA", ROLLOS, IMPS, {}), 700);
check("pesoRestante rB", pesoRestante("rB", ROLLOS, IMPS, {}), 300);
check("stockValorizado", stockValorizado(ROLLOS, IMPS, {}), 33000);
//   identidad §4.4: Σ neto = stock valorizado (sin ajustes ni archivados)
check("Σ neto = stock valorizado", bal.s1.neto + bal.s2.neto + bal.s3.neto, stockValorizado(ROLLOS, IMPS, {}));
check("gasto del mes (todas cierran este mes)", gastoDelMes(ROLLOS, IMPS, AHORA), 17000);

console.log("\n— (a) Horas §4.5 y stats §5.4 —");
//   horasMaquina = (300+600+120+360+240)/60 = 27 h
check("horasMaquina", horasMaquina(IMPS), 27);
//   horasSocio: s1=(300+300+120)/60=12 · s2=(300+120+120)/60=9 · s3=(120+240)/60=6
const st = statsPorSocio(SOCIOS, IMPS);
check("horas s1", st.s1.horas, 12);
check("horas s2", st.s2.horas, 9);
check("horas s3", st.s3.horas, 6);
check("Σ horasSocio = horasMaquina", st.s1.horas + st.s2.horas + st.s3.horas, horasMaquina(IMPS));
//   gramos: s1=100+100+50=250 · s2=100+50+50=200 · s3=50+80=130 (Σ=580=total)
check("gramos s1", st.s1.gramos, 250);
check("gramos s2", st.s2.gramos, 200);
check("gramos s3", st.s3.gramos, 130);
check("cantidad s1/s2/s3", [st.s1.cantidad, st.s2.cantidad, st.s3.cantidad], [3, 3, 2]);

const g = estadisticasGlobales(IMPS);
check("tasa de éxito 4/5", g.tasaExito, 0.8);
check("motivos de fallo", g.motivos, { warping: 1 });

//   mantenimiento §4.5: sin registros = todas las horas; con snapshot, la resta
check("horasDesdeUltimoMant sin registros", horasDesdeUltimoMant(IMPS, {}), 27);
check("horasDesdeUltimoMant con snapshot en 20 h",
  horasDesdeUltimoMant(IMPS, { m1: { fecha: AHORA - 2 * DIA, horasMaquina: 20 } }), 7);

// =====================================================================
// (b) Cola justa §4.7 — criterio de salida + propiedades
// =====================================================================
console.log("\n— (b) Cola justa §4.7 —");

const ids = (r) => r.map((i) => i.id);
const enColaBase = { estado: "cola", urgente: false, gramosEstimados: 50 };

// b1 · EL test del criterio: s1 con muchas horas recientes y 4 en cola;
//      s2 con cero horas manda una → la de s2 queda primera.
{
  const historial = {
    h1: { estado: "terminada", participantes: { s1: true }, tiempoRealMin: 1200, fechaFin: AHORA - 2 * DIA, rolloId: null, gramosReales: 500 },
  };
  const cola = [
    { id: "a1", ...enColaBase, participantes: { s1: true }, orden: 1, fechaCreacion: AHORA - 4 * DIA, tiempoEstimadoMin: 120 },
    { id: "a2", ...enColaBase, participantes: { s1: true }, orden: 2, fechaCreacion: AHORA - 4 * DIA + 1, tiempoEstimadoMin: 120 },
    { id: "a3", ...enColaBase, participantes: { s1: true }, orden: 3, fechaCreacion: AHORA - 4 * DIA + 2, tiempoEstimadoMin: 120 },
    { id: "a4", ...enColaBase, participantes: { s1: true }, orden: 4, fechaCreacion: AHORA - 4 * DIA + 3, tiempoEstimadoMin: 120 },
    { id: "b1", ...enColaBase, participantes: { s2: true }, orden: 5, fechaCreacion: AHORA - 1 * DIA, tiempoEstimadoMin: 120 },
  ];
  const tv = tiempoVirtualPorSocio(SOCIOS, historial, { ventanaEquidadDias: 30 }, AHORA);
  check("tv: s1 20 h, s2 0", [tv.s1, tv.s2], [1200, 0]);
  const r = ordenarCola(cola, tv);
  check("la de s2 (recién llegado) va primera", ids(r)[0], "b1");
  check("orden completo b1,a1..a4", ids(r), ["b1", "a1", "a2", "a3", "a4"]);
}

// b2 · Intercalado: todos en cero → se alternan por fechaCreacion, nadie
//      bloquea la máquina en tanda por haber cargado antes.
{
  const cola = [
    { id: "a1", ...enColaBase, participantes: { s1: true }, orden: 1, fechaCreacion: 1, tiempoEstimadoMin: 60 },
    { id: "a2", ...enColaBase, participantes: { s1: true }, orden: 2, fechaCreacion: 2, tiempoEstimadoMin: 60 },
    { id: "a3", ...enColaBase, participantes: { s1: true }, orden: 3, fechaCreacion: 3, tiempoEstimadoMin: 60 },
    { id: "b1", ...enColaBase, participantes: { s2: true }, orden: 4, fechaCreacion: 4, tiempoEstimadoMin: 60 },
    { id: "b2", ...enColaBase, participantes: { s2: true }, orden: 5, fechaCreacion: 5, tiempoEstimadoMin: 60 },
  ];
  const r = ordenarCola(cola, { s1: 0, s2: 0, s3: 0 });
  check("intercalado a1,b1,a2,b2,a3", ids(r), ["a1", "b1", "a2", "b2", "a3"]);
}

// b3 · Urgente: va primera aunque sea la más nueva, y NO es gratis —
//      empuja las siguientes del mismo socio para atrás.
{
  const cola = [
    { id: "u1", ...enColaBase, urgente: true, participantes: { s1: true }, orden: 9, fechaCreacion: 100, tiempoEstimadoMin: 600 },
    { id: "a1", ...enColaBase, participantes: { s1: true }, orden: 1, fechaCreacion: 1, tiempoEstimadoMin: 60 },
    { id: "b1", ...enColaBase, participantes: { s2: true }, orden: 2, fechaCreacion: 50, tiempoEstimadoMin: 60 },
  ];
  const r = ordenarCola(cola, { s1: 0, s2: 0, s3: 0 });
  check("urgente primera y su socio paga: u1,b1,a1", ids(r), ["u1", "b1", "a1"]);
}

// b4 · Compartida: vive en la sub-cola de todos; la agarra el turno del
//      socio libre y suma tiempo virtual a todos los participantes.
{
  const cola = [
    { id: "comp", ...enColaBase, participantes: { s1: true, s3: true }, orden: 1, fechaCreacion: 1, tiempoEstimadoMin: 200 },
    { id: "c1", ...enColaBase, participantes: { s3: true }, orden: 2, fechaCreacion: 2, tiempoEstimadoMin: 60 },
    { id: "a1", ...enColaBase, participantes: { s1: true }, orden: 3, fechaCreacion: 3, tiempoEstimadoMin: 60 },
  ];
  // s1 viene pesado (600 min), s3 en cero → turno de s3 → sale la compartida
  const r = ordenarCola(cola, { s1: 600, s2: 0, s3: 0 });
  check("compartida sale por el turno de s3", ids(r)[0], "comp");
  // tras la compartida: s3=100, s1=700 → sigue c1 (s3 sigue más bajo), después a1
  check("orden completo comp,c1,a1", ids(r), ["comp", "c1", "a1"]);
}

// b5 · Ventana de equidad: horas de hace 40 días no cuentan (default 30).
{
  const historial = {
    h1: { estado: "terminada", participantes: { s1: true }, tiempoRealMin: 1200, fechaFin: AHORA - 40 * DIA, rolloId: null, gramosReales: 100 },
  };
  const tv = tiempoVirtualPorSocio(SOCIOS, historial, { ventanaEquidadDias: 30 }, AHORA);
  check("uso viejo no castiga (tv s1 = 0)", tv.s1, 0);
  const tv60 = tiempoVirtualPorSocio(SOCIOS, historial, { ventanaEquidadDias: 60 }, AHORA);
  check("con ventana 60 sí cuenta", tv60.s1, 1200);
}

// b6 · La sub-cola propia manda: con turno propio, sale la de menor `orden`
//      aunque sea más nueva (reordenar las mías con fractional indexing).
{
  const cola = [
    { id: "vieja", ...enColaBase, participantes: { s1: true }, orden: 10, fechaCreacion: 1, tiempoEstimadoMin: 60 },
    { id: "alFrente", ...enColaBase, participantes: { s1: true }, orden: 5, fechaCreacion: 99, tiempoEstimadoMin: 60 },
  ];
  const r = ordenarCola(cola, { s1: 0, s2: 0, s3: 0 });
  check("menor `orden` gana en la sub-cola propia", ids(r), ["alFrente", "vieja"]);
}

// b7 · Espera acumulada: suma estimados de todo lo anterior + lo que imprime.
{
  const orden = [
    { id: "x1", tiempoEstimadoMin: 120 },
    { id: "x2", tiempoEstimadoMin: 60 },
    { id: "x3", tiempoEstimadoMin: null },
    { id: "x4", tiempoEstimadoMin: 30 },
  ];
  const esperas = conEspera(orden, 90).map((e) => e.esperaMin);
  check("esperas [90,210,270,270]", esperas, [90, 210, 270, 270]);
}

// b8 · Determinismo: mismo input → mismo output (sin efectos de orden interno).
{
  const cola = [
    { id: "a", ...enColaBase, participantes: { s1: true }, orden: 1, fechaCreacion: 1, tiempoEstimadoMin: 60 },
    { id: "b", ...enColaBase, participantes: { s2: true }, orden: 1, fechaCreacion: 1, tiempoEstimadoMin: 60 },
  ];
  const r1 = ids(ordenarCola(cola, { s1: 0, s2: 0 }));
  const r2 = ids(ordenarCola([...cola].reverse(), { s1: 0, s2: 0 }));
  check("empate total → desempata por id, estable", r1, r2);
}

// b9 · Empate "moral" con ruido de float: el epsilon evita que el redondeo
//      binario le gane al desempate por fechaCreacion (§4.7 propiedad 5).
//      61/3+90 y 97/3+78 son ambos 331/3 exactos, pero difieren en float.
{
  const cola = [
    { id: "aNueva", ...enColaBase, participantes: { s1: true }, orden: 1, fechaCreacion: 10, tiempoEstimadoMin: 60 },
    { id: "bVieja", ...enColaBase, participantes: { s2: true }, orden: 1, fechaCreacion: 5, tiempoEstimadoMin: 60 },
  ];
  const r = ordenarCola(cola, { s1: 61 / 3 + 90, s2: 97 / 3 + 78 });
  check("empate con ruido de float → gana la más vieja", ids(r), ["bVieja", "aNueva"]);
}

// b10 · Socio fantasma en participantes (borrado/typo): no compite con
//       tv=0 regalado — misma política que tiempoVirtualPorSocio. Sus
//       impresiones van al final.
{
  const cola = [
    { id: "fant", ...enColaBase, participantes: { sFantasma: true }, orden: 1, fechaCreacion: 1, tiempoEstimadoMin: 60 },
    { id: "a1", ...enColaBase, participantes: { s1: true }, orden: 2, fechaCreacion: 2, tiempoEstimadoMin: 60 },
  ];
  const r = ordenarCola(cola, { s1: 300, s2: 0, s3: 0 });
  check("fantasma no salta la cola", ids(r), ["a1", "fant"]);
}

// b11 · Robustez: inputs undefined no crashean (convención de calc.js).
{
  check("ordenarCola(undefined) → []", ordenarCola(undefined, { s1: 0 }), []);
  check("conEspera(undefined) → []", conEspera(undefined), []);
}

// =====================================================================
console.log(`\n${fallos ? `✗ ${fallos} test(s) fallaron` : "✓ Todos los tests pasan — criterio de salida F3 cumplido"}\n`);
process.exit(fallos ? 1 : 0);
