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
from flask import Blueprint, abort, current_app, flash, redirect, render_template, request, session, url_for
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

# Tenant fijo que Microsoft usa para TODAS las cuentas personales
# (outlook.com/hotmail.com/live.com) -- es el mismo GUID para cualquier
# cuenta personal, documentado por Microsoft.
_MS_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad"


def _ms_allowed_tenant_ids() -> set:
    # Vulnerabilidad "nOAuth": en un tenant de organización (Azure AD/Entra
    # ID) el atributo "mail" de un usuario lo puede fijar el admin de ESE
    # tenant a cualquier string, sin verificar que sea dueño de ese dominio
    # -- cualquiera puede crearse un tenant gratis y ponerle a un usuario
    # el correo de alguien más para hacerse pasar por esa identidad acá
    # (el id_token firma válido, pero el claim "email" no es confiable por
    # sí solo). Las cuentas personales no tienen este problema (su correo
    # sí está verificado por Microsoft al crearlas), por eso el tenant
    # consumer siempre se permite. Tenants de organización específicos
    # (ej. una universidad) deben agregarse explícitamente acá -- se
    # rechaza cualquier tenant no declarado, en vez de confiar en "common"
    # a ciegas.
    extra = os.getenv("MICROSOFT_ALLOWED_TENANT_IDS", "")
    ids = {t.strip().lower() for t in extra.split(",") if t.strip()}
    ids.add(_MS_CONSUMER_TENANT_ID)
    return ids


def _validate_ms_issuer(claims, value):
    if not _MS_ISSUER_RE.match(value or ""):
        return False
    tenant_id = str(claims.get("tid") or "").strip().lower()
    return bool(tenant_id) and tenant_id in _ms_allowed_tenant_ids()


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


_TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def _verify_turnstile(token: str, remote_ip: str = None) -> bool:
    """Valida el token del widget Cloudflare Turnstile contra su API antes
    de dejar arrancar un login -- filtra bots/scripts que peguen directo a
    /login/google o /login/microsoft sin pasar por la pantalla real. Si no
    hay TURNSTILE_SECRET_KEY configurada (ej. desarrollo local), no bloquea
    -- mismo patrón que GOOGLE_LOGIN_ENABLED/MICROSOFT_LOGIN_ENABLED."""
    secret = current_app.config.get("TURNSTILE_SECRET_KEY")
    if not secret:
        return True
    if not token:
        return False
    try:
        resp = httpx.post(
            _TURNSTILE_VERIFY_URL,
            data={"secret": secret, "response": token, "remoteip": remote_ip or ""},
            timeout=10,
        )
        resp.raise_for_status()
        return bool(resp.json().get("success"))
    except Exception:
        current_app.logger.exception("Error verificando Turnstile")
        return False


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


def _start_session(email, name=None, provider=None):
    session.clear()
    session.permanent = True
    session["logged_in"] = True
    session["email"] = email
    session["name"] = name or email
    session["provider"] = provider
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
        turnstile_enabled=bool(current_app.config.get("TURNSTILE_SITE_KEY")),
        turnstile_site_key=current_app.config.get("TURNSTILE_SITE_KEY", ""),
    )


@bp.route("/login/google", methods=["POST"])
@limiter.limit("40 per minute")
def login_google():
    if not current_app.config["GOOGLE_LOGIN_ENABLED"]:
        abort(404)
    token = request.form.get("cf-turnstile-response", "")
    if not _verify_turnstile(token, get_remote_address()):
        flash("Verificación de seguridad fallida. Intenta de nuevo.", "error")
        return redirect(url_for("auth.login"))
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
    name = userinfo.get("name")

    if not (email_verified and email and is_email_allowed(email)):
        return _no_access(email)

    return _start_session(email, name, "google")


@bp.route("/login/microsoft", methods=["POST"])
@limiter.limit("40 per minute")
def login_microsoft():
    if not current_app.config["MICROSOFT_LOGIN_ENABLED"]:
        abort(404)
    token = request.form.get("cf-turnstile-response", "")
    if not _verify_turnstile(token, get_remote_address()):
        flash("Verificación de seguridad fallida. Intenta de nuevo.", "error")
        return redirect(url_for("auth.login"))
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
    # Google. Por eso _validate_ms_issuer (arriba) ya restringió el tenant
    # emisor al consumer tenant o a uno explícitamente confiable: en un
    # tenant de organización ajeno, "mail" no está verificado y cualquiera
    # podría fijarlo a un correo de la whitelist para suplantar identidad.
    email = (userinfo.get("email") or "").strip().lower()
    if not email:
        preferred = (userinfo.get("preferred_username") or "").strip().lower()
        if "@" in preferred:
            email = preferred
    name = userinfo.get("name")

    if not (email and is_email_allowed(email)):
        return _no_access(email)

    return _start_session(email, name, "microsoft")


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
