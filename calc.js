// =====================================================================
// PRINTLOG · calc.js — funciones puras de métricas derivadas (§4, §8)
// ---------------------------------------------------------------------
// Reciben datos crudos, devuelven números/arrays. SIN acceso a Firebase.
// En F1 vive lo mínimo; F2 suma pesoRestante y F3 el orden justo/balances.
// =====================================================================

// Costo por gramo de un rollo (§4.4). 0 si el rollo no tiene datos.
export function costoPorGramo(rollo) {
  if (!rollo || !rollo.pesoInicial) return 0;
  return rollo.costo / rollo.pesoInicial;
}

// Gramos reales consumidos de un rollo: solo impresiones cerradas
// (terminadas + fallidas) con gramosReales cargados (§4.1).
export function consumidoRollo(rolloId, impresiones) {
  let total = 0;
  for (const imp of Object.values(impresiones || {})) {
    if (imp.rolloId === rolloId &&
        (imp.estado === "terminada" || imp.estado === "fallida") &&
        imp.gramosReales != null) {
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

// Orden provisorio de la cola (§7 · F1): urgentes primero (más viejas
// arriba), el resto por el campo `orden` que el socio controla a mano.
// En F3 lo reemplaza ordenarCola() con el orden justo por equidad (§4.7).
export function ordenarColaProvisoria(enCola) {
  return [...enCola].sort((a, b) => {
    const ua = a.urgente ? 1 : 0;
    const ub = b.urgente ? 1 : 0;
    if (ua !== ub) return ub - ua; // urgentes arriba
    if (ua && ub) return a.fechaCreacion - b.fechaCreacion; // urgentes por antigüedad
    return a.orden - b.orden; // resto por orden manual
  });
}

// Cantidad de participantes de una impresión (map { socioId: true }).
export function nParticipantes(imp) {
  if (!imp || !imp.participantes) return 1;
  const n = Object.keys(imp.participantes).length;
  return n > 0 ? n : 1;
}
