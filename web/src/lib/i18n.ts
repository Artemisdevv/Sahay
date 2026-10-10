import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "@/locales/en.json";
import ml from "@/locales/ml.json";
import hi from "@/locales/hi.json";

function readableMissingKey(key: string) {
  // Some older portal components still use their original camelCase label
  // keys. Show a readable label if one is missing while those resources are
  // being brought into sync, instead of exposing the translation key itself.
  const keyWithoutNamespace = key.slice(key.lastIndexOf(":") + 1);
  const label = keyWithoutNamespace
    .split(".")
    .filter(Boolean)
    .at(-1)
    ?.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label) return key;
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: en,
        shell: en.shell,
        admin: en.admin,
        serviceConsole: en.serviceConsole,
      },
      ml: { translation: ml, shell: ml.shell, admin: ml.admin, serviceConsole: { ...ml.service, ...ml.serviceConsole } },
      hi: { translation: hi, shell: hi.shell, admin: hi.admin, serviceConsole: { ...hi.service, ...hi.serviceConsole } },
    },
    ns: ["translation", "shell", "admin", "serviceConsole"],
    defaultNS: "translation",
    fallbackLng: "en",
    parseMissingKeyHandler: readableMissingKey,
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      caches: ["localStorage"],
      lookupLocalStorage: "sahay-language",
    },
  });

export default i18n;
