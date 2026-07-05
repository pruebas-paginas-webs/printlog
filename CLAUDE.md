# CLAUDE.md — PrintLog (nombre tentativo, renombrable)

> Tracker de uso compartido de una impresora 3D entre tres socios: cola de impresiones, stock de filamento, estadísticas de uso y balance de gastos. App web liviana, tiempo real, sin backend propio.

---

## 1. Contexto

Tres amigos compraron una impresora 3D en conjunto y necesitan coordinar su uso:

- Registrar qué se imprime, cuánto tarda y cuánto material consume.
- Saber cuánto filamento queda sin pesar rollos todo el tiempo.
- Repartir costos de material de forma justa (impresiones personales y compartidas conviven).
- Llevar horas de uso por socio y horas totales de la máquina (mantenimiento).

**Usuarios:** 3 personas fijas. Sin registro público, sin invitados.
**Contexto de uso principal: el celular, parado al lado de la impresora.** Mobile-first es obligatorio, no un nice-to-have. Desktop debe verse bien pero se diseña primero para pantalla chica.

---

## 2. Stack (no negociable)

- **HTML + CSS + JS vanilla.** Sin frameworks, sin build step, sin bundler.
- **Firebase Realtime Database** (plan Spark) vía CDN modular v10+ (`import` desde gstatic con `type="module"`).
- **Deploy: Firebase Hosting** (`mengueche-print.web.app`) con `firebase deploy --only hosting` después de cada fase. El repo vive en GitHub (`pruebas-paginas-webs/printlog`); Pages queda activo como espejo de backup.
- **Estructura: 3 archivos** → `index.html`, `styles.css`, `app.js`. Si `app.js` supera ~1500 líneas, se puede separar `calc.js` (métricas derivadas puras). Nada más.
- **Identidad:** selector "¿Quién sos?" al abrir la app por primera vez, persistido en `localStorage`. No hay login con contraseña entre socios.
- **Seguridad:** Firebase Anonymous Auth habilitado + reglas de RTDB:

```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

La config de Firebase (apiKey, etc.) va inline en `app.js`: es pública por diseño, las reglas son la protección real.

**Fotos:** Firebase Storage requiere plan Blaze en proyectos nuevos → NO usarlo. Las fotos se comprimen client-side con canvas (máx. 800px de lado, JPEG q≈0.7) y se guardan como base64 en RTDB si pesan ≤100 KB (límite duro 150 KB). Si excede, pedir link externo en su lugar.

---

## 3. Modelo de datos (RTDB)

```json
{
  "socios": {
    "s1": { "nombre": "Agustín", "color": "#e07a3f" },
    "s2": { "nombre": "…", "color": "#4f8fe0" },
    "s3": { "nombre": "…", "color": "#5fb87a" }
  },

  "rollos": {
    "$rolloId": {
      "material": "PLA",
      "colorFilamento": "Negro",
      "colorHex": "#1a1a1a",
      "marca": "Grilon3",
      "pesoInicial": 1000,
      "costo": 28000,
      "compradoPor": "s1",
      "fechaCompra": 1720000000000,
      "notasPerfil": "205° / cama 60° — retracción 0.8 mm. No pasar de 60 mm/s.",
      "archivado": false
    }
  },

  "impresiones": {
    "$impId": {
      "nombre": "Soporte auriculares",
      "estado": "cola",
      "orden": 1720000000000,
      "urgente": false,
      "participantes": { "s1": true, "s2": true },
      "rolloId": "-Nxy…",
      "gramosEstimados": 45,
      "tiempoEstimadoMin": 180,
      "gramosReales": null,
      "tiempoRealMin": null,
      "linkSTL": "https://www.printables.com/…",
      "notas": "0.2 mm, 15% infill, sin soportes",
      "motivoFallo": null,
      "fotoBase64": null,
      "creadoPor": "s1",
      "fechaCreacion": 1720000000000,
      "fechaFin": null
    }
  },

  "ajustes": {
    "$ajusteId": {
      "rolloId": "-Nxy…",
      "deltaGramos": -12,
      "motivo": "Pesada manual 14/07",
      "fecha": 1720000000000,
      "hechoPor": "s2"
    }
  },

  "wishlist": {
    "$itemId": {
      "nombre": "Organizador de cables",
      "link": "https://…",
      "propuestoPor": "s2",
      "votos": { "s1": true, "s3": true },
      "fecha": 1720000000000,
      "impreso": false
    }
  },

  "mantenimientos": {
    "$mantId": {
      "tipo": "Lubricación de ejes",
      "fecha": 1720000000000,
      "horasMaquina": 214,
      "hechoPor": "s3",
      "notas": ""
    }
  },

  "config": {
    "horasEntreMantenimiento": 200,
    "umbralStockBajoGramos": 150,
    "pesoCarreteVacio": 200,
    "ventanaEquidadDias": 30,
    "moneda": "ARS"
  }
}
```

Notas de schema:

- `participantes` es un **map** (`{ socioId: true }`), no un array — es el idioma de RTDB y evita problemas de índices.
- IDs generados con `push()` de Firebase.
- Fechas siempre en epoch ms (`Date.now()`).
- Estados de impresión: `"cola" | "imprimiendo" | "terminada" | "fallida"`.
- `orden` ordena solo la sub-cola personal de cada socio y `urgente` es el único salto global — la posición real en la cola la calcula el orden justo de §4.7.
- `motivoFallo`: `"warping" | "adhesion" | "atasco" | "filamento" | "corte_luz" | "otro"`.
- `rolloId` puede ser `null` (impresión con material ajeno): no impacta stock ni costos, sí cuenta horas.

---

## 4. Reglas de negocio (leer antes de escribir código)

### 4.1 Stock derivado — LA decisión de arquitectura

**Nunca se guarda `pesoRestante` como campo mutable.** Se calcula siempre:

```
pesoRestante(rollo) = pesoInicial
                    − Σ gramosReales de impresiones (terminadas + fallidas) del rollo
                    + Σ deltaGramos de ajustes del rollo
```

Motivo: si el stock fuera un campo que se descuenta al terminar una impresión, editar o borrar una impresión después generaría dobles descuentos o stock fantasma. Derivado, el número siempre cierra. Todas las métricas (horas, costos, balances) siguen el mismo principio: **datos crudos en RTDB, métricas calculadas en render.**

Las funciones de cálculo van en un módulo aparte (`calc.js` o sección claramente separada), como **funciones puras** que reciben los datos y devuelven números. Sin acceso a Firebase adentro.

### 4.2 Ciclo de vida de una impresión

`cola → imprimiendo → terminada | fallida`

- **Al crear:** los gramos y el tiempo estimados se copian del slicer (Cura/Prusa/Orca los muestran antes de imprimir). Cargar es copiar dos números.
- **Al pasar a "imprimiendo":**
  - Warning (no bloqueo) si ya hay otra impresión en estado `imprimiendo` — hay una sola máquina.
  - Warning (no bloqueo) si `gramosEstimados > pesoRestante` del rollo elegido.
- **Al pasar a "terminada":** pedir `gramosReales` y `tiempoRealMin`, prefilleados con los estimados (un tap si el slicer le pegó).
- **Al pasar a "fallida":** pedir gramos consumidos hasta el fallo, tiempo transcurrido y `motivoFallo`. **Las fallidas consumen material, cuentan horas de máquina y generan costo.** Solo no cuentan como éxito.

### 4.3 Impresiones compartidas

Tiempo, gramos y costo se dividen **en partes iguales** entre los participantes seleccionados. Sin porcentajes en v1 (decisión tomada; se puede agregar después si hace falta).

### 4.4 Costos y balance entre socios

```
costoPorGramo(rollo)   = costo / pesoInicial
costoImpresion         = gramosReales × costoPorGramo(rollo)
consumido(socio)       = Σ costoImpresion / nParticipantes   (donde participa)
aportado(socio)        = Σ costo de rollos que compró
neto(socio)            = aportado − consumido
stockValorizado        = Σ pesoRestante(rollo) × costoPorGramo(rollo)   (rollos no archivados)
```

En la vista de balance mostrar por socio: **aportado, consumido y neto**, más el **stock valorizado** total. Aclarar en la UI (texto chico) que los netos no suman cero mientras quede filamento sin usar: la diferencia es exactamente el valor del stock restante, que "pertenece" proporcionalmente a quienes tienen neto positivo. Los socios saldan cuentas cuando quieren; la app solo muestra los números.

### 4.5 Horas de máquina y mantenimiento

```
horasMaquina        = Σ tiempoRealMin (terminadas + fallidas) / 60
horasSocio          = Σ (tiempoRealMin / nParticipantes) / 60
horasDesdeUltimoMant = horasMaquina − horasMaquina del último mantenimiento registrado
```

Mostrar alerta en el dashboard cuando `horasDesdeUltimoMant ≥ config.horasEntreMantenimiento`. Al registrar un mantenimiento se guarda snapshot de `horasMaquina` en ese momento.

### 4.6 Ajuste manual de stock

Cada tanto los socios pesan un rollo (balanza de cocina), restan `config.pesoCarreteVacio` y corrigen. La UI del ajuste pide "peso medido con carrete" y calcula el delta contra el `pesoRestante` derivado actual, mostrando la corrección antes de confirmar. El ajuste se guarda como transacción en `ajustes` (nunca se pisa el histórico).

### 4.7 Cola justa — orden automático por equidad de uso

**Principio: el orden de la cola no se guarda, se calcula.** Igual que el stock (§4.1), la posición de cada impresión es una métrica derivada. El objetivo es equiparar el tiempo de máquina entre los tres: si uno viene usando la impresora tres semanas seguidas y tiene una cola larga cargada, y otro socio manda algo, lo del otro va primero.

**Tiempo virtual por socio:**

```
tiempoVirtual(socio) = horasSocio (§4.5) contando solo impresiones con fechaFin
                       dentro de los últimos config.ventanaEquidadDias días
```

La ventana (default 30 días, configurable) hace que la equidad sea sobre el uso **reciente**: un mes intenso de hace un año no te castiga para siempre.

**Algoritmo de orden (función pura en `calc.js`):**

```
ordenarCola(pendientes, historial, config):
  tv = tiempoVirtual por socio (ventana)
  resultado = urgentes ordenadas por fechaCreacion        // van primero
  por cada urgente: tv[p] += tiempoEstimadoMin / nParticipantes
  mientras queden pendientes no urgentes:
    s   = socio con menor tv que tenga impresiones pendientes donde participe
    imp = de esas, la de menor `orden` (su sub-cola personal)
    agregar imp a resultado, quitarla de pendientes
    tv[p] += tiempoEstimadoMin / nParticipantes           // cada participante
  devolver resultado
```

Propiedades que salen solas del algoritmo (verificarlas en el test de F3):

- El escenario clave funciona: A tiene muchas horas recientes y 10 impresiones en cola; B manda una → la de B queda primera (después de lo que esté imprimiendo, que **nunca se interrumpe**).
- Las impresiones de un mismo socio se **intercalan** con las de los demás; nadie bloquea la máquina en tanda por haber cargado antes.
- Las compartidas viven en la sub-cola de todos sus participantes: las agarra el primer turno que llegue de cualquiera, y al programarse suman tiempo virtual a todos → el sistema se autocorrige.
- Las urgentes no son gratis: también suman tiempo virtual, así que abusar de `urgente` empuja tus propias impresiones siguientes para atrás.
- Empate de tiempo virtual (ej.: arranque, todos en cero) → desempata `fechaCreacion`.

**Qué controla cada socio manualmente:**

- `orden` (number, default `Date.now()`, fractional indexing: punto medio entre vecinos para mover, primero − 60000 para el frente) ordena **solo la sub-cola propia**: cuál de *tus* impresiones entra en cada turno tuyo. "Mandar al frente" = al frente de tus impresiones, no de la cola global.
- `urgente` (boolean): el único salto global. Badge rojo en Cola y Dashboard; es comunicación entre socios ("es para el cumple del sábado") y funciona a confianza.

**Transparencia obligatoria:** arriba de la Cola se muestra el tiempo virtual de cada socio en la ventana ("Últimos 30 días: A 12 h · B 3 h · C 8 h"), para que el orden nunca parezca arbitrario. Cada card muestra además la espera estimada acumulada ("arranca en ~6 h", sumando los tiempos estimados de todo lo anterior).

El orden solo aplica al estado `cola`: lo que está `imprimiendo` no se toca, y el historial se ordena por `fechaFin`.

---

## 5. Vistas

Navegación por tabs inferiores (mobile) / laterales (desktop). Cinco secciones + config como modal.

1. **Dashboard** — impresión en curso (si hay) con su rollo, rollos activos con barra de % restante y alerta de stock bajo, próximos 3 en cola, alerta de mantenimiento si corresponde, mini-stats (horas totales, tasa de éxito, gasto del mes).
2. **Cola** — imprimiendo arriba (nunca se interrumpe), luego la cola en el orden justo calculado (§4.7) con el indicador de equidad por socio y la espera estimada acumulada en cada card, luego historial colapsable de terminadas/fallidas. Desde la card: cambio de estado, reordenar las propias, toggle de urgente. Alta de impresión con FAB.
3. **Stock** — rollos no archivados con barra de restante, costo por gramo, notas de perfil visibles al expandir. Alta de rollo, ajuste manual, archivar. Toggle para ver archivados.
4. **Estadísticas** — por socio: horas, gramos, cantidad de impresiones, consumido, aportado, neto (ver 4.4). Global: tasa de éxito (`terminadas / (terminadas + fallidas)`), conteo de motivos de fallo, desvío promedio estimado vs. real (¿el slicer miente?), gramos por mes como barras CSS simples. **Sin librerías de charts.**
5. **Wishlist** — items con votos (un voto por socio, toggle), ordenados por votos desc. Botón "Mandar a cola" que crea la impresión precargada desde el item y lo marca `impreso: true`. Galería de fotos de terminadas al pie o como sub-tab.

---

## 6. Diseño

Dirección, no mockup — Claude Code decide dentro de estos límites:

- **Tema oscuro de taller**: grises grafito profundos (como el frame de la impresora), no negro puro. Superficies con borde sutil, radio moderado.
- **Elemento firma: el color de acento de la UI es el `colorHex` del rollo actualmente cargado** (el del estado `imprimiendo`, o el último usado). Barras de progreso, FAB y highlights toman ese color. La app literalmente cambia de color cuando cambiás de filamento. Si no hay rollo activo, fallback a un naranja cálido de PLA.
- **Tipografía**: una mono técnica para números y datos (JetBrains Mono o IBM Plex Mono — vibra G-code) + una sans neutra y legible para UI. Números grandes en dashboard y stats.
- Evitar el look genérico de template: nada de crema + serif + terracota, nada de negro + verde ácido porque sí. La estética sale del mundo del proyecto: capas, filamento, panel de control de máquina.
- Piso de calidad: responsive real hasta 360px, focus visible, `prefers-reduced-motion` respetado, tap targets ≥44px.

Textos de UI en español (Argentina), voseo en los CTA ("Cargá una impresión"), sentence case, verbos activos. Los botones dicen lo que hacen: "Marcar terminada", no "Confirmar".

---

## 7. Fases de desarrollo

Avanzar fase por fase. No mezclar. Cada fase termina con deploy a Pages funcionando.

**F0 — Setup**
Repo + GitHub Pages, proyecto Firebase (Anonymous Auth + reglas de §2), esqueleto de `index.html` con navegación y tema base, selector de socio con `localStorage`, lectura/escritura de un nodo de prueba visible en pantalla.
✅ *Sale cuando: los tres abren la URL en el celular, eligen quién son, y ven el mismo dato en tiempo real.*

**F1 — CRUD núcleo**
Alta/edición de rollos e impresiones. Flujo de estados completo con los prompts de terminada/fallida (§4.2). Cola provisoria: urgentes primero, después orden cronológico, con reorden de las propias. La cola justa completa llega en F3, cuando existe el cálculo de horas. Vista Cola y vista Stock operativas (stock todavía puede mostrar solo peso inicial).
✅ *Sale cuando: se puede cargar un rollo real, crear dos impresiones, marcar una urgente y verla subir, y pasar una por todo el ciclo con los datos persistidos.*

**F2 — Stock derivado**
Implementar `calc.js`: pesoRestante derivado, ajustes manuales con el flujo de pesada (§4.6), warnings de §4.2, alerta de stock bajo, archivado de rollos.
✅ *Sale cuando: los gramos que muestra la app cierran contra una pesada manual real, y editar una impresión vieja recalcula todo sin romper nada.*

**F3 — Estadísticas, balance y cola justa**
Dashboard completo + vista Estadísticas con todas las métricas de §4.4 y §4.5, incluyendo casos compartidos. Activar `ordenarCola()` (§4.7) reemplazando el orden provisorio de F1, con indicador de equidad y espera estimada.
✅ *Sale cuando: (a) con 2 rollos y 5 impresiones de prueba (mezcla de individuales, compartidas y una fallida), los números de aportado/consumido/neto dan lo mismo que la cuenta a mano; y (b) pasa el test de equidad: un socio con muchas horas recientes y 4 impresiones en cola, otro con cero horas manda una → la del segundo queda primera.*

**F4 — Extras**
Wishlist con votos y "mandar a cola", mantenimiento con alerta por horas, fotos comprimidas de terminadas, export/backup manual a JSON (botón que descarga el árbol completo de RTDB).
✅ *Sale cuando: todo lo de §5 existe y el backup descargado se puede reimportar a mano en Firebase Console.*

---

## 8. Convenciones de código

- Español para el dominio (`rollo`, `impresion`, `socio`); inglés OK para helpers genéricos (`formatDate`, `debounce`).
- Estado: listeners `onValue()` de RTDB → estado global mínimo en memoria → función `render()` por vista. **Sin estado duplicado**: la verdad vive en RTDB, la UI la refleja.
- Métricas derivadas: solo vía funciones puras de `calc.js`. Nunca calcular inline en el render.
- Sin dependencias externas salvo el SDK de Firebase por CDN y las dos Google Fonts.
- Commits atómicos por feature, mensaje en español, prefijo de fase: `F2: ajuste manual de stock con flujo de pesada`.

---

## 9. Edge cases ya decididos

- **Borrar rollo con impresiones asociadas** → nunca `remove()`; archivar (`archivado: true`). Los archivados salen del dashboard y del stock, pero siguen alimentando históricos y balances.
- **Editar `gramosReales` de una impresión vieja** → no requiere lógica especial: el stock derivado se recalcula solo (por eso existe §4.1).
- **Stock negativo** → puede pasar (estimados imprecisos). Mostrar en rojo con leyenda "pesá el rollo y ajustá", no bloquear.
- **Impresión sin rollo** (`rolloId: null`) → permitida; suma horas, no toca stock ni costos.
- **Dos socios con la app abierta a la vez** → RTDB resuelve la sincronización; no hay edición concurrente del mismo formulario que valga la pena resolver en v1.
- **Rollo cargado a mitad de uso** (ya venían usándolo antes de la app) → `pesoInicial` es el peso al momento del alta, no el nominal del fabricante. El label del form lo aclara.
- **Compartida en varias sub-colas** → la programa el primer turno que llegue de cualquiera de sus participantes; al programarse suma tiempo virtual a todos (§4.7).
- **"Me saltó la cola"** → si un socio con pocas horas recientes se mete adelante de una cola larga ajena, es el comportamiento deseado, no un bug. El indicador de equidad arriba de la Cola existe exactamente para que eso se entienda de un vistazo.

---

## 10. Fuera de alcance v1 — no implementar sin preguntar

- Login real con cuentas/passwords.
- Multi-impresora.
- Costo de electricidad y depreciación de la máquina (idea futura: `config.costoHoraMaquina` que se suma al costo de cada impresión — anotado, no construido).
- Integración con OctoPrint/Klipper/Moonraker.
- Notificaciones push.
- Porcentajes custom en impresiones compartidas.
- Drag & drop para reordenar la cola (v1 usa botones; §4.7).

---

## 11. Cómo trabajar en este repo

- Una fase por vez; al terminar, checklist contra el criterio de salida y deploy.
- Cualquier cambio al schema de §3 se propone primero y espera OK explícito.
- Ante ambigüedad entre este documento y una idea "mejor": este documento gana; proponer la mejora aparte.
- Datos de prueba: crear un `seed.js` descartable para F3 (los 2 rollos + 5 impresiones del criterio de salida), no ensuciar producción.
