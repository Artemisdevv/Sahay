from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    sahay_dev: bool = False
    sahay_database_url: str = "sqlite:///./sahay.db"
    sahay_jwt_secret: str = ""
    sahay_cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.sahay_cors_origins.split(",") if origin.strip()]


settings = Settings()
