import json
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import HTTPException
from jwt.exceptions import PyJWKClientConnectionError

from app.auth import supabase
from tests.test_foundation import token


@pytest.mark.parametrize("algorithm", ["ES256", "RS256"])
def test_asymmetric_jwt_verifies_signature_and_key_rotation(monkeypatch, algorithm):
    if algorithm == "ES256":
        private_key = ec.generate_private_key(ec.SECP256R1())
        jwk = jwt.algorithms.ECAlgorithm.to_jwk(private_key.public_key())
    else:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key())
    key = json.loads(jwk)
    key.update(kid="current-key", alg=algorithm, use="sig")
    client = jwt.PyJWKClient("https://auth.example.test/auth/v1/.well-known/jwks.json")
    monkeypatch.setattr(client, "fetch_data", lambda: {"keys": [key]})
    monkeypatch.setattr(supabase, "jwks_client", lambda _: client)
    claims = jwt.decode(token(), options={"verify_signature": False})
    signed = jwt.encode(claims, private_key, algorithm=algorithm, headers={"kid": "current-key"})
    assert str(supabase.verify_token(signed).auth_user_id) == claims["sub"]
    forged = jwt.encode(
        {**claims, "email": "forged@example.test"},
        ec.generate_private_key(ec.SECP256R1()),
        algorithm="ES256",
        headers={"kid": "unknown-key"},
    )
    with pytest.raises(HTTPException) as exc:
        supabase.verify_token(forged)
    assert exc.value.status_code == 401
    # A newly published kid is found on a later lookup.
    key["kid"] = "rotated-key"
    rotated = jwt.encode(claims, private_key, algorithm=algorithm, headers={"kid": "rotated-key"})
    assert str(supabase.verify_token(rotated).auth_user_id) == claims["sub"]


def test_jwks_outage_returns_service_unavailable(monkeypatch):
    def unavailable(_):
        raise PyJWKClientConnectionError("offline")

    monkeypatch.setattr(
        supabase, "jwks_client", lambda _: SimpleNamespace(get_signing_key_from_jwt=unavailable)
    )
    signed = jwt.encode({}, ec.generate_private_key(ec.SECP256R1()), algorithm="ES256")
    with pytest.raises(HTTPException) as exc:
        supabase.verify_token(signed)
    assert exc.value.status_code == 503
