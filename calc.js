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
