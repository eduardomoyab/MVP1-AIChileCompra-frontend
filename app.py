import os
from datetime import timedelta

import httpx
from flask import Flask, redirect, render_template, send_from_directory, request, Response, session, stream_with_context, url_for
from dotenv import load_dotenv

import auth

load_dotenv()

app = Flask(__name__)

API_URL          = os.getenv("API_URL", "http://localhost:8000")
FRONTEND_API_KEY = os.getenv("FRONTEND_API_KEY", "")
HOST             = os.getenv("FLASK_HOST", "0.0.0.0")
PORT             = int(os.getenv("FLASK_PORT", "5000"))
DEBUG            = os.getenv("FLASK_DEBUG", "true").lower() == "true"

app.secret_key = os.environ["SECRET_KEY"]
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = not DEBUG
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=int(os.getenv("SESSION_LIFETIME_HOURS", "8")))

app.config["GOOGLE_CLIENT_ID"] = os.getenv("GOOGLE_CLIENT_ID", "")
app.config["GOOGLE_CLIENT_SECRET"] = os.getenv("GOOGLE_CLIENT_SECRET", "")
app.config["GOOGLE_LOGIN_ENABLED"] = bool(app.config["GOOGLE_CLIENT_ID"] and app.config["GOOGLE_CLIENT_SECRET"])

auth.init_oauth(app)
app.register_blueprint(auth.bp)

# Endpoints alcanzables sin sesión: login, su callback, y estáticos/logos.
_PUBLIC_ENDPOINTS = {"auth.login", "auth.login_google", "auth.google_callback", "static", "serve_imagenes"}


@app.before_request
def _require_login():
    if request.endpoint in _PUBLIC_ENDPOINTS:
        return None
    if not session.get("logged_in"):
        return redirect(url_for("auth.login"))


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
