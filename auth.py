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
import time
from functools import wraps

import httpx
from authlib.integrations.flask_client import OAuth
from flask import Blueprint, abort, current_app, flash, redirect, render_template, request, session, url_for
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from joserfc import jwt as mp_jwt
from joserfc.errors import JoseError
from joserfc.jwk import KeySet

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
    if not tenant_id:
        return False

    # xms_edov ("Email Domain Owner Verified"): mitigación oficial de
    # Microsoft para nOAuth -- https://learn.microsoft.com/entra/identity-platform/migrate-off-email-claim-authorization#using-the-xms_edov-optional-claim
    # Solo viene en true si ESE tenant verificó por DNS que es dueño del
    # dominio del correo (obligatorio para usarlo en Microsoft 365), así
    # que reemplaza la lista manual: cualquier organización cliente
    # (Chile Compra, Aminerals, la que sea) entra sola, sin tener que
    # agregar su tenant ID acá cada vez que se suma un cliente nuevo.
    # Requiere el claim opcional "xms_edov" activado en el App
    # Registration de Azure (compartido con db-admin-panel, mismo
    # client_id) -- si no está activado, el claim no llega y se sigue
    # exigiendo la lista manual de MICROSOFT_ALLOWED_TENANT_IDS.
    allowed = tenant_id in _ms_allowed_tenant_ids()
    edov = str(claims.get("xms_edov")).lower() == "true"
    current_app.logger.info(
        "Microsoft login: tenant=%s en_lista_manual=%s xms_edov=%r",
        tenant_id, allowed, claims.get("xms_edov"),
    )
    return allowed or edov


# --- SSO delegado desde Mercado Público (login vía Clave Única, sept. 2026) -----
#
# U.Chile embebe esta app dentro de su propia plataforma; sus usuarios ya se
# autenticaron en Mercado Público (que usa Clave Única por debajo). En vez de
# pedirles loguearse de nuevo acá, su plataforma reenvía por POST (nunca por
# URL -- se filtraría en logs/historial) el JWT de esa sesión, y nosotros
# verificamos que sea auténtico.
#
# Confirmado con Carla Cáceres (Jefa Arquitectura y Desarrollo, ChileCompra)
# contra dos JWT de prueba reales:
#   - alg RS256 (asimétrico): podemos validar la firma nosotros solos, sin
#     llamar a sus servidores en cada ingreso.
#   - aud="account" / azp="mercadoPublicoClient": es el token de acceso
#     GENÉRICO de su propio portal (Keycloak), no uno emitido pensando en
#     esta app -- no existe una audiencia nuestra que validar. La garantía
#     que sí nos da: solo alguien con sesión válida y reciente en Mercado
#     Público puede producir uno con firma correcta.
#   - No trae RUT ni correo verificado -- identificamos a la persona con
#     codigoUsuario + codigoOrganismo (sí vienen, y son únicos).
#   - No trae ningún flag de "habilitado para MVP1" -- ChileCompra todavía
#     no definió ese mecanismo (pendiente en el mismo hilo). Mientras tanto,
#     la política de acceso es: cualquier JWT válido con tipoUsuario=
#     "Comprador". Revisar esto cuando definan el flag real.
_MP_ISSUER = "https://balder.mercadopublico.cl/auth/realms/chilecomprarealm"
_MP_JWKS_URL = f"{_MP_ISSUER}/protocol/openid-connect/certs"
_MP_REQUIRED_TIPO_USUARIO = "Comprador"

# Cache en memoria del proceso (mismo patrón que el Limiter de más arriba).
# TTL largo porque estas llaves rotan muy rara vez -- si llega un JWT con un
# "kid" que no está en el caché, se refresca una vez al toque (podría ser
# justo una rotación) antes de rechazarlo. La actualización periódica
# "de fondo" (en vez de a demanda) queda para más adelante, en otra parte.
_MP_JWKS_TTL_SECONDS = 24 * 60 * 60
_mp_jwks_cache = {"keyset": None, "fetched_at": 0.0}


def _fetch_mp_jwks(force=False):
    now = time.time()
    if not force and _mp_jwks_cache["keyset"] and (now - _mp_jwks_cache["fetched_at"] < _MP_JWKS_TTL_SECONDS):
        return _mp_jwks_cache["keyset"]
    resp = httpx.get(_MP_JWKS_URL, timeout=10)
    resp.raise_for_status()
    keyset = KeySet.import_key_set(resp.json())
    _mp_jwks_cache["keyset"] = keyset
    _mp_jwks_cache["fetched_at"] = now
    return keyset


_mp_claims_registry = mp_jwt.JWTClaimsRegistry(
    iss={"essential": True, "value": _MP_ISSUER},
    exp={"essential": True},
)

# NO se exige "jti" de un solo uso a propósito: este JWT es el token de la
# sesión que la persona ya tiene abierta en Mercado Público, generado una
# vez al loguearse ahí (no uno nuevo por cada clic). Alguien puede cerrar
# MVP1, seguir navegando en Mercado Público sin volver a loguearse, y
# apretar el botón de nuevo más tarde -- eso reenvía el MISMO token, y debe
# seguir sirviendo mientras no venza. Un control de un solo uso bloquearía
# ese caso legítimo exactamente igual que a un token filtrado: no hay forma
# de distinguir uno de otro solo mirando el token. El riesgo que esto deja
# (un token filtrado sirve hasta que venza) es el mismo de cualquier cookie
# de sesión, incluida la de Google/Microsoft más abajo -- no es un nivel de
# seguridad menor al resto de la app.
def _verify_mp_token(token: str):
    """Verifica firma (RS256 contra el JWKS público), emisor y vigencia.
    Devuelve los claims si es válido, o None si no."""
    if not token:
        return None
    for attempt in (False, True):
        try:
            keyset = _fetch_mp_jwks(force=attempt)
            decoded = mp_jwt.decode(token, keyset)
            _mp_claims_registry.validate(decoded.claims)
            return decoded.claims
        except JoseError:
            if attempt:
                current_app.logger.warning("JWT de Mercado Público inválido, expirado o con firma incorrecta")
                return None
            # Primer intento falló: podría ser un "kid" rotado que el caché
            # todavía no tiene -- se reintenta una vez con el JWKS fresco.
            continue
    return None


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


def check_access(email: str):
    """Le pregunta al backend (GET /api/auth/check_access) en vez de tocar
    Postgres directo — el frontend no tiene ni debe tener credenciales de
    base de datos propias. Devuelve (allowed, sections, is_admin): sections
    es None si la app no tiene secciones definidas (sin restricción) o una
    lista de slugs (puede ser vacía) si sí las tiene; is_admin es True si el
    correo pertenece al grupo 'Admins' (ver access_service.is_admin en el
    backend) — habilita el link "Panel de administrador"."""
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
        data = resp.json()
        return bool(data.get("allowed")), data.get("sections"), bool(data.get("is_admin"))
    except Exception:
        current_app.logger.exception("Error consultando lista blanca de acceso")
        return False, [], False


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


def _start_session(email, name=None, provider=None, sections=None, is_admin=False):
    session.clear()
    session.permanent = True
    session["logged_in"] = True
    session["email"] = email
    session["name"] = name or email
    session["provider"] = provider
    # None = la app no tiene secciones definidas (sin restricción); lista
    # (posiblemente vacía) = solo esas secciones son visibles/accesibles.
    session["sections"] = sections
    session["is_admin"] = is_admin
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
        # "mp_invalido": vino de un intento fallido de SSO desde Mercado
        # Público (ver login_mercadopublico) -- la plantilla usa esto para
        # esconder los botones de Google/Microsoft, que no pintan nada para
        # alguien que llegó por ese otro camino.
        motivo=request.args.get("motivo", ""),
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

    allowed, sections, is_admin = check_access(email) if (email_verified and email) else (False, [], False)
    if not allowed:
        return _no_access(email)

    return _start_session(email, name, "google", sections, is_admin)


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

    allowed, sections, is_admin = check_access(email) if email else (False, [], False)
    if not allowed:
        return _no_access(email)

    return _start_session(email, name, "microsoft", sections, is_admin)


@bp.route("/login/mercadopublico", methods=["POST"])
@limiter.limit("40 per minute")
def login_mercadopublico():
    """Entrada vía SSO delegado: la plataforma de U.Chile autoenvía acá un
    formulario POST con el JWT de la sesión de Mercado Público del usuario
    (ver notas arriba de _verify_mp_token). No pasa por la whitelist de
    correos de check_access() -- es una puerta paralela, gateada por la
    firma de Mercado Público."""
    token = request.form.get("token", "")
    codigo_onu = request.form.get("codigoONU", "")  # contexto no sensible (qué categoría de producto); no participa en el control de acceso

    # El motivo="mp_invalido" ya le dice a login.html qué mensaje mostrar
    # (ver login.html) -- no se usa flash() acá para no duplicar el aviso.
    claims = _verify_mp_token(token)
    if not claims:
        return redirect(url_for("auth.login", motivo="mp_invalido"))

    if claims.get("tipoUsuario") != _MP_REQUIRED_TIPO_USUARIO:
        return redirect(url_for("auth.login", motivo="mp_invalido"))

    codigo_usuario = claims.get("codigoUsuario", "")
    codigo_organismo = claims.get("codigoOrganismo", "")
    # No hay correo (ni verificado) en este JWT -- se arma un identificador
    # sintético y se reutiliza el campo "email" de la sesión tal cual, para
    # no tener que tocar usage_service/analytics_service/chat_session_service
    # en el backend: todos ellos ya tratan x-user-email como una llave
    # opaca, sin exigirle formato de correo.
    identity = f"mp:{codigo_usuario}_{codigo_organismo}"
    name = claims.get("name") or identity

    response = _start_session(identity, name, "mercadopublico", sections=None, is_admin=False)
    if codigo_onu:
        session["codigo_onu"] = codigo_onu  # _start_session ya limpió la sesión antes; esto va después para no perderse
    return response


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
