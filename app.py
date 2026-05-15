import os
from flask import Flask, render_template, send_from_directory
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
    return render_template("index.html", api_url=API_URL, api_key=FRONTEND_API_KEY)


@app.route("/imagenes/<path:filename>")
def serve_imagenes(filename):
    imagenes_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "imagenes")
    return send_from_directory(imagenes_dir, filename)


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=DEBUG)
