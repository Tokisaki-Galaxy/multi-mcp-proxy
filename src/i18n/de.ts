import type { Catalog } from "./en";

/**
 * German. Neutral, impersonal phrasing throughout, so no reader has to decide
 * whether the panel is on du or Sie terms.
 */
export const de: Catalog = {
  // ---------------------------------------------------------------- generic
  "app.subtitle": "Transparenter MCP-Proxy für mehrere Dienste mit Schlüssel-Pools",
  "action.refresh": "Aktualisieren",
  "action.delete": "Löschen",
  "action.logout": "Abmelden",
  "state.loading": "Wird geladen…",
  "state.unknown": "unbekannt",

  // ------------------------------------------------------------------ theme
  "theme.mode.auto": "System",
  "theme.mode.light": "Hell",
  "theme.mode.dark": "Dunkel",
  "theme.title.auto": "Folgt dem System, aktuell {resolved}. Ein Klick schaltet auf hell.",
  "theme.title.light": "Fest auf hell. Ein Klick schaltet auf dunkel.",
  "theme.title.dark": "Fest auf dunkel. Ein Klick folgt wieder dem System.",
  "theme.resolved.light": "hell",
  "theme.resolved.dark": "dunkel",

  // --------------------------------------------------------------- language
  "lang.label": "Sprache",

  // ------------------------------------------------------------------ login
  "login.field": "Proxy-Schlüssel (x-proxy-key)",
  "login.placeholder": "Den bei der Bereitstellung gesetzten PROXY_KEY einfügen",
  "login.submit": "Anmelden",
  "login.invalid": "Der Schlüssel wurde abgelehnt",

  // ----------------------------------------------------------- service form
  "svc.new": "Dienst hinzufügen",
  "svc.preset.none": "Mit einer Vorlage beginnen",
  "svc.preset.custom": "Eigene",
  "svc.field.id": "Dienst-ID",
  "svc.field.name": "Anzeigename",
  "svc.field.url": "Upstream-MCP-Endpunkt",
  "svc.field.authType": "Position der Zugangsdaten",
  "svc.field.authType.header": "Anfrage-Header",
  "svc.field.authType.query": "URL-Parameter",
  "svc.field.authName": "Feldname",
  "svc.field.authPrefix": "Präfix",
  "svc.field.authPrefixHint": "Leer oder Bearer ",
  "svc.field.exhausted": "Statuscodes bei erschöpftem Kontingent",
  "svc.field.cooldown": "Statuscodes bei Ratenlimit",
  "svc.field.invalid": "Statuscodes bei ungültigem Schlüssel",
  "svc.save": "Dienst speichern",
  "svc.saved": "Gespeichert",
  "svc.savedWithUsage": "Gespeichert, mit Kontingent-Endpunkt",
  "svc.savedWithoutUsage": "Gespeichert, ohne Kontingent-Endpunkt",

  // -------------------------------------------------------------- usage api
  "usage.title": "Kontingent-Endpunkt (optional)",
  "usage.expand": "Ausklappen",
  "usage.collapse": "Einklappen",
  "usage.hint":
    "Ausfüllen, wenn der Upstream eine Kontingent-API bereitstellt. Ohne diese Angabe zeigt das Panel nur den Schlüsselstatus, nicht das Restkontingent.",
  "usage.field.url": "Kontingent-Endpunkt",
  "usage.field.authName": "Name des Auth-Headers",
  "usage.field.authPrefix": "Auth-Präfix",
  "usage.field.used": "Pfad für Verbrauch",
  "usage.field.limit": "Pfad für Obergrenze",
  "usage.field.limitFallback": "Ersatzpfad für Obergrenze",
  "usage.field.remaining": "Pfad für Restkontingent",
  "usage.hint.paths":
    "Pfade werden mit Punkten getrennt, etwa data.remainingCredits. Ist die Obergrenze null, greift der Ersatzpfad, den Tavily braucht, weil key.limit dort häufig null ist. Ist ein Pfad für das Restkontingent gesetzt, ergibt sich der Verbrauch aus Obergrenze minus Rest.",
  "usage.presetNote.exa":
    "Normale Exa-API-Schlüssel haben keinen Kontingent-Endpunkt, dafür ist Team Management nötig. Die Kontingent-Felder für diesen Dienst leer lassen.",

  // ----------------------------------------------------------- service list
  "svc.list": "Dienste",
  "svc.empty": "Noch keine Dienste. Oben einen hinzufügen.",
  "svc.delete": "Dienst löschen",
  "svc.deleteConfirm": "Dienst {id} mit allen Schlüsseln löschen?",
  "svc.stats.total": "gesamt",
  "svc.stats.active": "verfügbar",
  "svc.stats.cooling": "Abklingzeit",
  "svc.stats.exhausted": "erschöpft",
  "svc.stats.invalid": "ungültig",

  // ------------------------------------------------------------------- keys
  "keys.empty": "Noch keine Schlüssel",
  "keys.col.key": "Schlüssel",
  "keys.col.note": "Notiz",
  "keys.col.status": "Status",
  "keys.col.quota": "Kontingent",
  "keys.col.weight": "Gewicht",
  "keys.col.lastUsed": "Zuletzt genutzt",
  "keys.add": "Schlüssel hinzufügen",
  "keys.sync": "Kontingent abgleichen",
  "keys.placeholder":
    "Ein Schlüssel pro Zeile. Notiz nach einem Komma:\ntvly-abc123,Hauptkonto\ntvly-def456,Ersatz",
  "keys.note": "Notiz",
  "keys.notePrompt": "Notiz. Leer lassen zum Löschen.",
  "keys.noteUpdated": "Notiz aktualisiert",
  "keys.deleteConfirm": "Diesen Schlüssel löschen?",
  "keys.pasteFirst": "Zuerst mindestens einen Schlüssel einfügen",
  "keys.added": "{added} hinzugefügt, {skipped} Duplikate übersprungen",
  "keys.synced": "{synced} abgeglichen, {failed} fehlgeschlagen",
  "keys.readFailed": "Laden fehlgeschlagen: {message}",
  "keys.status.active": "aktiv",
  "keys.status.cooling": "Abklingzeit",
  "keys.status.exhausted": "erschöpft",
  "keys.status.invalid": "ungültig",
  "keys.ago.seconds.one": "{n} Sekunde her",
  "keys.ago.seconds.other": "{n} Sekunden her",
  "keys.ago.minutes.one": "{n} Minute her",
  "keys.ago.minutes.other": "{n} Minuten her",
  "keys.ago.hours.one": "{n} Stunde her",
  "keys.ago.hours.other": "{n} Stunden her",
  "keys.ago.days.one": "{n} Tag her",
  "keys.ago.days.other": "{n} Tage her",

  // ---------------------------------------------------------------- notices
  "notice.endpoint":
    "Clients verbinden sich mit https://your-domain/{service}/mcp und senden den Header x-proxy-key.",

  // ------------------------------------------------------------- api errors
  "api.unauthorized": "Nicht autorisiert",
  "api.invalidJson": "Ungültiger JSON-Inhalt",
  "api.badId":
    "Ungültige ID. Nur Kleinbuchstaben, Ziffern, Bindestrich oder Unterstrich, 1 bis 32 Zeichen, kein reserviertes Wort.",
  "api.urlHttps": "upstreamUrl muss eine https-URL sein",
  "api.authType": "auth.type muss 'header' oder 'query' sein",
  "api.authNameRequired": "auth.name ist erforderlich",
  "api.usageUrlHttps": "usage.url muss eine https-URL sein",
  "api.usageAuthType": "usage.style.type muss 'header' oder 'query' sein",
  "api.usageAuthNameRequired": "usage.style.name ist erforderlich",
  "api.usageNeedsPath":
    "usage braucht usedPath oder remainingPath, sonst lässt sich das Kontingent nicht lesen",
  "api.serviceNotFound": "Dienst nicht gefunden",
  "api.noKeys": "Keine Schlüssel angegeben",
  "api.duplicateNote": "Doppelte Notiz in diesem Stapel: {label}",
  "api.idsRequired": "Der Body muss { ids: string[] } sein",
  "api.keyNotFound": "Schlüssel nicht gefunden",
  "api.notFound": "Nicht gefunden",
  "api.internal": "Interner Proxy-Fehler",
  "api.noUsageProbe":
    "Für Dienst {id} ist kein Kontingent-Endpunkt konfiguriert, Kontingente lassen sich daher nicht abgleichen. Oben den Kontingent-Endpunkt ausfüllen. Normale Exa-API-Schlüssel haben keine Kontingent-API, dafür ist Team Management nötig.",
};
