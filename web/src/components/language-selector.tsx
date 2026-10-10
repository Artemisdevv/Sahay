import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Globe } from "lucide-react";

export function LanguageSelector() {
  const { i18n, t } = useTranslation();

  const languages = [
    { code: "en", label: "English", flag: "🇺🇸" },
    { code: "hi", label: "हिंदी", flag: "🇮🇳" },
    { code: "ml", label: "മലയാളം", flag: "🇮🇳" },
  ] as const;

  return (
    <Select
      value={i18n.language}
      onValueChange={(lng) => i18n.changeLanguage(lng)}
    >
      <SelectTrigger className="w-40 h-8 items-center gap-2">
        <Globe className="h-4 w-4" />
        <SelectValue placeholder={t("common.language")} />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4}>
        {languages.map((lang) => (
          <SelectItem key={lang.code} value={lang.code} className="flex items-center gap-2">
            <span>{lang.flag}</span>
            <span>{lang.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}