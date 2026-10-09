from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    sahay_dev: bool = False
    sahay_database_url: str = "sqlite:///./sahay.db"
    sahay_jwt_secret: str = ""
    sahay_cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    sahay_rate_limit_per_minute: int = 120
    sahay_register_rate_limit_per_minute: int = 10
    sahay_login_rate_limit_per_minute: int = 10
    sahay_server_x25519_secret_key: str = ""
    sahay_server_key_file: str = ".sahay-server-key"
    sahay_server_ed25519_secret_key: str = ""
    sahay_server_signing_key_file: str = ".sahay-server-ed25519-key"
    sahay_pii_encryption_key: str = ""
    sahay_pii_key_file: str = ".sahay-pii-key"
    sahay_pipeline_autorun: bool = True  # run the agent pipeline after each accepted report
    sahay_llm_mode: str = "mock"  # mock = deterministic rules, no network
    sahay_stt_mode: str = "mock"  # mock = no audio model; text payloads still work
    llm_provider: str = ""  # "groq" (default endpoint) or any OpenAI-compatible provider with LLM_BASE_URL
    llm_api_key: str = ""
    llm_model: str = "openai/gpt-oss-120b"
    llm_base_url: str = ""  # empty = provider default
    llm_timeout_s: float = 15.0
    llm_reasoning_effort: str = "low"  # for reasoning models (gpt-oss); set empty for providers that reject it
    sahay_search_mode: str = "mock"  # mock = canned hazard tips; live = Firecrawl web search
    sahay_web_search_key: str = ""

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.sahay_cors_origins.split(",") if origin.strip()]


settings = Settings()
