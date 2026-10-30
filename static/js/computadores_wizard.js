/* ═══════════════════════════════════════════════════════════════
   computadores_wizard.js — configuración de Computadores sobre el motor
   genérico (category_wizard.js). Debe cargarse ANTES de ese script (ver
   templates/computadores.html) -- define el global CONFIG que el motor
   lee al arrancar.

   "linea_procesador_o_procesador" es el único paso "lógico" de esta
   categoría: core_order lo declara así (ver
   categories/computadores_schema.py) porque el procesador se resuelve a
   uno de dos atributos reales según lo que haya dicho el usuario --
   `linea_procesador` (familia, ej. "Intel Core i5") por defecto, o
   `procesador_principal` (modelo exacto, ej. "Intel Core i5-1335U") si
   el usuario tiene uno en mente. Mismo criterio que ya usa el chat
   legacy ("regla de oro" en agents/computadores_rules.py).
   ═══════════════════════════════════════════════════════════════ */

const CONFIG = {
  slug: 'computadores',
  supportsConvenioMarco: true,

  introTitle: '¿Qué computador necesitas?',
  introSubtitle: 'Escribe tu requerimiento con lo que ya sepas -- aunque sea poco -- y lo iremos completando juntos paso a paso (ej. "notebook para el área legal" o "i5-1335U, 16GB RAM, 512GB SSD").',

  // Se muestra cuando lo descrito no corresponde a ningún computador (el
  // extractor clasifica tipo_equipo="Otro") -- ver handleOffTopicProduct
  // en category_wizard.js.
  offTopicMessage: 'Este asistente está diseñado específicamente para especificar computadores (laptops, equipos todo-en-uno o de escritorio). ' +
    'Lo que describiste no corresponde a ese tipo de equipo -- contanos qué computador necesitás (uso, procesador, RAM, almacenamiento, etc.) y seguimos.',

  logicalSteps: {
    linea_procesador_o_procesador: {
      attr: 'linea_procesador',
      secondaryAttr: 'procesador_principal',
      secondaryLabel: '¿Tienes un modelo exacto en mente? (opcional)',
      secondaryPlaceholder: 'Ej: Intel Core i5-1335U',
    },
  },

  docTitle: 'Requerimientos de Compra — Computadores',
  docLogoHtml: '<img src="/imagenes/logo-chilecompra.png" alt="ChileCompra" />',
  pdfFilenamePrefix: 'requerimientos-computadores',
};
