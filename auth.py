"""
auth.py — Login con Google para el Asistente Compra Ágil.

Acceso gateado por lista blanca de correos, administrada desde el módulo
"Aplicaciones" de db-admin-panel (mismo Postgres, schema `panel_admin`).
MVP1 no mantiene su propia tabla de usuarios: solo consulta esa lista
blanca al momento del login.

No hay usuario/contraseña de respaldo (a diferencia de db-admin-panel):
esta app no tiene concepto de admin/roles que lo justifique.
"""
import os
from functools import wraps

import psycopg2
from authlib.integrations.flask_client import OAuth
from flask import Blueprint, abort, current_app, flash, redirect, render_template, session, url_for

bp = Blueprint("auth", __name__)
oauth = OAuth()

APPLICATION_SLUG = "mvp1-compra-agil"


def init_oauth(app):
    oauth.init_app(app)
    if app.config["GOOGLE_LOGIN_ENABLED"]:
        oauth.register(
            name="google",
            client_id=app.config["GOOGLE_CLIENT_ID"],
            client_secret=app.config["GOOGLE_CLIENT_SECRET"],
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )


def is_email_allowed(email: str) -> bool:
    """Consulta directa a panel_admin.application_users (mismo Postgres que
    db-admin-panel) — sin pool, MVP1 no tiene el volumen para justificarlo."""
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        return False
    try:
        with psycopg2.connect(dsn, connect_timeout=10) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1 FROM panel_admin.application_users au
                    JOIN panel_admin.applications a ON a.id = au.application_id
                    WHERE a.slug = %s AND au.email = %s
                    """,
                    (APPLICATION_SLUG, email),
                )
                return cur.fetchone() is not None
    except Exception:
        current_app.logger.exception("Error consultando lista blanca de acceso")
        return False


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("auth.login"))
        return view(*args, **kwargs)

    return wrapped


@bp.route("/login")
def login():
    if session.get("logged_in"):
        return redirect(url_for("index"))
    return render_template("login.html", google_login_enabled=current_app.config["GOOGLE_LOGIN_ENABLED"])


@bp.route("/login/google")
def login_google():
    if not current_app.config["GOOGLE_LOGIN_ENABLED"]:
        abort(404)
    redirect_uri = url_for("auth.google_callback", _external=True)
    return oauth.google.authorize_redirect(redirect_uri)


@bp.route("/login/google/callback")
def google_callback():
    if not current_app.config["GOOGLE_LOGIN_ENABLED"]:
        abort(404)

    try:
        token = oauth.google.authorize_access_token()
    except Exception:
        flash("No se pudo completar el inicio de sesión con Google.", "error")
        return redirect(url_for("auth.login"))

    userinfo = token.get("userinfo") or {}
    email = (userinfo.get("email") or "").strip().lower()
    email_verified = userinfo.get("email_verified", False)

    if not (email_verified and email and is_email_allowed(email)):
        flash(
            f'La cuenta "{email or "desconocida"}" no tiene acceso a esta aplicación. '
            "Pídele a un administrador que te agregue en el módulo Aplicaciones del panel.",
            "error",
        )
        return redirect(url_for("auth.login"))

    session.clear()
    session.permanent = True
    session["logged_in"] = True
    session["email"] = email
    return redirect(url_for("index"))


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
