FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

EXPOSE 5000

# Railway inyecta $PORT; si no existe usa 5000.
# --worker-class gthread --threads 8: este proxy pasa casi todo su tiempo
# esperando al backend (I/O, incluye streams SSE que quedan abiertos varios
# segundos) -- con el worker sync por defecto, cada uno de esos streams
# ocupaba un worker completo y con solo 2 workers, 2 requests simultáneas
# (ej. un /analizar en curso + cualquier otra persona o pestaña) ya hacían
# cola. Con threads, los mismos 2 procesos atienden muchas más conexiones
# I/O-bound concurrentes sin el costo de memoria de más procesos.
# --timeout 120: default de gunicorn es 30s: un worker se da por "colgado" y
# se mata a mitad de una respuesta lenta (IA + consultas de precio), cortando
# el SSE en seco del lado del cliente. 120 iguala el timeout ya puesto en el
# httpx.Client que arma este mismo proxy hacia el backend.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-5000} --workers 2 --worker-class gthread --threads 8 --timeout 120 app:app"]
