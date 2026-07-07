// =====================================================================
// PRINTLOG · calc.js — funciones puras de métricas derivadas (§4, §8)
// ---------------------------------------------------------------------
// Reciben datos crudos, devuelven números/arrays. SIN acceso a Firebase.
// Todo lo derivado se calcula acá: stock (§4.1), costos y balance (§4.4),
// horas (§4.5) y el orden justo de la cola (§4.7).
// =====================================================================

// Cantidad de participantes de una impresión (map { socioId: true }).
export function nParticipantes(imp) {
  if (!imp || !imp.participantes) return 1;
  const n = Object.keys(imp.participantes).length;
  return n > 0 ? n : 1;
}

const CERRADA = (imp) => imp.estado === "terminada" || imp.estado === "fallida";

// ---------------------------------------------------------------------
// Stock derivado (§4.1)
// ---------------------------------------------------------------------

// Costo por gramo de un rollo (§4.4). 0 si el rollo no tiene datos.
export function costoPorGramo(rollo) {
  if (!rollo || !rollo.pesoInicial) return 0;
  return rollo.costo / rollo.pesoInicial;
}

// Gramos reales consumidos de un rollo: solo impresiones cerradas
// (terminadas + fallidas) con gramosReales cargados.
export function consumidoRollo(rolloId, impresiones) {
  let total = 0;
  for (const imp of Object.values(impresiones || {})) {
    if (imp.rolloId === rolloId && CERRADA(imp) && imp.gramosReales != null) {
      total += imp.gramosReales;
    }
  }
  return total;
}

// Suma de correcciones manuales (pesadas) de un rollo (§4.6).
export function ajusteRollo(rolloId, ajustes) {
  let total = 0;
  for (const aj of Object.values(ajustes || {})) {
    if (aj.rolloId === rolloId) total += aj.deltaGramos || 0;
  }
  return total;
}

// Peso restante DERIVADO (§4.1) — LA decisión de arquitectura.
// Nunca se guarda como campo mutable: se recalcula siempre.
//   pesoRestante = pesoInicial − Σ gramosReales + Σ deltaGramos
export function pesoRestante(rolloId, rollos, impresiones, ajustes) {
  const rollo = (rollos || {})[rolloId];
  if (!rollo) return 0;
  return (rollo.pesoInicial || 0)
    - consumidoRollo(rolloId, impresiones)
    + ajusteRollo(rolloId, ajustes);
}

// ---------------------------------------------------------------------
// Costos y balance entre socios (§4.4)
// ---------------------------------------------------------------------

// Por socio: aportado (rollos que compró, archivados incluidos §9),
// consumido (su parte de cada impresión cerrada con rollo) y neto.
export function balancePorSocio(socios, rollos, impresiones) {
  const b = {};
  for (const id of Object.keys(socios || {})) b[id] = { aportado: 0, consumido: 0, neto: 0 };

  for (const rollo of Object.values(rollos || {})) {
    if (b[rollo.compradoPor]) b[rollo.compradoPor].aportado += rollo.costo || 0;
  }
  for (const imp of Object.values(impresiones || {})) {
    if (!CERRADA(imp) || !imp.rolloId || imp.gramosReales == null) continue;
    const rollo = (rollos || {})[imp.rolloId];
    if (!rollo) continue;
    const costo = imp.gramosReales * costoPorGramo(rollo);
    const n = nParticipantes(imp);
    for (const sid of Object.keys(imp.participantes || {})) {
      if (b[sid]) b[sid].consumido += costo / n;
    }
  }
  for (const id of Object.keys(b)) b[id].neto = b[id].aportado - b[id].consumido;
  return b;
}

// Valor del filamento que queda en los rollos NO archivados (§4.4).
// Es (aprox.) la diferencia por la que los netos no suman cero.
export function stockValorizado(rollos, impresiones, ajustes) {
  let total = 0;
  for (const [id, rollo] of Object.entries(rollos || {})) {
    if (rollo.archivado) continue;
    total += pesoRestante(id, rollos, impresiones, ajustes) * costoPorGramo(rollo);
  }
  return total;
}

// Gasto en material del mes calendario de `ahora` (mini-stat del dashboard).
export function gastoDelMes(rollos, impresiones, ahora) {
  const d = new Date(ahora);
  const anio = d.getFullYear(), mes = d.getMonth();
  let total = 0;
  for (const imp of Object.values(impresiones || {})) {
    if (!CERRADA(imp) || !imp.rolloId || imp.gramosReales == null || imp.fechaFin == null) continue;
    const f = new Date(imp.fechaFin);
    if (f.getFullYear() !== anio || f.getMonth() !== mes) continue;
    total += imp.gramosReales * costoPorGramo((rollos || {})[imp.rolloId]);
  }
  return total;
}

// ---------------------------------------------------------------------
// Horas de máquina y por socio (§4.5)
// ---------------------------------------------------------------------

export function horasMaquina(impresiones) {
  let min = 0;
  for (const imp of Object.values(impresiones || {})) {
    if (CERRADA(imp) && imp.tiempoRealMin != null) min += imp.tiempoRealMin;
  }
  return min / 60;
}

// Por socio: horas (su parte), gramos (su parte) y cantidad de cerradas
// en las que participó (terminadas y fallidas por separado).
export function statsPorSocio(socios, impresiones) {
  const s = {};
  for (const id of Object.keys(socios || {})) {
    s[id] = { horas: 0, gramos: 0, cantidad: 0, terminadas: 0, fallidas: 0 };
  }
  for (const imp of Object.values(impresiones || {})) {
    if (!CERRADA(imp)) continue;
    const n = nParticipantes(imp);
    for (const sid of Object.keys(imp.participantes || {})) {
      if (!s[sid]) continue;
      if (imp.tiempoRealMin != null) s[sid].horas += imp.tiempoRealMin / n / 60;
      if (imp.gramosReales != null) s[sid].gramos += imp.gramosReales / n;
      s[sid].cantidad += 1;
      if (imp.estado === "terminada") s[sid].terminadas += 1;
      else s[sid].fallidas += 1;
    }
  }
  return s;
}

// Horas acumuladas desde el último mantenimiento registrado (§4.5).
// Sin mantenimientos: todas las horas de la máquina.
export function horasDesdeUltimoMant(impresiones, mantenimientos) {
  let ultimo = null;
  for (const m of Object.values(mantenimientos || {})) {
    if (!ultimo || (m.fecha || 0) > (ultimo.fecha || 0)) ultimo = m;
  }
  return horasMaquina(impresiones) - (ultimo?.horasMaquina || 0);
}

// ---------------------------------------------------------------------
// Estadísticas globales (§5.4)
// ---------------------------------------------------------------------

export function estadisticasGlobales(impresiones) {
  let terminadas = 0, fallidas = 0;
  const motivos = {};
  const desvG = [], desvT = [];
  for (const imp of Object.values(impresiones || {})) {
    if (!CERRADA(imp)) continue;
    if (imp.estado === "terminada") terminadas += 1;
    else {
      fallidas += 1;
      const m = imp.motivoFallo || "otro";
      motivos[m] = (motivos[m] || 0) + 1;
    }
    if (imp.gramosEstimados > 0 && imp.gramosReales != null) {
      desvG.push((imp.gramosReales - imp.gramosEstimados) / imp.gramosEstimados);
    }
    if (imp.tiempoEstimadoMin > 0 && imp.tiempoRealMin != null) {
      desvT.push((imp.tiempoRealMin - imp.tiempoEstimadoMin) / imp.tiempoEstimadoMin);
    }
  }
  const media = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  return {
    terminadas,
    fallidas,
    tasaExito: terminadas + fallidas > 0 ? terminadas / (terminadas + fallidas) : null,
    motivos,
    desvioGramos: media(desvG),   // fracción: 0.08 = el slicer estima 8% de menos
    desvioTiempo: media(desvT),
  };
}

// Gramos consumidos por mes calendario, últimos nMeses (viejo → nuevo).
export function gramosPorMes(impresiones, nMeses, ahora) {
  const base = new Date(ahora);
  const meses = [];
  for (let i = nMeses - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    meses.push({ anio: d.getFullYear(), mes: d.getMonth(), gramos: 0 });
  }
  for (const imp of Object.values(impresiones || {})) {
    if (!CERRADA(imp) || imp.gramosReales == null || imp.fechaFin == null) continue;
    const f = new Date(imp.fechaFin);
    const slot = meses.find((m) => m.anio === f.getFullYear() && m.mes === f.getMonth());
    if (slot) slot.gramos += imp.gramosReales;
  }
  return meses;
}

// ---------------------------------------------------------------------
// Cola justa — orden por equidad de uso (§4.7)
// ---------------------------------------------------------------------

// Minutos "virtuales" por socio: su parte de las impresiones cerradas con
// fechaFin dentro de la ventana (config.ventanaEquidadDias, default 30).
export function tiempoVirtualPorSocio(socios, impresiones, config, ahora) {
  const dias = config?.ventanaEquidadDias ?? 30;
  const desde = ahora - dias * 24 * 60 * 60 * 1000;
  const tv = {};
  for (const id of Object.keys(socios || {})) tv[id] = 0;
  for (const imp of Object.values(impresiones || {})) {
    if (!CERRADA(imp) || imp.fechaFin == null || imp.fechaFin < desde || imp.tiempoRealMin == null) continue;
    const n = nParticipantes(imp);
    for (const sid of Object.keys(imp.participantes || {})) {
      if (tv[sid] != null) tv[sid] += imp.tiempoRealMin / n;
    }
  }
  return tv;
}

// Orden justo (§4.7). Pura: no muta argumentos, no mira el reloj.
//   enCola:    array de impresiones en estado "cola" (cada una con su id)
//   tvInicial: minutos virtuales por socio (tiempoVirtualPorSocio)
// Reglas:
//   - urgentes primero, por fechaCreacion; también suman tiempo virtual
//   - después, turno del socio con menor tv; de su sub-cola personal
//     (menor `orden`) sale la impresión; cada participante suma est/n
//   - empate de tv (con epsilon: el tv acumula fracciones y el float
//     mete ruido) → fechaCreacion de la candidata; último recurso: id
//   - socios que no están en tvInicial (borrados/corruptos) no compiten:
//     misma política que tiempoVirtualPorSocio, sus impresiones van al final
const EPS_TV = 1e-6;
export function ordenarCola(enCola, tvInicial) {
  enCola = enCola || [];
  const tv = { ...tvInicial };
  const conocidos = new Set(Object.keys(tv));
  const ordenDe = (imp) => imp.orden ?? imp.fechaCreacion ?? 0;
  const estDe = (imp) => imp.tiempoEstimadoMin ?? 0;
  const sumarTv = (imp) => {
    const n = nParticipantes(imp);
    for (const sid of Object.keys(imp.participantes || {})) {
      if (conocidos.has(sid)) tv[sid] += estDe(imp) / n;
    }
  };

  const urgentes = enCola
    .filter((i) => i.urgente)
    .sort((a, b) => ((a.fechaCreacion || 0) - (b.fechaCreacion || 0)) || String(a.id).localeCompare(String(b.id)));
  const resultado = [...urgentes];
  urgentes.forEach(sumarTv); // las urgentes no son gratis

  let pendientes = enCola.filter((i) => !i.urgente);
  while (pendientes.length) {
    // candidata de cada socio: la de menor `orden` de su sub-cola
    const candidatas = new Map();
    for (const imp of pendientes) {
      for (const sid of Object.keys(imp.participantes || {})) {
        if (!conocidos.has(sid)) continue; // socio fantasma: no compite
        const actual = candidatas.get(sid);
        if (!actual ||
            ordenDe(imp) < ordenDe(actual) ||
            (ordenDe(imp) === ordenDe(actual) && (imp.fechaCreacion || 0) < (actual.fechaCreacion || 0))) {
          candidatas.set(sid, imp);
        }
      }
    }
    if (!candidatas.size) {
      // sin participantes conocidos: al final, por orden
      resultado.push(...[...pendientes].sort((a, b) => ordenDe(a) - ordenDe(b)));
      break;
    }
    // socio con menor tv; empate (± epsilon) → candidata más vieja; luego id
    let elegido = null;
    for (const [sid, imp] of candidatas) {
      if (!elegido) { elegido = { sid, imp }; continue; }
      const dtv = (tv[sid] ?? 0) - (tv[elegido.sid] ?? 0);
      const empate = Math.abs(dtv) <= EPS_TV;
      const dfc = (imp.fechaCreacion || 0) - (elegido.imp.fechaCreacion || 0);
      const did = String(imp.id).localeCompare(String(elegido.imp.id));
      if ((dtv < -EPS_TV) || (empate && (dfc < 0 || (dfc === 0 && did < 0)))) {
        elegido = { sid, imp };
      }
    }
    resultado.push(elegido.imp);
    sumarTv(elegido.imp);
    pendientes = pendientes.filter((i) => i !== elegido.imp);
  }
  return resultado;
}

// Espera estimada acumulada por card (§4.7): suma de los estimados de todo
// lo anterior. tiempoPrevioMin = estimado de lo que está imprimiendo (0 si nada).
export function conEspera(ordenadas, tiempoPrevioMin = 0) {
  let acum = tiempoPrevioMin;
  return (ordenadas || []).map((imp) => {
    const item = { imp, esperaMin: acum };
    acum += imp.tiempoEstimadoMin ?? 0;
    return item;
  });
}
