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

  // Pantalla de ingreso (ver inputScreenHtml en shell.js).
  inputHelper: 'Describe las características del equipo que necesitas. Completamos el resto juntos.',
  inputPlaceholder: 'Ej.: notebook con procesador Intel Core i5, 16 GB de RAM y 512 GB SSD…',
  exampleText: 'Notebook con procesador i5, 16 GB de RAM y 512 GB SSD',
  guide: [
    { title: 'Tipo de equipo', text: 'Laptop, todo en uno o escritorio' },
    { title: 'Procesador', text: 'Línea o modelo, si lo conoces' },
    { title: 'Memoria RAM', text: 'Capacidad en GB' },
    { title: 'Almacenamiento', text: 'Tipo y capacidad' },
  ],
  manualStart: {
    attr: 'tipo_equipo',
    title: 'Tipo de equipo',
    hint: 'Después te preguntamos procesador, memoria y almacenamiento.',
    options: [
      { value: 'Laptop', desc: 'Notebook o portátil' },
      { value: 'AIO', desc: 'Todo en uno: pantalla y equipo integrados' },
      { value: 'Desktop', desc: 'Torre o mini PC, monitor aparte' },
    ],
  },

  // Se muestra cuando lo descrito no corresponde a ningún computador (el
  // extractor clasifica tipo_equipo="Otro") -- ver handleOffTopicProduct
  // en category_wizard.js.
  offTopicMessage: 'Este asistente está diseñado específicamente para especificar computadores (laptops, equipos todo-en-uno o de escritorio). ' +
    'Lo que describiste no corresponde a ese tipo de equipo -- contanos qué computador necesitás (procesador, RAM, almacenamiento, etc.) y seguimos.',

  logicalSteps: {
    linea_procesador_o_procesador: {
      attr: 'linea_procesador',
      secondaryAttr: 'procesador_principal',
      secondaryLabel: '¿Tienes un modelo exacto en mente? (opcional)',
      secondaryPlaceholder: 'Ej: Intel Core i5-1335U',
    },
  },

  // Documento técnico (vista previa y PDF del backend): sin precios.
  docTitle: 'Especificaciones técnicas',
  docLogoHtml: '<img src="/imagenes/logo-chilecompra.png" alt="ChileCompra" />',
  pdfFilenamePrefix: 'especificaciones-tecnicas-computadores',

  // Título de respaldo de cada ítem mientras no llega el nombre del modelo:
  // tipo + procesador (modelo exacto, si no la línea) + RAM + almacenamiento.
  titleAttrs: ['tipo_equipo', ['procesador_principal', 'linea_procesador'], 'total_ram_gb', 'total_almacenamiento_gb'],
  titleSuffix: { total_ram_gb: ' RAM' },
};
