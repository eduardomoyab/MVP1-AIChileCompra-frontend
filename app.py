import os
import httpx
from flask import Flask, render_template, send_from_directory, request, Response, stream_with_context
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

API_URL          = os.getenv("API_URL", "http://localhost:8000")
FRONTEND_API_KEY = os.getenv("FRONTEND_API_KEY", "")
HOST             = os.getenv("FLASK_HOST", "0.0.0.0")
PORT             = int(os.getenv("FLASK_PORT", "5000"))
DEBUG            = os.getenv("FLASK_DEBUG", "true").lower() == "true"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/<path:path>", methods=["POST", "GET"])
def proxy(path):
    url = f"{API_URL}/api/{path}"
    headers = {"x-api-key": FRONTEND_API_KEY, "Content-Type": "application/json"}
    data = request.get_data()

    def generate():
        with httpx.stream(request.method, url, content=data, headers=headers, timeout=120) as r:
            for chunk in r.iter_bytes():
                yield chunk

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/imagenes/<path:filename>")
def serve_imagenes(filename):
    imagenes_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "imagenes")
    return send_from_directory(imagenes_dir, filename)


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=DEBUG)
