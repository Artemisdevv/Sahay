"""Test environment. Must run before `app.main` is imported anywhere (settings read env at import)."""
import json
import os
import tempfile
from pathlib import Path

_VECTOR = json.loads((Path(__file__).resolve().parents[2] / "contract" / "crypto-test-vector.json").read_text(encoding="utf-8"))
_DB = Path(tempfile.mkdtemp(prefix="sahay-test-")) / "test.db"

os.environ["SAHAY_DEV"] = "1"
os.environ["SAHAY_DATABASE_URL"] = f"sqlite:///{_DB.as_posix()}"
os.environ["SAHAY_SERVER_X25519_SECRET_KEY"] = _VECTOR["server"]["box_secret_key"]
os.environ["SAHAY_SERVER_ED25519_SECRET_KEY"] = _VECTOR["server"]["sign_seed"]
os.environ["SAHAY_PII_ENCRYPTION_KEY"] = _VECTOR["server"]["sign_seed"]
os.environ["SAHAY_PIPELINE_AUTORUN"] = "0"  # pipeline tests opt in explicitly
os.environ["SAHAY_LLM_MODE"] = "mock"  # never reach a real provider from tests, whatever backend/.env says
os.environ["SAHAY_SEARCH_MODE"] = "mock"
os.environ["SAHAY_STT_MODE"] = "mock"
os.environ["SAHAY_RATE_LIMIT_PER_MINUTE"] = "100000"
os.environ["SAHAY_REGISTER_RATE_LIMIT_PER_MINUTE"] = "100000"
os.environ["SAHAY_LOGIN_RATE_LIMIT_PER_MINUTE"] = "100000"
