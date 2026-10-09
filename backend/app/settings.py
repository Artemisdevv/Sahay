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

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.sahay_cors_origins.split(",") if origin.strip()]


settings = Settings()
