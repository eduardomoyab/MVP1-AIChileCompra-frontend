"""
auth.py — Login con Google/Microsoft para el Asistente Compra Ágil.

Acceso gateado por lista blanca de correos, administrada desde el módulo
"Aplicaciones" de db-admin-panel. MVP1 no mantiene su propia tabla de
usuarios ni tiene credenciales de Postgres propias: el frontend le
pregunta al backend (que ya tiene DATABASE_URL para PrecioCA/PrecioCM) vía
GET /api/auth/check_access — mismo patrón de API key que el resto del
proxy en app.py. El frontend no debe tener ninguna conexión más que al
backend.

No hay usuario/contraseña de respaldo (a diferencia de db-admin-panel):
esta app no tiene concepto de admin/roles que lo justifique.
"""
import os
import re
from functools import wraps

import httpx
from authlib.integrations.flask_client import OAuth
from flask import Blueprint, abort, current_app, flash, redirect, render_template, session, url_for
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

bp = Blueprint("auth", __name__)
oauth = OAuth()


def _rate_limit_key():
    # Una vez logueado, el límite sigue a la persona (su sesión), no a su
    # IP -- varios funcionarios de una misma oficina/NAT no deberían
    # compartir el mismo balde de rate limit. Antes de loguearse (pantalla
    # de login, callbacks de OAuth) cae a IP, que es lo único que hay.
    return session.get("email") or get_remote_address()


# Límite global por sesión/IP contra flood a nivel de aplicación. Storage en
# memoria del propio proceso -- si algún día se corre con más de un worker,
# necesita pasar a un backend compartido (Redis), cada worker tendría su
# propio balde si no.
limiter = Limiter(
    key_func=_rate_limit_key,
    default_limits=["300 per minute", "4000 per hour"],
    storage_uri="memory://",
)

# El endpoint "common" de Microsoft (cuentas personales + de organización)
# devuelve en su discovery doc un issuer con placeholder sin resolver
# ("https://login.microsoftonline.com/{tenantid}/v2.0"), pero el id_token
# real trae el tenant concreto (un GUID, o "9188...66dad" para cuentas
# personales). Authlib valida "iss" contra el issuer del discovery doc por
# default → siempre falla con "common". Se valida con un patrón en vez de
# con un valor exacto (la firma JWKS del token sigue siendo la garantía
# criptográfica real de que lo emitió Microsoft).
_MS_ISSUER_RE = re.compile(r"^https://login\.microsoftonline\.com/[^/]+/v2\.0$")


def _validate_ms_issuer(claims, value):
    return bool(_MS_ISSUER_RE.match(value or ""))


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
    if app.config["MICROSOFT_LOGIN_ENABLED"]:
        oauth.register(
            name="microsoft",
            client_id=app.config["MICROSOFT_CLIENT_ID"],
            client_secret=app.config["MICROSOFT_CLIENT_SECRET"],
            server_metadata_url="https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )


def is_email_allowed(email: str) -> bool:
    """Le pregunta al backend (GET /api/auth/check_access) en vez de tocar
    Postgres directo — el frontend no tiene ni debe tener credenciales de
    base de datos propias."""
    api_url = os.getenv("API_URL", "http://localhost:8000")
    api_key = os.getenv("FRONTEND_API_KEY", "")
    try:
        resp = httpx.get(
            f"{api_url}/api/auth/check_access",
            params={"email": email},
            headers={"x-api-key": api_key},
            timeout=10,
        )
        resp.raise_for_status()
        return bool(resp.json().get("allowed"))
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


def _no_access(email):
    flash(
        f'La cuenta "{email or "desconocida"}" no tiene acceso a esta aplicación. '
        "Pídele a un administrador que te agregue en el módulo Aplicaciones del panel.",
        "error",
    )
    return redirect(url_for("auth.login"))


def _start_session(email):
    session.clear()
    session.permanent = True
    session["logged_in"] = True
    session["email"] = email
    return redirect(url_for("index"))


@bp.route("/login")
@limiter.limit("40 per minute")
def login():
    if session.get("logged_in"):
        return redirect(url_for("index"))
    return render_template(
        "login.html",
        google_login_enabled=current_app.config["GOOGLE_LOGIN_ENABLED"],
        microsoft_login_enabled=current_app.config["MICROSOFT_LOGIN_ENABLED"],
    )


@bp.route("/login/google")
@limiter.limit("40 per minute")
def login_google():
    if not current_app.config["GOOGLE_LOGIN_ENABLED"]:
        abort(404)
    redirect_uri = url_for("auth.google_callback", _external=True)
    return oauth.google.authorize_redirect(redirect_uri)


@bp.route("/login/google/callback")
@limiter.limit("40 per minute")
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
        return _no_access(email)

    return _start_session(email)


@bp.route("/login/microsoft")
@limiter.limit("40 per minute")
def login_microsoft():
    if not current_app.config["MICROSOFT_LOGIN_ENABLED"]:
        abort(404)
    redirect_uri = url_for("auth.microsoft_callback", _external=True)
    return oauth.microsoft.authorize_redirect(redirect_uri)


@bp.route("/login/microsoft/callback")
@limiter.limit("40 per minute")
def microsoft_callback():
    if not current_app.config["MICROSOFT_LOGIN_ENABLED"]:
        abort(404)

    try:
        token = oauth.microsoft.authorize_access_token(
            claims_options={"iss": {"essential": True, "validate": _validate_ms_issuer}}
        )
    except Exception:
        flash("No se pudo completar el inicio de sesión con Microsoft.", "error")
        return redirect(url_for("auth.login"))

    userinfo = token.get("userinfo") or {}
    # Microsoft no expone "email_verified" en el id_token del endpoint
    # "common" (confirmado contra su discovery doc) — a diferencia de
    # Google, acá no hay ese claim para exigir. La firma del token
    # (validada por Authlib vía JWKS) ya garantiza que el email lo emitió
    # Microsoft; el control de acceso real sigue siendo la whitelist.
    email = (userinfo.get("email") or "").strip().lower()
    if not email:
        preferred = (userinfo.get("preferred_username") or "").strip().lower()
        if "@" in preferred:
            email = preferred

    if not (email and is_email_allowed(email)):
        return _no_access(email)

    return _start_session(email)


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
