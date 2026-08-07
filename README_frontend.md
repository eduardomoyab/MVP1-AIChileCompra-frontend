# Frontend — Asistente IA Compras Públicas

Servidor web construido en **Flask** que sirve la interfaz (organizada por categorías: Computadores, Medicamentos, y las que se agreguen) y actúa como **proxy seguro** entre el navegador y el backend FastAPI. El navegador nunca ve la URL ni la API key del backend.

> Repositorio: `github.com/eduardomoyab/MVP1-AIChileCompra-frontend` · versión `v1.0.0`

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Servidor web | Flask 3.0+ |
| Plantillas | Jinja2 — una por categoría (`computadores.html`, `medicamentos.html`) + partials compartidos (`_header.html`, `_session_modal.html`) |
| Estilos | Tailwind CSS (CDN) + CSS custom |
| Fuente | Inter (Google Fonts CDN) |
| Interactividad | JavaScript Vanilla |
| Streaming SSE | `fetch` + `ReadableStream` |
| Generación PDF | html2pdf.js 0.10.1 (html2canvas + jsPDF) |
| Proxy HTTP | httpx (streaming) |
| Despliegue | Railway |

---

## Arquitectura y rol de proxy

```mermaid
flowchart LR
    subgraph Público
        BR["Navegador\nusuario"]
    end

    subgraph Railway
        FE["Frontend Flask\n:5000\ndominio público"]
        BE["Backend FastAPI\n:8000\nred interna"]
        DB[("PostgreSQL")]
    end

    BR -- "HTTPS\nsin API key" --> FE
    FE -- "HTTP interno\n+ x-api-key header" --> BE
    BE --> DB
    BE -- "SSE stream" --> FE
    FE -- "SSE re-transmitido" --> BR
```

El proxy inyecta `x-api-key` server-side en cada petición, manteniendo la clave invisible al navegador y el backend inaccesible desde internet.

---

## Estructura del proyecto

La app está organizada por **categorías** (Computadores, Medicamentos, las que se agreguen después), cada una con su propio template + JS, más una pantalla de selección de categoría como home post-login.

```
MVP1-AIChileCompra-frontend/
├── app.py                     # Flask app: rutas, proxy, configuración
├── auth.py                    # Login (Google/Microsoft), Turnstile, rate limiting
├── requirements.txt
├── .env.example
├── templates/
│   ├── categorias.html        # Home post-login: selector de categoría
│   ├── computadores.html      # UI del asistente conversacional de Computadores
│   ├── medicamentos.html      # UI del buscador de Medicamentos
│   ├── login.html
│   ├── _header.html           # Partial: header + logos + panel de cuenta (compartido)
│   └── _session_modal.html    # Partial: aviso de sesión vencida (compartido)
├── static/
│   ├── js/
│   │   ├── shell.js           # Compartido entre TODAS las categorías: apiFetch,
│   │   │                      #   panel de cuenta, uso diario, sesión vencida
│   │   ├── app.js             # Lógica específica de Computadores (chat, ficha, SSE)
│   │   └── medicamentos.js    # Lógica específica del buscador de Medicamentos
│   └── css/style.css          # Animaciones y estilos complementarios
└── imagenes/                  # Logos institucionales (ChileCompra, OCP, UCH, UCBerkeley)
```

---

## Rutas Flask

| Ruta | Método | Descripción |
|---|---|---|
| `/` | GET | Selector de categoría (home post-login) |
| `/computadores` | GET | Asistente conversacional de Computadores |
| `/medicamentos` | GET | Buscador de Medicamentos |
| `/api/<path>` | GET / POST | Proxy transparente al backend (inyecta `x-api-key`, reenvía query string, re-transmite SSE) — solo rutas en el allowlist `_ALLOWED_PROXY_PREFIXES` |
| `/imagenes/<filename>` | GET | Sirve logos institucionales |
| `/static/...` | GET | CSS y JavaScript estáticos |
| `/login`, `/logout`, `/login/google`, `/login/microsoft` | GET / POST | Autenticación (ver `auth.py`) |

---

## Interfaz de usuario — Computadores

```mermaid
flowchart TD
    subgraph Header
        LOGOS["Logos: ChileCompra · OCP · UCBerkeley · UCH"]
    end

    subgraph Layout["Layout principal"]
        subgraph Chat["Panel Chat — 46% desktop"]
            SUGG["Sugerencias rápidas\n(4 casos de uso)"]
            MSGS["Área de mensajes\n(streaming token a token)"]
            INPUT["Textarea + botón enviar\nEnter · Shift+Enter"]
        end

        subgraph Ficha["Panel Ficha Técnica — 54% desktop"]
            PRICE["Estimación de precio\nP25 · Mediana · P75 (sticky)"]
            PROG["Barra de progreso\natributos completados"]
            SEC1["General\ntipo_equipo · marca"]
            SEC2["Procesador\nprocesador · línea · núcleos* · hilos* · frec*"]
            SEC3["Memoria RAM\nRAM GB · tecnología · frecuencia*"]
            SEC4["Almacenamiento\nGB · tecnología · configuración"]
            SEC5["Gráficos\nGPU? · nombre GPU · VRAM*"]
            SEC6["Pantalla y Sistema\npulgadas · SO · Wi-Fi"]
            PDF["Botón PDF\nhtml2pdf.js client-side"]
        end
    end

    Header --> Layout
```

`*` Campos de solo lectura — completados automáticamente por complemento, sin edición directa.

En **móvil** la interfaz usa tabs (Chat | Ficha) con badge rojo animado cuando llega una actualización de ficha.

---

## Interfaz de usuario — Medicamentos

A diferencia de Computadores, acá no hay chat ni recomendación — es un **buscador**: un campo de texto (con debounce, busca mientras escribes) más dos filtros opcionales (laboratorio, forma farmacéutica). Los resultados vienen agrupados por producto (no fila por fila del historial de compras) con un contador "comprado N veces". Ver `services/medicamento_service.py` en el backend para el detalle de cómo se arma el match.

---

## Badges de origen de atributos (solo Computadores)

Cada campo de la ficha muestra de dónde provino su valor:

| Badge | Color | Origen |
|---|---|---|
| **IA** | Violeta | Extraído e inferido por GPT-4o-mini |
| **Tú** | Verde | Ingresado o editado manualmente por el usuario |
| **Auto** | Ámbar | Derivado automáticamente por reglas de complemento |

---

## Editor manual inline (solo Computadores)

Al hacer clic en el ícono de edición de cualquier campo editable, se despliega el control apropiado según el tipo del atributo:

| Tipo | Control |
|---|---|
| `enum` | Select dropdown con valores fijos |
| `dict` | Input de texto con datalist (valores desde `/api/dropdowns`) |
| `numeric` | Input numérico — soporta valor único, lista o rango min/max |
| `boolean` | Selector Sí / No |
| `free` | Input de texto libre |

---

## Configuración (`.env`)

| Variable | Default | Requerida | Descripción |
|---|---|---|---|
| `API_URL` | `http://localhost:8000` | **Sí** | URL del backend (interna Railway en producción) |
| `FRONTEND_API_KEY` | — | **Sí** | Igual a `FRONTEND_API_KEY` del backend |
| `FLASK_HOST` | `0.0.0.0` | No | Host del servidor Flask |
| `FLASK_PORT` | `5000` | No | Puerto del servidor Flask |
| `FLASK_DEBUG` | `true` | No | Modo debug (`false` en producción) |

---

## Instalación local

```bash
cd MVP1-AIChileCompra-frontend

python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Linux / macOS

pip install -r requirements.txt

cp .env.example .env
# Configurar:
#   API_URL=http://localhost:8000
#   FRONTEND_API_KEY=<misma clave que el backend>

python app.py
# → http://localhost:5000
```

El backend debe estar corriendo en `API_URL` antes de iniciar el frontend.
