from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    sahay_dev: bool = False
    sahay_database_url: str = "sqlite:///./sahay.db"
    sahay_jwt_secret: str = ""
    sahay_cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"
    sahay_rate_limit_per_minute: int = 120
    sahay_register_rate_limit_per_minute: int = 10
    sahay_login_rate_limit_per_minute: int = 10
    sahay_server_x25519_secret_key: str = ""
    sahay_server_key_file: str = ".sahay-server-key"
    sahay_server_ed25519_secret_key: str = ""
    sahay_server_signing_key_file: str = ".sahay-server-ed25519-key"
    sahay_pii_encryption_key: str = ""
    sahay_pii_key_file: str = ".sahay-pii-key"
    # Live response (X-04, contract section 9). All off by default: no background loop runs unless one is set.
    sahay_demo_mover: bool = False  # glide en_route units to their incident, then mark them on scene
    sahay_demo_arrival_seconds: float = 60.0  # how long a unit takes to arrive in the demo
    sahay_demo_auto_accept_seconds: float = 0.0  # >0: a called unit accepts (then departs) after this long
    sahay_demo_auto_complete_seconds: float = 0.0  # >0: units on scene complete after this long
    sahay_call_timeout_s: float = 0.0  # >0: a called unit that does not answer in this time is skipped
    sahay_pipeline_autorun: bool = True  # run the agent pipeline after each accepted report
    sahay_llm_mode: str = "mock"  # mock = deterministic rules, no network
    sahay_stt_mode: str = "mock"  # mock = no audio model; text payloads still work; live = providers below
    sahay_stt_providers: str = "gemini:gemini-2.5-flash,groq:whisper-large-v3"  # tried left to right, see app/agents/stt_live.py
    sahay_stt_timeout_s: float = 20.0
    stt_api_key: str = ""  # Cloudflare Workers AI token (used when CLOUDFLARE_API_TOKEN is empty)
    sahay_stt_prompt: str = ""  # optional Whisper prompt, e.g. a Malayalam sentence to steer script and vocabulary
    cloudflare_account_id: str = ""
    cloudflare_api_token: str = ""
    llm_provider: str = ""  # "groq" (default endpoint) or any OpenAI-compatible provider with LLM_BASE_URL
    llm_api_key: str = ""  # key for the primary provider (Groq)
    llm_api_key_gemini: str = ""
    llm_gemini_model: str = "gemini-flash-latest"
    llm_fallback_provider: str = ""  # "gemini" = try it when the primary fails, before dropping to rules
    llm_model: str = "openai/gpt-oss-120b"
    llm_base_url: str = ""  # empty = provider default
    llm_timeout_s: float = 15.0
    llm_reasoning_effort: str = "low"  # for reasoning models (gpt-oss); set empty for providers that reject it
    sahay_search_mode: str = "mock"  # mock = canned hazard tips; live = Firecrawl web search
    sahay_web_search_key: str = ""
    sahay_static_dir: str = ""  # built SPA (web/dist/client). Set in the Docker image so one origin serves app + API
    # Production seeding without /dev/seed: when both are set and the database has no units/users, units and
    # staff accounts are created at startup with these passwords (never the demo defaults).
    sahay_seed_admin_password: str = ""
    sahay_seed_service_password: str = ""

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.sahay_cors_origins.split(",") if origin.strip()]


settings = Settings()
